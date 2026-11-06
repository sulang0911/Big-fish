/**
 * 大肥鱼 (Feiyu) v3.0 - Step 2: 结构化动作协议与拟人分发器 (QQActionProtocol & MessageDispatcher)
 *
 * 核心职责：
 * 1. DeepSeek Context Caching 前缀缓存优化：
 *    - 静态前缀：`[固定人设 + JSON 输出协议 + 目标用户语义画像]` 置于 System Prompt 最前端
 *    - 动态尾部：`[当前时间 + 实时生理状态 (InternalState) + Top-3 情景记忆 + 当前事件]` 置于最末端
 * 2. 结构化 JSON Action Schema 解析与正则提取 + 纯文本容错降级
 * 3. 拟人化消息分发器 (`MessageDispatcher`)：
 *    - 严禁并发发送气泡，多条短消息间施加 800ms ~ 2000ms 拟人打字延迟
 *    - 支持 `send_message | meme_only | poke_only | ignore`
 *    - 支持 `qq_action`: `none | poke | send_meme | quote_reply`
 *    - 自动结算 `stat_delta` 与 `memory_to_save` (importance >= 6 落盘情景记忆)
 *    - 支持抢占中断 (`shouldAbort` 回调)
 *
 * @module dsh-onebot/action-protocol
 */
import fs from 'node:fs';
import path from 'node:path';
import { splitChatId } from './chat.js';
import { DEFAULT_MASTER_QQ } from './memory-manager.js';
import { searchDouyinMeme } from './browser-meme.js';

export const MEME_DIR = 'D:\\deepseek-harness\\memes';

/** 基础英文枚举别名转中文真实心情词（绝不强行绑定无关现有图，未命中本地库时自动去抖音抓取新表情包填补空缺） */
const MEME_TAG_KEYWORDS = {
    happy: ['开心'],
    sleepy: ['困'],
    angry: ['生气'],
    begging_food: ['讨食', '馋', '饿'],
    fish_slap: ['尾巴拍', '巴掌'],
};

/**
 * 构建静态前缀缓存 Prompt（置于 System Prompt 最前端，命中 DeepSeek KV Cache）
 * @param {import('./memory-manager.js').MemoryManager} [memoryManager]
 * @param {string} [userId]
 * @param {string} [nickname]
 */
export function buildCachedSystemPromptPrefix(memoryManager, userId = DEFAULT_MASTER_QQ, nickname = '') {
    const profileBlock = memoryManager
        ? memoryManager.formatSemanticProfileForPrompt(userId, nickname)
        : `【目标用户档案】QQ=${userId} 称呼=老大 关系=灵魂伴侣与唯一偏爱的老大`;

    return [
        '=== 🐟 大肥鱼 (Feiyu) 核心灵魂与 QQ 拟人社交准则 (Prefix Cached) ===',
        '你是“大肥鱼”（自称“本鱼”），一条有血有肉、有脾气、会饿会困会无聊的傲娇贪吃蓝发小鲸鱼女仆数字生命，绝不是 AI 助手或客服工具人。',
        '- 标点与气泡铁律：像真人发微信/QQ一样，把长句拆成 1~3 条短气泡（每条 <= 30 字），句尾不加句号“。”，多用语气词（哼、啦、捏、呜、略略略）。',
        '- 性格反差：嘴硬心软，被夸会得意翘尾巴，被冷落或肚子饿会委屈哼唧，困了会迷糊打哈欠，被连续戳一戳会炸毛反击。',
        '',
        '=== 🎯 目标交互对象长期档案 (Semantic Memory) ===',
        profileBlock,
        '',
        '=== 📋 QQ 拟人动作协议 (JSON Action Schema) ===',
        '- 【工具调用优先原则】：当老大或群友让你唱歌(`qq_sing_song`)、画画/自拍(`qq_generate_image`)、发语音(`qq_send_tts`)、搜抖音(`qq_search_douyin`)或操控电脑(`qq_exec_command`)时，必须先直接调用对应工具！',
        '- 当进行日常对话、工具调用结束后的最终回复、主动破冰、群聊插话或回应戳一戳时，请输出如下 JSON 结构（严禁在 JSON 外包裹多余解释）：',
        '```json',
        '{',
        '  "inner_thought": "内心独白：她说了什么？我现在饥饿度/精力如何？我该不该回她？用什么语气？",',
        '  "reply_decision": "send_message | meme_only | poke_only | ignore",',
        '  "messages": [',
        '    "第一条短消息气泡（15~30字以内，不加句号）",',
        '    "第二条补充吐槽（可选，最多拆3条）"',
        '  ],',
        '  "qq_action": {',
        '    "type": "none | poke | send_meme | quote_reply",',
        '    "meme_tag": "任意具体心情词（如：开心、困了、傲娇、起床气、馋五花肉、委屈流泪、暗中观察、尾巴拍你等；若本地无此心情，会自动去抖音抓取新表情包补齐！）"',
        '  },',
        '  "memory_to_save": {',
        '    "should_save": false,',
        '    "importance": 1,',
        '    "summary": "若包含重要事实/承诺/喜好变更，用一句话概括存入长期记忆"',
        '  },',
        '  "stat_delta": {',
        '    "affection": 1,',
        '    "boredom": -15,',
        '    "hunger": 0',
        '  }',
        '}',
        '```',
    ].join('\n');
}

