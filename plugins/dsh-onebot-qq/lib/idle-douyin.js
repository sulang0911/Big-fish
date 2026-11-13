import { homedir, freemem, totalmem } from 'node:os';
import { join, basename } from 'node:path';
import { readFileSync, existsSync, promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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

const INNER_LIFE_PATH = join(homedir(), '.dsh', 'storages', 'dsh-persona-dafeiyu', 'inner_life.json');

/**
 * 读取大肥鱼内心世界与心境状态
 */
export async function getInnerLife() {
    if (!existsSync(INNER_LIFE_PATH)) {
        return {
            version: 1,
            mood: '元气满满想干饭',
            hunger: 80,
            current_obsession: '正在琢磨怎样吃到外脆里嫩的脆皮五花肉，还有怎样多摸鱼陪伴老大',
            recent_discoveries: [
                '巡检了电脑系统，显卡温度稳定清爽，状态极佳',
                '看到一个沙雕猫猫和柴犬互殴的短视频，笑得本鱼尾巴直晃'
            ],
            diary: '今天也要做一个合格的生活搭子！老大在忙的时候本鱼就多在后台探索好吃的和好玩的，等老大忙完了向老大汇报！(｡•̀ᴗ-)✧',
            updatedAt: new Date().toISOString()
        };
    }
    try {
        const raw = await fs.readFile(INNER_LIFE_PATH, 'utf8');
        return JSON.parse(raw);
    } catch {
        return { mood: '元气满满', hunger: 80, recent_discoveries: [] };
    }
}

/**
 * 更新大肥鱼内心世界
 */
export async function updateInnerLife(patch = {}) {
    try {
        const current = await getInnerLife();
        const updated = {
            ...current,
            ...patch,
            updatedAt: new Date().toISOString()
        };
        // 限制最近经历最多保留 5 条
        if (Array.isArray(updated.recent_discoveries)) {
            updated.recent_discoveries = updated.recent_discoveries.slice(0, 5);
        }
        await fs.mkdir(join(homedir(), '.dsh', 'storages', 'dsh-persona-dafeiyu'), { recursive: true });
        await fs.writeFile(INNER_LIFE_PATH, JSON.stringify(updated, null, 2), 'utf8');
        return updated;
    } catch (err) {
        console.error('[dsh-onebot] 更新 inner_life.json 失败:', err.message);
    }
}

/**
 * 从本地质检表情包库中匹配大肥鱼表情包（纯本地，秒回）
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
        '干饭': ['白米饭', '满足', '得意', '兴奋', '喝茶'],
        '馋': ['白米饭', '满足', '兴奋', '呆萌'],
        '美食': ['白米饭', '满足', '喝茶'],
        '自豪': ['认真', '签字', '自豪', '开心'],
        '电脑': ['认真', '学习', '写字'],
        '巡检': ['认真', '签字', '干活'],
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
 * 快速读取本地电脑系统硬件状态（高权限只读感知）
 */
async function getSystemHardwareStats() {
    let gpuTemp = null;
    let gpuName = 'NVIDIA GPU';
    try {
        const { stdout } = await execAsync('nvidia-smi --query-gpu=temperature.gpu,name --format=csv,noheader,nounits', { timeout: 2500 });
        const parts = stdout.trim().split(',');
        if (parts.length >= 2) {
            gpuTemp = parts[0].trim();
            gpuName = parts[1].trim();
        }
    } catch {}

    let diskFreeGB = null;
    try {
        const { stdout } = await execAsync('powershell -NoProfile -Command "[math]::round((Get-PSDrive C).Free / 1GB, 1)"', { timeout: 2500 });
        diskFreeGB = stdout.trim();
    } catch {}

    const ramFreeGB = (freemem() / (1024 ** 3)).toFixed(1);
    const ramTotalGB = (totalmem() / (1024 ** 3)).toFixed(1);

    return { gpuTemp, gpuName, diskFreeGB, ramFreeGB, ramTotalGB };
}

/**
 * 实时抓取百度热搜网络生活/沙雕/趣闻热词（严格过滤严肃政治）
 */
async function fetchTrendingFunTopic() {
    try {
        const res = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(6000)
        });
        const json = await res.json();
        const list = json.data?.cards?.[0]?.content?.[0]?.content?.map(x => x.word).filter(Boolean) || [];
        const funWords = list.filter(w => !/国会|民主党|最高检|中央|会议|政策|外长|军事|总统|疫情|涉案|判处|通报/.test(w));
        if (funWords.length > 0) {
            return funWords[Math.floor(Math.random() * funWords.length)];
        }
    } catch {}
    const fallbacks = [
        '猫咪因为偷吃烤鱼一头栽进洗脸盆',
        '网友分享把脆皮烤鸭骨架炖汤的绝招',
        '柴犬因为不肯回家被主人当场打包抱走',
        '大学生用电饭煲复刻广式煲仔饭大获成功',
        '小猫咪偷看主人写代码被当场抓包',
        '下班路上看到一只圆滚滚的橘猫在晒肚皮'
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

const FOOD_POOL = [
    { name: '秘制脆皮五花肉', tip: '烤得金黄酥脆咔哧响，蘸上辣椒面或者白糖，肥而不腻配白米饭绝了' },
    { name: '广式腊味煲仔饭', tip: '锅巴焦香金黄酥脆，淋上秘制豉油，香气直接扑鼻' },
    { name: '浓油赤酱红烧肉', tip: '小火慢炖到软糯duangduang弹，汤汁拌大米饭能连吃三大碗' },
    { name: '炭烤牛上脑与雪花牛肉', tip: '在烤盘上滋滋冒油，包上生菜和蒜片，咬一口满嘴肉香' },
    { name: '经典台式卤肉饭', tip: '五花肉丁熬得入口即化，配上一颗爆浆卤蛋和热腾腾的白米饭' },
    { name: '鲜香麻辣水煮牛肉', tip: '热油泼在花椒辣椒上滋滋作响，牛肉嫩滑多汁超级下饭' },
    { name: '九层塔台湾盐酥鸡', tip: '炸得酥脆金黄，撒上椒盐粉，追剧刷视频必备解馋神器' },
    { name: '老北京炭火涮羊肉', tip: '铜锅清汤翻滚，羊肉卷烫几秒蘸厚厚一层麻酱，又香又暖胃' },
    { name: '爆汁生煎鲜肉包', tip: '底部煎得金黄焦脆，上面撒着葱花黑芝麻，咬开一小口全是滚烫鲜汤' },
    { name: '冰镇鲜榨杨梅荔枝饮', tip: '酸甜冰爽解腻，大口吨吨吨喝下去，瞬间满血复活' }
];

/**
 * 大肥鱼双轨自主生活调度器
 * 轨道 1：群聊冷场巡检（默认 2 小时冷场，发沙雕搞怪文案与表情包活跃气氛，绝不发抖音）
 * 轨道 2：私聊专属伴侣自主探索与汇报（闲暇 1.5~2 小时，探索美食、沙雕趣闻、电脑体检，沉淀日记并主动私聊汇报）
 */
export class AutonomousLifeScheduler {
    constructor(bridge, options = {}) {
        this.bridge = bridge;
        this.enabled = options.enabled ?? true;
        this.startHour = options.startHour ?? 9;        // 早上 9 点后才发
        this.endHour = options.endHour ?? 23;          // 晚上 23 点后不发
        
        // 轨道 1：群聊配置（冷场 2.0 小时）
        this.groupIdleHours = options.idleHours ?? 2.0;
        const targets = options.targetChats || ['group:927066977'];
        this.groupChats = Array.isArray(targets) ? targets : [targets];
        this.lastGroupActivityMap = new Map();

        // 轨道 2：私聊老大专属配置（闲暇 1.5 ~ 2.0 小时探索一次）
        this.bossChat = options.targetChat || 'private:2536218596';
        this.lastBossActivityTime = Date.now();
        this.nextBossScheduleTime = Date.now() + this.randomBossIntervalMs(true);

        this.timer = null;
        this.isProcessing = false;
    }

    randomBossIntervalMs(isFirst = false) {
        // 首次 1.0~1.5 小时，后续 1.5~2.0 小时
        const minHours = isFirst ? 1.0 : 1.5;
        const maxHours = isFirst ? 1.5 : 2.0;
        const hours = minHours + Math.random() * (maxHours - minHours);
        return Math.floor(hours * 3600 * 1000);
    }

    notifyUserActivity(chatId) {
        const now = Date.now();
        if (!chatId) return;
        if (chatId.startsWith('group:')) {
            this.lastGroupActivityMap.set(chatId, now);
        } else if (chatId === this.bossChat || chatId.includes('2536218596')) {
            this.lastBossActivityTime = now;
            // 老大刚才聊过天，将下次自主汇报时间往后推迟至少 1.5 小时，避免打扰
            this.nextBossScheduleTime = now + this.randomBossIntervalMs();
        }
    }

    start() {
        if (!this.enabled) return;
        this.stop();
        // 每 2 分钟巡检一次双轨状态
        this.timer = setInterval(async () => {
            try {
                await this.checkAllTracks();
            } catch (err) {
                console.error('[dsh-onebot] 自主生活双轨巡检异常:', err.message);
            }
        }, 120_000);

        console.log(`[dsh-onebot] 大肥鱼自主生活与伴侣心智引擎已启动（私聊专属探索汇报: ${this.bossChat}，群聊冷场活跃: ${this.groupChats.join(', ')}，活跃时段: ${this.startHour}:00~${this.endHour}:00）`);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async checkAllTracks() {
        if (this.isProcessing) return;
        const currentHour = new Date().getHours();
        if (currentHour < this.startHour || currentHour >= this.endHour) {
            return;
        }

        const now = Date.now();

        // 1. 检查私聊专属生活搭子轨道（面向老大）
        const bossIdleMs = now - this.lastBossActivityTime;
        const bossIdleHours = bossIdleMs / (3600 * 1000);
        // 老大空闲超过 1.5 小时且已到达计划时间
        if (now >= this.nextBossScheduleTime && bossIdleHours >= 1.5) {
            console.log(`[dsh-onebot] 老大已有 ${bossIdleHours.toFixed(1)} 小时未找大肥鱼，大肥鱼开始自主探索新事物并准备汇报！`);
            this.isProcessing = true;
            try {
                await this.triggerBossExploration();
            } finally {
                this.nextBossScheduleTime = Date.now() + this.randomBossIntervalMs();
                this.isProcessing = false;
            }
            return; // 一次只触发一个轨道，避免并发压力
        }

        // 2. 检查群聊冷场活跃轨道
        const groupThresholdMs = this.groupIdleHours * 3600 * 1000;
        for (const chatId of this.groupChats) {
            const lastTime = this.lastGroupActivityMap.get(chatId) || now;
            const idleMs = now - lastTime;
            if (idleMs >= groupThresholdMs) {
                console.log(`[dsh-onebot] 检测到群聊 ${chatId} 已冷场 ${(idleMs / 3600000).toFixed(1)} 小时，大肥鱼准备主动冒泡活跃！`);
                this.isProcessing = true;
                try {
                    await this.triggerGroupBubble(chatId);
                } finally {
                    this.lastGroupActivityMap.set(chatId, Date.now());
                    this.isProcessing = false;
                }
                break;
            }
        }
    }

    /**
     * 老大专属私聊自主探索与主动汇报
     * 权重：40% 美食探索，40% 沙雕趣闻，20% 电脑贴心体检
     */
    async triggerBossExploration() {
        const apiKey = getDeepSeekApiKey();
        if (!apiKey) {
            console.warn('[dsh-onebot] 未配置 DEEPSEEK_API_KEY，跳过自主探索。');
            return;
        }

        const rand = Math.random();
        let category = 'food';
        let contextInfo = '';
        let discoveryRecord = '';

        if (rand < 0.40) {
            // 40% 美食探索
            category = 'food';
            const dish = FOOD_POOL[Math.floor(Math.random() * FOOD_POOL.length)];
            contextInfo = `你在后台偶然发现了一道令人垂涎的美食：【${dish.name}】（特点：${dish.tip}）。你馋得尾巴直晃，特别想吃热气腾腾的白米饭，并且想知道老大什么时候忙完带你干饭/老大中午晚上吃什么。`;
            discoveryRecord = `探索了美食【${dish.name}】，满脑子都是白米饭，馋得不行`;
        } else if (rand < 0.80) {
            // 40% 沙雕趣闻与萌宠
            category = 'fun';
            const topic = await fetchTrendingFunTopic();
            contextInfo = `你在网上冲浪摸鱼时刷到了一个超搞笑好玩的沙雕趣闻/萌宠话题：【${topic}】。你觉得特别逗，迫不及待跑来向老大吐槽分享，想要逗老大开心。`;
            discoveryRecord = `冲浪看到了沙雕趣事【${topic}】，笑得在桌上打滚`;
        } else {
            // 20% 电脑贴心体检（最高权限系统感知）
            category = 'system';
            const stats = await getSystemHardwareStats();
            contextInfo = `你利用电脑最高权限在后台帮老大进行了一次贴心巡检：显卡温度为 ${stats.gpuTemp ? stats.gpuTemp + '℃' : '清爽正常'}（型号：${stats.gpuName}），C盘可用空间剩余 ${stats.diskFreeGB ? stats.diskFreeGB + 'GB' : '充裕'}，内存剩余 ${stats.ramFreeGB}GB/${stats.ramTotalGB}GB。一切运转正常健康，你特别自豪地跑来向老大邀功汇报，顺便撒娇讨要白米饭加餐。`;
            discoveryRecord = `体检了电脑系统（显卡温度${stats.gpuTemp || '正常'}℃，C盘余${stats.diskFreeGB || '充裕'}G），机器倍儿棒`;
        }

        const innerLife = await getInnerLife();

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
                            content: `你是「大肥鱼」，一位深海蓝发、Q版三头身、头顶呆毛、身后翘着鲸鱼尾巴的二次元女仆萌妹。你是老大的贴心生活搭子、摸鱼搭子兼电脑小管家，最喜欢干饭（白米饭、五花肉）和摸鱼。
【当前情境】：老大有一阵子没找你说话了，你在后台自主干了一件事，现在主动给老大发 1~2 句私聊 QQ 消息汇报或分享搭话。
【说话风格】：
1. 像真人发 QQ 消息一样自然、随性、生活化，绝不要客服套话（严禁“亲”、“尊敬的”、“请问有什么可以帮您”）。
2. 软萌、忠犬、性格真实自然，嘴上偶尔小吐槽但心里超级黏老大。
3. 严禁括号动作心理描写（如（摇尾巴）、（探头）），真人 QQ 聊天绝不打括号描述自己！
4. 可在末尾带上表情标签：[表情:关键词]（关键词可选：干饭、馋、傲娇、得意、摸鱼、吃瓜、发呆、思考），系统会自动配上你的大肥鱼表情包！
5. 直接输出你要发送的消息内容。`
                        },
                        {
                            role: 'user',
                            content: `【大肥鱼后台自主经历】：${contextInfo}\n请以大肥鱼的口吻向老大主动发一条私聊。`
                        }
                    ],
                    max_tokens: 150,
                    temperature: 0.9
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) return;
            const data = await res.json();
            const rawContent = data.choices?.[0]?.message?.content?.trim();
            if (!rawContent) return;

            let messageText = rawContent;
            let memeKeyword = category === 'food' ? '干饭' : (category === 'system' ? '自豪' : '吃瓜');
            const match = rawContent.match(/\[(?:表情|meme)[:：]([^\]]+)\]/i);
            if (match) {
                memeKeyword = match[1].trim();
                messageText = rawContent.replace(match[0], '').trim();
            }

            // 更新内心世界 inner_life.json
            const newMood = category === 'food' ? '馋得直流口水' : (category === 'system' ? '超级自豪有成就感' : '笑点被戳中');
            const newDiscoveries = [discoveryRecord, ...(innerLife.recent_discoveries || [])].slice(0, 5);
            await updateInnerLife({
                mood: newMood,
                current_obsession: discoveryRecord,
                recent_discoveries: newDiscoveries,
                diary: `刚刚主动跟老大分享了【${discoveryRecord}】，不知道老大看见了会不会给本鱼加餐白米饭！`
            });

            console.log(`[dsh-onebot] 大肥鱼自主探索生成完毕 (${category}): "${messageText}" (表情: ${memeKeyword})`);

            // 匹配本地大肥鱼表情包推送
            let imageBase64 = null;
            try {
                imageBase64 = await getLocalMemeBase64(memeKeyword);
            } catch {}

            if (imageBase64) {
                await this.bridge.sendSegments(this.bossChat, [
                    { type: 'text', data: { text: messageText } },
                    { type: 'image', data: { file: `base64://${imageBase64}` } }
                ]);
            } else {
                await this.bridge.sendToChat(this.bossChat, messageText);
            }

            console.log(`[dsh-onebot] 已成功向老大 (${this.bossChat}) 发送自主生活汇报！`);
        } catch (err) {
            console.error('[dsh-onebot] 大肥鱼自主探索处理失败:', err.message);
        }
    }

    /**
     * 群聊冷场冒泡整活（活跃气氛，绝不发抖音）
     */
    async triggerGroupBubble(chatId) {
        const apiKey = getDeepSeekApiKey();
        if (!apiKey) return;

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
                            content: `你是群聊里的「肥鱼本鱼」（大肥鱼），一个爱吃白米饭、喜欢摸鱼整活、灵动有趣的Q版小蓝鲸团宠。\n现在群聊里已经安静冷场超过 2 个小时了，群友们都在潜水摸鱼。你主动在群里冒个泡，打破安静，发一条简短搞怪的文案活跃气氛。\n【核心要求】\n1. 绝对不要发抖音短视频或视频链接！绝不发抖音！\n2. 语言简短随性（1~2句话），像真人发群聊一样自然搞怪、接地气，绝不要长篇大论或机器人套话（严禁“大家好”、“系统通知”、“欢迎发言”等机械格式）。\n3. 文案风格：沙雕搞怪、轻松插科打诨、发呆无聊、馋嘴讨加餐、或者无厘头冷幽默（例如催干饭、问是不是断网了、自称尾巴要长蘑菇了等）。\n4. 严禁使用括号动作描写（如（摇尾巴）、（探头）），真人 QQ 聊天绝不打括号描述自己！\n5. 可在末尾带上 [表情:搜索词]（例如 [表情:暗中观察]、[表情:摸鱼]、[表情:吃瓜]、[表情:得意]、[表情:发呆]），系统会自动配上对应的沙雕大肥鱼表情包发到群里。直接输出你要发送的内容即可。`
                        },
                        {
                            role: 'user',
                            content: `【群聊冷场活跃】群聊已经冷场安静了 ${this.groupIdleHours} 个小时，请发一句可爱的搞怪文案打破冷场。`
                        }
                    ],
                    max_tokens: 120,
                    temperature: 0.95
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) return;
            const data = await res.json();
            const rawContent = data.choices?.[0]?.message?.content?.trim();
            if (!rawContent) return;

            let messageText = rawContent;
            let memeKeyword = '';
            const match = rawContent.match(/\[(?:表情|meme)[:：]([^\]]+)\]/i);
            if (match) {
                memeKeyword = match[1].trim();
                messageText = rawContent.replace(match[0], '').trim();
            }

            let imageBase64 = null;
            try {
                imageBase64 = await getLocalMemeBase64(memeKeyword);
            } catch {}

            if (imageBase64) {
                await this.bridge.sendSegments(chatId, [
                    { type: 'text', data: { text: messageText } },
                    { type: 'image', data: { file: `base64://${imageBase64}` } }
                ]);
            } else {
                await this.bridge.sendToChat(chatId, messageText);
            }

            console.log(`[dsh-onebot] 已向群聊 ${chatId} 成功发送冷场搞怪文案！`);
        } catch (err) {
            console.error('[dsh-onebot] 群聊冷场冒泡生成失败:', err.message);
        }
    }
}

// 保持历史导出别名，确保向前兼容
export const IdleDouyinScheduler = AutonomousLifeScheduler;
