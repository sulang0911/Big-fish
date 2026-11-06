/**
 * Step 4: QQ 消息防抖聚合器与内在生理状态机 (DriveAndSensorEngine)
 * - DriveEngine (InternalState): 维护 hunger(0-100), energy(0-100), boredom(0-100), mood，每分钟自然演化 + 昼夜生物钟 (01:30~07:30 睡眠与被吵醒起床气，12:00/18:00 饭点饥饿加速)
 * - MessageDebounceBuffer: 私聊 2000ms 滑动防抖窗口（最长等待 5000ms），多条碎消息合并后再调用 LLM
 * - PokeAggregator: 监听 OneBot notify.poke 事件，5000ms 内连续戳一戳聚合为 { event: "poked_by_user", count: N }
 * @module dsh-onebot/drive-engine
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const INNER_LIFE_PATH = join(homedir(), '.dsh', 'storages', 'dsh-persona-dafeiyu', 'inner_life.json');

function clamp(val, min, max) {
    const rounded = Math.round((Number(val) || 0) * 10) / 10;
    return Math.max(min, Math.min(max, rounded));
}

function randFloat(min, max) {
    return Math.round((min + Math.random() * (max - min)) * 10) / 10;
}

/**
 * 判断某个时间是否处于深夜睡眠时段 (01:30 ~ 07:30)
 */
export function isSleepWindow(date = new Date()) {
    const minutesOfDay = date.getHours() * 60 + date.getMinutes();
    return minutesOfDay >= (1 * 60 + 30) && minutesOfDay < (7 * 60 + 30);
}

/**
 * 判断某个时间是否处于饭点时段 (11:30~13:00 或 17:30~19:00)
 */
export function isMealTimeWindow(date = new Date()) {
    const minutesOfDay = date.getHours() * 60 + date.getMinutes();
    const isLunch = minutesOfDay >= (11 * 60 + 30) && minutesOfDay <= (13 * 60);
    const isDinner = minutesOfDay >= (17 * 60 + 30) && minutesOfDay <= (19 * 60);
    return isLunch || isDinner;
}

export class DriveEngine {
    constructor(options = {}) {
        this.storePath = options.storePath || INNER_LIFE_PATH;
        this.now = options.now || (() => Date.now());
        this.onStateChange = options.onStateChange || null;
        this.state = this._load(options.initialState);
        this.tickTimer = null;
        this.onTickCallbacks = [];
        if (typeof options.onTick === 'function') {
            this.onTickCallbacks.push(options.onTick);
        }
    }

    _load(initialOverride) {
        const defaults = {
            version: 3,
            hunger: 80,
            energy: 85,
            boredom: 25,
            mood: '元气满满想干饭',
            sleeping: false,
            wokenUpAt: 0,
            current_obsession: '正在琢磨怎样能吃到外脆里嫩的脆皮五花肉，还有怎样多摸鱼陪伴老大',
            recent_discoveries: [
                '刚学习了一道秘制红烧肉绝密配方，据说拌大米饭能连吃三大碗！',
                '巡检了电脑系统，显卡温度稳定清爽，状态极佳',
            ],
            diary: '今天也要做一个合格的生活搭子！(｡•̀ᴗ-)✧',
            updatedAt: new Date().toISOString(),
        };
        if (initialOverride && typeof initialOverride === 'object' && Object.keys(initialOverride).length > 0) {
            return {
                ...defaults,
                ...initialOverride,
                hunger: clamp(initialOverride.hunger ?? 80, 0, 100),
                energy: clamp(initialOverride.energy ?? 85, 0, 100),
                boredom: clamp(initialOverride.boredom ?? 25, 0, 100),
            };
        }
        try {
            if (existsSync(this.storePath)) {
                const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
                if (raw && typeof raw === 'object') {
                    return {
                        ...defaults,
                        ...raw,
                        hunger: clamp(raw.hunger ?? 80, 0, 100),
                        energy: clamp(raw.energy ?? 85, 0, 100),
                        boredom: clamp(raw.boredom ?? 25, 0, 100),
                        sleeping: Boolean(raw.sleeping ?? isSleepWindow()),
                        wokenUpAt: Number(raw.wokenUpAt || 0),
                    };
                }
            }
        } catch (err) {
            console.warn('[DriveEngine] 读取状态文件失败，使用默认值:', err.message);
        }
        return defaults;
    }

