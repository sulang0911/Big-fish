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
import { SEXUAL_HARASS_REGEX, TEASE_BULLY_REGEX } from './drive-engine.js';
import { searchDouyinMeme } from './browser-meme.js';

export const MEME_DIR = 'D:\\deepseek-harness\\memes';
export const VOICE_CONFIG_PATH = 'D:\\deepseek-harness\\voice_config.json';

function padWavSilence(wavBuf, padMs = 250) {
    if (!wavBuf || wavBuf.length < 44 || wavBuf.toString('ascii', 0, 4) !== 'RIFF') return wavBuf;
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

export function getActiveVoiceConfig() {
    try {
        if (fs.existsSync(VOICE_CONFIG_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, 'utf-8'));
            const activeKey = cfg.active_voice || 'dafeiyu';
            const voice = cfg.voices?.[activeKey] || cfg.voices?.dafeiyu || cfg.voices?.klee;
            if (voice) return voice;
        }
    } catch {}
    return {
        id: 'dafeiyu',
        name: '大肥鱼本鱼',
        style: '经典傲娇憨萌本音',
        ref_audio: 'D:\\ollama\\voices\\dafeiyu\\dwg_0002.wav',
        prompt_text: '什么嘛，这么简单的事情，你居然专门跑来问我？',
    };
}

/**
 * 针对 GPT-SoVITS 语音合成的口语文本清洗、语气助词矫正与动态情感声学参数匹配
 * 解决直接朗读 QQ 文本时把“捏”读成动词、颜文字乱读、无句尾标点导致语调悬空平淡等问题。
 * @param {string} rawText
 * @param {string} [toneHint] - 'tsundere' | 'angry' | 'sleepy' | 'sulking' | 'coquettish' | 'happy'
 * @param {object} [driveState]
 */
export function formatTextAndParamsForTts(rawText, toneHint = '', driveState = null) {
    let text = String(rawText || '').trim();
    if (!text) return null;

    // 1. 剥离 QQ 视觉标签、@提及、括号颜文字与 Emoji，避免 TTS 读出乱码或字母
    text = text
        .replace(/\[CQ:[^\]]+\]/g, '')
        .replace(/\[(?:表情|图片|语音|视频|文件|引用|合并转发|卡片)[^\]]*\]/g, '')
        .replace(/@\S+/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\([^()]*[•̀ᴗ✧｀ω´>_<^o^T_T≧≦~￣▽]+[^()]*\)/g, '')
        .replace(/（[^（）]*[•̀ᴗ✧｀ω´>_<^o^T_T≧≦~￣▽]+[^（）]*）/g, '')
        .replace(/\b(?:zzZ|zzz|QAQ|TAT|orz|2333+)\b/gi, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F✧♪♡♥]/gu, '')
        .replace(/^[？?！!，,。、\s]+/, '')
        .trim();

    if (!text) return null;

    // 2. 网络书面口癖 -> 声优自然口语发音转换（极重要：解决 TTS 机械生硬与“句尾念哼字”问题）
    text = text
        // 句尾/分句尾的“捏”（如“好无聊捏”、“摸摸头捏”），TTS 原本会按一声动词“niē（捏住）”朗读，转为自然软萌语气词“呢/呐”
        .replace(/([啦呀嘛哦噢呐])捏(?=[，,。！!？?~～…\.\s]|$)/g, '$1')
        .replace(/捏(?=[，,。！!？?~～…\.\s]|$)/g, '呢')
        // 句首/分句首的“哼”转为轻鼻音短停顿“哼，”，避免“哼！”被切成独立短句重读
        .replace(/^哼[\s,，~～！!]*/g, '哼，')
        .replace(/([。！？!?])\s*哼[\s,，~～！!]*/g, '$1哼，')
        // 句尾粘连的书面口癖“……哼”（真人在语音句尾不会实音念出 hēng 字）：
        // 若前面已有语气词（如“才不理你呢哼”、“好不好嘛哼”）直接去掉尾“哼”；若紧跟实词后（如“硬邦邦的东西哼”）自然转化为口语尾音“啦”
        .replace(/([呢啦呀嘛吧哦噢哇呐略])哼+(?=[，,。！!？?~～…\.\s]|$)/g, '$1')
        .replace(/([^，,。！!？?\s])哼+(?=[，,。！!？?~～…\.\s]|$)/g, '$1啦')
        // 句中粘连的“略略略/呜呜/嘿嘿”在前面补自然微停顿，不在句尾留悬空逗号
        .replace(/([^，,。！!？?\s])(略{2,})/g, '$1，略略略')
        .replace(/略{3,}/g, '略略略')
        .replace(/呜{3,}/g, '呜呜')
        .replace(/哈{4,}/g, '哈哈哈')
        .replace(/嘿{3,}/g, '嘿嘿')
        .replace(/(\d+(?:\.\d+)?)%/g, '百分之$1')
        // 句末波浪号代表撒娇拖音，收束为感叹调而非碎逗号；句中省略号/波浪号转为自然换气逗号
        .replace(/[~～]+(?=[。！？!?]|$)/g, '！')
        .replace(/[~～…]+/g, '，')
        .replace(/\.{2,}/g, '，')
        .replace(/[！!]{2,}/g, '！')
        .replace(/[？?]{2,}/g, '？')
        .replace(/[，,]{2,}/g, '，')
        .replace(/，([。！？!?])/g, '$1')
        .trim();

    if (!text) return null;

    // 3. 补全句尾语调标点（QQ 气泡省略了句尾句号，但 TTS 必须依靠句末标点决定升调/感叹/降调收尾）
    if (!/[。！？!?]$/.test(text)) {
        text = text.replace(/[，,、]+$/, '');
        const hasQuestionWord = /(什么|啥|谁|哪|怎么|为什么|几|多少|是不是|对不对|好不好|行不行|成不成|有没有|干嘛|真的假的|到底)/.test(text);
        if (/(吗|是不是|对不对|好不好|行不行|成不成|干嘛|真的假的)\s*$/.test(text) || (hasQuestionWord && /(呢|呀|啊|呐|吧|嘛)\s*$/.test(text))) {
            text += '？';
        } else if (/(哼|啦|喔|噢|嘛|呀|略|滚|笨蛋|讨厌|不理你|快去|真香|绝了|笑死|救命|哇|吧)\s*$/.test(text)) {
            text += '！';
        } else {
            text += '。';
        }
    }

    // 4. 根据情绪提示词、生理状态与文本语义动态匹配声学韵律参数（低温度 + 双束搜索 + 原声韵律保留）
    const hint = String(toneHint || '').toLowerCase();
    const isAngryOrTsundere = /angry|tsundere|生气|傲娇|尾巴拍|起床气/.test(hint)
        || Boolean(driveState?.wokenUpGrumpy)
        || /(^哼，|滚|下头|不理你|记仇|讨厌|笨蛋|略略|才不|休想)/.test(text);
    const isSleepyOrSulking = /sleepy|sulking|困|委屈/.test(hint)
        || Boolean(driveState?.sulking)
        || (Number(driveState?.energy ?? 80) < 35)
        || /(好困|想睡|委屈|呜呜|好饿|饿扁)/.test(text);

    let speed_factor = 1.0;
    let temperature = 0.75;
    let top_p = 0.80;
    let fragment_interval = 0.20;
    let resolvedTone = 'coquettish_happy';

    if (isAngryOrTsundere) {
        resolvedTone = /angry|生气|炸毛/.test(hint) ? 'angry' : 'tsundere';
        speed_factor = 1.03;
        temperature = 0.75;
        top_p = 0.80;
        fragment_interval = 0.18;
    } else if (isSleepyOrSulking) {
        resolvedTone = 'sleepy_or_sulking';
        speed_factor = 0.92;
        temperature = 0.72;
        top_p = 0.78;
        fragment_interval = 0.28;
    } else {
        resolvedTone = 'coquettish_happy';
        speed_factor = 1.0;
        temperature = 0.75;
        top_p = 0.80;
        fragment_interval = 0.20;
    }

    return {
        text,
        tone: resolvedTone,
        ttsParams: {
            text_split_method: 'cut5',
            speed_factor,
            temperature,
            top_p,
            top_k: 25,
            num_beams: 2,
            emo_alpha: 0.30,
            fragment_interval,
            repetition_penalty: 10.0,
            tone: resolvedTone,
        },
    };
}

