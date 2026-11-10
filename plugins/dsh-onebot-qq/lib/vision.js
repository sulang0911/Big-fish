import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const LUNA_VISION_URL = 'https://sub2api.emberanvil.dev/v1/chat/completions';
const LUNA_VISION_MODEL = 'gpt-6-luna';

let cachedModel = null;
let lastCheckTime = 0;
let cachedLunaKey = null;

function getLunaApiKey() {
    if (process.env.LUNA_API_KEY) return process.env.LUNA_API_KEY.trim();
    if (cachedLunaKey) return cachedLunaKey;
    try {
        const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml');
        if (fs.existsSync(credPath)) {
            const content = fs.readFileSync(credPath, 'utf8');
            const m = content.match(/LUNA_API_KEY:\s*([^\r\n]+)/);
            if (m && m[1]) {
                cachedLunaKey = m[1].trim().replace(/^['"]|['"]$/g, '');
                return cachedLunaKey;
            }
        }
    } catch {}
    return null;
}

/**
 * 优先调用 gpt-6-luna 多模态视觉接口识别图片内容与图中文字
 */
async function describeWithLunaVision(imageBase64, prompt) {
    const apiKey = getLunaApiKey();
    if (!apiKey || !imageBase64) return null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 18000);
        const resp = await fetch(LUNA_VISION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: LUNA_VISION_MODEL,
                reasoning_effort: 'low',
                max_tokens: 1024,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
                        ],
                    },
                ],
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const json = await resp.json();
        const raw = (json?.choices?.[0]?.message?.content || '').trim();
        const cleaned = raw.replace(/\*\*/g, '').replace(/\n+/g, ' ').trim().slice(0, 360);
        if (cleaned.length > 3) {
            console.log(`[dsh-onebot] 视觉模型(${LUNA_VISION_MODEL})识别结果: ${cleaned}`);
            return cleaned;
        }
    } catch (e) {
        console.warn(`[dsh-onebot] Luna 视觉识别降级本地 Ollama: ${e?.message || e}`);
    }
    return null;
}

/**
 * 探测 Ollama 当前已下载的最佳视觉模型
 * 优先级：minicpm-v (中文视觉最佳) -> moondream (轻量快速) -> 其他 vision 模型
 */