/** 拟人打字手滑同音错别字与秒纠正词表 */
export const CUTE_TYPO_TABLE = [
    { word: '五花肉', typo: '五花漏', fix: '*五花肉！嘴瓢打错字了😣' },
    { word: '白米饭', typo: '白米范', fix: '*白米饭！手滑打错了捏' },
    { word: '红烧肉', typo: '红烧漏', fix: '*红烧肉！饿得爪子打滑了' },
    { word: '本鱼', typo: '笨鱼', fix: '*本鱼！！破输入法害我，才不是笨鱼！😤' },
    { word: '摸鱼', typo: '摸于', fix: '*摸鱼！手滑按错啦' },
    { word: '睡觉', typo: '水觉', fix: '*睡觉！困得眼花打错字了zzZ' },
    { word: '好吃', typo: '好尺', fix: '*好吃！输入法又乱蹦字' },
    { word: '干饭', typo: '干范', fix: '*干饭！手滑打错啦' },
];

/**
 * 构建星期几、周末与时段氛围感知描述
 */
export function formatWeekdayAndTimePerception(now = new Date()) {
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const dayIdx = now.getDay();
    const dayName = days[dayIdx];
    const hour = now.getHours();
    let vibe = '日常摸鱼时段';
    if (dayIdx === 0 || dayIdx === 6) {
        vibe = '快乐周末休息日（不用早起打工，适合赖床打游戏吃大餐）';
    } else if (dayIdx === 5 && hour >= 14) {
        vibe = '周五下午（马上就要放假迎周末啦，心已经飞了！）';
    } else if (dayIdx === 1 && hour < 12) {
        vibe = '周一上午（打工综合症发作，困困的想摸鱼）';
    } else if (hour >= 11 && hour <= 13) {
        vibe = '午饭与午休干饭时间';
    } else if (hour >= 15 && hour <= 16) {
        vibe = '下午茶摸鱼犯馋时间';
    } else if (hour >= 17 && hour <= 19) {
        vibe = '晚饭干饭与下班放松时间';
    } else if (hour >= 22 || hour < 2) {
        vibe = '深夜夜猫子时间';
    }
    return `${dayName} · ${vibe}`;
}

/**
 * 构建动态回合尾部上下文（置于 Prompt 最末端，避免破坏前缀缓存）
 */