    save() {
        try {
            this.state.updatedAt = new Date().toISOString();
            mkdirSync(dirname(this.storePath), { recursive: true });
            const tmp = `${this.storePath}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
            renameSync(tmp, this.storePath);
        } catch (err) {
            console.warn('[DriveEngine] 保存状态失败:', err.message);
        }
    }

    start(onTick) {
        if (typeof onTick === 'function') {
            this.onTickCallbacks.push(onTick);
        }
        this.stop();
        // 每 60 秒执行一次生理状态演化 Tick
        this.tickTimer = setInterval(() => {
            this.tick();
        }, 60_000);
        if (this.tickTimer.unref) this.tickTimer.unref();
    }

    stop() {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    isSleeping(now = new Date()) {
        return isSleepWindow(now);
    }

    isWokenUpGrumpy(nowMs = Date.now()) {
        // 如果在睡眠时段被吵醒，15 分钟内带有起床气状态
        return this.state.wokenUpAt > 0 && (nowMs - this.state.wokenUpAt) < 15 * 60_000 && isSleepWindow(new Date(nowMs));
    }

    /**
     * 每分钟后台生理数值自然演化
     */
    tick(now = new Date()) {
        const sleepMode = isSleepWindow(now);
        const mealMode = isMealTimeWindow(now);

        if (sleepMode) {
            this.state.sleeping = true;
            // 深夜能量处于低谷（20 左右），同时缓慢休息恢复，无聊度降低
            if (this.state.energy > 25) {
                this.state.energy = clamp(this.state.energy - 2, 15, 100);
            } else {
                this.state.energy = clamp(this.state.energy + 1, 15, 30);
            }
            this.state.boredom = clamp(this.state.boredom - 1, 0, 100);
            this.state.hunger = clamp(this.state.hunger - 0.1, 0, 100);
            if (!this.isWokenUpGrumpy(now.getTime())) {
                this.state.mood = '呼呼大睡中(zzZ)';
            }
        } else {
            // 白天刚睡醒时恢复元气
            if (this.state.sleeping) {
                this.state.sleeping = false;
                this.state.wokenUpAt = 0;
                this.state.energy = Math.max(this.state.energy, 85);
            }
            // 饭点 (12:00 / 18:00 前后) 饥饿加速下降，均带自然随机波动
            const hungerDrop = mealMode ? randFloat(0.6, 1.2) : randFloat(0.1, 0.25);
            this.state.hunger = clamp(this.state.hunger - hungerDrop, 0, 100);
            // 无聊度适度上升：每分钟 +0.2 ~ +0.4（平均 +0.3/分钟，约每小时 +18 点，约 2.5~3 小时累积到高无聊度）
            this.state.boredom = clamp(this.state.boredom + randFloat(0.2, 0.4), 0, 100);
            // 午休时段 (13:00~14:00) 打盹回精力，其余白天时段平缓消耗 (-0.05 ~ -0.1/分钟，每小时约 -4.5)
            const hour = now.getHours();
            if (hour === 13 && this.state.energy < 85) {
                this.state.energy = clamp(this.state.energy + randFloat(0.3, 0.6), 0, 100);
            } else {
                this.state.energy = clamp(this.state.energy - randFloat(0.05, 0.1), 15, 100);
            }
            this._recomputeMood();
        }

        this.save();
        if (typeof this.onStateChange === 'function') {
            try { this.onStateChange(this.getSnapshot()); } catch {}
        }
        for (const cb of this.onTickCallbacks) {
            try {
                void cb(this.getSnapshot());
            } catch (err) {
                console.warn('[DriveEngine] tick 回调异常:', err.message);
            }
        }
        return this.getSnapshot();
    }

    /**
     * 按分钟步进演化生理状态（支持单测或批量时间推进）
     */
    stepMinutes(minutes = 1, now = new Date(this.now())) {
        const steps = Math.max(1, Math.round(Number(minutes) || 1));
        for (let i = 0; i < steps; i++) {
            this.tick(now);
        }
        return this.getSnapshot();
    }

    getState() {
        return this.getSnapshot();
    }

    formatStateForPrompt(opts = {}) {
        const snap = this.getSnapshot();
        const nowStr = new Date(this.now()).toLocaleString('zh-CN', { hour12: false });
        const wokeNote = (opts.wokeUpFromSleep || snap.wokenUpGrumpy)
            ? ' ⚠️【生物钟警告：你刚刚在深夜 01:30~07:30 熟睡中被吵醒，迷迷糊糊带着强烈起床气，说话要揉眼睛抱怨困！】'
            : '';
        return `【当前时间与大肥鱼实时内在生理状态 (InternalState)】时间=${nowStr} | 饱食度(hunger)=${snap.hunger}/100 | 精力(energy)=${snap.energy}/100 | 无聊度(boredom)=${snap.boredom}/100 | 心境(mood)=${snap.mood}${wokeNote}`;
    }

    _recomputeMood() {
        if (this.isWokenUpGrumpy()) {
            this.state.mood = '刚被吵醒迷迷糊糊有起床气';
        } else if (this.state.sleeping) {
            this.state.mood = '呼呼大睡中(zzZ)';
        } else if (this.state.hunger < 20) {
            this.state.mood = '饿扁了眼巴巴求投喂白米饭';
        } else if (this.state.boredom > 80) {
            this.state.mood = '无聊得尾巴长蘑菇想找老大说话';
        } else if (this.state.energy < 30) {
            this.state.mood = '困困的想趴桌摸鱼';
        } else if (this.state.hunger > 85) {
            this.state.mood = '吃饱喝足超级开心满足';
        } else {
            this.state.mood = '元气满满摸鱼中';
        }
    }

    /**
     * 当收到用户消息时触发：检测深夜吵醒（饱食度仅通过 /fish feed 投喂增加，普通聊天不再凭空加饱食度）
     */
    onUserMessage(userText = '', now = new Date()) {
        const text = String(userText || '').trim();
        let wokenUp = false;

        if (isSleepWindow(now)) {
            this.state.wokenUpAt = now.getTime();
            this.state.sleeping = false;
            this.state.mood = '刚被吵醒迷迷糊糊有起床气';
            wokenUp = true;
        }

        // 非 /fish 指令的普通聊天随机缓解 2.0 ~ 5.0 无聊度
        if (!/^\/fish(?:\s|$)/i.test(text)) {
            this.state.boredom = clamp(this.state.boredom - randFloat(2.0, 5.0), 0, 100);
        }
        if (!wokenUp) {
            this._recomputeMood();
        }
        this.save();
        return { fed: false, wokenUp, wokeUpFromSleep: wokenUp, state: this.getSnapshot() };
    }

    /**
     * 应用 LLM 或互动指令输出的 stat_delta ({ affection, boredom, hunger, energy })
     */
    applyStatDelta(statDelta = {}) {
        if (!statDelta || typeof statDelta !== 'object') return this.getSnapshot();
        if (statDelta.hunger !== undefined) {
            const dh = clamp(statDelta.hunger, -30, 50);
            this.state.hunger = clamp(this.state.hunger + dh, 0, 100);
        }
        if (statDelta.boredom !== undefined) {
            const db = clamp(statDelta.boredom, -50, 20);
            this.state.boredom = clamp(this.state.boredom + db, 0, 100);
        }
        if (statDelta.energy !== undefined) {
            const de = clamp(statDelta.energy, -25, 35);
            this.state.energy = clamp(this.state.energy + de, 0, 100);
        }
        this._recomputeMood();
        this.save();
        if (typeof this.onStateChange === 'function') {
            try { this.onStateChange(this.getSnapshot()); } catch {}
        }
        return this.getSnapshot();
    }

    getSnapshot() {
        return {
            hunger: this.state.hunger,
            energy: this.state.energy,
            boredom: this.state.boredom,
            mood: this.state.mood,
            sleeping: isSleepWindow() && !this.isWokenUpGrumpy(),
            wokenUpGrumpy: this.isWokenUpGrumpy(),
            current_obsession: this.state.current_obsession,
            recent_discoveries: this.state.recent_discoveries,
            diary: this.state.diary,
            updatedAt: this.state.updatedAt,
        };
    }
}

/**
 * 连续碎消息防抖合流缓冲器 (MessageDebounceBuffer)
 * 收到私聊消息后开启 2000ms 滑动防抖窗口（若继续发消息则重置计时器，最长等待 5000ms），
 * 将多条碎消息用换行符拼接为一次完整的用户输入后再交给 LLM 处理。
 */
export class MessageDebounceBuffer {
    constructor(options = {}) {
        this.windowMs = options.debounceMs ?? options.windowMs ?? 2000;
        this.maxWaitMs = options.maxWaitMs ?? 5000;
        this.defaultFlushCallback = options.onFlush || null;
        this.buffers = new Map(); // chatId -> { items: [], timer, maxTimer, firstAt, flushCallback }
    }

    /**
     * 推入一条待防抖合并的消息；支持 push(item) 或 push(chatId, item, flushCallback)
     */
    push(arg1, arg2, arg3) {
        let chatId;
        let item;
        let flushCallback;
        if (typeof arg1 === 'object' && arg1 !== null) {
            item = arg1;
            chatId = item.chatId || `private:${item.userId || DEFAULT_MASTER_QQ}`;
            flushCallback = arg2 || this.defaultFlushCallback;
        } else {
            chatId = String(arg1);
            item = arg2;
            flushCallback = arg3 || this.defaultFlushCallback;
        }
        let entry = this.buffers.get(chatId);
        const now = Date.now();
        if (!entry) {
            entry = {
                items: [],
                timer: null,
                maxTimer: null,
                firstAt: now,
                flushCallback,
            };
            this.buffers.set(chatId, entry);
            entry.maxTimer = setTimeout(() => {
                this.flush(chatId);
            }, this.maxWaitMs);
            if (entry.maxTimer.unref) entry.maxTimer.unref();
        } else if (flushCallback) {
            entry.flushCallback = flushCallback;
        }

        entry.items.push(item);
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            this.flush(chatId);
        }, this.windowMs);
        if (entry.timer.unref) entry.timer.unref();
    }

    flush(chatId) {
        const entry = this.buffers.get(chatId);
        if (!entry) return;
        this.buffers.delete(chatId);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.maxTimer) clearTimeout(entry.maxTimer);
        if (entry.items.length === 0) return;

        const mergedText = entry.items.map(it => it.text).filter(Boolean).join('\n');
        const lastItem = entry.items[entry.items.length - 1];
        const cb = entry.flushCallback || this.defaultFlushCallback;
        if (!cb) return;
        try {
            void Promise.resolve(cb({
                ...lastItem,
                chatId,
                text: mergedText,
                count: entry.items.length,
                mergedCount: entry.items.length,
                rawItems: entry.items,
            })).catch(err => {
                console.error('[MessageDebounceBuffer] flush 回调异常:', err.message);
            });
        } catch (err) {
            console.error('[MessageDebounceBuffer] flush 同步异常:', err.message);
        }
    }

    clear() {
        this.clearAll();
    }

    clearAll() {
        for (const [chatId] of this.buffers) {
            const entry = this.buffers.get(chatId);
            if (entry?.timer) clearTimeout(entry.timer);
            if (entry?.maxTimer) clearTimeout(entry.maxTimer);
        }
        this.buffers.clear();
    }
}

/**
 * QQ 戳一戳互动聚合器 (PokeAggregator)
 * 监听 OneBot notify.poke 事件，若用户在 5000ms 内连续戳了肥鱼多次，
 * 聚合为一条 { event: "poked_by_user", count: N } 交给肥鱼吐槽或反戳回去。
 */
export class PokeAggregator {
    constructor(options = {}) {
        this.windowMs = options.windowMs ?? 5000;
        this.selfIdGetter = options.selfIdGetter || (() => '2163178914');
        this.onPokeAggregated = options.onFlush || options.onPokeAggregated || (() => {});
        this.pendingPokes = new Map(); // key(chatId#userId) -> { chatId, userId, groupId, count, timer }
    }

    handleNotice(event, explicitSelfId) {
        if (!event || typeof event !== 'object') return false;
        const isPoke = (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke')
            || (event.notice_type === 'poke');
        if (!isPoke) return false;

        const selfId = String(explicitSelfId || this.selfIdGetter() || '');
        const targetId = String(event.target_id ?? '');
        const userId = String(event.user_id ?? '');
        // 仅当被戳的目标是大肥鱼自己（且不是自己戳自己）时响应
        if (!userId || (selfId && targetId && targetId !== selfId) || userId === selfId) {
            return false;
        }

        const groupId = event.group_id ? String(event.group_id) : '';
        const chatId = groupId ? `group:${groupId}` : `private:${userId}`;
        const key = `${chatId}#${userId}`;

        let rec = this.pendingPokes.get(key);
        if (!rec) {
            rec = {
                chatId,
                userId,
                groupId,
                count: 0,
                timer: null,
            };
            this.pendingPokes.set(key, rec);
        }
        rec.count += 1;
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = setTimeout(() => {
            this.pendingPokes.delete(key);
            const payload = {
                event: 'poked_by_user',
                chatId: rec.chatId,
                userId: rec.userId,
                groupId: rec.groupId,
                count: rec.count,
            };
            try {
                void Promise.resolve(this.onPokeAggregated(payload)).catch(err => {
                    console.warn('[PokeAggregator] 处理戳一戳聚合事件失败:', err.message);
                });
            } catch (err) {
                console.warn('[PokeAggregator] 回调异常:', err.message);
            }
        }, this.windowMs);
        if (rec.timer.unref) rec.timer.unref();
        return true;
    }

    clear() {
        this.stop();
    }

    stop() {
        for (const [, rec] of this.pendingPokes) {
            if (rec.timer) clearTimeout(rec.timer);
        }
        this.pendingPokes.clear();
    }
}
