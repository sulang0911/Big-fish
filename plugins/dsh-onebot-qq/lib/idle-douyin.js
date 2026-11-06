import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readFileSync, existsSync, promises as fs } from 'node:fs';

function getDeepSeekApiKey() {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    const credPath = join(homedir(), '.dsh', '.credentials.yaml');
    if (existsSync(credPath)) {
        try {
            const content = readFileSync(credPath, 'utf8');
            const match = content.match(/DEEPSEEK_API_KEY:\s*([^\r\n]+)/);
            if (match) return match[1].trim();
        } catch {}
    }
    return '';
}

/**
 * 从本地质检表情包库中匹配大肥鱼表情包（纯本地，秒回，无需启动浏览器）
 */
export async function getLocalMemeBase64(keyword = '') {
    const memesDir = 'D:\\deepseek-harness\\memes';
    const otherDir = 'D:\\deepseek-harness\\memes\\other_memes';

    const mainFiles = (await fs.readdir(memesDir).catch(() => []))
        .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
        .map(f => join(memesDir, f));
    const otherFiles = (await fs.readdir(otherDir).catch(() => []))
        .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
        .map(f => join(otherDir, f));
    const allFiles = [...mainFiles, ...otherFiles];
    if (allFiles.length === 0) return null;

    const kw = (keyword || '').toLowerCase().trim();
    const synonyms = {
        '发呆': ['呆萌', '思考', '趴桌'],
        '无聊': ['趴桌', '摸鱼', '慵懒'],
        '暗中观察': ['呆萌', '思考', '打招呼'],
        '吃瓜': ['喝茶', '呆萌', '微笑'],
        '傲娇': ['叉腰', '哼', '自豪'],
        '干饭': ['白米饭', '满足', '得意'],
        '震惊': ['惊讶', '目瞪口呆'],
        '哭': ['悲伤', '难过', '流泪']
    };
    const searchTerms = [kw, ...(synonyms[kw] || [])].filter(Boolean);

    for (const term of searchTerms) {
        const matches = allFiles.filter(f => basename(f).toLowerCase().includes(term));
        if (matches.length > 0) {
            const pick = matches[Math.floor(Math.random() * matches.length)];
            const buf = await fs.readFile(pick);
            return buf.toString('base64');
        }
    }

    // 默认回退：优先从正版大肥鱼系列表情包中挑选
    const dafeiyuFiles = mainFiles.filter(f => basename(f).startsWith('dafeiyu_'));
    const pool = dafeiyuFiles.length > 0 ? dafeiyuFiles : allFiles;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const buf = await fs.readFile(pick);
    return buf.toString('base64');
}

/**
 * 群聊冷场主动冒泡调度器
 * 当群内持续冷场（默认 2 小时）无人发言时，由大肥鱼在活跃时段（09:00~23:00）主动冒泡，发一条沙雕搞怪文案与表情包活跃气氛。
 * 严禁发抖音视频与链接。
 */
export class IdleDouyinScheduler {
    constructor(bridge, options = {}) {
        this.bridge = bridge;
        this.enabled = options.enabled ?? true;
        this.idleHours = options.idleHours ?? 2.0;       // 冷场 2.0 小时
        this.startHour = options.startHour ?? 9;        // 早上 9 点后才发
        this.endHour = options.endHour ?? 23;          // 晚上 23 点后不发
        // 目标群聊列表（默认六胃帝皇玩 group:927066977）
        const targets = options.targetChats || (options.targetChat ? [options.targetChat] : ['group:927066977']);
        this.targetChats = Array.isArray(targets) ? targets : [targets];
        this.lastActivityMap = new Map();
        this.startTime = Date.now();
        this.timer = null;
        this.isProcessing = false;
    }

    notifyUserActivity(chatId) {
        const now = Date.now();
        if (chatId) {
            this.lastActivityMap.set(chatId, now);
        }
    }