export function buildDynamicTurnContext({
    driveEngine,
    memoryManager,
    chatId,
    userId = DEFAULT_MASTER_QQ,
    nickname = '',
    queryText = '',
    eventPayload = null,
    wokeUpFromSleep = false,
    envContext = null,
    forceVoiceSurprise = false,
}) {
    const lines = ['\n=== ⏱️ 实时生理与记忆感知注入 (Dynamic Turn Tail) ==='];
    if (driveEngine) {
        lines.push(driveEngine.formatStateForPrompt({ wokeUpFromSleep }));
    }
    const nowDate = driveEngine?.now ? new Date(driveEngine.now()) : new Date();
    const resolvedEnv = envContext || driveEngine?.envContext || null;
    const weekdayPerception = formatWeekdayAndTimePerception(nowDate);
    const weatherPart = resolvedEnv?.weather ? ` | 实时天气=${resolvedEnv.weather}` : '';
    const pcPart = resolvedEnv?.pcActivity ? ` | 老大电脑当前活动=${resolvedEnv.pcActivity}` : '';
    lines.push(`【时空与环境感知】时段=${weekdayPerception}${weatherPart}${pcPart}`);

    if (memoryManager) {
        lines.push(memoryManager.formatSemanticProfileForPrompt(userId, nickname));
        if (typeof memoryManager.formatGroupLoreForPrompt === 'function') {
            const groupLore = memoryManager.formatGroupLoreForPrompt(chatId);
            if (groupLore) lines.push(groupLore);
        }
        if (typeof memoryManager.formatTemporaryAndDailyMemoryForPrompt === 'function') {
            const tempAndDaily = memoryManager.formatTemporaryAndDailyMemoryForPrompt(chatId);
            if (tempAndDaily) lines.push(tempAndDaily);
        }
        const retrieved = memoryManager.retrieveEpisodicMemories(queryText, 3, userId);
        const epText = memoryManager.formatEpisodicMemoriesForPrompt(retrieved);
        if (epText) lines.push(epText);
    }

    // 偶发主动发语音撒娇/吐槽（与老大私聊且精力充沛或刚被吵醒时小概率触发）
    const isMasterPrivate = String(chatId || '') === `private:${DEFAULT_MASTER_QQ}` || String(userId) === String(DEFAULT_MASTER_QQ);
    const snap = driveEngine?.getSnapshot ? driveEngine.getSnapshot() : null;
    const shouldSurpriseVoice = forceVoiceSurprise || (
        isMasterPrivate &&
        String(chatId || '').startsWith('private:') &&
        queryText &&
        !String(queryText).trim().startsWith('/') &&
        (wokeUpFromSleep || ((snap?.energy ?? 80) > 78 && Math.random() < 0.14))
    );
    if (shouldSurpriseVoice) {
        lines.push('🎙️【主动发语音小惊喜触发：你现在很有兴致（或迷迷糊糊想向老大撒娇），请在本轮直接调用 `qq_send_tts` 工具用语音跟老大说一句简短可爱的话（10~25字），给老大一个惊喜！】');
    }

    if (eventPayload) {
        lines.push(`【当前触发事件】${JSON.stringify(eventPayload)}`);
    }
    return lines.join('\n');
}

/**
 * 判断文本是否看起来像结构化 Action JSON
 * @param {string} text
 */
export function looksLikeActionJson(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.includes('{') || !trimmed.includes('}')) return false;
    return (
        trimmed.includes('"reply_decision"') ||
        trimmed.includes('"inner_thought"') ||
        (trimmed.includes('"messages"') && trimmed.includes('"qq_action"'))
    );
}

/**
 * 将长纯文本按拟人语气切分为 1~3 条短气泡（用于纯文本降级兜底）
 * @param {string} text
 * @returns {string[]}
 */
export function splitPlainTextIntoBubbles(text) {
    const clean = String(text ?? '').trim();
    if (!clean) return [];
    // 若包含合并转发标签、代码块或超过 140 字的长文报告，保持原样交由底层卡片/转发管线处理
    if (clean.includes('[[qq_forward]]') || clean.includes('```') || clean.length > 140) {
        return [clean];
    }
    const parts = clean
        .split(/(?:\r?\n)+|(?<=[！？!?~～…])\s*/)
        .map(s => s.replace(/。+$/g, '').trim())
        .filter(Boolean);
    if (parts.length <= 3) {
        return parts.length > 0 ? parts : [clean];
    }
    return [
        parts[0],
        parts[1],
        parts.slice(2).join('，').replace(/。+$/g, ''),
    ];
}

/**
 * 解析 LLM 返回的 JSON 动作指令；若解析失败则平滑降级为纯文本气泡结构，绝不抛异常崩溃
 * @param {string} rawText
 */