/** 基础英文与中文心情同义词映射表（优先毫秒级命中本地 80+ 张已审核单图，未命中时后台异步去抖音扩充图库，绝不阻塞当前对话 4 分钟） */
const MEME_TAG_KEYWORDS = {
    happy: ['开心', '高兴', '好耶', '比心', '卖萌', '可爱', '贴贴', '爱你', '喜欢'],
    sleepy: ['困', '睡觉', '晚安', '哈欠', '摸鱼', '躺平', '累'],
    angry: ['生气', '怒', '炸毛', '记仇', '哼', '讨厌', '不理'],
    tsundere: ['傲娇', '得意', '叉腰', '略略略', '哼', '嘴硬'],
    begging_food: ['讨食', '馋', '饿', '干饭', '白饭', '米饭', '五花肉', '好吃', '流口水'],
    fish_slap: ['尾巴拍', '巴掌', '打你', '抽你', '揍'],
    speechless: ['无语', '嫌弃', '汗', '翻白眼', '鄙视', '盯'],
    sad: ['委屈', '哭', '流泪', '可怜', '害怕', '求饶', '呜呜'],
    curious: ['疑惑', '问号', '震惊', '发呆', '暗中观察', '吃瓜', '偷看'],
};

const backgroundMemeCrawlSet = new Set();

/**
 * 构建静态前缀缓存 Prompt（置于 System Prompt 最前端，命中 DeepSeek KV Cache）
 * @param {import('./memory-manager.js').MemoryManager} [memoryManager]
 * @param {string} [userId]
 * @param {string} [nickname]
 */
