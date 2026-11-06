/**
 * 大肥鱼 (Feiyu) v3.0 - Step 5: 社交仲裁与防骚扰风控器 (SocialArbiter)
 *
 * 核心职责：
 * 1. 统合 MemoryManager (Step 3)、DriveEngine/MessageDebounceBuffer/PokeAggregator (Step 4) 与 MessageDispatcher (Step 2)
 * 2. 私聊主动破冰 (`proactive_dm_tick`)：
 *    - 触发条件：`boredom > 85` 且距上次聊天 > 4 小时、`hunger < 15` 讨食、或老大昨晚熬夜今日未冒泡
 *    - 防骚扰熔断锁 (`unanswered_proactive_count >= 2`)：主动发消息未获老大回复绝不超过 2 次，老大回复后清零解锁
 *    - 全局冷却锁：每次主动消息后进入 60 ~ 120 分钟随机冷却；睡眠时段 (01:30 ~ 07:30) 严禁主动发消息
 *    - 抢占取消机制 (Preemption)：生成或逐条气泡延迟期间老大发来新消息，立即废弃主动消息
 * 3. 群聊潜伏吃瓜与智能插话 (`group_chime_in_check`)：
 *    - 维护群聊 Working Memory 环形缓冲区
 *    - 当群内触发兴趣词（干饭/五花肉/游戏/摸鱼/写代码/肥鱼）或 60s 内热聊刷屏且 `energy > 30` 时，请求 LLM 决策，若 `reply_decision == "ignore"` 则继续潜水
 * 4. 戳一戳聚合响应 (`poked_by_user`)：5000ms 聚合窗口后触发傲娇反击或反戳
 * 5. 开发者调试指令（零 Token 消耗）：`/fish status`、`/fish mem`、`/fish tick`
 *
 * @module dsh-onebot/social-arbiter
 */