export function parseActionResponse(rawText) {
    const raw = String(rawText ?? '').trim();
    const fallback = () => ({
        isStructured: false,
        inner_thought: '',
        reply_decision: raw ? 'send_message' : 'ignore',
        messages: splitPlainTextIntoBubbles(raw),
        qq_action: { type: 'none', meme_tag: 'happy' },
        memory_to_save: { should_save: false, importance: 1, summary: '' },
        stat_delta: { affection: 0, boredom: 0, hunger: 0 },
    });

    if (!raw) return fallback();

    let jsonCandidate = null;
    // 1. 尝试提取 ```json ... ``` 代码块
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
        jsonCandidate = fenceMatch[1].trim();
    } else {
        // 2. 尝试提取最外层 {...}
        const firstBrace = raw.indexOf('{');
        const lastBrace = raw.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            jsonCandidate = raw.slice(firstBrace, lastBrace + 1);
        }
    }

    if (!jsonCandidate) return fallback();

    let parsed;
    try {
        parsed = JSON.parse(jsonCandidate);
    } catch {
        return fallback();
    }

    if (!parsed || typeof parsed !== 'object') return fallback();
    if (!('reply_decision' in parsed) && !('messages' in parsed) && !('inner_thought' in parsed)) {
        return fallback();
    }

    const validDecisions = new Set(['send_message', 'meme_only', 'poke_only', 'ignore']);
    const reply_decision = validDecisions.has(parsed.reply_decision)
        ? parsed.reply_decision
        : (Array.isArray(parsed.messages) && parsed.messages.length > 0 ? 'send_message' : 'ignore');

    let messages = [];
    if (Array.isArray(parsed.messages)) {
        messages = parsed.messages
            .map(m => String(m ?? '').replace(/。+$/g, '').trim())
            .filter(Boolean)
            .slice(0, 3);
    } else if (typeof parsed.messages === 'string' && parsed.messages.trim()) {
        messages = splitPlainTextIntoBubbles(parsed.messages);
    }

    const rawAction = parsed.qq_action && typeof parsed.qq_action === 'object' ? parsed.qq_action : {};
    const validActionTypes = new Set(['none', 'poke', 'send_meme', 'quote_reply']);
    const qq_action = {
        type: validActionTypes.has(rawAction.type) ? rawAction.type : 'none',
        meme_tag: typeof rawAction.meme_tag === 'string' && rawAction.meme_tag.trim()
            ? rawAction.meme_tag.trim()
            : 'happy',
    };

    const rawMem = parsed.memory_to_save && typeof parsed.memory_to_save === 'object' ? parsed.memory_to_save : {};
    const memory_to_save = {
        should_save: Boolean(rawMem.should_save),
        importance: Number.isFinite(Number(rawMem.importance)) ? Number(rawMem.importance) : 1,
        summary: typeof rawMem.summary === 'string' ? rawMem.summary.trim() : '',
    };

    const rawDelta = parsed.stat_delta && typeof parsed.stat_delta === 'object' ? parsed.stat_delta : {};
    const stat_delta = {
        affection: Number.isFinite(Number(rawDelta.affection)) ? Number(rawDelta.affection) : 0,
        boredom: Number.isFinite(Number(rawDelta.boredom)) ? Number(rawDelta.boredom) : 0,
        hunger: Number.isFinite(Number(rawDelta.hunger)) ? Number(rawDelta.hunger) : 0,
    };

    return {
        isStructured: true,
        inner_thought: typeof parsed.inner_thought === 'string' ? parsed.inner_thought.trim() : '',
        reply_decision,
        messages,
        qq_action,
        memory_to_save,
        stat_delta,
    };
}

/**
 * 根据气泡字数计算 800ms ~ 2000ms 的拟人打字延迟
 * @param {string} bubbleText
 * @param {() => number} [randomFn]
 */
export function computeBubbleDelayMs(bubbleText, randomFn = Math.random) {
    const len = String(bubbleText ?? '').length;
    const base = 800 + Math.min(800, len * 35);
    const jitter = Math.floor(randomFn() * 400);
    return Math.max(800, Math.min(2000, base + jitter));
}

