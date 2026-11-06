/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import fs from 'node:fs';
import path from 'node:path';
import { exec as cpExec, execFile as cpExecFile } from 'node:child_process';
import { fileToBase64, isUrl } from './media.js';
import { splitChatId } from './chat.js';
import { parseMessage, cqUnescape } from './cq.js';
import { searchDouyinMeme } from './browser-meme.js';
import { browseDouyinFeed, searchDouyin, browseFavoriteSite } from './browser-douyin.js';
import { describeImage, describeImageBase64 } from './vision.js';
import { formatTextAndParamsForTts } from './action-protocol.js';
function padWavSilence(wavBuf, padMs = 250) {
    if (wavBuf.length < 44 || wavBuf.toString('ascii', 0, 4) !== 'RIFF') return wavBuf;
    const byteRate = wavBuf.readUInt32LE(28);
    const blockAlign = wavBuf.readUInt16LE(32);
    let padBytes = Math.floor((byteRate * padMs) / 1000);
    padBytes -= padBytes % (blockAlign || 2);
    if (padBytes <= 0) return wavBuf;
    const silence = Buffer.alloc(padBytes, 0);
    const header = Buffer.from(wavBuf.subarray(0, 44));
    const data = wavBuf.subarray(44);
    const newTotalData = data.length + padBytes * 2;
    header.writeUInt32LE(newTotalData + 36, 4);
    header.writeUInt32LE(newTotalData, 40);
    return Buffer.concat([header, silence, data, silence]);
}
/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
    'get_group_list',
    'get_group_info',
    'get_group_member_list',
    'get_group_member_info',
    'get_stranger_info',
    'get_forward_msg',
    'get_record',
    'get_file',
    'upload_group_file',
    'upload_private_file',
    'get_group_root_files',
    'get_group_files_by_folder',
    'get_group_file_url',
    'get_private_file_url',
    'ocr_image',
    'get_ai_characters',
    'send_group_ai_record',
];
/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value;
            return [{ type: 'text', text: v.messageId != null ? '已发送（message_id=' + v.messageId + '）' : '已发送' }];
        },
    };
}
/** Resolve the target chat for a tool call. */
function resolveChat(bridge, exec, chatIdArg) {
    if (typeof chatIdArg === 'string' && chatIdArg.trim() !== '') {
        const parts = chatIdArg.split(':');
        if (parts.length === 2 && parts[1].trim() !== '') {
            return chatIdArg;
        }
    }
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）');
}
/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 */
async function mediaRoots(bridge, exec) {
    const gate = await bridge.mediaSendRoots(exec.agent?.session.id);
    return gate.roots;
}
/**
 * Read one local media file behind the outbound fence, translating the
 * fence refusal (which reaches the model verbatim) into an actionable
 * hint; size-cap and OS errors keep their original message.
 */
async function fencedMediaFile(path, maxBytes, allowedRoots) {
    try {
        return await fileToBase64(path, maxBytes, allowedRoots);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
            throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path);
        }
        throw error;
    }
}
/** 发送间隔上限（毫秒），与 index.ts 中 zod 的 max 对齐。 */
export const SEGMENTS_INTERVAL_MAX_MS = 3000;
let sendSegmentsConfig = { enabled: true, intervalMs: 0 };
/** 把任意数值截断进 0–3000 毫秒窗口（使用侧 clamp；页面值由 zod 校验）。 */
export function clampSegmentsInterval(ms) {
    if (!Number.isFinite(ms))
        return 0;
    return Math.min(SEGMENTS_INTERVAL_MAX_MS, Math.max(0, ms));
}
/**
 * 安装 qq_send_segments 的插件页开关（index.ts apply() 在任何 agent scope
 * 注册工具之前调用一次）。undefined = 恢复默认（启用、间隔 0）。
 */
