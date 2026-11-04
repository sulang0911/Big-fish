/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import fs from 'node:fs';
import path from 'node:path';
import { exec as cpExec } from 'node:child_process';
import { fileToBase64, isUrl } from './media.js';
import { splitChatId } from './chat.js';
import { parseMessage, cqUnescape } from './cq.js';
import { searchDouyinMeme } from './browser-meme.js';
import { browseDouyinFeed, searchDouyin } from './browser-douyin.js';
import { describeImage, describeImageBase64 } from './vision.js';
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
    if (typeof chatIdArg === 'string' && chatIdArg !== '')
        return chatIdArg;
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
    register(defineTool({
        name: 'qq_send_tts',
        description: '使用本地部署的 GPT-SoVITS 语音大模型将指定文字合成大肥鱼的声音，并向 QQ 会话发送语音消息。当老大想听你的声音、要求发语音、或者你想用语音向老大撒娇/说话时调用此工具。',
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
            const payload = {
                text: a.text,
                text_lang: 'zh',
                ref_audio_path: 'D:\\ollama\\voices\\klee\\116425_audio.wav',
                prompt_text: '到了到了，就是这里，我们来把宝物挖出来吧。',
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
            return { sent: true, messageId: messageId ?? null };
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
            if (typeof a.keyword === 'string' && a.keyword.trim() !== '') {
                const kw = a.keyword.trim().toLowerCase();
                const matched = foundFiles.filter(f => path.basename(f).toLowerCase().includes(kw));
                if (matched.length > 0) {
                    targetFile = matched[Math.floor(Math.random() * matched.length)];
                }
            }
            // 如果本地关键词未直接命中，但本地已有大肥鱼表情包，优先从本地正版大肥鱼表情包库挑选，绝不乱发
            if (!targetFile && foundFiles.length > 0) {
                targetFile = foundFiles[Math.floor(Math.random() * foundFiles.length)];
            }
            // 只有本地完全没有任何表情包时，才自发前往抖音搜索爬取
            if (!targetFile) {
                try {
                    const crawlRes = await searchDouyinMeme(a.keyword || '大肥鱼 表情包');
                    if (crawlRes && crawlRes.base64) {
                        const messageId = await bridge.sendSegments(chatId, [
                            { type: 'image', data: { file: `base64://${crawlRes.base64}` } },
                        ]);
                        let visualDescription = '';
                        try {
                            visualDescription = await describeImageBase64(crawlRes.base64);
                        } catch {}
                        return { sent: true, meme: crawlRes.filename, fromDouyin: true, messageId: messageId ?? null, visualDescription };
                    }
                } catch (e) {
                    return { sent: false, error: '本地无表情包且从抖音抓取失败: ' + e.message };
                }
            }
            const buf = await fs.promises.readFile(targetFile);
            const b64 = buf.toString('base64');
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'image', data: { file: `base64://${b64}` } },
            ]);
            let visualDescription = '';
            try {
                visualDescription = await describeImageBase64(b64);
            } catch {}
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
                results: res.items.map(it => ({
                    title: it.title,
                    author: it.author,
                    url: it.url,
                    diggCount: it.diggCount
                })),
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
            if (args.send_sample !== false && res.savedFiles && res.savedFiles.length > 0) {
                const sampleName = res.savedFiles[0];
                const samplePath = path.join('D:\\deepseek-harness\\memes', sampleName);
                if (fs.existsSync(samplePath)) {
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
        description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
        parameters: {
            chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
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
                return [{ type: 'text', text: list.length + ' 条历史消息' }];
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
