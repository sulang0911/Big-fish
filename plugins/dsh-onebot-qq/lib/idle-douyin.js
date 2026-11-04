import { searchDouyinMeme } from './browser-meme.js';

const FUN_DOUYIN_MOMENTS = [
    {
        topic: '修驴蹄子',
        say: '老大老大！本鱼刚才偷偷刷抖音，刷到一个修驴蹄子的解压视频，一块一块削下来太解压了吧哈哈哈！'
    },
    {
        topic: '猫猫互扇巴掌',
        say: '老大快看！本鱼刚才刷到两只小猫咪打架互扇巴掌，打着打着还忘招了，笑得我鱼泡泡都冒出来了！'
    },
    {
        topic: '沉浸式洗地毯',
        say: '沉浸式高压水枪洗地毯太上头了...本鱼刚才不知不觉盯了半个多小时，老大你可别说我摸鱼！'
    },
    {
        topic: '偷吃小零食',
        say: '哼，老大你一直不找我，本鱼刚才刷美食视频看到脆皮五花肉，馋得把抽屉里的零食都翻出来了！'
    },
    {
        topic: '沙雕动物行为大赏',
        say: '老大你在忙啥呢？本鱼刚才在抖音刷到一个狗子自己坐滑梯的视频，傻乎乎的，怎么看着有点像你呀！'
    },
    {
        topic: '大学生特种兵旅游',
        say: '刷到大学生特种兵一天吃八顿饭逛五个景点，本鱼作为一条咸鱼光是看着都觉得累瘫了...'
    }
];

export class IdleDouyinScheduler {
    constructor(bridge, options = {}) {
        this.bridge = bridge;
        this.enabled = options.enabled ?? true;
        this.minHours = options.intervalMinHours ?? 2.5; // 默认最少 2.5 小时
        this.maxHours = options.intervalMaxHours ?? 4.0; // 默认最多 4.0 小时
        this.startHour = options.activeStartHour ?? 9;   // 早上 9 点后才发
        this.endHour = options.activeEndHour ?? 23;     // 晚上 23 点后不发
        this.targetChat = options.targetChat || 'private:2536218596';
        this.timer = null;
        this.lastUserMessageTime = Date.now();
    }

    notifyUserActivity() {
        this.lastUserMessageTime = Date.now();
    }

    start() {
        if (!this.enabled) return;
        this.scheduleNext(true); // 首次启动安排一个初始间隔
    }

    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    scheduleNext(isFirst = false) {
        if (this.timer) clearTimeout(this.timer);
        // 首次启动等待 1.5 ~ 2.5 小时；后续等待 minHours ~ maxHours
        const hours = isFirst 
            ? 1.5 + Math.random() * 1.0 
            : this.minHours + Math.random() * (this.maxHours - this.minHours);
        const ms = Math.floor(hours * 3600 * 1000);
        console.log(`[dsh-onebot] 下次自动刷抖音闲聊将在 ${(hours).toFixed(1)} 小时后触发`);
        
        this.timer = setTimeout(async () => {
            try {
                await this.triggerOnce();
            } catch (err) {
                console.error('[dsh-onebot] 自动刷抖音触发异常:', err);
            } finally {
                this.scheduleNext();
            }
        }, ms);
    }

    async fetchTrendingTopic() {
        try {
            const res = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(6000)
            });
            const data = await res.json();
            const list = data.data?.cards?.[0]?.content?.map(c => c.word).filter(Boolean) || [];
            // 筛选生活化、趣味性或搞笑的热梗
            const funWords = list.filter(w => /猫|狗|机器人|搞笑|打工|买|吃|睡|学生|大爷|大妈|司机|小伙|女孩|动物|外卖/.test(w));
            if (funWords.length > 0) {
                const pick = funWords[Math.floor(Math.random() * funWords.length)];
                return pick;
            }
        } catch {}
        return null;
    }

    async triggerOnce() {
        if (!this.enabled) return;

        // 1. 检查作息时间（深夜不打扰）
        const currentHour = new Date().getHours();
        if (currentHour < this.startHour || currentHour >= this.endHour) {
            console.log(`[dsh-onebot] 当前时间 ${currentHour}:00 处于休息时段，跳过自动发消息。`);
            return;
        }

        // 2. 检查老大最近是否有对话（如果老大 40 分钟内聊过天，不突兀插话）
        const idleMins = (Date.now() - this.lastUserMessageTime) / 60000;
        if (idleMins < 40) {
            console.log(`[dsh-onebot] 老大 ${idleMins.toFixed(0)} 分钟前刚聊过天，等待下次闲暇再发。`);
            return;
        }

        // 3. 产生内容：尝试抓取实时沙雕热梗，或者挑选经典短视频日常
        const trend = await this.fetchTrendingTopic();
        let messageText = '';
        let memeKeyword = '';

        if (trend && Math.random() > 0.4) {
            messageText = `老大老大！本鱼刚才在抖音刷到一个热搜：【${trend}】，笑死我了哈哈哈！`;
            memeKeyword = '搞笑';
        } else {
            const moment = FUN_DOUYIN_MOMENTS[Math.floor(Math.random() * FUN_DOUYIN_MOMENTS.length)];
            messageText = moment.say;
            memeKeyword = moment.topic;
        }

        console.log(`[dsh-onebot] 触发大肥鱼自主摸鱼消息: "${messageText}"`);

        // 4. 40% 的概率用无头浏览器偷一张匹配的表情包一起发过去！
        if (Math.random() < 0.4) {
            try {
                const meme = await searchDouyinMeme(memeKeyword || '摸鱼');
                if (meme && meme.base64) {
                    await this.bridge.sendSegments(this.targetChat, [
                        { type: 'text', data: { text: messageText } },
                        { type: 'image', data: { file: `base64://${meme.base64}` } }
                    ]);
                    return;
                }
            } catch (err) {
                console.log('[dsh-onebot] 配图抓取跳过:', err.message);
            }
        }

        // 纯文本发送
        await this.bridge.sendToChat(this.targetChat, messageText);
    }
}