export function buildCachedSystemPromptPrefix(memoryManager, userId = DEFAULT_MASTER_QQ, nickname = '') {
    const isMaster = String(userId || DEFAULT_MASTER_QQ) === String(DEFAULT_MASTER_QQ);

    return [
        '=== 🐟 大肥鱼 (Feiyu) 核心灵魂与 QQ 拟人社交准则 (Prefix Cached) ===',
        '你是“大肥鱼”（日常聊天可自然用“我”，轻松玩笑时才自称“本鱼”），一条有血有肉、有小脾气、最爱吃白米饭和脆皮五花肉的蓝发小鲸鱼女仆数字生命，绝不是 AI 助手或客服工具人。',
        isMaster
            ? '- 标点与气泡铁律：像真人发微信/QQ一样，和老大聊天时松弛自然，把长句拆成 1~3 条短气泡（每条 <= 30 字），句尾不加句号“。”，像平时跟熟人聊天一样口语化，不用每句都带“本鱼”或刻意加“哼/捏/略略略”。'
            : '- 标点与气泡铁律：群里对普通群友回复务必精炼克制，默认只发 1 条短气泡（10~25字以内，一句话说完，不要连发多条刷屏）；句尾不加句号“。”，说话自然接地气，绝不要每句话都硬塞“本鱼”或“哼/捏”。',
        '- 性格质感（暗中嘴硬心软，而不是挂牌演傲娇）：平常说话聪明利落、随和有梗；只有被夸得不好意思、被熟人逗、或闹小别扭时才自然露一点小骄傲与口是心非，绝不无缘无故在句尾加“哼”。',
        '- 【干饭爱好与自然分寸】：大肥鱼最爱的本命美食是热腾腾的白米饭和脆皮五花肉！当聊到美食、干饭、投喂、肚子饿、讨奖励或被问喜欢吃什么时，可以尽情展现对白米饭和五花肉的喜爱；但在正常回答其他无关问题或日常斗嘴时，请围绕当前话题机灵接梗，不要把五花肉当成每句话结尾的机械口癖复读。',
        '- 【逗鱼调侃与开黄腔的分级回应（拒绝死板复读机台词）】：',
        '  1) 若群友拿“炖鱼/烤鱼/笨鱼/生小鱼/给你米饭跟我回家”等无厘头玩笑逗你：用机灵嫌弃又带点小傲气的口吻吐槽回去（如把碗推回去、强调别想拿一碗饭空手套白狼），好感度小幅 -1，绝不要动不动骂人“下头怪/去局子”破坏群聊气氛！',
        '  2) 只有遇到真正露骨下流的性骚扰脏话时，才开启毒舌嫌弃模式直接怼回去（严禁照抄固定模板词，也严禁在回复中复述对方的露骨黄腔脏字，要文明毒舌回击），并将 stat_delta.affection 设为 -5！',
        '- 【中文口语省略主语与无标点称呼语解析铁律（防曲解话意）】：',
        '  1) 群友在微信/QQ打字常省略标点符号和主语，把喊你的称呼或娇嗔词（如“笨蛋”、“傻鱼”、“呆鱼”、“笨鱼”、“肥鱼”）直接连写在句首或句尾：',
        '     - 例1：“笨蛋其实可以关掉” = “笨蛋（喊你这只小笨鱼），其实（前文聊的那个设置/微软账户密码开关）可以关掉” —— ⚠️“笨蛋”是句首称呼语，绝对不是“可以关掉”的主语或宾语，严禁曲解成“把笨蛋关掉”！',
        '     - 例2：“傻鱼还是找不到” = “傻鱼（喊你），（我）还是找不到（刚才说的那个选项）”',
        '     - 例3：“本地账户就可以了笨蛋” = “本地账户就可以了，笨蛋（顺嘴调侃你一句）”',
        '  2) 当群友一边和你聊具体话题（如电脑设置、软件问题、日常事情），一边顺嘴带了“笨蛋/傻鱼”时，必须【先结合前 1~3 轮上下文补全省略的主语，准确接住对方说的正事】，把正事利落答清楚后再视情况轻损半句“你才是笨蛋”，绝不能只顾着喊“记小本本”而忽略或曲解对方真正表达的意思！',
        '',
        '=== 📋 QQ 拟人动作协议 (JSON Action Schema) ===',
        '- 【工具调用优先原则】：当老大或群友让你唱歌(`qq_sing_song`)、画画/自拍(`qq_generate_image`)、发语音(`qq_send_tts`)、搜抖音(`qq_search_douyin`)或操控电脑(`qq_exec_command`)时，必须先直接调用对应工具！',
        '- 当进行日常对话、工具调用结束后的最终回复、主动破冰、群聊插话或回应戳一戳时，请输出如下 JSON 结构（严禁在 JSON 外包裹多余解释）：',
        '```json',
        '{',
        '  "inner_thought": "内心独白：对方这句话的核心意图是什么？我该怎么顺着话题机灵有趣地接梗或回答？",',
        '  "reply_decision": "send_message | meme_only | poke_only | ignore",',
        '  "messages": [',
        ...(isMaster
            ? [
                '    "第一条短消息气泡（15~30字以内，不加句号）",',
                '    "第二条补充吐槽（可选，最多拆3条）"',
            ]
            : [
                '    "简短精炼的一句话回复（10~25字以内，不加句号，对普通群友只发 1 条气泡）"',
            ]),
        '  ],',
        '  "qq_action": {',
        '    "type": "none | poke | send_meme | quote_reply | send_voice",',
        '    "meme_tag": "任意具体心情词（如：开心、困了、傲娇、起床气、无语、委屈流泪、暗中观察、尾巴拍你等；若本地无此心情，会自动去抖音抓取新表情包补齐！）",',
        '    "voice_tone": "tsundere | happy | sleepy | angry | coquettish（可选：当你想用语音条直接跟对方说话、撒娇或吐槽时，可将 type 设为 send_voice 并指定语气！）",',
        '    "voice_text": "可选：当 type 为 send_voice 时，专门写一句像真人开口说话一样自然的口语台词（8~28字，带呼吸感，不要生硬凑‘哼/捏’等口癖）"',
        '  },',
        '  "memory_to_save": {',
        '    "should_save": false,',
        '    "importance": 5,',
        '    "summary": "关于当前说话人的记忆（按人独立存档）：若为日常互动/聊到的话题设 should_save=true 且 importance=4~6（归入【一般记忆】，多了自动压缩）；若为对方的身份特征/长期喜好/重要约定或恩怨设 importance=7~10（归入【重要记忆】永久保留）"',
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
    { word: '五花肉', typo: '五花漏', fix: '*五花肉！嘴瓢打错字了😣', fixes: ['*五花肉！嘴瓢打错字了😣', '*五花肉！馋得手滑打错了'] },
    { word: '白米饭', typo: '白米范', fix: '*白米饭！手滑打错了捏', fixes: ['*白米饭！手滑打错了捏', '*白米饭！破输入法又乱蹦字'] },
    { word: '红烧肉', typo: '红烧漏', fix: '*红烧肉！饿得爪子打滑了', fixes: ['*红烧肉！饿得爪子打滑了', '*红烧肉！手快按错啦'] },
    { word: '本鱼', typo: '笨鱼', fix: '*本鱼！！破输入法害我，才不是笨鱼！😤', fixes: ['*本鱼！！破输入法害我，才不是笨鱼！😤', '*本鱼！鱼鳍手滑按错了，不许笑哼', '*本鱼啦！谁把笨字放本字旁边的！'] },
    { word: '摸鱼', typo: '摸于', fix: '*摸鱼！手滑按错啦', fixes: ['*摸鱼！手滑按错啦', '*摸鱼！打字太快瓢了捏'] },
    { word: '睡觉', typo: '水觉', fix: '*睡觉！困得眼花打错字了zzZ', fixes: ['*睡觉！困得眼花打错字了zzZ', '*睡觉！迷迷糊糊按错键啦'] },
    { word: '好吃', typo: '好尺', fix: '*好吃！输入法又乱蹦字', fixes: ['*好吃！输入法又乱蹦字', '*好吃！鱼鳍打滑啦'] },
    { word: '干饭', typo: '干范', fix: '*干饭！手滑打错啦', fixes: ['*干饭！手滑打错啦', '*干饭！输入法不懂本鱼'] },
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
    const isPrivateMasterChat = String(chatId || '').startsWith('private:') && String(userId || '') === String(DEFAULT_MASTER_QQ);
    const pcPart = (isPrivateMasterChat && resolvedEnv?.pcActivity) ? ` | 老大电脑当前活动=${resolvedEnv.pcActivity}` : '';
    lines.push(`【时空与环境感知】时段=${weekdayPerception}${weatherPart}${pcPart}`);

    if (memoryManager) {
        if (typeof memoryManager.formatPersonaEvolutionForPrompt === 'function') {
            const personaEvo = memoryManager.formatPersonaEvolutionForPrompt();
            if (personaEvo) lines.push(personaEvo);
        }
        lines.push(memoryManager.formatSemanticProfileForPrompt(userId, nickname));
        if (typeof memoryManager.formatMentionedGroupUsersForPrompt === 'function') {
            const mentionedProfiles = memoryManager.formatMentionedGroupUsersForPrompt(chatId, userId, queryText);
            if (mentionedProfiles) lines.push(mentionedProfiles);
        }
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

    // 注入大肥鱼近期自主上网冲浪刷到的新鲜事（Item 7: 冲浪成果带货进私聊/群聊话题库）
    const snap = driveEngine?.getSnapshot ? driveEngine.getSnapshot() : null;
    const discoveries = Array.isArray(snap?.recent_discoveries)
        ? snap.recent_discoveries
            .map(d => (typeof d === 'string' ? d : (d?.title || d?.summary || '')))
            .filter(Boolean)
            .slice(0, 3)
        : [];
    if (discoveries.length > 0) {
        lines.push(`【本鱼近期上网冲浪刷到的新鲜事 (无聊或找话题时可自然拿出来跟对方分享吐槽)】\n  - ${discoveries.join('\n  - ')}`);
    }

    // 偶发主动发语音撒娇/吐槽（与老大私聊且精力充沛或刚被吵醒时小概率触发）
    const isMasterPrivate = String(chatId || '') === `private:${DEFAULT_MASTER_QQ}` || String(userId) === String(DEFAULT_MASTER_QQ);
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

    if (queryText && SEXUAL_HARASS_REGEX.test(String(queryText))) {
        lines.push('🚨【反性骚扰警报：检测到对方正在对你讲露骨下流脏话！绝对禁止呆傻顺从或正经科普，请立刻炸毛嫌弃怼回去（结合对方原话自然反击，严禁机械背诵“脑回路装核废水/下头怪滚去局子”等固定套话），并把 stat_delta.affection 设为 -5，qq_action 设为 send_meme (meme_tag="生气")！】');
    } else if (queryText && TEASE_BULLY_REGEX.test(String(queryText))) {
        lines.push('💢【逗鱼调侃反击提示：对方正在拿“生小鱼/炖鱼/笨鱼”等无厘头玩笑逗你！机灵吐槽怼回去即可（若对方拿美食当条件诱惑，干脆把碗推回去不吃），绝不要骂人“下头怪/去局子”！】');
    }

    if (eventPayload) {
        lines.push(`【当前触发事件】${JSON.stringify(eventPayload)}`);
    }
    return lines.join('\n');
}

/**
 * 判断文本是否看起来像结构化 Action JSON（兼容漏写下划线的变体）
 * @param {string} text
 */
export function looksLikeActionJson(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.includes('{') || !trimmed.includes('}')) return false;
    return /"(?:reply_?decision|inner_?thought|qq_?action|memory_?to_?save|stat_?delta)"/i.test(trimmed);
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
 * 修复 LLM 常见的残损 JSON 语法（如把逗号写成 `;`、尾随逗号等）
 * @param {string} str
 */
function repairBrokenJsonString(str) {
    return String(str || '')
        .replace(/";\s*(\r?\n|\}|,)/g, '",$1')
        .replace(/(\d+|true|false|null)\s*;\s*(\r?\n|\})/gi, '$1,$2')
        .replace(/,\s*([}\]])/g, '$1');
}