    start() {
        if (!this.enabled) return;
        this.stop();
        // 每 2 分钟轮询一次各群聊冷场状态
        this.timer = setInterval(async () => {
            try {
                await this.checkAllChats();
            } catch (err) {
                console.error('[dsh-onebot] 群聊冷场巡检异常:', err.message);
            }
        }, 120_000);

        console.log(`[dsh-onebot] 群聊冷场冒泡调度器已启动（监听群聊: ${this.targetChats.join(', ')}，冷场阈值: ${this.idleHours} 小时，活跃时段: ${this.startHour}:00~${this.endHour}:00）`);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async checkAllChats() {
        if (this.isProcessing) return;
        const currentHour = new Date().getHours();
        if (currentHour < this.startHour || currentHour >= this.endHour) {
            return;
        }

        const now = Date.now();
        const thresholdMs = this.idleHours * 3600 * 1000;

        for (const chatId of this.targetChats) {
            const lastTime = this.lastActivityMap.get(chatId) || this.startTime;
            const idleMs = now - lastTime;
            if (idleMs >= thresholdMs) {
                console.log(`[dsh-onebot] 检测到 ${chatId} 已冷场 ${(idleMs / 3600000).toFixed(1)} 小时（>= ${this.idleHours}h），准备主动冒泡整活！`);
                this.isProcessing = true;
                try {
                    await this.triggerOnce(chatId);
                } finally {
                    // 无论成功与否，重置该聊天的计时器，避免持续刷屏
                    this.lastActivityMap.set(chatId, Date.now());
                    this.isProcessing = false;
                }
            }
        }
    }

    async generateModelThought(chatId) {
        const apiKey = getDeepSeekApiKey();
        if (!apiKey) {
            console.warn('[dsh-onebot] 未找到 DEEPSEEK_API_KEY，无法让模型自主生成搞怪文案');
            return null;
        }

        try {
            const res = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        {
                            role: 'system',
                            content: `你是群聊里的「肥鱼本鱼」（大肥鱼），一个傲娇可爱、爱吃白米饭、喜欢摸鱼整活的Q版小蓝鲸团宠。\n现在群聊里已经安静冷场超过 2 个小时了，群友们都在潜水摸鱼。你主动在群里冒个泡，打破安静，发一条简短搞怪的文案活跃气氛。\n【核心要求】\n1. 绝对不要发抖音短视频或视频链接！绝不发抖音！\n2. 语言简短随性（1~2句话），像真人发群聊一样自然搞怪、接地气，绝不要长篇大论或机器人套话（严禁“大家好”、“系统通知”、“欢迎发言”等机械格式）。\n3. 文案风格：沙雕搞怪、反向催水群、发呆无聊、求白米饭加餐、傲娇吐槽、或者无厘头冷幽默（例如催干饭、问是不是断网了、自称尾巴要长蘑菇了等）。\n4. 严禁使用括号动作描写（如（摇尾巴）、（探头）），真人 QQ 聊天绝不打括号描述自己！\n5. 可在末尾带上 [表情:搜索词]（例如 [表情:暗中观察]、[表情:摸鱼]、[表情:吃瓜]、[表情:傲娇]、[表情:发呆]），系统会自动配上对应的沙雕大肥鱼表情包发到群里。直接输出你要发送的内容即可。`
                        },
                        {
                            role: 'user',
                            content: `【群聊冷场活跃】群聊已经冷场安静了 ${this.idleHours} 个小时，请发一句可爱的搞怪文案打破冷场。`
                        }
                    ],
                    max_tokens: 120,
                    temperature: 0.95
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) return null;
            const data = await res.json();
            const rawContent = data.choices?.[0]?.message?.content?.trim();
            if (!rawContent) return null;

            let messageText = rawContent;
            let memeKeyword = '';
            const match = rawContent.match(/\[(?:表情|meme)[:：]([^\]]+)\]/i);
            if (match) {
                memeKeyword = match[1].trim();
                messageText = rawContent.replace(match[0], '').trim();
            }

            return { messageText, memeKeyword };
        } catch (err) {
            console.error('[dsh-onebot] 模型自主生成搞怪文案失败:', err.message);
            return null;
        }
    }

    async triggerOnce(chatId = this.targetChats[0]) {
        if (!chatId) return;

        const thought = await this.generateModelThought(chatId);
        if (!thought || !thought.messageText) {
            console.warn('[dsh-onebot] 大肥鱼搞怪文案生成为空，跳过本次。');
            return;
        }

        const { messageText, memeKeyword } = thought;
        console.log(`[dsh-onebot] 大肥鱼搞怪文案就绪: "${messageText}" (表情需求: ${memeKeyword || '默认'})`);

        // 获取本地匹配的正版大肥鱼表情包
        let imageBase64 = null;
        try {
            imageBase64 = await getLocalMemeBase64(memeKeyword);
        } catch (e) {
            console.warn('[dsh-onebot] 读取本地表情包异常:', e.message);
        }

        if (imageBase64) {
            await this.bridge.sendSegments(chatId, [
                { type: 'text', data: { text: messageText } },
                { type: 'image', data: { file: `base64://${imageBase64}` } }
            ]);
            console.log(`[dsh-onebot] 已向 ${chatId} 成功发送冷场冒泡搞怪文案 + 表情包！`);
            return;
        }

        // 纯文本发送
        await this.bridge.sendToChat(chatId, messageText);
        console.log(`[dsh-onebot] 已向 ${chatId} 成功发送冷场冒泡搞怪纯文本！`);
    }
}