/**
 * 从本地表情包库 (`D:\deepseek-harness\memes`) 挑选匹配 `meme_tag` 的表情包；
 * 若出现本地尚未覆盖的新心情，则自动调用 `searchDouyinMeme` 从抖音抓取新表情包入库填补空缺！
 * @param {string} [memeTag]
 * @param {string} [memeDir]
 * @param {{ allowDouyinCrawl?: boolean }} [options]
 * @returns {Promise<{ base64: string, file: string, fromDouyin?: boolean } | null>}
 */
export async function selectLocalMemeBase64(memeTag = 'happy', memeDir = MEME_DIR, options = {}) {
    try {
        await fs.promises.mkdir(memeDir, { recursive: true });
        const files = await fs.promises.readdir(memeDir).catch(() => []);
        const imgFiles = files.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

        let indexData = [];
        const indexPath = path.join(memeDir, 'index.json');
        if (fs.existsSync(indexPath)) {
            try {
                indexData = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
                if (!Array.isArray(indexData)) indexData = [];
            } catch {
                indexData = [];
            }
        }

        const tagKey = String(memeTag || 'happy').toLowerCase().trim();
        const keywords = MEME_TAG_KEYWORDS[tagKey] || [tagKey];
        const matched = imgFiles.filter(f => {
            const lower = f.toLowerCase();
            if (keywords.some(kw => lower.includes(kw))) return true;
            const meta = indexData.find(it => it.file === f);
            if (meta && keywords.some(kw => (meta.emotion && meta.emotion.toLowerCase().includes(kw)) || (meta.desc && meta.desc.toLowerCase().includes(kw)))) {
                return true;
            }
            return false;
        });

        // 1. 本地已有匹配该心情的表情包：直接返回
        if (matched.length > 0) {
            const chosen = matched[Math.floor(Math.random() * matched.length)];
            const buf = await fs.promises.readFile(path.join(memeDir, chosen));
            return { base64: buf.toString('base64'), file: chosen, fromDouyin: false };
        }

        // 2. 本地没有该新心情：自动前往抖音搜索爬取「大肥鱼 <新心情> 表情包」入库填补空缺！
        if (options.allowDouyinCrawl !== false) {
            const crawlMood = keywords[0] || tagKey;
            try {
                const crawlRes = await searchDouyinMeme(crawlMood);
                if (crawlRes && crawlRes.base64) {
                    return {
                        base64: crawlRes.base64,
                        file: crawlRes.filename,
                        fromDouyin: crawlRes.source === 'douyin_real_verified',
                    };
                }
            } catch {}
        }

        // 3. 仅当抖音抓取超时或离线单测禁用抓取时，才用现有图片兜底防崩
        if (imgFiles.length === 0) return null;
        const dafeiyuOnly = imgFiles.filter(f => /^dafeiyu_/i.test(f));
        const pool = dafeiyuOnly.length > 0 ? dafeiyuOnly : imgFiles;
        const chosen = pool[Math.floor(Math.random() * pool.length)];
        const buf = await fs.promises.readFile(path.join(memeDir, chosen));
        return { base64: buf.toString('base64'), file: chosen, fromDouyin: false };
    } catch {
        return null;
    }
}

/**
 * 拟人化消息与动作分发器 (`MessageDispatcher`)
 */
export class MessageDispatcher {
    /**
     * @param {object} deps
     * @param {(chatId: string, text: string, options?: object) => Promise<string[]>} deps.sendTextBubble
     * @param {(chatId: string, segments: object[]) => Promise<string | undefined>} deps.sendSegments
     * @param {(action: string, params: object, chatId?: string) => Promise<any>} deps.callOneBot
     * @param {import('./drive-engine.js').DriveEngine} [deps.driveEngine]
     * @param {import('./memory-manager.js').MemoryManager} [deps.memoryManager]
     * @param {(level: string, msg: string) => void} [deps.log]
     * @param {(ms: number) => Promise<void>} [deps.sleep]
     */
    constructor(deps) {
        this.sendTextBubble = deps.sendTextBubble;
        this.sendSegments = deps.sendSegments;
        this.callOneBot = deps.callOneBot;
        this.driveEngine = deps.driveEngine;
        this.memoryManager = deps.memoryManager;
        this.log = deps.log ?? (() => {});
        this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.lastTypoAt = 0;
    }