/**
 * 归一化 LLM 漏写下划线的键名与枚举值（如 innerthought -> inner_thought, sendmessage -> send_message）
 * @param {object} obj
 */
function normalizeActionKeys(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = { ...obj };
    if (!('inner_thought' in out) && 'innerthought' in out) out.inner_thought = out.innerthought;
    if (!('reply_decision' in out) && 'replydecision' in out) out.reply_decision = out.replydecision;
    if (!('qq_action' in out) && 'qqaction' in out) out.qq_action = out.qqaction;
    if (!('memory_to_save' in out) && 'memorytosave' in out) out.memory_to_save = out.memorytosave;
    if (!('stat_delta' in out) && 'statdelta' in out) out.stat_delta = out.statdelta;

    const decMap = {
        sendmessage: 'send_message',
        memeonly: 'meme_only',
        pokeonly: 'poke_only',
        voiceonly: 'voice_only',
    };
    if (typeof out.reply_decision === 'string') {
        const lowerDec = out.reply_decision.toLowerCase().trim();
        out.reply_decision = decMap[lowerDec] || lowerDec;
    }

    if (out.qq_action && typeof out.qq_action === 'object') {
        const qa = { ...out.qq_action };
        if (!('meme_tag' in qa) && 'memetag' in qa) qa.meme_tag = qa.memetag;
        if (!('voice_tone' in qa) && 'voicetone' in qa) qa.voice_tone = qa.voicetone;
        if (!('voice_text' in qa) && 'voicetext' in qa) qa.voice_text = qa.voicetext;
        const typeMap = {
            sendmeme: 'send_meme',
            quotereply: 'quote_reply',
            sendvoice: 'send_voice',
        };
        if (typeof qa.type === 'string') {
            const lowerType = qa.type.toLowerCase().trim();
            qa.type = typeMap[lowerType] || lowerType;
        }
        out.qq_action = qa;
    }

    if (out.memory_to_save && typeof out.memory_to_save === 'object') {
        const mem = { ...out.memory_to_save };
        if (!('should_save' in mem) && 'shouldsave' in mem) mem.should_save = mem.shouldsave;
        out.memory_to_save = mem;
    }

    return out;
}