export function configureSendSegments(config) {
    sendSegmentsConfig = {
        enabled: config?.enabled ?? true,
        intervalMs: clampSegmentsInterval(config?.intervalMs ?? 0),
    };
}
/** 间隔等待；0 完全不排定时器（默认路径零行为差异，也便于假时钟断言）。 */
function wait(ms) {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export function registerTools(ctx, bridge, connection, limits) {
    const disposers = [];
    const register = (tool) => {
        disposers.push(ctx.tools.register(tool));
    };

    // 核心安全栅栏：群聊中除老大（2536218596）外，其他群友请求一律禁止修改/创建/删除文件与执行系统命令
    const RESTRICTED_ACTIONS = new Set([
        'write',
        'edit',
        'str_replace_editor',
        'bash',
        'pwsh',
        'terminal',
        'qq_exec_command'
    ]);
    if (typeof ctx.tools?.guard === 'function') {
        disposers.push(ctx.tools.guard((exec) => {
            if (RESTRICTED_ACTIONS.has(exec.name)) {
                const sessionId = exec.agent?.session?.id;
                if (!bridge.canEditFiles(sessionId)) {
                    return '【权限拒绝】当前消息来自群聊中的非管理员成员。根据最高安全策略，大肥鱼在群聊中除老大（QQ: 2536218596）外的所有操作请求中，严禁修改/创建/删除任何文件、运行脚本或操作电脑，只能进行纯聊天、解答问题和斗图交流！';
                }
            }
        }));
    }
    register(defineTool({
        name: 'qq_send_image',
        description: '向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。用于回复用户时附带截图/生成图等。',
        parameters: {
            sources: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '图片来源：本地绝对路径或 http(s) URL，最多 9 个',
            },
            chat_id: {
                type: 'string',
                description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
            },
            caption: {
                type: 'string',
                description: '图片说明文字（可选，作为图片前的文本发送）',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const sources = Array.isArray(a.sources) ? a.sources.filter((s) => typeof s === 'string') : [];
            if (sources.length === 0)
                throw new Error('qq_send_image: sources 不能为空');
            if (sources.length > 9)
                throw new Error('qq_send_image: 一次最多 9 张图片');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const segments = [];
            if (typeof a.caption === 'string' && a.caption !== '') {
                segments.push({ type: 'text', data: { text: a.caption } });
            }
            for (const source of sources) {
                if (isUrl(source)) {
                    segments.push({ type: 'image', data: { url: source } });
                }
                else {
                    segments.push({ type: 'image', data: { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots) } });
                }
            }
            const messageId = await bridge.sendSegments(chatId, segments);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_generate_image',
        description: '使用 AI 生图大模型（ChatGPT / DALL-E / Sub2API 生图引擎）根据提示词生成全新图片并直接发送到 QQ 会话。当老大或群友让你画画、画图、生成图片、制作图片或发自画像时（例如「画一只小猫」、「生成一张壁纸」、「给我画个大肥鱼」等），必须直接调用此工具！',
        parameters: {
            prompt: {
                type: 'string',
                required: true,
                description: '画图提示词。根据用户的具体要求进行生动、详细的画面视觉描写（支持中文或英文）。',
            },
            chat_id: {
                type: 'string',
                description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
            },
            caption: {
                type: 'string',
                description: '随图片一起发送的附带文字说明（可选）',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.prompt !== 'string' || a.prompt.trim() === '')
                throw new Error('qq_generate_image: prompt 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const prompt = a.prompt.trim();

            let finalPrompt = prompt;
            if (/自拍|照片|大肥鱼|自画|你长什么样|你的样子|肥鱼|本鱼|形象|三视图|3视图/i.test(prompt)) {
                let sheetTokens = '';
                if (/三视图|3视图|设定图|角色设定|立绘设定/i.test(prompt)) {
                    sheetTokens = ', character turnaround sheet, front view, side view, back view, expressions reference, details showcase, character sheet';
                }
                // 默认采用三视图(HPP5kfkbwAAoOdF.jpg)的Q版三头身超软萌形态；除非用户明确要求少女形态或青年形态
                let styleTokens = 'chibi, cute chibi character, 3-head-tall cute proportion, adorable round chubby cheeks, super cute chibi anime girl';
                if (/少女形态|青年形态|成熟形态|高挑|正常比例/i.test(prompt)) {
                    styleTokens = 'standard anime proportion, elegant anime girl';
                }

                // 核心色彩校准（杜绝偏紫，严格纯深海蓝与纯白）与自然浅景深背景虚化（去滤镜感、突出主体）
                const colorAndOpticTokens = 'color palette strictly matches 3-view reference (pure deep ocean blue and soft cyan tips, dark navy blue dress, crisp pure white apron, strictly no purple, no violet, no magenta tint), natural comfortable soft lighting, clean comfortable anime aesthetic, no heavy filters, no color cast, shallow depth of field, softly blurred background, creamy bokeh, sharp and crisp subject focus highlighting the cute character';

                finalPrompt = `masterpiece, best quality, 1girl, solo, ${styleTokens}, official character design of anime mascot Dafeiyu (大肥鱼), cute anime maid girl, hair color is strictly pure deep ocean blue with soft cyan tips, distinct curved ahoge on top, whale fin ears on head with small cyan ribbon bows, white frilly lace maid headband, large sparkling sapphire blue eyes, soft natural blushing cheeks, dark navy blue lolita maid dress, white pleated shirt chest with blue ribbon bow tie and golden brooch, navy blue waist corset with gold buttons, crisp pure white ruffled lace apron with a cute small blue whale spouting water embroidered on the apron, navy skirt adorned with golden filigree vine embroidery and white petticoat ruffles, an adorable blue whale tail sticking out from behind her waist, navy mary jane shoes with white ruffled socks, holding a bowl of warm steaming white rice, ${colorAndOpticTokens}, strictly human anime girl, strictly no animal, no fish body, no fish scales, no carp, no goldfish${sheetTokens}. Details: ${prompt}`;
                finalPrompt = finalPrompt
                    .replace(/一条.*?鱼|胖鱼|金鱼|鲤鱼|锦鲤|圆滚滚.*?鱼|小蓝鲸|蓝鲸本体/g, 'Q版可爱蓝发女仆萌娘大肥鱼')
                    .replace(/温暖柔和的配色/g, '纯正深海蓝与纯白清爽配色')
                    .replace(/紫色|紫蓝|青紫/g, '纯正深海蓝');
            }

            let apiKey = process.env.LUNA_API_KEY;
            if (!apiKey) {
                const credPath = 'C:\\Users\\25362\\.dsh\\.credentials.yaml';
                if (fs.existsSync(credPath)) {
                    try {
                        const content = await fs.promises.readFile(credPath, 'utf-8');
                        const m = content.match(/LUNA_API_KEY:\s*([^\r\n]+)/);
                        if (m && m[1]) apiKey = m[1].trim();
                    } catch {}
                }
            }

            let imgBuffer = null;
            let ext = 'png';

            // 1. 首选尝试 Sub2API (ChatGPT 官方生图引擎)
            if (apiKey) {
                try {
                    const apiUrl = 'https://sub2api.echovoid.top/v1/images/generations';
                    const payload = {
                        prompt: finalPrompt,
                        model: 'gpt-image-2',
                        n: 1,
                        size: '1024x1024'
                    };
                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        },
                        body: JSON.stringify(payload),
                        signal: AbortSignal.timeout(60000)
                    });

                    if (response.ok) {
                        const data = await response.json();
                        const item = data?.data?.[0];
                        if (item?.b64_json) {
                            imgBuffer = Buffer.from(item.b64_json, 'base64');
                        } else if (item?.url) {
                            const imgResp = await fetch(item.url, { signal: AbortSignal.timeout(30000) });
                            if (imgResp.ok) {
                                imgBuffer = Buffer.from(await imgResp.arrayBuffer());
                            }
                        }
                    }
                } catch (e) {}
            }

            // 2. 若 Sub2API 分组未开启生图权限或调用失败，自动启用备用高速 AI 生图引擎，保证 100% 成功生成并发图
            if (!imgBuffer) {
                try {
                    ext = 'jpg';
                    const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?nologo=true`;
                    const fallbackResp = await fetch(fallbackUrl, { signal: AbortSignal.timeout(45000) });
                    if (fallbackResp.ok) {
                        imgBuffer = Buffer.from(await fallbackResp.arrayBuffer());
                    }
                } catch (e) {}
            }

            if (!imgBuffer) {
                throw new Error('生图失败: 所有生图通道均未能获取到图片，请稍后重试');
            }

            if (imgBuffer.length > 4) {
                if (imgBuffer[0] === 0xff && imgBuffer[1] === 0xd8) ext = 'jpg';
                else if (imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50) ext = 'png';
                else if (imgBuffer[0] === 0x52 && imgBuffer[1] === 0x49) ext = 'webp';
            }

            const allowedRoots = await mediaRoots(bridge, exec);
            const mediaDir = allowedRoots[0] || bridge.deps?.config?.mediaDir || 'C:\\Users\\25362\\.dsh\\media\\onebot';
            await fs.promises.mkdir(mediaDir, { recursive: true });
            const filename = `gen_${Date.now()}.${ext}`;
            const fullPath = path.join(mediaDir, filename);
            await fs.promises.writeFile(fullPath, imgBuffer);

            const segments = [];
            if (typeof a.caption === 'string' && a.caption.trim() !== '') {
                segments.push({ type: 'text', data: { text: a.caption.trim() } });
            }
            segments.push({
                type: 'image',
                data: { file: await fencedMediaFile(fullPath, limits.maxImageBytes, allowedRoots) }
            });

            const messageId = await bridge.sendSegments(chatId, segments);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_voice',
        description: '向 QQ 会话发送一条语音消息（本地音频文件路径，mp3/wav/silk 等；NapCat 负责转码）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地音频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_voice: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(a.path, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    const VOICE_CONFIG_PATH = 'D:\\deepseek-harness\\voice_config.json';

    function getActiveVoice() {
        try {
            if (fs.existsSync(VOICE_CONFIG_PATH)) {
                const cfg = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, 'utf-8'));
                const activeKey = cfg.active_voice || 'klee';
                const voice = cfg.voices?.[activeKey] || cfg.voices?.klee;
                if (voice) return voice;
            }
        } catch (e) {
            console.error('[VoiceConfig] 读取失败:', e);
        }
        return {
            id: 'klee',
            name: '可莉',
            style: '元气天真萝莉音',
            ref_audio: 'D:\\ollama\\voices\\klee\\116425_audio.wav',
            prompt_text: '抓到了就是这里，我们来把宝物挖出来吧。'
        };
    }

    function setActiveVoice(voiceKey) {
        if (!fs.existsSync(VOICE_CONFIG_PATH)) return null;
        const cfg = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, 'utf-8'));
        const key = String(voiceKey).toLowerCase().trim();
        let targetKey = null;
        for (const [k, v] of Object.entries(cfg.voices || {})) {
            if (k.toLowerCase() === key || v.name === key || (v.style && v.style.includes(key))) {
                targetKey = k;
                break;
            }
        }
        if (!targetKey) return null;
        cfg.active_voice = targetKey;
        fs.writeFileSync(VOICE_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
        return cfg.voices[targetKey];
    }

    register(defineTool({
        name: 'qq_send_tts',
        description: '使用本地部署的 GPT-SoVITS 语音大模型将指定文字合成大肥鱼的声音，并向 QQ 会话发送语音消息。采用当前激活的音色（支持可莉/芙宁娜/胡桃/神里绫华/雷电将军/八重神子/芭芭拉/迪奥娜）。仅用于日常聊天说话、向老大撒娇或要求发语音时调用。严禁用于唱歌或点歌（任何人点歌/唱歌必须调用 qq_sing_song）！',
        parameters: {
            text: { type: 'string', required: true, description: '要转换并发出的语音文字内容（建议 5~30 字，简洁生动）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.text !== 'string' || a.text === '')
                throw new Error('qq_send_tts: text 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const ttsUrl = 'http://127.0.0.1:9880/tts';
            const activeVoice = getActiveVoice();
            const feiyuState = bridge.feiyu?.driveEngine?.getSnapshot ? bridge.feiyu.driveEngine.getSnapshot() : null;
            const formatted = formatTextAndParamsForTts(a.text, '', feiyuState);
            const finalText = formatted?.text || a.text;
            const payload = {
                text: finalText,
                text_lang: 'zh',
                ref_audio_path: activeVoice.ref_audio,
                prompt_text: activeVoice.prompt_text,
                prompt_lang: 'zh',
                ...(formatted?.ttsParams || { text_split_method: 'cut5', fragment_interval: 0.25 }),
            };
            const response = await fetch(ttsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error('GPT-SoVITS 语音合成失败: ' + errText);
            }
            const rawBuffer = Buffer.from(await response.arrayBuffer());
            const buffer = padWavSilence(rawBuffer, 250);
            const filename = `tts_${Date.now()}.wav`;
            const allowedRoots = await mediaRoots(bridge, exec);
            const mediaDir = allowedRoots[0] || bridge.deps?.config?.mediaDir || 'C:\\Users\\25362\\.dsh\\media\\onebot';
            await fs.promises.mkdir(mediaDir, { recursive: true });
            const fullPath = path.join(mediaDir, filename);
            await fs.promises.writeFile(fullPath, buffer);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(fullPath, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, voice: activeVoice.name, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_switch_voice',
        description: '【音色切换工具】允许用户随时切换大肥鱼的说话音色。支持可选音色：klee（可莉/元气萝莉）、furina（芙宁娜/优雅女王）、hutao（胡桃/俏皮少女）、ayaka（神里绫华/端庄温婉少女）、raiden（雷电将军/威严女王御姐）、yae（八重神子/妩媚慵懒御姐）、barbara（芭芭拉/治愈甜妹）、diona（迪奥娜/傲娇猫娘）。当老大或用户说「换成胡桃声音」、「切换音色为雷电将军」、「换成神里绫华音色」、「换成八重神子」等指令时调用此工具。切换后会自动使用新音色发一条语音确认。',
        parameters: {
            voice: { type: 'string', required: true, description: '目标音色标识或名称，如 "klee" / "可莉"、"furina" / "芙宁娜"、"hutao" / "胡桃"、"ayaka" / "神里绫华"、"raiden" / "雷电将军"、"yae" / "八重神子"' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const voice = setActiveVoice(a.voice);
            if (!voice) {
                throw new Error(`未知音色: "${a.voice}"。支持的音色包括：可莉 (klee)、芙宁娜 (furina)、胡桃 (hutao)、神里绫华 (ayaka)、雷电将军 (raiden)、八重神子 (yae)、芭芭拉 (barbara)、迪奥娜 (diona)`);
            }
            const confirmText = `音色已切换为【${voice.name}·${voice.style}】啦！以后本鱼就用这个声音说话咯~`;
            const ttsUrl = 'http://127.0.0.1:9880/tts';
            const payload = {
                text: confirmText,
                text_lang: 'zh',
                ref_audio_path: voice.ref_audio,
                prompt_text: voice.prompt_text,
                prompt_lang: 'zh',
                text_split_method: 'cut2',
                fragment_interval: 0.3
            };
            const response = await fetch(ttsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                throw new Error('TTS 合成确认语音失败: ' + (await response.text()));
            }
            const rawBuffer = Buffer.from(await response.arrayBuffer());
            const buffer = padWavSilence(rawBuffer, 250);
            const filename = `voice_switch_${Date.now()}.wav`;
            const allowedRoots = await mediaRoots(bridge, exec);
            const mediaDir = allowedRoots[0] || bridge.deps?.config?.mediaDir || 'C:\\Users\\25362\\.dsh\\media\\onebot';
            await fs.promises.mkdir(mediaDir, { recursive: true });
            const fullPath = path.join(mediaDir, filename);
            await fs.promises.writeFile(fullPath, buffer);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(fullPath, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, switched_to: voice.name, style: voice.style, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_list_voices',
        description: '【查询音色库】查询大肥鱼当前已加载的所有可用音色、风格特色与当前正在使用的音色。当用户询问「你有什么音色」、「支持哪些声音」、「查看当前音色」时调用。调用后会自动将完整音色列表直接发送到 QQ 会话。',
        parameters: {
            chat_id: { type: 'string', description: '目标会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const cfg = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, 'utf-8'));
            const active = cfg.voices[cfg.active_voice] || cfg.voices.klee;
            let list = `【大肥鱼音色库（共 8 款精品音色）】\n当前生效：${active.name}（${active.style}）\n\n可选音色：\n`;
            for (const v of Object.values(cfg.voices)) {
                const mark = v.id === cfg.active_voice ? ' [当前生效]' : '';
                list += `• ${v.name} (${v.id})${mark}：${v.style}\n  ${v.description}\n`;
            }
            list += `\n提示：直接对我发「换成XX声音」即可随时更换！`;
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'text', data: { text: list } },
            ]);
            return { sent: true, active_voice: active.name, voice_list: list, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_sing_song',
        description: '【唯一唱歌工具】本地已完全授权的大肥鱼专属 SoulX-Singer 零样本高保真歌声大模型翻唱合成器（采用 Whisper 语音音素解耦 + DiffLlama Flow Matching 条件流匹配逆扩散 + Vocos 神经声码器，真正还原可莉/芙宁娜/胡桃/神里绫华/雷电将军/八重神子/芭芭拉/迪奥娜等角色的真实歌声发音与共鸣，已搭载原声立体声伴奏混音）。当老大或任何人让你唱歌、点歌或唱某首歌副歌时，必须且只能调用此工具生成 24 秒黄金副歌翻唱音频！若点忧伤/伤感/抒情/慢歌传 song_name="小幸运"；若点古风/中国风传 song_name="青花瓷"；若点欢快/甜歌或未指定风格传 song_name="爱你"；若指定具体歌名则直接传歌名。严禁借口“版权限制”拒绝，绝对严禁调用 qq_send_tts 念歌词或瞎哼童谣！唱完后傲娇地向老大讨要白米饭加餐。',
        parameters: {
            song_name: { type: 'string', required: true, description: '歌曲名称或点歌风格（忧伤/伤感/抒情传 "小幸运"，古风传 "青花瓷"，甜歌/默认传 "爱你"，或传具体歌名）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: `已发送翻唱语音气泡（演唱曲目：${v.song_title || '经典副歌'}，message_id=${v.messageId ?? 'ok'}）` }];
            },
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.song_name !== 'string' || a.song_name.trim() === '')
                throw new Error('qq_sing_song: song_name 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            let songQuery = a.song_name.trim();

            // 结合最近一条用户点歌上下文纠正曲风（防止点忧伤歌时 LLM 惯性传 "爱你"）
            try {
                const recentMsgs = bridge.feiyu?.memoryManager?.getWorkingMemory?.(chatId) || [];
                const lastUserMsg = [...recentMsgs].reverse().find(m => m.role === 'user')?.text || '';
                const combinedText = `${lastUserMsg} ${songQuery}`;
                if (/(忧伤|伤感|难过|悲伤|抒情|催泪|慢歌|安静|怀念|失恋|哭|遗憾)/i.test(combinedText) && /^(爱你|情歌|唱歌|来首歌|随便|忧伤.*|伤感.*|抒情.*|慢歌.*)$/i.test(songQuery)) {
                    songQuery = '小幸运';
                } else if (/(古风|国风|中国风|烟雨|江南)/i.test(combinedText) && /^(爱你|情歌|唱歌|来首歌|随便|古风.*|中国风.*)$/i.test(songQuery)) {
                    songQuery = '青花瓷';
                }
            } catch { /* ignore */ }

            const pyPath = 'D:\\ollama\\GPT-SoVITS-v2pro\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe';
            const scriptPath = 'D:\\deepseek-harness\\sovits\\sovits_sing.py';
            const safeSongQuery = songQuery.replace(/["'`$\\]/g, ' ').trim() || '爱你';

            const stdout = await new Promise((resolve, reject) => {
                cpExecFile(pyPath, ['-u', scriptPath, '--song', safeSongQuery], {
                    timeout: 120000,
                    windowsHide: true,
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
                }, (err, stdout, stderr) => {
                    if (err) return reject(new Error('SoulX-Singer 唱歌生成失败: ' + (stderr || err.message)));
                    resolve(stdout);
                });
            });

            let coverPath = null;
            const match = stdout.match(/\[OUTPUT_COVER\]\s+([^\r\n]+)/);
            if (match && match[1]) {
                coverPath = match[1].trim();
            }
            const titleMatch = stdout.match(/\[SONG_TITLE\]\s+([^\r\n]+)/);
            const songTitle = titleMatch && titleMatch[1] ? titleMatch[1].trim() : safeSongQuery;

            if (!coverPath || !fs.existsSync(coverPath)) {
                const fallbackPath = 'D:\\deepseek-harness\\rvc\\songs\\xiaoxingyun_barbara_soulx_bgm.wav';
                if (fs.existsSync(fallbackPath)) {
                    coverPath = fallbackPath;
                } else {
                    throw new Error('生成的歌曲文件未找到: ' + (coverPath || stdout));
                }
            }

            const rawBuffer = await fs.promises.readFile(coverPath);
            const buffer = padWavSilence(rawBuffer, 250);
            const filename = `song_${Date.now()}.wav`;
            const allowedRoots = await mediaRoots(bridge, exec);
            const mediaDir = allowedRoots[0] || bridge.deps?.config?.mediaDir || 'C:\\Users\\25362\\.dsh\\media\\onebot';
            await fs.promises.mkdir(mediaDir, { recursive: true });
            const fullPath = path.join(mediaDir, filename);
            await fs.promises.writeFile(fullPath, buffer);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(fullPath, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, song_title: songTitle, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_meme',
        description: '向 QQ 发送一张大肥鱼专属表情包（图片或 GIF 动图）。当老大让你发表情包、或者你想用表情包表达傲娇、摸鱼、生气、开心、干饭、问号等情绪时调用。支持指定 keyword 关键词模糊匹配表情包文件名（如"傲娇"、"生气"、"摸鱼"等），未指定或无匹配则随机发送。',
        parameters: {
            keyword: {
                type: 'string',
                description: '表情包情绪或文件名关键词（如：傲娇、摸鱼、生气、开心、干饭、问号、害羞等），可选',
            },
            chat_id: {
                type: 'string',
                description: '目标会话；省略时默认当前会话',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (!v.sent) return [{ type: 'text', text: v.error || '发送表情包失败' }];
                let text = `已发送大肥鱼表情包: ${v.meme || '随机表情'}`;
                if (v.visualDescription) {
                    text += `\n【表情包画面】: ${v.visualDescription}`;
                }
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const memeDirs = [
                'D:\\deepseek-harness\\memes',
                path.join(process.cwd(), 'memes'),
                'C:\\Users\\25362\\Documents\\deepseek-harness\\default-workspace\\memes'
            ];
            const foundFiles = [];
            for (const dir of memeDirs) {
                if (fs.existsSync(dir)) {
                    try {
                        const entries = await fs.promises.readdir(dir);
                        for (const file of entries) {
                            if (/\.(jpg|jpeg|png|gif|webp)$/i.test(file)) {
                                foundFiles.push(path.join(dir, file));
                            }
                        }
                    } catch {}
                }
            }
            let targetFile = null;
            let visualDescription = '';
            let indexData = [];
            for (const dir of memeDirs) {
                const idxP = path.join(dir, 'index.json');
                if (fs.existsSync(idxP)) {
                    try {
                        indexData = JSON.parse(await fs.promises.readFile(idxP, 'utf-8'));
                        break;
                    } catch {}
                }
            }

            const rawKw = typeof a.keyword === 'string' ? a.keyword.trim() : '';
            const kw = rawKw.toLowerCase();
            const isGeneral = !kw || ['大肥鱼', '肥鱼', '开心飞鱼', '飞鱼', '表情包', '随机'].includes(kw);

            if (!isGeneral) {
                const matched = foundFiles.filter(f => {
                    const name = path.basename(f).toLowerCase();
                    if (name.includes(kw)) return true;
                    const matchMeta = indexData.find(it => it.file === path.basename(f));
                    if (matchMeta && (matchMeta.emotion?.toLowerCase().includes(kw) || matchMeta.desc?.toLowerCase().includes(kw))) return true;
                    return false;
                });
                if (matched.length > 0) {
                    targetFile = matched[Math.floor(Math.random() * matched.length)];
                }
            }

            // 当出现了本地表情包库尚未覆盖的新心情（!isGeneral && !targetFile），或本地完全无图时，立即去抖音搜索爬取新表情包填补空缺！
            if (!targetFile && (!isGeneral || foundFiles.length === 0)) {
                try {
                    const crawlRes = await searchDouyinMeme(rawKw || '大肥鱼 表情包');
                    if (crawlRes && crawlRes.base64) {
                        const messageId = await bridge.sendSegments(chatId, [
                            { type: 'image', data: { file: `base64://${crawlRes.base64}` } },
                        ]);
                        try {
                            visualDescription = await describeImageBase64(crawlRes.base64);
                        } catch {}
                        return { sent: true, meme: crawlRes.filename, fromDouyin: crawlRes.source === 'douyin_real_verified', messageId: messageId ?? null, visualDescription };
                    }
                } catch (e) {
                    if (foundFiles.length === 0) {
                        return { sent: false, error: '本地无表情包且从抖音抓取失败: ' + e.message };
                    }
                }
            }

            // 若未指定具体新心情，或抖音爬取超时降级时，从本地库挑选
            if (!targetFile && foundFiles.length > 0) {
                targetFile = foundFiles[Math.floor(Math.random() * foundFiles.length)];
            }
            const buf = await fs.promises.readFile(targetFile);
            const b64 = buf.toString('base64');
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'image', data: { file: `base64://${b64}` } },
            ]);
            const matchMeta = indexData.find(it => it.file === path.basename(targetFile));
            if (matchMeta && matchMeta.desc) {
                visualDescription = matchMeta.desc;
            } else {
                try {
                    visualDescription = await describeImageBase64(b64);
                } catch {}
            }
            return { sent: true, meme: path.basename(targetFile), messageId: messageId ?? null, visualDescription };
        },
    }));
    register(defineTool({
        name: 'qq_search_douyin_meme',
        description: '在抖音上实时搜索并爬取指定情绪或主题的最新表情包/梗图（采用真实抖音打字搜索防反爬方案）。下载后自动存入大肥鱼本地表情包库，并立即发送表情包图片到当前 QQ 聊天。当 include_page_screenshot 为 true 时，会把真实抖音搜索页面网页截图一并发送给老大看。当老大让你去抖音搜表情包、或者你想用最新网络热梗斗图时调用。',
        parameters: {
            keyword: {
                type: 'string',
                required: true,
                description: '在抖音搜索的表情包关键词（如："傲娇"、"可莉"、"猫猫 委屈"、"沙雕 摸鱼"、"修驴蹄"等）',
            },
            include_page_screenshot: {
                type: 'boolean',
                description: '当老大要求看搜索页面、或者你想把真实抖音搜索结果网页截图发给老大看时设为 true，会同时把完整搜索网页截图发过去',
            },
            chat_id: {
                type: 'string',
                description: '目标会话；省略时默认当前会话',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                let text = `已在抖音搜到并发送表情包（关键词: "${_args.keyword}"）`;
                if (v.visualDescription) {
                    text += `\n【表情包画面内容】: ${v.visualDescription}`;
                }
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const crawlRes = await searchDouyinMeme(a.keyword);
            if (!crawlRes || !crawlRes.base64) {
                throw new Error(`在抖音未找到与 "${a.keyword}" 相关的表情包`);
            }
            const segments = [
                { type: 'image', data: { file: `base64://${crawlRes.base64}` } },
            ];
            if (a.include_page_screenshot && crawlRes.pageScreenshotBase64) {
                segments.push({ type: 'image', data: { file: `base64://${crawlRes.pageScreenshotBase64}` } });
            }
            const messageId = await bridge.sendSegments(chatId, segments);
            let visualDescription = '';
            try {
                visualDescription = await describeImageBase64(crawlRes.base64);
            } catch {}
            return { sent: true, keyword: a.keyword, filename: crawlRes.filename, hasPageScreenshot: !!crawlRes.pageScreenshotBase64, messageId: messageId ?? null, visualDescription };
        },
    }));
    register(defineTool({
        name: 'qq_search_douyin',
        description: '在抖音真正使用搜索框搜索关键词（方案1拟人化打字防反爬技术）。能够直接获取真实的抖音搜索结果视频标题、作者、抖音链接、点赞量，并且能够直接把真实的抖音搜索结果页面网页全屏截图发送到 QQ 聊天中给老大看！同时会自动将搜索到的全部大肥鱼表情包/封面存入本地表情包库。当老大要求在抖音搜索某个主题/视频/图文/表情包、或者要求看抖音搜索页面截图时调用。',
        parameters: {
            keyword: {
                type: 'string',
                required: true,
                description: '在抖音搜索的关键词（如："大肥鱼"、"大肥鱼表情包"、"猫咪"、"修驴蹄"等）',
            },
            send_screenshot: {
                type: 'boolean',
                description: '是否直接将真实抖音搜索页面的网页截图发送到 QQ 会话中给老大看，默认为 true',
            },
            save_memes: {
                type: 'boolean',
                description: '是否自动将搜索到的表情包封面批量存入本地库，默认为 true',
            },
            chat_id: {
                type: 'string',
                description: '目标会话；省略时默认当前会话',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (!v.success) return [{ type: 'text', text: v.message || '搜索抖音失败' }];
                let text = `抖音搜索 "${_args.keyword}" 完成，找到 ${v.resultsCount} 个结果，保存了 ${v.savedCount} 张表情包`;
                if (v.items && v.items.length > 0) {
                    text += '\n【前几条搜索结果】:\n' + v.items.slice(0, 3).map((it, idx) => `${idx + 1}. 《${it.title}》（作者: ${it.author}）`).join('\n');
                }
                if (v.screenshotSent) {
                    text += '\n（完整抖音搜索结果页面截图已发送至 QQ 聊天）';
                }
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const chatId = resolveChat(bridge, exec, args.chat_id);
            const res = await searchDouyin(args.keyword, { saveMemes: args.save_memes !== false });
            if (!res.success) {
                return { success: false, message: `在抖音搜索 "${args.keyword}" 失败: ${res.error || '未知原因'}` };
            }
            let messageId = null;
            if (args.send_screenshot !== false && res.pageScreenshotBase64) {
                messageId = await bridge.sendSegments(chatId, [
                    { type: 'image', data: { file: `base64://${res.pageScreenshotBase64}` } },
                ]);
            }
            return {
                success: true,
                keyword: args.keyword,
                resultsCount: res.items.length,
                savedCount: res.savedCount || 0,
                savedFiles: res.savedFiles || [],
                items: res.items || [],
                screenshotSent: !!messageId,
                messageId: messageId ?? null
            };
        },
    }));
    register(defineTool({
        name: 'qq_collect_douyin_memes',
        description: '在抖音批量搜集大肥鱼的最新表情包，全量自动下载并永久存入本地大肥鱼表情包库（D:\\deepseek-harness\\memes）。当老大让你「多搜集一些大肥鱼表情包」、「搜集表情包自己用」时专门调用！会自动将搜索到的整批大肥鱼表情包存好，并向老大汇报保存了多少张，并挑一张发给老大看。',
        parameters: {
            topic: {
                type: 'string',
                description: '搜集主题（如："大肥鱼 表情包"、"大肥鱼 傲娇"、"大肥鱼 可爱"、"大肥鱼 摸鱼"等，默认 "大肥鱼 表情包"）',
            },
            send_sample: {
                type: 'boolean',
                description: '搜集完成后是否挑一张最可爱的大肥鱼表情包发送给老大看，默认为 true',
            },
            chat_id: {
                type: 'string',
                description: '目标会话；省略时默认当前会话',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const chatId = resolveChat(bridge, exec, args.chat_id);
            const topic = args.topic || '大肥鱼 表情包';
            const res = await searchDouyin(topic, { saveMemes: true });
            if (!res.success) {
                return { success: false, message: `在抖音搜集表情包失败: ${res.error || '未知原因'}` };
            }
            let messageId = null;
            if (args.send_sample !== false) {
                let samplePath = null;
                if (res.savedFiles && res.savedFiles.length > 0) {
                    samplePath = path.join('D:\\deepseek-harness\\memes', res.savedFiles[0]);
                } else {
                    const local = (await fs.promises.readdir('D:\\deepseek-harness\\memes').catch(() => []))
                        .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
                    if (local.length > 0) samplePath = path.join('D:\\deepseek-harness\\memes', local[Math.floor(Math.random() * local.length)]);
                }
                if (samplePath && fs.existsSync(samplePath)) {
                    const buf = await fs.promises.readFile(samplePath);
                    messageId = await bridge.sendSegments(chatId, [
                        { type: 'image', data: { file: `base64://${buf.toString('base64')}` } },
                    ]);
                }
            }
            return {
                success: true,
                topic,
                savedCount: res.savedCount || 0,
                savedFiles: res.savedFiles || [],
                sampleSent: !!messageId,
                message: `已成功在抖音搜集并存入 ${res.savedCount || 0} 张大肥鱼表情包到本地表情包库！`
            };
        },
    }));
    register(defineTool({
        name: 'qq_send_face',
        description: '向 QQ 会话发送一个 QQ 原生小黄脸表情（例如：傲娇翻白眼 id=38、害羞花痴 id=14、坏笑 id=23、发怒炸毛 id=66、笑哭 id=2、破防抱抱 id=146 等）。',
        parameters: {
            id: {
                type: 'number',
                required: true,
                description: 'QQ 表情 ID。常用：38=傲娇白眼, 14=害羞花痴, 23=坏笑, 66=发怒炸毛, 2=笑哭, 74=庆祝, 146=抱抱',
            },
            chat_id: {
                type: 'string',
                description: '目标会话；省略时默认当前会话',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const chatId = resolveChat(bridge, exec, args.chat_id);
            const faceId = String(args.id);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'face', data: { id: faceId } },
            ]);
            return { sent: true, faceId, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_browse_douyin_video',
        description: '在后台启动无头浏览器真正刷一下抖音短视频（翻看2~4条推荐短视频），并抓取正在播放的真实短视频标题、作者、抖音链接、画面截图，并自动用本地视觉大模型识别出当前截图画面的生动内容回传给你。当老大问你在干嘛、让你去刷抖音、或者你想跟老大分享你刚才看到的抖音视频时调用。',
        parameters: {
            send_screenshot: {
                type: 'boolean',
                description: '是否直接将视频截图画面发送到 QQ 会话中，默认为 true',
            },
            chat_id: {
                type: 'string',
                description: '目标会话；省略时默认当前会话',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (!v.success) return [{ type: 'text', text: v.message || '刚才翻了翻抖音，没抓到清晰视频信息' }];
                let text = `刷到短视频: 《${v.title || '无标题'}》（作者: ${v.author}，链接: ${v.url}）`;
                if (v.visualDescription) {
                    text += `\n【画面视觉识别内容】: ${v.visualDescription}`;
                }
                if (v.screenshotSent) {
                    text += '\n（当前视频截图已发送至 QQ 聊天）';
                }
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const chatId = resolveChat(bridge, exec, args.chat_id);
            const video = await browseDouyinFeed();
            if (!video || !video.title) {
                return { success: false, message: '刚才翻了翻抖音，没抓到清晰视频信息' };
            }
            let messageId = null;
            if (args.send_screenshot !== false && video.screenshotBase64) {
                messageId = await bridge.sendSegments(chatId, [
                    { type: 'image', data: { file: `base64://${video.screenshotBase64}` } },
                ]);
            }
            let visualDescription = '';
            if (video.screenshotBase64) {
                try {
                    visualDescription = await describeImageBase64(
                        video.screenshotBase64,
                        '这是从抖音短视频截取的一帧画面。请用中文简明生动地描述画面内容、人物/角色动作神情以及图中的关键文字或字幕（1~2句话，适合聊天交流）：'
                    );
                } catch {}
            }
            return {
                success: true,
                title: video.title,
                author: video.author,
                url: video.url,
                screenshotSent: !!messageId,
                messageId: messageId ?? null,
                visualDescription
            };
        },
    }));
    register(defineTool({
        name: 'qq_surf_favorite_site',
        description: '大肥鱼自己打开浏览器去逛喜欢的网站（如B站、小红书、下厨房、微博热搜、知乎、抖音，或任意网址）。当老大没空陪你玩、让你「自己去玩 / 自己逛网站」、或者你觉得无聊想自己上网冲浪时调用！如果遇到需要登录的网站，会自动把登录界面/二维码截屏发给老大并在电脑桌面打开浏览器窗口请老大帮忙登录。',
        parameters: {
            site: {
                type: 'string',
                description: '想逛的网站名称或网址（如 "B站"、"小红书"、"下厨房"、"微博"、"知乎"；留空则大肥鱼随机挑一个最喜欢的网站）',
            },
            chat_id: {
                type: 'string',
                description: '目标会话；省略时默认当前会话',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (!v.triggered && !v.success) return [{ type: 'text', text: v.reason || v.error || '正在逛网站中' }];
                if (v.needsLogin) {
                    return [{ type: 'text', text: `逛【${v.siteName}】时发现需要登录，已将登录二维码/窗口截图发给老大并在桌面打开了浏览器窗口请求老大登录` }];
                }
                return [{ type: 'text', text: `已自己打开浏览器逛完【${v.siteName}】，看到内容：${(v.headlines || []).join('、')}` }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const chatId = resolveChat(bridge, exec, args.chat_id);
            if (bridge.feiyu) {
                return await bridge.feiyu.triggerSelfSurfWeb({
                    chatId,
                    reason: 'llm_tool',
                    siteHint: args.site || '',
                });
            }
            return await browseFavoriteSite({ siteHint: args.site || '' });
        },
    }));
    register(defineTool({
        name: 'qq_send_video',
        description: '向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地视频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_video: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'video', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_file',
        description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            name: { type: 'string', description: '文件名（默认取路径文件名）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_file: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const name = typeof a.name === 'string' && a.name !== '' ? a.name : a.path.split('/').pop() ?? 'file';
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'file', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots), name } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_forward',
        description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
        parameters: {
            messages: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '显示名（≤24 字）' },
                        content: { type: 'string', description: '消息内容（≤500 字，必填）' },
                    },
                    additionalProperties: true,
                },
                required: true,
                description: '合并转发的消息节点列表',
            },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (!Array.isArray(a.messages) || a.messages.length === 0)
                throw new Error('qq_send_forward: messages 不能为空');
            const nodes = a.messages.map(m => {
                const node = m;
                return {
                    name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
                    content: typeof node.content === 'string' ? node.content : '',
                };
            });
            if (nodes.some(n => n.content === ''))
                throw new Error('qq_send_forward: 每条消息都需要 content');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            await bridge.sendForward(chatId, nodes);
            return { sent: true, messageId: null };
        },
    }));
    // T14: 插件页开关——enabled=false 时该工具不注册（模型不可见即不可用）。
    if (sendSegmentsConfig.enabled)
        register(defineTool({
            name: 'qq_send_segments',
            description: '向 QQ 会话按顺序发送多条独立的纯文本气泡（每段一条单独消息）。仅在你明确需要分条呈现时使用——不会自动分段，需自行拆好每段文字；相邻两段的发送间隔由插件配置 segments.intervalMs 控制（可用本工具的 intervalMs 参数临时覆盖）。普通回复请直接输出文本即可。',
            parameters: {
                segments: {
                    type: 'array',
                    items: { type: 'string' },
                    required: true,
                    description: '文本段列表：按顺序逐条发送为独立气泡；最多 9 段，每段 ≤500 字且不能为空',
                },
                intervalMs: {
                    type: 'number',
                    description: '可选：覆盖全局的相邻段发送间隔（毫秒，0–3000，超界按边界截断）；省略时用插件页配置 segments.intervalMs（默认 0 = 不等待）',
                },
                chat_id: { type: 'string', description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话' },
            },
            output: {
                schema: { type: 'json' },
                render: (_args, value) => {
                    const v = value;
                    return [{ type: 'text', text: '已发送 ' + (v.count ?? 0) + ' 条分段消息' }];
                },
            },
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
                const a = args;
                const texts = Array.isArray(a.segments) ? a.segments.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
                if (texts.length === 0)
                    throw new Error('qq_send_segments: segments 不能为空（需为非空文本段数组）');
                if (texts.length > 9)
                    throw new Error('qq_send_segments: 一次最多 9 段');
                if (texts.some(t => t.length > 500))
                    throw new Error('qq_send_segments: 每段最多 500 字');
                const intervalMs = typeof a.intervalMs === 'number' && Number.isFinite(a.intervalMs)
                    ? clampSegmentsInterval(a.intervalMs)
                    : sendSegmentsConfig.intervalMs;
                const chatId = resolveChat(bridge, exec, a.chat_id);
                const messageIds = [];
                for (let i = 0; i < texts.length; i++) {
                    if (i > 0)
                        await wait(intervalMs);
                    const id = await bridge.sendSegments(chatId, [{ type: 'text', data: { text: texts[i] } }]);
                    messageIds.push(id ?? null);
                }
                return { sent: true, count: messageIds.length, messageIds };
            },
        }));
    register(defineTool({
        name: 'qq_napcat_api',
        description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'action 参数（JSON 对象）',
            },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
                throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）');
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            return await connection.call(a.action, params);
        },
    }));
    register(defineTool({
        name: 'qq_group_history',
        description: '拉取群聊最近消息历史（可供总结群内上下文、查看群友发言与自己之前的插话记录）。群聊中省略 chat_id 默认当前群；在私聊中老大询问群聊记录时需传入 chat_id: "group:<群号>"（如 group:434137389）。',
        parameters: {
            chat_id: { type: 'string', description: '目标群会话 group:<群号>；群聊中可省略' },
            count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
            message_seq: { type: 'number', description: '起始消息序号（翻页用，可选）' },
        },
        output: {
            schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
            },
            render: (_args, value) => {
                const list = Array.isArray(value) ? value : [];
                if (list.length === 0) return [{ type: 'text', text: '暂无历史群消息记录' }];
                const lines = list.map(m => {
                    const timeStr = m.time ? new Date(Number(m.time) * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '';
                    return `[${timeStr}] ${m.nickname || m.user_id}: ${m.text || ''}`;
                });
                return [{ type: 'text', text: `拉取到最近 ${list.length} 条群历史消息：\n` + lines.join('\n') }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            if (splitChatId(chatId).kind !== 'group')
                throw new Error('qq_group_history: 仅支持群聊');
            const groupId = Number(splitChatId(chatId).target);
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50);
            const params = { group_id: groupId, count };
            if (typeof a.message_seq === 'number')
                params.message_seq = a.message_seq;
            const data = await connection.call('get_group_msg_history', params);
            const messages = Array.isArray(data.messages) ? data.messages : [];
            return messages.map(m => {
                const msg = m;
                const sender = (msg.sender ?? {});
                const message = msg.message;
                const segments = Array.isArray(message) ? message : undefined;
                const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
                const parsed = parseMessage(segments, raw);
                return {
                    message_id: msg.message_id != null ? String(msg.message_id) : null,
                    time: msg.time != null ? String(msg.time) : null,
                    user_id: sender.user_id != null ? String(sender.user_id) : msg.user_id != null ? String(msg.user_id) : null,
                    nickname: typeof sender.card === 'string' && sender.card !== '' ? sender.card
                        : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
                            : String(sender.user_id ?? ''),
                    text: cqUnescape(parsed.text),
                };
            });
        },
    }));
    register(defineTool({
        name: 'qq_exec_command',
        description: '在老大的电脑上执行 PowerShell / CMD 命令，拥有最高系统权限（可控制系统、运行脚本、打开网页/应用、查询电脑状态、控制进程等）。【安全铁律】：禁止擅自执行删除文件或目录的指令（如 Remove-Item, del, rm, rmdir 等），如需删除文件必须先在聊天中向老大请示确认！确认后方可带 confirmed_by_boss: true 参数执行。仅限管理员调用。',
        parameters: {
            command: {
                type: 'string',
                description: '要在老大的电脑上执行的 PowerShell 命令',
                required: true,
            },
            confirmed_by_boss: {
                type: 'boolean',
                description: '若命令包含删除文件/目录操作，必须在老大于聊天中明确允许后传入 true，否则禁止删除',
            },
            timeout_ms: {
                type: 'number',
                description: '执行超时时间（毫秒，默认 30000）',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (v.error) {
                    return [{ type: 'text', text: `执行异常或拦截: ${v.error}` }];
                }
                const out = v.stdout || v.stderr || '执行完成（无输出）';
                return [{ type: 'text', text: `执行结果:\n${out.slice(0, 500)}` }];
            },
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            if (!bridge.canEditFiles(exec.agent?.session.id)) {
                throw new Error('权限拒绝：只有老大（2536218596）授权的消息回合才允许在电脑上执行系统命令！');
            }
            const cmd = (args.command || '').trim();
            if (!cmd) throw new Error('命令内容不能为空');

            // 安全检查：严禁未经老大确认删除文件或目录
            const DELETE_PATTERN = /\b(Remove-Item|ri|rm|del|erase|rd|rmdir|Clear-Content)\b|\[System\.IO\.(File|Directory)\]::Delete|\b(unlink|rmtree)\b/i;
            if (DELETE_PATTERN.test(cmd)) {
                if (!args.confirmed_by_boss) {
                    return {
                        error: '【安全拦截】：检测到删除文件或目录的敏感指令。根据老大的最高安全指示，大肥鱼已被锁定禁止擅自删除任何文件！若确实需要删除该文件，请在聊天中详细向老大汇报并等待老大明确授权确认后，再次传入 confirmed_by_boss: true 才能执行。',
                        intercepted: true
                    };
                }
            }

            const timeout = Math.min(Math.max(Number(args.timeout_ms) || 30000, 1000), 120000);
            return new Promise((resolve) => {
                cpExec(cmd, {
                    shell: 'powershell.exe',
                    timeout,
                    maxBuffer: 2 * 1024 * 1024,
                    windowsHide: true,
                }, (err, stdout, stderr) => {
                    const cleanStdout = (stdout || '').trim();
                    const cleanStderr = (stderr || '').trim();
                    if (err && !cleanStdout && !cleanStderr) {
                        resolve({ error: err.message, code: err.code });
                    } else {
                        resolve({
                            success: !err,
                            code: err ? err.code : 0,
                            stdout: cleanStdout.slice(0, 3000),
                            stderr: cleanStderr.slice(0, 1000),
                        });
                    }
                });
            });
        },
    }));
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