async function getVisionModel() {
    const now = Date.now();
    if (cachedModel && now - lastCheckTime < 60000) {
        return cachedModel;
    }

    return new Promise((resolve) => {
        const req = http.request({
            hostname: OLLAMA_HOST,
            port: OLLAMA_PORT,
            path: '/api/tags',
            method: 'GET',
            timeout: 2000
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const models = (json.models || []).map(m => m.name || m.model || '');
                    
                    if (models.some(m => m.includes('minicpm-v'))) {
                        cachedModel = 'minicpm-v';
                    } else if (models.some(m => m.includes('moondream'))) {
                        cachedModel = 'moondream';
                    } else {
                        // 寻找任何包含 vision 或 vl 的模型
                        const anyVision = models.find(m => m.includes('vision') || m.includes('vl') || m.includes('llava'));
                        cachedModel = anyVision || null;
                    }
                    lastCheckTime = now;
                    resolve(cachedModel);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}

/**
 * 使用本地 Ollama 视觉模型识别 Base64 图片内容并返回中文画面描述
 * @param {string} imageBase64 图片 base64 字符串
 * @param {string} [customPrompt] 自定义提示词
 * @returns {Promise<string|null>} 画面文字描述或 null
 */
export async function describeImageBase64(imageBase64, customPrompt) {
    try {
        if (!imageBase64) return null;
        const defaultPrompt = '请用中文简明生动地描述画面核心内容、人物/二次元角色（发色、衣着、姿态动作、神情表情）以及图中的全部文字（1~2句话）：';
        const lunaDesc = await describeWithLunaVision(imageBase64, customPrompt || defaultPrompt);
        if (lunaDesc) return lunaDesc;

        const model = await getVisionModel();
        if (!model) return null;

        const prompt = customPrompt || (model.includes('minicpm-v')
            ? defaultPrompt
            : '请用中文简短描述这张图片的内容、角色、动作表情以及文字（1~2句话）：');

        const payload = JSON.stringify({
            model,
            prompt,
            images: [imageBase64],
            stream: false
        });

        return await new Promise((resolve) => {
            const req = http.request({
                hostname: OLLAMA_HOST,
                port: OLLAMA_PORT,
                path: '/api/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 35000
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        let text = (parsed.response || '').trim();
                        text = text.replace(/^["'“”]|["'“”]$/g, '').replace(/\n+/g, ' ').slice(0, 300);
                        if (text.length > 3) {
                            console.log(`[dsh-onebot] 视觉模型(${model})识别结果: ${text}`);
                            resolve(text);
                        } else {
                            resolve(null);
                        }
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
            req.write(payload);
            req.end();
        });
    } catch (e) {
        console.warn('[dsh-onebot] 视觉识别异常:', e.message);
        return null;
    }
}

/**
 * 使用本地 Ollama 视觉模型识别图片内容并返回中文画面描述
 * @param {string} imagePath 本地图片绝对路径
 * @param {string} [customPrompt] 自定义提示词
 * @returns {Promise<string|null>} 画面文字描述或 null
 */
export async function describeImage(imagePath, customPrompt) {
    try {
        if (!fs.existsSync(imagePath)) return null;
        const imageBuf = await fs.promises.readFile(imagePath);
        return await describeImageBase64(imageBuf.toString('base64'), customPrompt);
    } catch (e) {
        console.warn('[dsh-onebot] 视觉识别读取图片异常:', e.message);
        return null;
    }
}

/**
 * 情绪大类与视觉特征映射规则：用于校验视觉识别出的真实画面/配字是否与目标表情包名称一致
 */
const EMOTION_VISUAL_RULES = [
    {
        targetPattern: /(哭|泪|委屈|难过|伤心|悲伤|呜呜|可怜|叹气|忧郁)/i,
        mustMatch: /(哭|泪|悲伤|难过|委屈|抱膝|伤心|叹气|忧郁|困扰|低头|失落|苦|呜)/i,
        mustNotMatch: /(表情愉悦|表情是愉快的|笑逐颜开|欢呼|得意|自豪|满足|享受|开心地笑|签署|签字|握手|太阳镜)/i,
        canonicalTag: '委屈流泪',
    },
    {
        targetPattern: /(生气|愤怒|炸毛|暴躁|打人|尾巴拍|拍你|抽你|气鼓鼓|恼羞|嫌弃|鄙视|不爽|滚)/i,
        mustMatch: /(生气|愤怒|恼羞|不悦|严肃|握拳|双拳|炸毛|叉腰|双臂交叉|咬|瞪|凶|嫌弃|打|怒|哼|不服)/i,
        mustNotMatch: /(闭着眼睛微笑|表情愉悦|表情是愉快的|显得很满足和开心|温柔安慰|正在签署|拿着笔准备|握手)/i,
        canonicalTag: '生气炸毛',
    },
    {
        targetPattern: /(干饭|讨食|讨饭|饿|嘴馋|五花肉|白米饭|吃饭|好吃|香)/i,
        mustMatch: /(饭|吃|筷子|碗|茶壶|喝|嘴馋|饿|肉|咬|美食|食物|流口水|张嘴)/i,
        mustNotMatch: /(正在签署|拿着笔|坐在笔记本电脑前|握手|太阳镜)/i,
        canonicalTag: '嘴馋干饭',
    },
    {
        targetPattern: /(困|睡觉|摸鱼|趴桌|慵懒|累|躺平|晚安|打哈欠)/i,
        mustMatch: /(趴|困|慵懒|睡|摸鱼|累|休息|闭眼|枕|哈欠|无聊)/i,
        mustNotMatch: /(欢呼|跳舞|双臂张开|震惊|张大嘴|签署)/i,
        canonicalTag: '犯困摸鱼',
    },
    {
        targetPattern: /(震惊|惊讶|目瞪口呆|瞳孔地震|卧槽|疑惑|问号|发呆|懵)/i,
        mustMatch: /(震惊|惊讶|目瞪口呆|张大嘴|嘴巴微张|眼睛睁大|眉毛拱起|眉毛上扬|困惑|疑惑|呆|咬)/i,
        mustNotMatch: /(闭着眼睛微笑|闭眼满脸得意|正在签署|拿着笔)/i,
        canonicalTag: '震惊疑惑',
    },
    {
        targetPattern: /(傲娇|叉腰|得意|自豪|骄傲|哼|略略略|臭屁)/i,
        mustMatch: /(叉腰|抱胸|双臂交叉|得意|自豪|傲娇|俏皮|顽皮|自信|嘴角上扬|太阳镜)/i,
        mustNotMatch: /(哭泣|流泪|悲伤|绝望|抱膝)/i,
        canonicalTag: '傲娇得意',
    },
    {
        targetPattern: /(开心|高兴|欢呼|兴奋|快乐|比耶|卖萌|可爱|微笑|打招呼|wink)/i,
        mustMatch: /(开心|愉悦|愉快|微笑|笑容|欢呼|兴奋|比耶|剪刀手|可爱|眨眼|招手|跳舞)/i,
        mustNotMatch: /(哭泣|流泪|悲伤|绝望|抱膝|愤怒|不悦)/i,
        canonicalTag: '开心卖萌',
    },
    {
        targetPattern: /(认真|学习|写字|干活|工作|签字|思考|琢磨)/i,
        mustMatch: /(写字|签字|签署|笔|工作|学习|电脑|专注|思考|严肃)/i,
        mustNotMatch: /(哭泣|流泪|跳舞|欢呼)/i,
        canonicalTag: '认真思考',
    },
];

/**
 * 根据视觉描述文本推断其真实的表情包情绪标签与是否符合目标名称
 * @param {string} visualDesc 视觉模型返回的描述（含画面与图中文字）
 * @param {string} [targetEmotion] 期望获取的目标表情包名称/情绪词
 */
export function evaluateMemeDescription(visualDesc, targetEmotion = '') {
    const desc = String(visualDesc || '').trim();
    if (!desc || desc.length < 5) {
        return { pass: false, reason: '视觉模型未返回有效描述', trueTag: '', desc };
    }

    // 1. 严格剔除视频封面截图、聊天记录长截图、多宫格合集、插件教程海报、真人/其他角色杂图
    const cleanedDescForNoise = desc.replace(/不是(?:多宫格合集|教程海报|聊天记录截图|视频封面截图)(?:或(?:多宫格合集|教程海报|聊天记录截图|视频封面截图))*/g, '');
    const hasNoiseOrReject = /(视频封面|聊天记录|评论区截图|网页截图|列表截图|多宫格|九宫格|十六宫格|合集|教程海报|宣传海报|图文无关|下来播放|自动播放|播放数据|接管的账号|主人不要我了|装上这.*插件|给大肥鱼装上|6个器官|活人感拉满|从夯到拉|一觉醒来|哪张最像我|当务之急|小狗表情包|海绵宝宝|痞老板|不是蓝色|并非蓝色|没有动漫|橘发|橙发|红发|金发|真人|企鹅角色|黄色卡通角色|教程-3分钟|邀请观看者学习|与一个穿女仆装的角色握手)/i.test(cleanedDescForNoise);
    const hasFeiyu = /(蓝色头发|蓝发|蓝色长发|蓝色短发|大肥鱼少女|鲸鱼娘|蓝白.*女仆)/.test(desc);
    if (!hasFeiyu || hasNoiseOrReject) {
        return {
            pass: false,
            reason: `属于视频/聊天截图/海报合集或非纯正大肥鱼单张表情包 (${desc.slice(0, 50)})`,
            trueTag: '',
            desc,
        };
    }

    // 2. 提取该图片真实的视觉情绪标签 (`trueTag`)
    let inferredTags = [];
    for (const rule of EMOTION_VISUAL_RULES) {
        if (rule.mustMatch.test(desc) && !rule.mustNotMatch.test(desc)) {
            inferredTags.push(rule.canonicalTag);
        }
    }
    const trueTag = inferredTags[0] || '日常可爱';

    // 3. 若指定了目标名称 `targetEmotion`，严格核对“画面真实表情/图中文字”是否符合该名称！
    const cleanTarget = String(targetEmotion || '')
        .replace(/大肥鱼|肥鱼|飞鱼|表情包|图片/g, '')
        .trim();

    if (cleanTarget && !/^(通用|日常|随机|新心情)$/.test(cleanTarget)) {
        // 检查图中文字或描述是否直接包含目标词
        const directTextHit = desc.includes(cleanTarget);
        const matchedRule = EMOTION_VISUAL_RULES.find(r => r.targetPattern.test(cleanTarget));

        if (matchedRule) {
            const matchesVisual = matchedRule.mustMatch.test(desc);
            const hasConflict = matchedRule.mustNotMatch.test(desc);
            if ((!matchesVisual && !directTextHit) || hasConflict) {
                return {
                    pass: false,
                    reason: `画面内容/文字(真实为「${trueTag}」: ${desc.slice(0, 40)}...)与目标表情包名称「${cleanTarget}」不符`,
                    trueTag,
                    desc,
                };
            }
        } else if (!directTextHit) {
            // 若是特殊自定义词（如“暗中观察”、“警惕狐疑”），检查单字重合度或冲突词
            const chars = [...cleanTarget].filter(c => /[\u4e00-\u9fa5]/.test(c));
            const charHit = chars.some(c => desc.includes(c));
            if (!charHit) {
                return {
                    pass: false,
                    reason: `画面内容与文字(${desc.slice(0, 40)}...)未体现「${cleanTarget}」特征`,
                    trueTag,
                    desc,
                };
            }
        }
    }

    return {
        pass: true,
        reason: '符合大肥鱼单张表情包特征且内容与表情名称一致',
        trueTag,
        inferredTags,
        desc,
    };
}

/**
 * 对下载的候选表情包执行完整视觉模型识别与一致性核验（零暗示客观提问，防小模型顺着提示词产生幻觉）
 * @param {string} imagePath
 * @param {string} [targetEmotion]
 */
export async function inspectAndVerifyMeme(imagePath, targetEmotion = '') {
    const prompt = [
        '请客观描述这张图片（不要猜测）：',
        '1. 版式类型（是单张角色表情包、多宫格合集、聊天记录截图、视频封面截图、还是教程海报）？',
        '2. 图中人物的发色、衣着、真实面部表情和肢体动作是什么？',
        '3. 请原样逐字读出图中出现的所有中文文字（若无文字写“图中无文字”）。',
    ].join('');
    const visualDesc = await describeImage(imagePath, prompt);
    return evaluateMemeDescription(visualDesc, targetEmotion);
}