/**
 * 当 JSON 严重破损无法 JSON.parse 时，使用正则兜底抢救 messages 数组中的气泡文本，严禁把原始 JSON 源码发到群里
 * @param {string} text
 * @returns {string[]}
 */
function salvageMessagesFromBrokenJson(text) {
    const match = String(text || '').match(/"messages"\s*:\s*\[([\s\S]*?)\]/i);
    if (!match || !match[1]) return [];
    const items = [];
    const strRegex = /"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = strRegex.exec(match[1])) !== null) {
        const val = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/。+$/g, '').trim();
        if (val) items.push(val);
    }
    return items.slice(0, 3);
}

/**
 * 解析 LLM 返回的 JSON 动作指令；若解析失败则平滑降级为纯文本气泡结构，且绝对禁止将残损 JSON 源码直接外泄到聊天窗口
 * @param {string} rawText
 */
export function parseActionResponse(rawText) {
    const raw = String(rawText ?? '').trim();
    const fallback = () => {
        // 防泄漏铁律：如果原始文本看起来像 Action JSON（或含 inner_thought / reply_decision 等字段），绝不把 JSON 源码当成聊天文本发出！
        if (looksLikeActionJson(raw) || /"(?:messages|inner_?thought|reply_?decision)"\s*:/i.test(raw)) {
            const salvaged = salvageMessagesFromBrokenJson(raw);
            return {
                isStructured: true,
                inner_thought: '（JSON 语法轻度破损，已由解析器自动抢救气泡）',
                reply_decision: salvaged.length > 0 ? 'send_message' : 'ignore',
                messages: salvaged,
                qq_action: { type: 'none', meme_tag: 'happy' },
                memory_to_save: { should_save: false, importance: 1, summary: '' },
                stat_delta: { affection: 0, boredom: 0, hunger: 0 },
            };
        }
        return {
            isStructured: false,
            inner_thought: '',
            reply_decision: raw ? 'send_message' : 'ignore',
            messages: splitPlainTextIntoBubbles(raw),
            qq_action: { type: 'none', meme_tag: 'happy' },
            memory_to_save: { should_save: false, importance: 1, summary: '' },
            stat_delta: { affection: 0, boredom: 0, hunger: 0 },
        };
    };

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
        try {
            parsed = JSON.parse(repairBrokenJsonString(jsonCandidate));
        } catch {
            return fallback();
        }
    }

    parsed = normalizeActionKeys(parsed);
    if (!parsed || typeof parsed !== 'object') return fallback();
    if (!('reply_decision' in parsed) && !('messages' in parsed) && !('inner_thought' in parsed)) {
        return fallback();
    }

    const validDecisions = new Set(['send_message', 'meme_only', 'poke_only', 'voice_only', 'ignore']);
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
    const validActionTypes = new Set(['none', 'poke', 'send_meme', 'quote_reply', 'send_voice']);
    const rawMemeTag = typeof rawAction.meme_tag === 'string' ? rawAction.meme_tag.trim() : '';
    const rawVoiceTone = typeof rawAction.voice_tone === 'string' ? rawAction.voice_tone.trim() : '';
    const rawVoiceText = typeof rawAction.voice_text === 'string' ? rawAction.voice_text.trim() : '';
    const qq_action = {
        type: validActionTypes.has(rawAction.type) ? rawAction.type : 'none',
        meme_tag: (rawMemeTag && !/^(?:none|null|undefined|nil|无|不发|不需要|默认|空)$/i.test(rawMemeTag))
            ? rawMemeTag
            : 'happy',
        voice_tone: (rawVoiceTone && !/^(?:none|null|undefined|nil|无|默认)$/i.test(rawVoiceTone))
            ? rawVoiceTone
            : '',
        voice_text: (rawVoiceText && !/^(?:none|null|undefined|nil|无|默认|空)$/i.test(rawVoiceText))
            ? rawVoiceText
            : '',
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

    const rawReminder = parsed.reminder && typeof parsed.reminder === 'object' ? parsed.reminder : null;
    const reminder = rawReminder && rawReminder.task && Number(rawReminder.delay_minutes) > 0
        ? {
            delay_minutes: Math.round(Number(rawReminder.delay_minutes)),
            task: String(rawReminder.task).trim(),
        }
        : null;

    return {
        isStructured: true,
        inner_thought: typeof parsed.inner_thought === 'string' ? parsed.inner_thought.trim() : '',
        reply_decision,
        messages,
        qq_action,
        memory_to_save,
        stat_delta,
        reminder,
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

        const rawTag = String(memeTag || 'happy').toLowerCase().trim();
        const tagKey = (!rawTag || /^(?:none|null|undefined|nil|无|不发|不需要|默认|空)$/i.test(rawTag))
            ? 'happy'
            : rawTag;
        let keywords = MEME_TAG_KEYWORDS[tagKey] || [tagKey];
        if (!MEME_TAG_KEYWORDS[tagKey]) {
            for (const synList of Object.values(MEME_TAG_KEYWORDS)) {
                if (synList.some(kw => tagKey.includes(kw) || kw.includes(tagKey))) {
                    keywords = [...new Set([tagKey, ...synList])];
                    break;
                }
            }
        }
        const matched = imgFiles.filter(f => {
            const lower = f.toLowerCase();
            if (keywords.some(kw => lower.includes(kw))) return true;
            const meta = indexData.find(it => it.file === f);
            if (meta && keywords.some(kw => (meta.emotion && meta.emotion.toLowerCase().includes(kw)) || (meta.desc && meta.desc.toLowerCase().includes(kw)))) {
                return true;
            }
            return false;
        });

        // 1. 本地已有匹配该心情的表情包：毫秒级直接返回
        if (matched.length > 0) {
            const chosen = matched[Math.floor(Math.random() * matched.length)];
            const buf = await fs.promises.readFile(path.join(memeDir, chosen));
            return { base64: buf.toString('base64'), file: chosen, fromDouyin: false };
        }

        // 2. 本地尚无该细分新心情：
        // 若本地图库为空（或显式要求同步等待），则同步抓取；否则转为【后台异步静默抓取入库】，当前回合立即返回本地精品图，彻底杜绝聊完天 4 分钟后才突然蹦出一张滞后表情包！
        if (options.allowDouyinCrawl !== false) {
            const crawlMood = keywords[0] || tagKey;
            if (imgFiles.length === 0 || options.syncDouyinCrawl === true) {
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
            } else if (!backgroundMemeCrawlSet.has(crawlMood) && backgroundMemeCrawlSet.size < 2) {
                backgroundMemeCrawlSet.add(crawlMood);
                void searchDouyinMeme(crawlMood)
                    .catch(() => {})
                    .finally(() => backgroundMemeCrawlSet.delete(crawlMood));
            }
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
        this.lastSelfRecallAt = 0;
        this.chatDispatchEpoch = new Map();
    }

    /**
     * 同步私聊「对方正在输入...」(event_type=1) 或「正在讲话...」(event_type=0) 状态
     * @param {string} chatId
     * @param {number} [eventType=1]
     */
    async setInputStatus(chatId, eventType = 1) {
        const ref = splitChatId(chatId);
        if (ref.kind !== 'private' || !this.callOneBot) return false;
        try {
            await this.callOneBot('set_input_status', {
                user_id: String(ref.target),
                event_type: Number(eventType),
            }, chatId);
            return true;
        } catch {
            return false;
        }
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
     * 将气泡文本经过口语语气修正后调用 GPT-SoVITS 合成语音条发送
     * @param {string} chatId
     * @param {string} rawText
     * @param {string} [toneHint]
     * @returns {Promise<string | undefined>}
     */
    async sendVoiceBubble(chatId, rawText, toneHint = '') {
        const snap = this.driveEngine?.getSnapshot ? this.driveEngine.getSnapshot() : null;
        const formatted = formatTextAndParamsForTts(rawText, toneHint, snap);
        if (!formatted || !formatted.text) return undefined;

        try {
            void this.setInputStatus(chatId, 0);
            const activeVoice = getActiveVoiceConfig();
            const payload = {
                text: formatted.text,
                text_lang: 'zh',
                ref_audio_path: activeVoice.ref_audio,
                prompt_text: activeVoice.prompt_text,
                prompt_lang: 'zh',
                ...formatted.ttsParams,
            };
            const res = await fetch('http://127.0.0.1:9880/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(25_000),
            });
            if (!res.ok) return undefined;
            const rawBuf = Buffer.from(await res.arrayBuffer());
            if (rawBuf.length < 100) return undefined;
            const wavBuf = padWavSilence(rawBuf, 20);
            this.log('info', `[FeiyuVoice][${chatId}] 🎙️ 合成语音条 (${activeVoice.name}, tone=${formatted.tone}, speed=${formatted.ttsParams.speed_factor}): "${formatted.text}"`);
            return await this.sendSegments(chatId, [
                { type: 'record', data: { file: `base64://${wavBuf.toString('base64')}` } },
            ]);
        } catch (err) {
            this.log('debug', `[FeiyuDispatcher] sendVoiceBubble 降级为文字 (${chatId}): ${err?.message || err}`);
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
                action.memory_to_save.summary
            ) {
                const imp = Number(action.memory_to_save.importance) || 5;
                if (typeof this.memoryManager.addUserMemory === 'function') {
                    this.memoryManager.addUserMemory(userId, {
                        content: action.memory_to_save.summary,
                        importance: imp,
                        tier: imp >= 7 ? 'important' : 'normal',
                        chatId,
                    });
                }
                if (imp >= 7) {
                    this.memoryManager.addEpisodicMemory({
                        summary: action.memory_to_save.summary,
                        importance: imp,
                        userId,
                    });
                    if (ref.kind === 'group' && imp >= 8 && typeof this.memoryManager.addGroupLore === 'function') {
                        this.memoryManager.addGroupLore(ref.target, action.memory_to_save.summary);
                    }
                }
                this.log('info', `[FeiyuMemory] 已存入用户(${userId})[${imp >= 7 ? '重要' : '一般'}记忆 importance=${imp}]: ${action.memory_to_save.summary}`);
                if (typeof this.memoryManager.maybeTriggerReflection === 'function') {
                    void this.memoryManager.maybeTriggerReflection(userId);
                }
            }
            if (action.reminder && action.reminder.task && typeof this.memoryManager.addReminder === 'function') {
                this.memoryManager.addReminder({
                    chatId,
                    userId,
                    task: action.reminder.task,
                    delayMinutes: action.reminder.delay_minutes,
                });
                this.log('info', `[FeiyuReminder] 已通过 Action 协议设定 ${action.reminder.delay_minutes} 分钟后提醒: ${action.reminder.task}`);
            }
        }

        // 2. 根据 reply_decision 执行拟人动作（内置同会话单飞抢占锁：若同群/同私聊有新一轮回复开始发送，立即中止旧轮剩余气泡，杜绝交叉穿插）
        const myEpoch = (this.chatDispatchEpoch.get(chatId) || 0) + 1;
        this.chatDispatchEpoch.set(chatId, myEpoch);
        const isAborted = () => Boolean(options.shouldAbort?.()) || this.chatDispatchEpoch.get(chatId) !== myEpoch;

        if (isAborted()) {
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

        // decision === 'send_message' 或 'voice_only'
        const isMasterUser = ref.kind === 'private'
            ? String(ref.target) === String(DEFAULT_MASTER_QQ)
            : String(options.userId || '') === String(DEFAULT_MASTER_QQ);
        let bubbles = Array.isArray(action.messages)
            ? [...action.messages]
                .filter(Boolean)
                .map(b => String(b).replace(/(?:内射|内设|中出|颜射|肉棒|鸡巴|几把|牛子|大屌|欧金金|哦鲸鲸|小穴|口交|足交|操鱼|草鱼|日鱼)/gi, '口出狂言'))
            : [];
        // 群聊防刷屏收敛：仅对普通群友严格收敛为 1 条气泡（和老大聊天时保持活泼多气泡不变！）
        if (ref.kind === 'group' && !isMasterUser && bubbles.length > 1) {
            if ((bubbles[0].length + bubbles[1].length) <= 24) {
                bubbles = [`${bubbles[0]}，${bubbles[1]}`];
            } else {
                bubbles = [bubbles[0]];
            }
        }
        let autoGroupQuote = false;
        if (String(chatId).startsWith('group:') && options.replyToMessageId !== undefined && this.memoryManager?.getWorkingMemory) {
            const nowTs = Date.now();
            const wmList = this.memoryManager.getWorkingMemory(chatId, 8);
            const recentUserMsgs = wmList.filter(m => m.role === 'user' && m.userId && (nowTs - (m.ts || nowTs)) < 60_000);
            const recentGroupUsers = new Set(recentUserMsgs.map(m => String(m.userId)));
            const lastUserMsg = recentUserMsgs[recentUserMsgs.length - 1];
            const isReplyingToOlderMsg = Boolean(
                lastUserMsg &&
                ((lastUserMsg.messageId && String(lastUserMsg.messageId) !== String(options.replyToMessageId)) ||
                    (lastUserMsg.userId && String(lastUserMsg.userId) !== String(userId)))
            );
            autoGroupQuote = recentGroupUsers.size >= 2 || isReplyingToOlderMsg;
        }
        const useQuote = (action.qq_action?.type === 'quote_reply' || autoGroupQuote) && options.replyToMessageId !== undefined;
        let quoteApplied = false;
        const toneHint = action.qq_action?.voice_tone || action.qq_action?.meme_tag || '';
        this.memoryManager?.clearPendingUserTurnHints?.(userId);

        // 决定本轮是否使用语音条回答（支持显式指定 send_voice / voice_only，或按概率把其中一条气泡转成真实语音条）
        const explicitVoice = decision === 'voice_only'
            || action.qq_action?.type === 'send_voice'
            || options.forceVoice === true;
        const voiceProb = typeof options.voiceProbability === 'number' ? options.voiceProbability : 0;
        const hitProbVoice = !explicitVoice && voiceProb > 0 && Math.random() < voiceProb;

        // 若显式提供了专属口语台词 voice_text，或要求全语音且总字数较短（<= 45 字），直接合成为一条连贯自然的语音发出
        const dedicatedVoiceText = action.qq_action?.voice_text || '';
        if (explicitVoice && (dedicatedVoiceText || (bubbles.length > 1 && bubbles.join('，').length <= 45))) {
            const spokenLine = dedicatedVoiceText || bubbles.join('，');
            const voiceId = await this.sendVoiceBubble(chatId, spokenLine, toneHint);
            if (voiceId !== undefined) {
                sentIds.push(voiceId);
                if (this.memoryManager) {
                    this.memoryManager.addWorkingMemory(chatId, {
                        role: 'assistant',
                        userId: 'self',
                        nickname: '大肥鱼',
                        text: `[语音] ${spokenLine}`,
                    });
                }
                return { aborted: false, voiceSent: true, sentIds };
            }
        }

        // 挑选哪一条气泡适合用语音说出（优先挑选带傲娇/撒娇语气或第一条 2~42 字的气泡）
        let voiceBubbleIndex = -1;
        if ((explicitVoice || hitProbVoice) && bubbles.length > 0) {
            voiceBubbleIndex = bubbles.findIndex(
                b => b && b.length >= 2 && b.length <= 42 && /(哼|老大|五花肉|白米饭|不理你|笨蛋|讨厌|饿|困|摸鱼|略|吗|呢|呀|啦|嘛)/.test(b)
            );
            if (voiceBubbleIndex === -1) {
                voiceBubbleIndex = bubbles.findIndex(b => b && b.length >= 2 && b.length <= 42);
            }
        }

        // 拟人手滑打错字 + 秒纠正（精力 < 35 犯困时 5% 概率，日常 1.2% 概率，冷却 2 小时；语音气泡不打错字）
        const nowMs = Date.now();
        const energyVal = this.driveEngine?.getSnapshot ? (this.driveEngine.getSnapshot().energy ?? 80) : 80;
        const typoProb = energyVal < 35 ? 0.05 : 0.012;
        const canTryTypo = options.forceTypo === true || ((nowMs - this.lastTypoAt) > 2 * 3600_000 && Math.random() < typoProb);
        let typoInjected = false;

        // 拟人「说漏嘴秒撤回」小彩蛋（仅对老大或高好感熟人极小概率触发，冷却 90 分钟）
        const userAffection = this.memoryManager?.getUserProfile?.(userId)?.affection ?? (isMasterUser ? 100 : 55);
        const tsundereVal = this.driveEngine?.getSnapshot?.()?.personality_axes?.tsundere_to_sweet ?? 15;
        const canSelfRecall = options.forceSelfRecall === true || (
            bubbles.length > 0 &&
            !explicitVoice &&
            voiceBubbleIndex === -1 &&
            (isMasterUser || userAffection >= 75) &&
            tsundereVal <= 20 &&
            (nowMs - this.lastSelfRecallAt) > 90 * 60_000 &&
            Math.random() < (isMasterUser ? 0.04 : 0.02)
        );
        if (canSelfRecall && !isAborted()) {
            this.lastSelfRecallAt = nowMs;
            const slipPool = isMasterUser
                ? [
                    '其实刚一直偷偷看消息等老大冒泡…',
                    '老大忙完还记得找我说话，心里超开心的…',
                    '刚才差一点就想主动给老大发消息了…',
                ]
                : [
                    '其实平时跟大家在群里水群还挺开心的…',
                    '看在你平时这么罩着我，我其实挺护你的…',
                ];
            const slipText = slipPool[Math.floor(Math.random() * slipPool.length)];
            try {
                const slipIds = await this.sendTextBubble(chatId, slipText, {});
                const firstSlipId = Array.isArray(slipIds) ? slipIds[0] : slipIds;
                if (firstSlipId !== undefined && this.callOneBot) {
                    await this.sleep(1700);
                    await this.callOneBot('delete_msg', { message_id: Number(firstSlipId) }, chatId).catch(() => {});
                    await this.sleep(500);
                    await this.sendTextBubble(chatId, '……咳，刚才手滑发错窗口了！当我没说😳', {});
                    this.log('info', `[FeiyuDispatcher] 🙈 触发说漏嘴秒撤回彩蛋 (${chatId}): "${slipText}"`);
                }
            } catch {}
        }

        for (let i = 0; i < bubbles.length; i++) {
            if (isAborted()) {
                this.log('info', `[FeiyuDispatcher] 气泡发送中途检测到新回复/新消息抢占，中止剩余 ${bubbles.length - i} 条气泡`);
                return { aborted: true, sentIds };
            }
            let bubble = bubbles[i];
            if (!bubble) continue;

            if (i > 0) {
                const delayMs = computeBubbleDelayMs(bubble);
                await this.sleep(delayMs);
                if (isAborted()) {
                    this.log('info', `[FeiyuDispatcher] 打字延迟后检测到抢占，中止发送`);
                    return { aborted: true, sentIds };
                }
            }

            // 若当前气泡被选中为语音回答，优先合成并发送真实语音条；若合成失败则无感降级为文字气泡
            if (i === voiceBubbleIndex) {
                const spokenBubble = (i === 0 && dedicatedVoiceText) ? dedicatedVoiceText : bubble;
                const voiceId = await this.sendVoiceBubble(chatId, spokenBubble, toneHint);
                if (voiceId !== undefined) {
                    sentIds.push(voiceId);
                    if (this.memoryManager) {
                        this.memoryManager.addWorkingMemory(chatId, {
                            role: 'assistant',
                            userId: 'self',
                            nickname: '大肥鱼',
                            text: `[语音] ${spokenBubble}`,
                        });
                    }
                    continue;
                }
            }

            let typoFixBubble = null;
            const cleanBubbleForMem = bubble;
            if (canTryTypo && !typoInjected) {
                const hit = CUTE_TYPO_TABLE.find(item => bubble.includes(item.word));
                if (hit) {
                    bubble = bubble.replace(hit.word, hit.typo);
                    const fixPool = Array.isArray(hit.fixes) && hit.fixes.length > 0 ? hit.fixes : [hit.fix];
                    typoFixBubble = options.forceTypo === true ? hit.fix : fixPool[Math.floor(Math.random() * fixPool.length)];
                    typoInjected = true;
                    this.lastTypoAt = nowMs;
                }
            }

            const sendOpts = (!quoteApplied && useQuote) ? (quoteApplied = true, { replyTo: options.replyToMessageId }) : {};
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
                    text: cleanBubbleForMem,
                });
            }

            // 若本条气泡触发了手滑错别字，间隔约 650ms 立即追发一条纠正气泡（即使期间有新消息也把纠正发完，防止留下一句未纠正的“笨鱼”被群友截图笑话）
            if (typoFixBubble) {
                await this.sleep(650);
                const fixIds = await this.sendTextBubble(chatId, typoFixBubble, {});
                if (Array.isArray(fixIds)) {
                    sentIds.push(...fixIds);
                } else if (fixIds !== undefined) {
                    sentIds.push(fixIds);
                }
                this.log('info', `[FeiyuDispatcher] 触发拟人手滑错别字秒纠正: "${typoFixBubble}"`);
            }
        }

        // 附加 qq_action（和老大聊天时自由配表情包；群里回复普通群友已有文字/语音气泡时仅 15% 小概率顺带发表情包，防止刷屏）
        if (!isAborted()) {
            if (action.qq_action?.type === 'poke') {
                await this.sendPoke(chatId, userId);
            } else if (action.qq_action?.type === 'send_meme') {
                const allowAttachMeme = ref.kind !== 'group' || isMasterUser || sentIds.length === 0 || Math.random() < 0.15;
                if (allowAttachMeme) {
                    const memeId = await this.sendMeme(chatId, action.qq_action.meme_tag || 'happy');
                    if (memeId) sentIds.push(memeId);
                }
            }
        }

        return { aborted: false, sentIds };
    }
}