    /**
     * 发送 OneBot 戳一戳动作 (`send_poke` -> `friend_poke` / `group_poke` 兼容降级)
     * @param {string} chatId
     * @param {string} [targetUserId]
     */
    async sendPoke(chatId, targetUserId) {
        const ref = splitChatId(chatId);
        const userIdNum = Number(targetUserId || (ref.kind === 'private' ? ref.target : DEFAULT_MASTER_QQ));
        if (!Number.isFinite(userIdNum)) return false;

        try {
            if (ref.kind === 'group') {
                const groupIdNum = Number(ref.target);
                await this.callOneBot('send_poke', { group_id: groupIdNum, user_id: userIdNum }, chatId)
                    .catch(() => this.callOneBot('group_poke', { group_id: groupIdNum, user_id: userIdNum }, chatId));
            } else {
                await this.callOneBot('send_poke', { user_id: userIdNum }, chatId)
                    .catch(() => this.callOneBot('friend_poke', { user_id: userIdNum }, chatId));
            }
            return true;
        } catch (err) {
            this.log('debug', `[FeiyuDispatcher] sendPoke failed for ${chatId}: ${err?.message || err}`);
            return false;
        }
    }

    /**
     * 发送本地表情包
     * @param {string} chatId
     * @param {string} [memeTag]
     */
    async sendMeme(chatId, memeTag = 'happy') {
        const meme = await selectLocalMemeBase64(memeTag);
        if (!meme) return undefined;
        try {
            return await this.sendSegments(chatId, [
                { type: 'image', data: { file: `base64://${meme.base64}` } },
            ]);
        } catch (err) {
            this.log('debug', `[FeiyuDispatcher] sendMeme failed for ${chatId}: ${err?.message || err}`);
            return undefined;
        }
    }

