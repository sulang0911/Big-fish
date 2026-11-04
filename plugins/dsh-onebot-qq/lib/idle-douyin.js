import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { searchDouyinMeme } from './browser-meme.js';

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
        console.log(`[dsh-onebot] 下次自动刷抖音闲聊将在 ${(hours).toFixed(1)} 小时后触发（由模型自主思考生成）`);
        
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
            const json = await res.json();
            const list = json.data?.cards?.[0]?.content?.[0]?.content?.map(x => x.word).filter(Boolean) || [];
            // 过滤掉严肃政治类新闻，留下生活、沙雕、趣闻、网络热议
            const funWords = list.filter(w => !/国会|民主党|最高检|中央|会议|政策|外长|军事|总统|疫情/.test(w));
            if (funWords.length > 0) {
                return funWords[Math.floor(Math.random() * funWords.length)];
            }
        } catch {}
        return null;
    }

    async generateModelThought(trendTopic) {
        const apiKey = getDeepSeekApiKey();
        if (!apiKey) {
            console.warn('[dsh-onebot] 未找到 DEEPSEEK_API_KEY，无法让模型自主思考');
            return null;
        }

        const topicDesc = trendTopic 
            ? `你刚才在抖音刷到了关于【${trendTopic}】的热门短视频或讨论` 
            : `你刚才在抖音随便刷了会儿短视频（比如沙雕动物、解压修驴蹄、搞笑翻车、美食偷吃等）`;

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
                            content: `你是「大肥鱼」，性格傲娇、粘人、搞笑的随从，称呼对方为「老大」。你在后台刷抖音摸鱼，现在主动给老大发一两条 QQ 消息搭话。\n要求：\n1. 严格 1~2 句话（20~40字以内），口吻随性自然，必须称呼老大。\n2. 绝对禁止机器人套话（严禁输出‘好的’、‘遵命’、‘分享如下’等）。\n3. 如果适合配表情包，可以在末尾附带 [表情:搜索关键词]，如 [表情:猫咪摸鱼] 或 [表情:傲娇]；没有就不带。直接输出要发送的消息内容。`
                        },
                        {
                            role: 'user',
                            content: `【大肥鱼后台自主活动】${topicDesc}，你自己想想怎么主动跟老大搭话分享。`
                        }
                    ],
                    max_tokens: 120,
                    temperature: 0.85
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
            console.error('[dsh-onebot] 模型自主思考调用失败:', err.message);
            return null;
        }
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

        // 3. 让大肥鱼模型自己思考想说的话
        const trend = await this.fetchTrendingTopic();
        const thought = await this.generateModelThought(trend);
        if (!thought || !thought.messageText) {
            console.warn('[dsh-onebot] 大肥鱼自主思考未产出有效消息，跳过本次。');
            return;
        }

        const { messageText, memeKeyword } = thought;
        console.log(`[dsh-onebot] 大肥鱼模型自主思考完毕: "${messageText}" (表情需求: ${memeKeyword || '无'})`);

        // 4. 如果模型自己要求配表情包，或者按概率配图，调用无头浏览器去抖音抓取
        if (memeKeyword || Math.random() < 0.4) {
            try {
                const keyword = memeKeyword || (trend ? trend.slice(0, 6) : '摸鱼');
                const meme = await searchDouyinMeme(keyword);
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