import { homedir, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { MemoryManager, DEFAULT_MASTER_QQ } from './memory-manager.js';
import { DriveEngine, MessageDebounceBuffer, PokeAggregator } from './drive-engine.js';
import {
    buildCachedSystemPromptPrefix,
    buildDynamicTurnContext,
    parseActionResponse,
    MessageDispatcher,
} from './action-protocol.js';

const execAsync = promisify(exec);

/** 高兴趣群聊关键词正则 */
export const GROUP_INTEREST_REGEX = /(五花肉|白米饭|红烧肉|夜宵|烧烤|火锅|奶茶|干饭|好饿|饿了|美食|好吃|游戏|原神|启动|写代码|bug|报错|摸鱼|下班|放假|熬夜|肥鱼|大肥鱼|本鱼|小蓝鲸|老大)/i;

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

async function getSystemHardwareBrief() {
    let gpuInfo = '';
    try {
        const { stdout } = await execAsync('nvidia-smi --query-gpu=temperature.gpu,name --format=csv,noheader,nounits', { timeout: 2000 });
        const parts = stdout.trim().split(',');
        if (parts.length >= 2) gpuInfo = `${parts[1].trim()} ${parts[0].trim()}°C`;
    } catch {}
    const ramFreeGB = (freemem() / (1024 ** 3)).toFixed(1);
    return gpuInfo ? `GPU(${gpuInfo}), 可用内存 ${ramFreeGB}GB` : `可用内存 ${ramFreeGB}GB`;
}

export class SocialArbiter {
    /**
     * @param {object} bridge - ChatBridge 实例
     * @param {object} [options]
     */
    constructor(bridge, options = {}) {
        this.bridge = bridge;
        this.masterQQ = String(options.masterQQ || DEFAULT_MASTER_QQ);
        this.masterChatId = options.targetChat || `private:${this.masterQQ}`;
        this.groupChats = Array.isArray(options.targetChats) && options.targetChats.length > 0
            ? options.targetChats
            : ['group:927066977'];
        this.idleHours = options.idleHours ?? 2.0;
        this.groupLastActivityMap = new Map();
        this.startTime = Date.now();
        this.now = options.now ?? (() => Date.now());
        this.log = options.log ?? ((level, msg) => bridge?.deps?.log?.(level, msg) ?? console.log(`[FeiyuArbiter][${level}] ${msg}`));

        // 1. 初始化三层记忆管理器 (Step 3)
        this.memoryManager = options.memoryManager ?? new MemoryManager({
            filePath: options.memoryFilePath,
            masterQQ: this.masterQQ,
            now: this.now,
            llmReflector: (userId, profile, facts) => this.reflectProfileViaLLM(userId, profile, facts),
        });

        // 2. 初始化内驱力状态机 (Step 4)
        const initialDriveState = this.memoryManager.getPersistedDriveState() || {};
        this.driveEngine = options.driveEngine ?? new DriveEngine({
            initialState: initialDriveState,
            now: this.now,
            onStateChange: state => {
                this.memoryManager.saveDriveState(state);
            },
            onTick: state => {
                void this.onBackgroundDriveTick(state);
            },
        });

        // 3. 初始化拟人消息分发器 (Step 2)
        this.dispatcher = options.dispatcher ?? new MessageDispatcher({
            sendTextBubble: (chatId, text, sendOpts) => this.bridge.sendRawTextBubble
                ? this.bridge.sendRawTextBubble(chatId, text, sendOpts)
                : this.bridge.sendToChat(chatId, text, { ...sendOpts, bypassFeiyuInterceptor: true }),
            sendSegments: (chatId, segments) => this.bridge.sendSegments(chatId, segments),
            callOneBot: (action, params, chatId) => this.bridge.guardedConnectionCall
                ? this.bridge.guardedConnectionCall(action, params, chatId)
                : this.bridge.deps.connection.call(action, params),
            driveEngine: this.driveEngine,
            memoryManager: this.memoryManager,
            log: this.log,
            sleep: options.sleep,
        });

        // 4. 初始化私聊防抖缓冲池 (2000ms 防抖, 5000ms 最大等待)
        this.debounceBuffer = options.debounceBuffer ?? new MessageDebounceBuffer({
            debounceMs: options.debounceMs ?? 2000,
            maxWaitMs: options.maxWaitMs ?? 5000,
            now: this.now,
            onFlush: payload => {
                if (this.onDebouncedFlush) {
                    void this.onDebouncedFlush(payload);
                }
            },
        });

        // 5. 初始化戳一戳聚合器 (5000ms 聚合窗口)
        this.pokeAggregator = options.pokeAggregator ?? new PokeAggregator({
            windowMs: options.pokeWindowMs ?? 5000,
            onFlush: pokePayload => {
                void this.handlePokeEvent(pokePayload);
            },
        });

        // 6. 防骚扰与抢占状态
        const meta = this.memoryManager.data.meta || {};
        this.unansweredProactiveCount = Number(meta.unanswered_proactive_count ?? 0);
        this.proactiveCooldownUntilMs = Number(meta.proactive_cooldown_until_ms ?? 0);
        this.lastMasterLateNightMs = Number(meta.last_master_late_night_ms ?? 0);
        this.masterActivityEpoch = 0;
        this.activeProactiveAbort = null;
        this.isProactiveRunning = false;

        // 群聊插话冷却与近期消息时间戳统计
        this.groupCooldownUntilMap = new Map();
        this.groupBurstTimestamps = new Map();
        this.isGroupChimeRunning = false;

        // Fetch 注入点（方便单测 mock）
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }

    start() {
        this.driveEngine.start();
        this.log('info', `[FeiyuArbiter] v3.0 自主数字生命引擎已启动 (master=${this.masterChatId}, unanswered=${this.unansweredProactiveCount}/2)`);
    }

    stop() {
        this.driveEngine.stop();
        this.debounceBuffer.clear();
        this.pokeAggregator.clear();
        if (this.activeProactiveAbort) {
            this.activeProactiveAbort.abort();
            this.activeProactiveAbort = null;
        }
    }

    /**
     * 生成 60 ~ 120 分钟的随机全局主动冷却毫秒数
     */
    randomCooldownMs() {
        const minutes = 60 + Math.floor(Math.random() * 61);
        return minutes * 60_000;
    }

    persistArbiterMeta() {
        if (!this.memoryManager.data.meta) this.memoryManager.data.meta = {};
        this.memoryManager.data.meta.unanswered_proactive_count = this.unansweredProactiveCount;
        this.memoryManager.data.meta.proactive_cooldown_until_ms = this.proactiveCooldownUntilMs;
        this.memoryManager.data.meta.last_master_late_night_ms = this.lastMasterLateNightMs;
        this.memoryManager.saveSync();
    }

    /**
     * 当收到用户消息时调用：更新活动时间、清零未回复熔断计数、触发抢占中断、检测投喂关键词
     * @param {string} chatId
     * @param {string} [text]
     * @param {string} [userId]
     * @param {string} [nickname]
     */
    notifyUserActivity(chatId, text = '', userId = '', nickname = '') {
        if (!chatId) return { fed: false, wokeUpFromSleep: false };
        const nowMs = this.now();
        this.groupLastActivityMap.set(chatId, nowMs);
        const resolvedUserId = userId || (chatId.startsWith('private:') ? chatId.slice(8) : '');

        // 若是老大发来消息（私聊或群聊）：立刻递增 epoch 抢占任何正在生成/发送的主动私聊，并重置未回复计数器为 0
        if (resolvedUserId === this.masterQQ || chatId === this.masterChatId) {
            this.masterActivityEpoch += 1;
            if (this.activeProactiveAbort) {
                this.activeProactiveAbort.abort();
                this.activeProactiveAbort = null;
                this.log('info', '[FeiyuArbiter] 检测到老大发来新消息，已立即中断正在进行的主动私聊生成！');
            }
            if (this.unansweredProactiveCount > 0) {
                this.unansweredProactiveCount = 0;
                this.persistArbiterMeta();
            }
            // 记录老大是否在深夜 (23:30 ~ 04:00) 熬夜说话
            const d = new Date(nowMs);
            const mins = d.getHours() * 60 + d.getMinutes();
            if (mins >= 23 * 60 + 30 || mins <= 4 * 60) {
                this.lastMasterLateNightMs = nowMs;
                this.persistArbiterMeta();
            }
        }

        if (resolvedUserId) {
            this.memoryManager.touchUserInteraction(resolvedUserId, nickname);
        }
        if (text) {
            this.memoryManager.addWorkingMemory(chatId, {
                role: 'user',
                userId: resolvedUserId || 'unknown',
                nickname: nickname || resolvedUserId,
                text,
            });
        }

        const interactionRes = this.driveEngine.onUserMessage(text, new Date(nowMs));
        return interactionRes;
    }

    /**
     * 处理 OneBot Notice 事件（捕获 `notify.poke` 戳一戳）
     * @param {object} event
     */
    handleNoticeEvent(event) {
        if (!event || event.post_type !== 'notice') return false;
        const botId = this.bridge?.deps?.connection?.selfId || this.bridge?.deps?.config?.botQQ || '2163178914';
        return this.pokeAggregator.handleNotice(event, botId);
    }

    /**
     * 响应 5000ms 聚合后的戳一戳事件 (`poked_by_user`)
     * @param {{ event: string, chatId: string, userId: string, groupId: string, count: number }} pokePayload
     */
    async handlePokeEvent(pokePayload) {
        const { chatId, userId, count } = pokePayload;
        this.log('info', `[FeiyuArbiter] 收到聚合戳一戳事件: chat=${chatId}, user=${userId}, count=${count}`);

        const wokeUpFromSleep = this.driveEngine.isSleeping(new Date(this.now()));
        this.driveEngine.applyStatDelta({ boredom: -10 });

        const prompt = [
            `用户 (QQ: ${userId}) 刚刚在 5 秒内连续戳了你 ${count} 下！`,
            count >= 3
                ? '你被戳得脸颊鼓起、呆毛炸立，非常傲娇不服气，请立刻在 JSON 中输出 1~2 条短气泡吐槽并设置 qq_action.type = "poke" 反戳回去（或发 angry/fish_slap 表情包）！'
                : '请根据你当前的心情和生理状态，输出 JSON 动作协议回应这次戳一戳（可以傲娇哼唧、讨食、或者反戳回去）。',
            buildDynamicTurnContext({
                driveEngine: this.driveEngine,
                memoryManager: this.memoryManager,
                chatId,
                userId,
                queryText: '戳一戳',
                eventPayload: pokePayload,
                wokeUpFromSleep,
            }),
        ].join('\n');

        const rawJson = await this.callDeepSeekAction(userId, prompt);
        let action = parseActionResponse(rawJson);
        if (!rawJson || (action.reply_decision === 'ignore' && action.messages.length === 0)) {
            action = {
                isStructured: true,
                inner_thought: `被连续戳了 ${count} 下，本鱼必须傲娇反击！`,
                reply_decision: 'send_message',
                messages: count >= 3
                    ? [`哼！连戳本鱼 ${count} 下干嘛啦`, '再戳肚皮本鱼要拿尾巴拍你了捏']
                    : ['干嘛戳本鱼的脸颊啦，哼'],
                qq_action: { type: 'poke', meme_tag: 'angry' },
                memory_to_save: { should_save: false, importance: 1, summary: '' },
                stat_delta: { affection: 1, boredom: -10, hunger: 0 },
            };
        }
        await this.dispatcher.dispatch(chatId, action, { userId });
    }

    /**
     * 后台每分钟生理心跳回调：检查是否触发主动私聊 (`proactive_dm_tick`) 与群聊冷场暖场 (`group_idle_bubble`)
     * @param {object} state
     */
    async onBackgroundDriveTick(state) {
        if (!this.isProactiveRunning) {
            const check = this.evaluateProactiveDmTrigger(state, false);
            if (check.shouldTrigger) {
                await this.triggerProactiveDm({ force: false, reason: check.reason });
            }
        }
        await this.checkGroupIdleTick();
    }

    /**
     * 群聊冷场巡检：检查是否有群聊连续超过 idleHours (默认 2 小时) 无人发言
     * 处于 09:00 ~ 23:00 时段时，主动发送搞怪暖场气泡打破冷场（严禁发抖音）
     */
    async checkGroupIdleTick() {
        if (this.isGroupChimeRunning) return;
        const nowMs = this.now();
        const d = new Date(nowMs);
        const hour = d.getHours();
        if (hour < 9 || hour >= 23) return;

        const thresholdMs = (this.idleHours || 2.0) * 3600_000;
        for (const chatId of this.groupChats) {
            const lastTime = this.groupLastActivityMap.get(chatId) || this.startTime;
            const idleMs = nowMs - lastTime;
            if (idleMs >= thresholdMs) {
                this.log('info', `[FeiyuArbiter] 检测到群聊 ${chatId} 已冷场 ${(idleMs / 3600_000).toFixed(1)} 小时，触发主动暖场冒泡！`);
                try {
                    await this.triggerGroupIdleBubble(chatId);
                } catch (e) {
                    this.log('warn', `[FeiyuArbiter] 群聊冷场冒泡异常: ${e?.message || e}`);
                } finally {
                    this.groupLastActivityMap.set(chatId, this.now());
                }
            }
        }
    }

    async triggerGroupIdleBubble(chatId) {
        const prompt = [
            `【系统内部事件：group_idle_bubble（群聊冷场 2 小时主动暖场冒泡）】`,
            `群聊 ${chatId} 已经安静冷场超过 2 小时了，群友们都在潜水没说话。`,
            `你作为群里的傲娇团宠大肥鱼，现在主动冒个泡，打破冷场，发 1~2 条简短沙雕/傲娇/搞怪的文案活跃气氛（绝不发抖音！不要长篇大论，每条 <= 25 字，句尾不加句号）。`,
            `可搭配 send_meme，挑选一张符合你傲娇/摸鱼/干饭心境的大肥鱼表情包！`,
            buildDynamicTurnContext({
                driveEngine: this.driveEngine,
                memoryManager: this.memoryManager,
                chatId,
                userId: this.masterQQ,
                eventPayload: { event: 'group_idle_bubble', idleHours: this.idleHours || 2.0 },
            }),
        ].join('\n');

        const rawJson = await this.callDeepSeekAction(this.masterQQ, prompt);
        if (!rawJson) return false;

        const action = parseActionResponse(rawJson);
        if (action.reply_decision === 'ignore') {
            action.reply_decision = 'send_message';
            if (!action.messages || action.messages.length === 0) {
                action.messages = ['群里好安静，你们是在背着本鱼集体偷偷吃好吃的吗 (=｀ω´=)'];
            }
        }

        await this.dispatcher.dispatch(chatId, action, {
            userId: this.masterQQ,
        });
        this.log('info', `[FeiyuArbiter] 群聊 ${chatId} 冷场主动冒泡成功发送！`);
        return true;
    }

    /**
     * 评估当前是否满足主动私聊老大的条件（含防骚扰熔断与冷却锁检查）
     * @param {object} [state]
     * @param {boolean} [force]
     */
    evaluateProactiveDmTrigger(state = this.driveEngine.getState(), force = false) {
        const nowMs = this.now();
        const nowDate = new Date(nowMs);

        if (!force) {
            // 1. 睡眠锁：01:30 ~ 07:30 绝不主动发起话题
            if (this.driveEngine.isSleeping(nowDate)) {
                return { shouldTrigger: false, lockedBy: 'sleeping', reason: '深夜睡眠时段 (01:30~07:30)' };
            }
            // 2. 未回复熔断器：连续 2 次主动私聊未获回复，彻底锁死主动私聊
            if (this.unansweredProactiveCount >= 2) {
                return {
                    shouldTrigger: false,
                    lockedBy: 'circuit_breaker',
                    reason: `未回复熔断已锁定 (${this.unansweredProactiveCount}/2)，等待老大回复后解锁`,
                };
            }
            // 3. 全局冷却锁：60 ~ 120 分钟随机冷却
            if (nowMs < this.proactiveCooldownUntilMs) {
                const remainMin = Math.ceil((this.proactiveCooldownUntilMs - nowMs) / 60_000);
                return {
                    shouldTrigger: false,
                    lockedBy: 'cooldown',
                    reason: `全局冷却中（剩余 ${remainMin} 分钟）`,
                };
            }
        }

        const profile = this.memoryManager.getSemanticProfile(this.masterQQ);
        const lastChatMs = profile.last_interaction_time ? Date.parse(profile.last_interaction_time) : 0;
        const idleHours = lastChatMs > 0 ? (nowMs - lastChatMs) / 3600_000 : 99;

        // 触发条件 A：饥饿度极低 (hunger < 15) 主动找老大讨食
        if (state.hunger < 15) {
            return {
                shouldTrigger: true,
                reason: `肚子快饿扁了 (hunger=${state.hunger.toFixed(0)})，主动找老大讨要脆皮五花肉和白米饭`,
            };
        }

        // 触发条件 B：无聊度极高 (boredom > 85) 且距上次和老大聊天超过 4 小时
        if (state.boredom > 85 && idleHours >= 4) {
            return {
                shouldTrigger: true,
                reason: `无聊度爆表 (boredom=${state.boredom.toFixed(0)}) 且老大已超过 ${idleHours.toFixed(1)} 小时没理本鱼`,
            };
        }

        // 触发条件 C：老大昨晚深夜熬夜，今天早上 09:30 后还没动静
        if (this.lastMasterLateNightMs > 0 && nowDate.getHours() >= 9) {
            const lastNightDate = new Date(this.lastMasterLateNightMs);
            if (lastNightDate.getDate() !== nowDate.getDate() && idleHours >= 6) {
                return {
                    shouldTrigger: true,
                    reason: '老大昨晚熬夜很晚，今天还没冒泡，主动关心问候老大起床没',
                };
            }
        }

        if (force) {
            return {
                shouldTrigger: true,
                reason: '管理员手动执行 /fish tick 强制触发主动思考与私聊测试',
            };
        }

        return { shouldTrigger: false, lockedBy: 'none', reason: '生理数值尚平稳，暂不打扰老大' };
    }

    /**
     * 执行主动私聊破冰 (`proactive_dm_tick`)，包含完整的抢占取消与防骚扰计数更新
     * @param {{ force?: boolean, reason?: string, chatId?: string }} [opts]
     */
    async triggerProactiveDm(opts = {}) {
        const force = Boolean(opts.force);
        const targetChatId = opts.chatId || this.masterChatId;
        const check = this.evaluateProactiveDmTrigger(this.driveEngine.getState(), force);
        if (!check.shouldTrigger) {
            return { triggered: false, reason: check.reason };
        }

        if (this.isProactiveRunning) {
            return { triggered: false, reason: '已有主动私聊任务正在运行' };
        }

        this.isProactiveRunning = true;
        const startEpoch = this.masterActivityEpoch;
        const abortController = new AbortController();
        this.activeProactiveAbort = abortController;

        try {
            const reason = opts.reason || check.reason;
            this.log('info', `[FeiyuArbiter] 触发主动私聊思考 (force=${force}): ${reason}`);

            const hwBrief = await getSystemHardwareBrief();
            const prompt = [
                `【系统内部事件：proactive_dm_tick（主动找老大私聊破冰）】`,
                `触发原因：${reason}`,
                `顺带感知到的电脑状态：${hwBrief}`,
                `请以大肥鱼的傲娇/贪吃/粘人本色，主动给老大发 1~3 条短气泡（每条 <= 25 字，句尾不加句号），可以撒娇抱怨无聊、讨要脆皮五花肉/白米饭、关心老大、或者顺便提一句帮老大巡检了电脑状态。`,
                `必须严格输出 JSON Action Schema！`,
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId: targetChatId,
                    userId: this.masterQQ,
                    queryText: reason,
                    eventPayload: { event: 'proactive_dm_tick', reason, force },
                }),
            ].join('\n');

            const rawJson = await this.callDeepSeekAction(this.masterQQ, prompt, abortController.signal);

            // 抢占检查 1：LLM 生成期间老大是否发来了消息？
            if (this.masterActivityEpoch !== startEpoch || abortController.signal.aborted) {
                this.log('info', '[FeiyuArbiter] 主动私聊生成完毕时检测到老大已先开口，废弃本次主动消息');
                return { triggered: false, aborted: true, reason: 'preempted_by_user' };
            }

            let action = parseActionResponse(rawJson);
            if (!rawJson || action.reply_decision === 'ignore' || (action.messages.length === 0 && action.reply_decision === 'send_message')) {
                const state = this.driveEngine.getState();
                action = {
                    isStructured: true,
                    inner_thought: `主动找老大：${reason}`,
                    reply_decision: 'send_message',
                    messages: state.hunger < 25
                        ? ['老大老大，本鱼肚皮都快饿扁了捏', '什么时候赏本鱼一碗脆皮五花肉拌大米饭呀']
                        : ['哼，老大忙什么呢这么久不理本鱼', `本鱼刚才顺便巡检了下电脑（${hwBrief}），快夸我`],
                    qq_action: { type: 'send_meme', meme_tag: state.hunger < 25 ? 'begging_food' : 'happy' },
                    memory_to_save: { should_save: false, importance: 1, summary: '' },
                    stat_delta: { affection: 1, boredom: -30, hunger: 0 },
                };
            }

            // 执行拟人气泡分发（注入实时抢占钩子）
            const dispatchRes = await this.dispatcher.dispatch(targetChatId, action, {
                userId: this.masterQQ,
                shouldAbort: () => this.masterActivityEpoch !== startEpoch || abortController.signal.aborted,
            });

            if (dispatchRes.aborted) {
                return { triggered: false, aborted: true, reason: 'preempted_during_dispatch' };
            }

            // 更新未回复熔断计数器与 60~120 分钟随机全局冷却锁
            this.unansweredProactiveCount += 1;
            this.proactiveCooldownUntilMs = this.now() + this.randomCooldownMs();
            this.driveEngine.applyStatDelta({ boredom: -35 });
            this.lastMasterLateNightMs = 0;
            this.persistArbiterMeta();

            return {
                triggered: true,
                action,
                sentIds: dispatchRes.sentIds,
                unansweredCount: this.unansweredProactiveCount,
            };
        } catch (err) {
            this.log('warn', `[FeiyuArbiter] 主动私聊异常降级: ${err?.message || err}`);
            return { triggered: false, error: String(err?.message || err) };
        } finally {
            this.isProactiveRunning = false;
            if (this.activeProactiveAbort === abortController) {
                this.activeProactiveAbort = null;
            }
        }
    }

    /**
     * 群聊潜伏吃瓜与智能插话评估 (`group_chime_in_check`)
     * @param {object} inbound - NormalizedInbound
     * @returns {Promise<boolean>} - 若返回 true 表示已由智能插话接管响应，外层无需走普通唤醒流
     */
    async evaluateGroupLurkAndChime(inbound) {
        const { chatId, groupId, userId, nickname, text } = inbound;
        const cleanText = String(text || '').trim();
        if (!cleanText) return false;

        const nowMs = this.now();
        // 记录最近 60 秒内的群消息时间戳（用于判断热聊刷屏）
        const tsList = (this.groupBurstTimestamps.get(groupId) || []).filter(t => nowMs - t < 60_000);
        tsList.push(nowMs);
        this.groupBurstTimestamps.set(groupId, tsList);

        // 睡眠中、精力不足 (energy <= 30) 或正在插话中，保持安静潜水
        if (this.driveEngine.isSleeping(new Date(nowMs))) return false;
        if (this.driveEngine.state.energy <= 30) return false;
        if (this.isGroupChimeRunning) return false;

        // 检查群插话冷却
        const cooldownUntil = this.groupCooldownUntilMap.get(chatId) || 0;
        if (nowMs < cooldownUntil) return false;

        const hitInterestKeyword = GROUP_INTEREST_REGEX.test(cleanText);
        const isHotBurst = tsList.length >= 5;

        if (!hitInterestKeyword && !isHotBurst) return false;

        // 兴趣词命中时 45% 概率触发 LLM 评估；刷屏热聊时 25% 概率触发评估
        const triggerProb = hitInterestKeyword ? 0.45 : 0.25;
        if (Math.random() > triggerProb) return false;

        this.isGroupChimeRunning = true;
        try {
            const recentMsgs = this.memoryManager.getWorkingMemory(chatId).slice(-10);
            const historyBlock = recentMsgs
                .map(m => `[${m.nickname || m.userId}]: ${m.text}`)
                .join('\n');

            const prompt = [
                `【系统内部事件：group_chime_in_check（群聊潜伏吃瓜插话评估）】`,
                `当前群号：${groupId}，刚刚群友 [${nickname}(${userId})] 说了："${cleanText}"`,
                `近期群聊上下文：\n${historyBlock}`,
                `判断准则：`,
                `1. 如果群友在聊美食（尤其五花肉/白米饭/夜宵）、游戏、摸鱼、或者提到了本鱼/老大，且你觉得插一句嘴会很有趣，请将 reply_decision 设为 "send_message"（或 "meme_only"），输出 1~2 条超短沙雕/傲娇吐槽（每条 <= 20 字，不加句号）。`,
                `2. 如果话题严肃、或者你不感兴趣、或者插话会显得突兀打扰别人，请务必将 reply_decision 设为 "ignore"，保持高冷潜水！`,
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId,
                    userId,
                     nickname,
                    queryText: cleanText,
                    eventPayload: { event: 'group_chime_in_check', hitInterestKeyword, isHotBurst },
                }),
            ].join('\n');

            const rawJson = await this.callDeepSeekAction(userId, prompt);
            if (!rawJson) return false;

            const action = parseActionResponse(rawJson);
            if (action.reply_decision === 'ignore') {
                this.log('debug', `[FeiyuArbiter] 群 ${groupId} 插话评估结果: ignore (${action.inner_thought})`);
                return true;
            }

            // 设置 15 ~ 30 分钟群聊插话冷却，防止群内刷屏
            const groupCooldownMs = (15 + Math.floor(Math.random() * 16)) * 60_000;
            this.groupCooldownUntilMap.set(chatId, this.now() + groupCooldownMs);

            await this.dispatcher.dispatch(chatId, action, {
                userId,
                replyToMessageId: inbound.messageId,
            });
            return true;
        } catch (err) {
            this.log('debug', `[FeiyuArbiter] 群聊插话评估异常: ${err?.message || err}`);
            return false;
        } finally {
            this.isGroupChimeRunning = false;
        }
    }

    /**
     * 管理员调试指令：`/fish status` | `/fish mem` | `/fish tick`
     * 前两条指令纯内存读取，消耗 0 LLM Token！
     * @param {string} chatId
     * @param {string} subCommand
     */
    async handleFishCommand(chatId, subCommand = 'status') {
        const sub = String(subCommand || 'status').trim().toLowerCase().split(/\s+/)[0] || 'status';

        if (sub === 'status') {
            const st = this.driveEngine.getState();
            const profile = this.memoryManager.getSemanticProfile(this.masterQQ);
            const nowMs = this.now();
            const sleeping = this.driveEngine.isSleeping(new Date(nowMs));
            const cooldownRemainMin = this.proactiveCooldownUntilMs > nowMs
                ? Math.ceil((this.proactiveCooldownUntilMs - nowMs) / 60_000)
                : 0;
            const circuitLocked = this.unansweredProactiveCount >= 2;

            const report = [
                '🐟 【大肥鱼 v3.0 实时内驱力与风控面板 (/fish status)】',
                `• 生理心境 (mood)   : ${st.mood}${sleeping ? ' 💤(睡眠期 01:30~07:30)' : ''}`,
                `• 饱食度 (hunger)   : ${st.hunger} / 100 ${st.hunger < 20 ? '⚠️(饿扁讨食中)' : ''}`,
                `• 精力值 (energy)   : ${st.energy} / 100`,
                `• 无聊度 (boredom)  : ${st.boredom} / 100 ${st.boredom > 85 ? '🔥(渴望找老大)' : ''}`,
                `• 老大好感度        : ${profile.affection} / 100 (${profile.relationship_tag})`,
                `• 未回复熔断计数    : ${this.unansweredProactiveCount} / 2 ${circuitLocked ? '🔒(已触发防骚扰熔断，待老大回复解锁)' : '🟢(正常)'}`,
                `• 主动破冰冷却锁    : ${cooldownRemainMin > 0 ? `⏳ 剩余 ${cooldownRemainMin} 分钟` : '🟢 已就绪'}`,
            ].join('\n');

            await this.bridge.sendToChat(chatId, report, { bypassFeiyuInterceptor: true });
            return report;
        }

        if (sub === 'mem' || sub === 'memory') {
            const profile = this.memoryManager.getSemanticProfile(this.masterQQ);
            const recentEp = this.memoryManager.getRecentEpisodicMemories(5);
            const epLines = recentEp.length > 0
                ? recentEp.map((m, idx) => `  ${idx + 1}. [重要度:${m.importance}/10 | ${m.created_at.slice(0, 10)}] ${m.summary}`).join('\n')
                : '  （暂无已沉淀的高重要度情景记忆）';

            const report = [
                '🧠 【大肥鱼 v3.0 三层记忆检视面板 (/fish mem)】',
                '▍语义记忆 (Semantic Memory - 老大档案)',
                `• QQ / 称呼 : ${profile.user_id} (${profile.nickname})`,
                `• 关系标签  : ${profile.relationship_tag} (好感度: ${profile.affection}/100)`,
                `• 核心画像  :\n  - ${(profile.known_facts || []).slice(0, 8).join('\n  - ')}`,
                '',
                '▍最近 5 条情景记忆 (Episodic Memory)',
                epLines,
            ].join('\n');

            await this.bridge.sendToChat(chatId, report, { bypassFeiyuInterceptor: true });
            return report;
        }

        if (sub === 'tick') {
            await this.bridge.sendToChat(chatId, '⚡ 正在无视冷却锁强制触发一次大肥鱼主动思考与破冰测试 (`/fish tick`)...', {
                bypassFeiyuInterceptor: true,
            });
            const res = await this.triggerProactiveDm({ force: true, chatId });
            return res;
        }

        const usage = '用法：\n/fish status — 查看饥饿度/精力/无聊度/好感度及防骚扰冷却锁\n/fish mem — 查看老大语义档案与最近 5 条情景记忆\n/fish tick — 无视冷却锁立即触发一次主动私聊测试';
        await this.bridge.sendToChat(chatId, usage, { bypassFeiyuInterceptor: true });
        return usage;
    }

    /**
     * 调用 DeepSeek 生成结构化 JSON Action（遵循 Context Caching 前缀排布）
     * @param {string} userId
     * @param {string} dynamicUserPrompt
     * @param {AbortSignal} [externalSignal]
     */
    async callDeepSeekAction(userId, dynamicUserPrompt, externalSignal) {
        const apiKey = getDeepSeekApiKey();
        if (!apiKey) return null;

        const systemPrefix = buildCachedSystemPromptPrefix(this.memoryManager, userId);
        const timeoutSignal = AbortSignal.timeout(20_000);
        const signal = externalSignal && typeof AbortSignal.any === 'function'
            ? AbortSignal.any([externalSignal, timeoutSignal])
            : (externalSignal || timeoutSignal);

        try {
            const res = await this.fetchImpl('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: systemPrefix },
                        { role: 'user', content: dynamicUserPrompt },
                    ],
                    temperature: 0.85,
                    max_tokens: 450,
                }),
                signal,
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.choices?.[0]?.message?.content?.trim() || null;
        } catch (err) {
            this.log('debug', `[FeiyuArbiter] callDeepSeekAction 失败或中断: ${err?.message || err}`);
            return null;
        }
    }

    /**
     * 异步重整压缩用户画像 (`reflectUserProfile` LLM 回调)
     */
    async reflectProfileViaLLM(userId, profile, facts) {
        const apiKey = getDeepSeekApiKey();
        if (!apiKey) return null;
        try {
            const res = await this.fetchImpl('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    response_format: { type: 'json_object' },
                    messages: [
                        {
                            role: 'system',
                            content: '你是记忆提炼器。请将以下关于目标用户的多条碎片事实去重、合并为不超过 6 条精炼的长期特征列表，输出 JSON: {"known_facts": ["事实1", "事实2"]}',
                        },
                        {
                            role: 'user',
                            content: JSON.stringify({ user_id: userId, facts }),
                        },
                    ],
                    temperature: 0.3,
                    max_tokens: 300,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) return null;
            const data = await res.json();
            const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
            return Array.isArray(parsed.known_facts) ? parsed.known_facts : null;
        } catch {
            return null;
        }
    }
}