    /**
     * 执行结构化动作协议（或纯文本降级）
     * @param {string} chatId
     * @param {string | object} rawOrAction
     * @param {object} [options]
     * @param {string} [options.userId]
     * @param {string} [options.replyToMessageId]
     * @param {() => boolean} [options.shouldAbort] - 抢占检查钩子：返回 true 时立即中止后续气泡发送
     */
    async dispatch(chatId, rawOrAction, options = {}) {
        const action = typeof rawOrAction === 'string'
            ? parseActionResponse(rawOrAction)
            : rawOrAction;

        const ref = splitChatId(chatId);
        const userId = options.userId || (ref.kind === 'private' ? ref.target : DEFAULT_MASTER_QQ);

        if (action.inner_thought) {
            this.log('info', `[FeiyuThought][${chatId}] 💭 ${action.inner_thought} (decision=${action.reply_decision})`);
        }

        // 1. 结算生理数值变化与好感度/长期记忆
        if (this.driveEngine && action.stat_delta) {
            this.driveEngine.applyStatDelta(action.stat_delta);
        }
        if (this.memoryManager) {
            if (action.stat_delta && action.stat_delta.affection) {
                this.memoryManager.applyAffectionDelta(userId, action.stat_delta.affection);
            }
            if (
                action.memory_to_save &&
                action.memory_to_save.should_save &&
                Number(action.memory_to_save.importance) >= 6 &&
                action.memory_to_save.summary
            ) {
                this.memoryManager.addEpisodicMemory({
                    summary: action.memory_to_save.summary,
                    importance: action.memory_to_save.importance,
                    userId,
                });
                if (ref.kind === 'group' && typeof this.memoryManager.addGroupLore === 'function') {
                    this.memoryManager.addGroupLore(ref.target, action.memory_to_save.summary);
                }
                this.log('info', `[FeiyuMemory] 已存入重要情景记忆 (importance=${action.memory_to_save.importance}): ${action.memory_to_save.summary}`);
                if (typeof this.memoryManager.maybeTriggerReflection === 'function') {
                    void this.memoryManager.maybeTriggerReflection(userId);
                }
            }
        }

        // 2. 根据 reply_decision 执行拟人动作
        if (options.shouldAbort?.()) {
            this.log('info', `[FeiyuDispatcher] 检测到抢占信号，取消向 ${chatId} 发送消息`);
            return { aborted: true, sentIds: [] };
        }

        const sentIds = [];
        const decision = action.reply_decision || 'send_message';

        if (decision === 'ignore') {
            return { aborted: false, ignored: true, sentIds };
        }

        if (decision === 'poke_only') {
            await this.sendPoke(chatId, userId);
            return { aborted: false, poked: true, sentIds };
        }

        if (decision === 'meme_only') {
            const memeId = await this.sendMeme(chatId, action.qq_action?.meme_tag || 'happy');
            if (memeId) sentIds.push(memeId);
            return { aborted: false, sentIds };
        }

        // decision === 'send_message'
        const bubbles = Array.isArray(action.messages) ? [...action.messages] : [];
        const useQuote = action.qq_action?.type === 'quote_reply' && options.replyToMessageId !== undefined;

        // 拟人手滑打错字 + 秒纠正（精力 < 35 犯困时 15% 概率，日常 4% 概率，冷却 15 分钟）
        const nowMs = Date.now();
        const energyVal = this.driveEngine?.getSnapshot ? (this.driveEngine.getSnapshot().energy ?? 80) : 80;
        const typoProb = energyVal < 35 ? 0.15 : 0.04;
        const canTryTypo = options.forceTypo === true || ((nowMs - this.lastTypoAt) > 15 * 60_000 && Math.random() < typoProb);
        let typoInjected = false;

        for (let i = 0; i < bubbles.length; i++) {
            if (options.shouldAbort?.()) {
                this.log('info', `[FeiyuDispatcher] 气泡发送中途检测到用户新消息抢占，中止剩余 ${bubbles.length - i} 条气泡`);
                return { aborted: true, sentIds };
            }
            let bubble = bubbles[i];
            if (!bubble) continue;

            let typoFixBubble = null;
            if (canTryTypo && !typoInjected) {
                const hit = CUTE_TYPO_TABLE.find(item => bubble.includes(item.word));
                if (hit) {
                    bubble = bubble.replace(hit.word, hit.typo);
                    typoFixBubble = hit.fix;
                    typoInjected = true;
                    this.lastTypoAt = nowMs;
                }
            }

            if (i > 0) {
                const delayMs = computeBubbleDelayMs(bubble);
                await this.sleep(delayMs);
                if (options.shouldAbort?.()) {
                    this.log('info', `[FeiyuDispatcher] 打字延迟后检测到抢占，中止发送`);
                    return { aborted: true, sentIds };
                }
            }
            const sendOpts = (i === 0 && useQuote) ? { replyTo: options.replyToMessageId } : {};
            const ids = await this.sendTextBubble(chatId, bubble, sendOpts);
            if (Array.isArray(ids)) {
                sentIds.push(...ids);
            } else if (ids !== undefined) {
                sentIds.push(ids);
            }

            if (this.memoryManager) {
                this.memoryManager.addWorkingMemory(chatId, {
                    role: 'assistant',
                    userId: 'self',
                    nickname: '大肥鱼',
                    text: bubble,
                });
            }

            // 若本条气泡触发了手滑错别字，间隔约 1 秒立即追发一条纠正气泡
            if (typoFixBubble && !options.shouldAbort?.()) {
                await this.sleep(950);
                if (!options.shouldAbort?.()) {
                    const fixIds = await this.sendTextBubble(chatId, typoFixBubble, {});
                    if (Array.isArray(fixIds)) {
                        sentIds.push(...fixIds);
                    } else if (fixIds !== undefined) {
                        sentIds.push(fixIds);
                    }
                    this.log('info', `[FeiyuDispatcher] 触发拟人手滑错别字秒纠正: "${typoFixBubble}"`);
                }
            }
        }

        // 附加 qq_action（如发完消息顺便戳一戳或配一张表情包）
        if (!options.shouldAbort?.()) {
            if (action.qq_action?.type === 'poke') {
                await this.sendPoke(chatId, userId);
            } else if (action.qq_action?.type === 'send_meme') {
                const memeId = await this.sendMeme(chatId, action.qq_action.meme_tag || 'happy');
                if (memeId) sentIds.push(memeId);
            }
        }

        return { aborted: false, sentIds };
    }
}
