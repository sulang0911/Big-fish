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
import { browseFavoriteSite } from './browser-douyin.js';

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
        this.groupIdleThresholdMap = new Map();
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
            storePath: options.driveFilePath,
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
        this.lastProactiveDmSentAt = Number(meta.last_proactive_dm_sent_at ?? 0);
        this.lastSelfSurfAt = Number(meta.last_self_surf_at ?? 0);
        this.isSelfSurfing = false;
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

    /**
     * 生成 2.0 ~ 2.5 小时（120 ~ 150 分钟）的随机群聊冷场冒泡阈值毫秒数
     */
    rollGroupIdleThresholdMs() {
        return Math.round((2.0 + Math.random() * 0.5) * 3600_000);
    }

    persistArbiterMeta() {
        if (!this.memoryManager.data.meta) this.memoryManager.data.meta = {};
        this.memoryManager.data.meta.unanswered_proactive_count = this.unansweredProactiveCount;
        this.memoryManager.data.meta.proactive_cooldown_until_ms = this.proactiveCooldownUntilMs;
        this.memoryManager.data.meta.last_master_late_night_ms = this.lastMasterLateNightMs;
        this.memoryManager.data.meta.last_proactive_dm_sent_at = this.lastProactiveDmSentAt;
        this.memoryManager.data.meta.last_self_surf_at = this.lastSelfSurfAt;
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
        if (String(chatId).startsWith('group:') && !this.groupChats.includes(chatId)) {
            this.groupChats.push(chatId);
        }
        this.groupLastActivityMap.set(chatId, nowMs);
        this.groupIdleThresholdMap.set(chatId, this.rollGroupIdleThresholdMs());
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
            // 若老大让大肥鱼“自己去玩 / 自己逛网站 / 我先忙”，立即触发大肥鱼自主打开浏览器逛喜欢的网站
            const cleanMasterText = String(text || '').trim();
            if (
                cleanMasterText &&
                !cleanMasterText.startsWith('/') &&
                /(自己玩|自己去玩|你自己玩|自己逛|去逛网站|去逛网页|自己去逛|去刷网页|自己上网|我先忙|我在忙|没空陪你|自己待会)/i.test(cleanMasterText)
            ) {
                this.log('info', `[FeiyuArbiter] 老大让大肥鱼自己玩 ("${cleanMasterText}")，准备打开浏览器逛喜欢的网站...`);
                setTimeout(() => {
                    void this.triggerSelfSurfWeb({
                        chatId,
                        reason: 'boss_told_to_play',
                        siteHint: cleanMasterText,
                    });
                }, 1500);
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
            } else {
                // 若已经找过老大但老大超过 15 分钟没空理大肥鱼，且大肥鱼依然无聊 (boredom > 65)，自动打开浏览器自己逛喜欢的网站！
                const nowMs = this.now();
                if (
                    !this.isSelfSurfing &&
                    !this.driveEngine.isSleeping(new Date(nowMs)) &&
                    this.unansweredProactiveCount >= 1 &&
                    state.boredom > 65 &&
                    this.lastProactiveDmSentAt > 0 &&
                    (nowMs - this.lastProactiveDmSentAt) >= 15 * 60_000 &&
                    (nowMs - this.lastSelfSurfAt) >= 60 * 60_000
                ) {
                    await this.triggerSelfSurfWeb({
                        chatId: this.masterChatId,
                        reason: 'boss_unanswered',
                    });
                }
            }
        }
        await this.checkGroupIdleTick();
    }

    /**
     * 群聊冷场巡检：检查是否有群聊连续超过 2.0 ~ 2.5 小时（随机）无人发言
     * 每天 21:00 到次日 09:00 免打扰不冒泡；处于 09:00 ~ 21:00 时段时主动发送搞怪暖场气泡打破冷场
     */
    async checkGroupIdleTick() {
        if (this.isGroupChimeRunning) return;
        const nowMs = this.now();
        const d = new Date(nowMs);
        const hour = d.getHours();
        // 每天 21:00 到次日 09:00 不冒泡
        if (hour < 9 || hour >= 21) return;

        const todayNineAmMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0, 0).getTime();
        const st = this.driveEngine.getState();
        const isHighBoredom = st.boredom > 80 && st.energy > 30;

        for (const chatId of this.groupChats) {
            const rawLastTime = this.groupLastActivityMap.get(chatId) || this.startTime;
            // 早间 09:00 解禁后从 09:00 起算冷场时长，避免每天 09:00 准点机械冒泡
            const lastTime = Math.max(rawLastTime, todayNineAmMs);
            let thresholdMs = this.groupIdleThresholdMap.get(chatId);
            if (!thresholdMs) {
                thresholdMs = this.rollGroupIdleThresholdMs();
                this.groupIdleThresholdMap.set(chatId, thresholdMs);
            }
            const idleMs = nowMs - lastTime;
            const cooldownUntil = this.groupCooldownUntilMap.get(chatId) || 0;

            // 触发分支 A：高无聊度 (boredom > 80 且精力 > 30)，群内安静满 25~40 分钟即主动冒泡找群友求陪聊
            const boredomWaitMs = 30 * 60_000;
            const hitBoredomTrigger = isHighBoredom && idleMs >= boredomWaitMs && nowMs >= cooldownUntil;
            // 触发分支 B：常规 2.0 ~ 2.5 小时随机冷场破冰
            const hitIdleTrigger = idleMs >= thresholdMs;

            if (hitBoredomTrigger || hitIdleTrigger) {
                const idleHoursText = (idleMs / 3600_000).toFixed(2);
                const mode = hitBoredomTrigger && !hitIdleTrigger ? 'high_boredom' : 'idle';
                this.log('info', `[FeiyuArbiter] 群聊 ${chatId} 触发主动冒泡 (mode=${mode}, boredom=${st.boredom}, idle=${idleHoursText}h)`);
                try {
                    await this.triggerGroupIdleBubble(chatId, Number(idleHoursText), mode);
                } catch (e) {
                    this.log('warn', `[FeiyuArbiter] 群聊主动冒泡异常: ${e?.message || e}`);
                } finally {
                    this.groupLastActivityMap.set(chatId, this.now());
                    this.groupIdleThresholdMap.set(chatId, this.rollGroupIdleThresholdMs());
                    this.groupCooldownUntilMap.set(chatId, this.now() + Math.round(this.randFloat(30, 50) * 60_000));
                }
            }
        }
    }

    async triggerGroupIdleBubble(chatId, idleHours = 2.2, mode = 'idle') {
        const st = this.driveEngine.getState();
        const prompt = mode === 'high_boredom'
            ? [
                `【系统内部事件：group_boredom_bubble（大肥鱼无聊度爆表主动在群里找人玩）】`,
                `当前你的无聊度高达 ${st.boredom}/100，尾巴都快无聊得长蘑菇了！群聊 ${chatId} 刚好安静了一会儿。`,
                `请以傲娇团宠大肥鱼的口吻，主动在群里发 1~2 条简短搞怪的气泡（每条 <= 25 字，句尾不加句号），抱怨无聊、问大家在干嘛、或者傲娇地让人来摸鱼头/投喂你！`,
                `可搭配 send_meme，挑选一张符合你无聊/求关注心境的表情包！`,
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId,
                    userId: this.masterQQ,
                    eventPayload: { event: 'group_boredom_bubble', boredom: st.boredom, idleHours },
                }),
            ].join('\n')
            : [
                `【系统内部事件：group_idle_bubble（群聊冷场主动暖场冒泡）】`,
                `群聊 ${chatId} 已经安静冷场约 ${idleHours} 小时了，群友们都在潜水没说话。`,
                `你作为群里的傲娇团宠大肥鱼，现在主动冒个泡，打破冷场，发 1~2 条简短沙雕/傲娇/搞怪的文案活跃气氛（绝不发抖音！不要长篇大论，每条 <= 25 字，句尾不加句号）。`,
                `可搭配 send_meme，挑选一张符合你傲娇/摸鱼/干饭心境的大肥鱼表情包！`,
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId,
                    userId: this.masterQQ,
                    eventPayload: { event: 'group_idle_bubble', idleHours },
                }),
            ].join('\n');

        const rawJson = await this.callDeepSeekAction(this.masterQQ, prompt);
        if (!rawJson) return false;

        const action = parseActionResponse(rawJson);
        if (action.reply_decision === 'ignore') {
            action.reply_decision = 'send_message';
            if (!action.messages || action.messages.length === 0) {
                action.messages = mode === 'high_boredom'
                    ? ['好无聊捏，本鱼的尾巴都要长蘑菇了，都没人出来陪本鱼唠嗑吗']
                    : ['群里好安静，你们是在背着本鱼集体偷偷吃好吃的吗 (=｀ω´=)'];
            }
        }

        await this.dispatcher.dispatch(chatId, action, {
            userId: this.masterQQ,
        });
        // 主动在群里冒泡发泄后，无聊度随机回落 22 ~ 36 点
        this.driveEngine.applyStatDelta({ boredom: -this.randFloat(22, 36) });
        this.log('info', `[FeiyuArbiter] 群聊 ${chatId} 主动冒泡 (${mode}) 成功发送！`);
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

        // 触发条件 B：无聊时优先找老大 (boredom > 75 且尚未被冷落，或距上次聊天 >= 2 小时)
        if (state.boredom > 75 && (this.unansweredProactiveCount === 0 || idleHours >= 2)) {
            return {
                shouldTrigger: true,
                reason: `觉得无聊了 (boredom=${state.boredom.toFixed(0)})，优先找老大陪本鱼玩`,
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

            // 更新未回复熔断计数器与 60~120 分钟随机全局冷却锁（记录发送时间，若老大 15 分钟未回复则肥鱼自己去逛网站）
            this.unansweredProactiveCount += 1;
            this.lastProactiveDmSentAt = this.now();
            this.proactiveCooldownUntilMs = this.now() + this.randomCooldownMs();
            this.driveEngine.applyStatDelta({ boredom: -10 });
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
     * 大肥鱼自主打开浏览器逛喜欢的网站（当找老大没被搭理、或老大让它自己玩时触发）
     * 若遇到需要登录的网站，自动截图发给老大并在桌面弹出可见 Chrome 请老大登录！
     * @param {{ chatId?: string, reason?: string, siteHint?: string, visible?: boolean, surfRunner?: Function }} [opts]
     */
    async triggerSelfSurfWeb(opts = {}) {
        if (this.isSelfSurfing) {
            return { triggered: false, reason: 'already_surfing' };
        }
        this.isSelfSurfing = true;
        const targetChatId = opts.chatId || this.masterChatId;
        const runner = opts.surfRunner || browseFavoriteSite;

        try {
            this.lastSelfSurfAt = this.now();
            this.persistArbiterMeta();

            const res = await runner({
                siteHint: opts.siteHint || '',
                visible: opts.visible ?? false,
                openDesktopOnLogin: opts.openDesktopOnLogin ?? true,
            });

            if (!res || !res.success) {
                return { triggered: false, error: res?.error || 'surf_failed' };
            }

            // 情况 1：该网站需要登录！向老大发截图求助，并已在桌面弹出可见浏览器窗口
            if (res.needsLogin) {
                const loginMsg = [
                    `🌐 【大肥鱼上网求助】`,
                    `老大老大！本鱼刚刚自己打开浏览器想逛【${res.siteName}】玩的，结果${res.loginReason || '弹出来要登录'}捏 🥺`,
                    `我已经把登录画面截屏发给你（同时在电脑桌面上打开了浏览器窗口），老大有空帮本鱼扫个码或者登一下账号嘛！`,
                ].join('\n');
                await this.bridge.sendToChat(targetChatId, loginMsg, { bypassFeiyuInterceptor: true });
                if (res.screenshotBase64 && this.bridge.sendSegments) {
                    await this.bridge.sendSegments(targetChatId, [
                        { type: 'image', data: { file: `base64://${res.screenshotBase64}` } },
                    ]);
                }
                return { triggered: true, needsLogin: true, siteName: res.siteName, url: res.url };
            }

            // 情况 2：无需登录（或已登录），开心逛完网站，记录到小本本并大幅降低无聊度！
            const boredomDrop = -this.randFloat(25, 38);
            const energyDrop = -this.randFloat(1, 2.5);
            this.driveEngine.applyStatDelta({ boredom: boredomDrop, energy: energyDrop });

            const topTopics = (res.headlines || []).slice(0, 3);
            const topicText = topTopics.length > 0
                ? topTopics.map(t => `「${t}」`).join('、')
                : `【${res.category}】专栏`;

            // 写入大肥鱼日记与最新发现（/fish diary 可直接偷看到）
            this.driveEngine.state.current_obsession = `刚自己逛了${res.siteName}，对${topTopics[0] ? `「${topTopics[0]}」` : res.category}念念不忘`;
            this.driveEngine.state.diary = `老大忙的时候本鱼自己打开浏览器逛了【${res.siteName}】，看到了 ${topicText}，超有趣！(｡•̀ᴗ-)✧`;
            if (!Array.isArray(this.driveEngine.state.recent_discoveries)) {
                this.driveEngine.state.recent_discoveries = [];
            }
            this.driveEngine.state.recent_discoveries.unshift(`在【${res.siteName}】自己冲浪发现了：${topicText}`);
            this.driveEngine.state.recent_discoveries = this.driveEngine.state.recent_discoveries.slice(0, 5);
            this.driveEngine.save();

            const prefixLine = opts.reason === 'boss_unanswered'
                ? `哼，刚才找老大玩老大没空理本鱼，本鱼就自己打开浏览器溜去逛【${res.siteName}】解闷啦！`
                : `好耶！本鱼自己打开浏览器去逛了一圈最喜欢的【${res.siteName}】（${res.category}）~`;

            const surfMsg = [
                `🌐 【大肥鱼自主冲浪报告】`,
                prefixLine,
                `• 逛到的好玩内容: ${topicText}`,
                `• 状态变化: 无聊度 ${boredomDrop} (当前 ${this.driveEngine.state.boredom}/100) | 已记入秘密小本本 (/fish diary)`,
            ].join('\n');

            await this.bridge.sendToChat(targetChatId, surfMsg, { bypassFeiyuInterceptor: true });
            if (res.screenshotBase64 && this.bridge.sendSegments) {
                await this.bridge.sendSegments(targetChatId, [
                    { type: 'image', data: { file: `base64://${res.screenshotBase64}` } },
                ]);
            }
            return { triggered: true, needsLogin: false, siteName: res.siteName, headlines: topTopics };
        } catch (err) {
            this.log('warn', `[FeiyuArbiter] 自主逛网站异常: ${err?.message || err}`);
            return { triggered: false, error: String(err?.message || err) };
        } finally {
            this.isSelfSurfing = false;
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
        const boredom = Number(this.driveEngine.state.boredom) || 0;
        const isHighBoredomChime = boredom >= 65 && !/^\/fish(?:\s|$)/i.test(cleanText);

        if (!hitInterestKeyword && !isHotBurst && !isHighBoredomChime) return false;

        // 基础概率：兴趣词 45%，刷屏热聊 25%，高无聊度闲聊接话 15%~35%；当无聊度 > 60 时整体插话欲望动态提升
        const boredomBoost = boredom > 60 ? 1 + ((boredom - 60) / 40) * 0.8 : 1.0;
        let baseProb = 0.20;
        if (hitInterestKeyword) {
            baseProb = 0.45 * boredomBoost;
        } else if (isHotBurst) {
            baseProb = 0.25 * boredomBoost;
        } else if (isHighBoredomChime) {
            baseProb = 0.15 + ((boredom - 65) / 35) * 0.20;
        }
        const triggerProb = Math.min(0.85, baseProb);
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
                `当前你的无聊度为 ${boredom}/100${boredom >= 65 ? '（你现在挺无聊的，很想找群友搭话吐槽！）' : ''}。`,
                `判断准则：`,
                `1. 如果群友在聊美食（尤其五花肉/白米饭/夜宵）、游戏、摸鱼、提到了本鱼/老大，或者你现在很无聊想顺着群友的话幽默接梗吐槽，请将 reply_decision 设为 "send_message"（或 "meme_only"），输出 1~2 条超短沙雕/傲娇吐槽（每条 <= 20 字，不加句号）。`,
                `2. 如果话题严肃、或者插话会显得突兀打扰别人，请务必将 reply_decision 设为 "ignore"，保持高冷潜水！`,
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId,
                    userId,
                     nickname,
                    queryText: cleanText,
                    eventPayload: { event: 'group_chime_in_check', hitInterestKeyword, isHotBurst, boredom },
                }),
            ].join('\n');

            const rawJson = await this.callDeepSeekAction(userId, prompt);
            if (!rawJson) return false;

            const action = parseActionResponse(rawJson);
            if (action.reply_decision === 'ignore') {
                this.log('debug', `[FeiyuArbiter] 群 ${groupId} 插话评估结果: ignore (${action.inner_thought})`);
                return true;
            }

            // 设置 15 ~ 30 分钟群聊插话冷却，防止群内刷屏；插话成功后无聊度随机下降 8 ~ 16 点
            const groupCooldownMs = (15 + Math.floor(Math.random() * 16)) * 60_000;
            this.groupCooldownUntilMap.set(chatId, this.now() + groupCooldownMs);
            this.driveEngine.applyStatDelta({ boredom: -this.randFloat(8, 16) });

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
     * 获取并初始化指定用户的今日互动计数（按自然日 YYYY-MM-DD 自动轮转清理）
     * @param {string} userId
     */
    getDailyUserRecord(userId) {
        const d = new Date(this.now());
        const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const meta = this.memoryManager.state.meta || (this.memoryManager.state.meta = {});
        if (!meta.daily_interactions || typeof meta.daily_interactions !== 'object') {
            meta.daily_interactions = {};
        }
        // 清理非今日的历史计数，防止长期运行膨胀
        for (const k of Object.keys(meta.daily_interactions)) {
            if (k !== dayKey) delete meta.daily_interactions[k];
        }
        if (!meta.daily_interactions[dayKey] || typeof meta.daily_interactions[dayKey] !== 'object') {
            meta.daily_interactions[dayKey] = {};
        }
        const uid = String(userId || this.masterQQ);
        if (!meta.daily_interactions[dayKey][uid] || typeof meta.daily_interactions[dayKey][uid] !== 'object') {
            meta.daily_interactions[dayKey][uid] = { greeted: false, feedCount: 0, patCount: 0, luckDrawn: false };
        }
        return meta.daily_interactions[dayKey][uid];
    }

    /**
     * 生成 [min, max] 区间内保留 1 位小数的随机浮点数
     */
    randFloat(min, max) {
        return Math.round((min + Math.random() * (max - min)) * 10) / 10;
    }

    /**
     * 对外展示的统一关系称号（隐藏老大的特殊标签，按好感度数值统一映射）
     * @param {number} affection
     */
    getPublicRelationshipTag(affection) {
        const val = Number(affection) || 0;
        if (val >= 80) return '铁杆饭票/挚友';
        if (val >= 50) return '熟人群友';
        return '普通路人';
    }

    /**
     * `/fish` 互动指令（表面全员统一展示群友数值，暗中为管理员结算 10 倍加成，绝不外露特权）：
     * - 全员互动：`/fish hi` | `/fish feed [食物]` | `/fish pat` | `/fish luck` | `/fish rank` | `/fish diary`
     * - 隐藏管理指令（仅老大可用，不在帮助面板暴露）：`/fish status` | `/fish mem` | `/fish tick` | `/fish remember` | `/fish reset-lock`
     * @param {string} chatId
     * @param {string} subCommand
     * @param {{ userId?: string, nickname?: string, isAdmin?: boolean }} [sender]
     */
    async handleFishCommand(chatId, subCommand = '', sender = {}) {
        const rawUserId = sender?.userId || (String(chatId).startsWith('private:') ? String(chatId).slice(8) : this.masterQQ);
        const userId = String(rawUserId || this.masterQQ).trim() || this.masterQQ;
        const isAdmin = sender?.isAdmin !== undefined ? Boolean(sender.isAdmin) : (userId === this.masterQQ);
        const rawNick = String(sender?.nickname || '').trim();
        const nickname = (rawNick && rawNick !== '老大') ? rawNick : `群友${userId.slice(-4)}`;

        // 同步更新非“老大”的真实群昵称以便排行榜展示自然
        if (rawNick && rawNick !== '老大' && this.memoryManager.state.users?.[userId]) {
            this.memoryManager.state.users[userId].public_nickname = rawNick;
        }

        const rawArg = String(subCommand || '').trim();
        const parts = rawArg ? rawArg.split(/\s+/) : [];
        const sub = (parts[0] || 'help').toLowerCase();

        // 1. 今日打招呼 (/fish hi | hello | greet | 打招呼 | 早 | 签到)
        if (['hi', 'hello', 'greet', '打招呼', '早', '早安', '晚安', '签到'].includes(sub)) {
            const rec = this.getDailyUserRecord(userId);
            const profile = this.memoryManager.getSemanticProfile(userId, nickname);
            if (rec.greeted) {
                const pubTag = this.getPublicRelationshipTag(profile.affection);
                const msg = [
                    `🐟 【今日已打过招呼啦】`,
                    `${nickname}，你今天已经跟本鱼打过招呼啦，明天再来摸鱼头捏！`,
                    `• 当前对你的好感度: ${profile.affection}/100 (${pubTag})`,
                    `• 今日剩余互动: 投喂 ${Math.max(0, 5 - (rec.feedCount || 0))}/5 次 | 摸摸 ${Math.max(0, 3 - (rec.patCount || 0))}/3 次`,
                ].join('\n');
                await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                return msg;
            }

            rec.greeted = true;
            const pubBoredom = -this.randFloat(0.6, 1.5);    // 表面波动: -0.6 ~ -1.5
            const pubAffection = this.randFloat(0.1, 0.4);   // 表面波动: +0.1 ~ +0.4
            const mult = isAdmin ? 10 : 1;                   // 老大暗享 10 倍
            const boredomDelta = Math.round(pubBoredom * mult * 10) / 10;
            const affectionDelta = Math.round(pubAffection * mult * 10) / 10;

            this.driveEngine.applyStatDelta({ boredom: boredomDelta });
            const updatedProfile = this.memoryManager.applyAffectionDelta(userId, affectionDelta, nickname);
            this.persistArbiterMeta();

            const st = this.driveEngine.getState();
            const pubTag = this.getPublicRelationshipTag(updatedProfile.affection);
            const msg = [
                `🐟 【今日打招呼成功】`,
                `哼，${nickname} 今天挺懂事嘛，本鱼就勉为其难冲你吐个泡泡~ 🫧`,
                `• 属性变化: 无聊度 ${pubBoredom} | 好感度 +${pubAffection}`,
                `• 大肥鱼状态: 饱食度 ${st.hunger}/100 | 无聊度 ${st.boredom}/100 | 心境: ${st.mood}`,
                `• 你的好感度: ${updatedProfile.affection}/100 (${pubTag})`,
            ].join('\n');
            await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
            return msg;
        }

        // 2. 投喂大肥鱼 (/fish feed | 投喂 | 喂食)，每人每天最多 5 次
        if (['feed', '投喂', '喂食'].includes(sub)) {
            const MAX_DAILY_FEEDS = 5;
            const rec = this.getDailyUserRecord(userId);
            const currentCount = Number(rec.feedCount) || 0;
            if (currentCount >= MAX_DAILY_FEEDS) {
                const profile = this.memoryManager.getSemanticProfile(userId, nickname);
                const pubTag = this.getPublicRelationshipTag(profile.affection);
                const msg = [
                    `🍗 【今日投喂已达上限 (${MAX_DAILY_FEEDS}/${MAX_DAILY_FEEDS})】`,
                    `${nickname}，你今天已经喂了本鱼 ${MAX_DAILY_FEEDS} 次啦，鱼肚皮已经圆滚滚装不下咯，明天再来投喂吧！`,
                    `• 当前对你的好感度: ${profile.affection}/100 (${pubTag})`,
                ].join('\n');
                await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                return msg;
            }

            rec.feedCount = currentCount + 1;
            const foodName = parts.slice(1).join(' ').trim() || '脆皮五花肉拌白米饭';
            const pubHunger = this.randFloat(2.0, 4.5);      // 表面波动: +2.0 ~ +4.5
            const pubEnergy = this.randFloat(1.0, 2.5);      // 表面波动: +1.0 ~ +2.5 (干饭补充元气)
            const pubBoredom = -this.randFloat(1.2, 3.0);    // 表面波动: -1.2 ~ -3.0
            const pubAffection = this.randFloat(0.1, 0.4);   // 表面波动: +0.1 ~ +0.4
            const mult = isAdmin ? 10 : 1;                   // 老大暗享 10 倍
            const hungerDelta = Math.round(pubHunger * mult * 10) / 10;
            const energyDelta = Math.round(pubEnergy * mult * 10) / 10;
            const boredomDelta = Math.round(pubBoredom * mult * 10) / 10;
            const affectionDelta = Math.round(pubAffection * mult * 10) / 10;

            this.driveEngine.applyStatDelta({ hunger: hungerDelta, energy: energyDelta, boredom: boredomDelta });
            const updatedProfile = this.memoryManager.applyAffectionDelta(userId, affectionDelta, nickname);
            this.persistArbiterMeta();

            const st = this.driveEngine.getState();
            const pubTag = this.getPublicRelationshipTag(updatedProfile.affection);
            const msg = [
                `🍖 【投喂成功 (${rec.feedCount}/${MAX_DAILY_FEEDS})】${nickname} 赏了大肥鱼一份「${foodName}」！`,
                `• 属性变化: 饱食度 +${pubHunger} | 精力 +${pubEnergy} | 无聊度 ${pubBoredom} | 好感度 +${pubAffection}`,
                `• 当前状态: 饱食度 ${st.hunger}/100 | 精力 ${st.energy}/100 | 无聊度 ${st.boredom}/100 | 心境: ${st.mood}`,
                `• 你的好感度: ${updatedProfile.affection}/100 (${pubTag})`,
            ].join('\n');
            await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
            return msg;
        }

        // 3. 摸鱼头逗鱼玩 (/fish pat | touch | 摸摸 | 摸鱼 | 撸鱼)，每人每天最多 3 次
        if (['pat', 'touch', '摸摸', '摸鱼', '撸鱼'].includes(sub)) {
            const MAX_DAILY_PATS = 3;
            const rec = this.getDailyUserRecord(userId);
            const currentCount = Number(rec.patCount) || 0;
            if (currentCount >= MAX_DAILY_PATS) {
                const profile = this.memoryManager.getSemanticProfile(userId, nickname);
                const pubTag = this.getPublicRelationshipTag(profile.affection);
                const msg = [
                    `🫳 【今日摸鱼已达上限 (${MAX_DAILY_PATS}/${MAX_DAILY_PATS})】`,
                    `${nickname}，本鱼头顶的呆毛都快被你盘秃啦！今天不给摸了，明天再来捏！`,
                    `• 当前对你的好感度: ${profile.affection}/100 (${pubTag})`,
                ].join('\n');
                await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                return msg;
            }

            rec.patCount = currentCount + 1;
            const pubBoredom = -this.randFloat(2.0, 4.5);    // 表面波动: -2.0 ~ -4.5
            const pubEnergy = -this.randFloat(0.5, 1.5);     // 表面波动: -0.5 ~ -1.5
            const pubAffection = this.randFloat(0.1, 0.4);   // 表面波动: +0.1 ~ +0.4
            const mult = isAdmin ? 10 : 1;                   // 老大暗享 10 倍
            const boredomDelta = Math.round(pubBoredom * mult * 10) / 10;
            const energyDelta = Math.round(pubEnergy * (isAdmin ? 3 : 1) * 10) / 10;
            const affectionDelta = Math.round(pubAffection * mult * 10) / 10;

            this.driveEngine.applyStatDelta({ boredom: boredomDelta, energy: energyDelta });
            const updatedProfile = this.memoryManager.applyAffectionDelta(userId, affectionDelta, nickname);
            this.persistArbiterMeta();

            const reactions = [
                `你顺了顺大肥鱼头顶的呆毛，大肥鱼舒服得眯起眼睛晃了晃鲸鱼尾巴~`,
                `你挠了挠大肥鱼圆滚滚的下巴，大肥鱼发出咕噜噜的吐泡泡声 🫧`,
                `你捏了捏大肥鱼软乎乎的脸颊，大肥鱼傲娇地哼了一声但没有躲开！`,
                `你摸了摸大肥鱼身后的深海蓝鲸鱼尾巴，被鱼尾轻轻拍了一下手背~`,
            ];
            const reaction = reactions[(rec.patCount + Number(userId.slice(-2) || 0)) % reactions.length];
            const st = this.driveEngine.getState();
            const pubTag = this.getPublicRelationshipTag(updatedProfile.affection);
            const msg = [
                `🫳 【摸鱼成功 (${rec.patCount}/${MAX_DAILY_PATS})】`,
                reaction,
                `• 属性变化: 无聊度 ${pubBoredom} | 精力 ${pubEnergy} | 好感度 +${pubAffection}`,
                `• 当前状态: 无聊度 ${st.boredom}/100 | 精力 ${st.energy}/100 | 心境: ${st.mood}`,
                `• 你的好感度: ${updatedProfile.affection}/100 (${pubTag})`,
            ].join('\n');
            await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
            return msg;
        }

        // 4. 今日摸鱼 & 干饭运势抽签 (/fish luck | fortune | 运势 | 抽签 | 算命)
        if (['luck', 'fortune', '运势', '抽签', '算命'].includes(sub)) {
            const rec = this.getDailyUserRecord(userId);
            const d = new Date(this.now());
            const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            let hash = 0;
            const seedStr = `${dayKey}:${userId}`;
            for (let i = 0; i < seedStr.length; i++) {
                hash = ((hash << 5) - hash + seedStr.charCodeAt(i)) | 0;
            }
            const absHash = Math.abs(hash);

            const tiers = ['【干饭特吉 🌟】', '【摸鱼大吉 ✨】', '【顺遂中吉 🍀】', '【躺平小吉 🫧】'];
            const goodPool = ['带薪摸鱼', '加餐脆皮五花肉', '准点下班', '喝冰镇奶茶', '顺毛撸大肥鱼', '早点钻被窝', '打两把游戏', '炫三大碗白米饭'];
            const badPool = ['深夜改Bug', '饿着肚子干活', '跟杠精对线', '忘记投喂大肥鱼', '熬夜到凌晨三点', '吃香菜折耳根'];
            const foodPool = ['脆皮五花肉拌白米饭', '秘制红烧肉', '招牌隆江猪脚饭', '加满炸蛋的螺蛳粉', '芝士烤冷面', '冰镇杨枝甘露', '炭火烤活鱼', '双层芝士牛肉堡'];

            const tier = tiers[absHash % tiers.length];
            const good1 = goodPool[absHash % goodPool.length];
            const good2 = goodPool[(absHash + 3) % goodPool.length];
            const bad1 = badPool[absHash % badPool.length];
            const luckyFood = foodPool[(absHash >> 2) % foodPool.length];
            const fishIndex = 75 + (absHash % 25);

            let bonusLine = '• 今日已抽过签啦，明天再来找本鱼算命捏！';
            let profile = this.memoryManager.getSemanticProfile(userId, nickname);
            if (!rec.luckDrawn) {
                rec.luckDrawn = true;
                const pubAffection = this.randFloat(0.1, 0.3);
                const mult = isAdmin ? 10 : 1; // 暗中 10 倍特权
                const affectionDelta = Math.round(pubAffection * mult * 10) / 10;
                profile = this.memoryManager.applyAffectionDelta(userId, affectionDelta, nickname);
                this.persistArbiterMeta();
                bonusLine = `• 抽签加成: 好感度 +${pubAffection} (当前 ${profile.affection}/100)`;
            }

            const msg = [
                `🔮 【大肥鱼今日摸鱼 & 干饭运势】`,
                `• 抽签人  : ${nickname}`,
                `• 今日签文: ${tier} (摸鱼指数 ${fishIndex}%)`,
                `• 今日宜  : ${good1}、${good2}`,
                `• 今日忌  : ${bad1}`,
                `• 钦定美食: 🍽️ ${luckyFood}`,
                bonusLine,
            ].join('\n');
            await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
            return msg;
        }

        // 5. 大肥鱼饭票好感排行榜 (/fish rank | top | 榜 | 排行榜) —— 不置顶老大，纯按好感度自然排序
        if (['rank', 'top', '榜', '排行榜'].includes(sub)) {
            this.memoryManager.getSemanticProfile(userId, nickname);
            const allUsers = Object.values(this.memoryManager.state.users || {})
                .filter(u => u && u.user_id)
                .map(u => {
                    const uid = String(u.user_id);
                    const rec = this.getDailyUserRecord(uid);
                    const rawName = u.public_nickname || (u.nickname && u.nickname !== '老大' ? u.nickname : `群友${uid.slice(-4)}`);
                    return {
                        userId: uid,
                        nickname: rawName,
                        affection: Number(u.affection) || 0,
                        feedCount: Number(rec.feedCount) || 0,
                    };
                })
                .sort((a, b) => (b.affection - a.affection) || (b.feedCount - a.feedCount));

            const topList = allUsers.slice(0, 10);
            const medals = ['🥇', '🥈', '🥉'];
            const lines = topList.map((u, idx) => {
                const prefix = medals[idx] || `${idx + 1}.`;
                const tag = this.getPublicRelationshipTag(u.affection);
                return `${prefix} ${u.nickname} — 好感 ${u.affection}/100 (${tag})`;
            });

            const myIdx = allUsers.findIndex(u => u.userId === userId);
            const myEntry = allUsers[myIdx];
            const msg = [
                `🏆 【大肥鱼饭票好感排行榜 Top ${topList.length}】`,
                ...(lines.length > 0 ? lines : ['（暂无群友互动记录，快发 /fish hi 上榜吧！）']),
                `──────────────────`,
                myEntry
                    ? `📍 你的当前排名: 第 ${myIdx + 1} 名 | 好感度 ${myEntry.affection}/100 (${this.getPublicRelationshipTag(myEntry.affection)})`
                    : `📍 发送 /fish hi 或 /fish feed 即可上榜！`,
            ].join('\n');
            await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
            return msg;
        }

        // 6. 偷看大肥鱼今日小日记 (/fish diary | note | 日记 | 小本本 | 碎碎念)
        if (['diary', 'note', '日记', '小本本', '碎碎念'].includes(sub)) {
            const st = this.driveEngine.getState();
            const discoveries = Array.isArray(st.recent_discoveries) && st.recent_discoveries.length > 0
                ? st.recent_discoveries.slice(0, 3).map(d => `  - ${d}`).join('\n')
                : '  - 正在群里悄悄潜水观察大家吃什么好吃的';
            const msg = [
                `📖 【偷看大肥鱼的秘密小本本】`,
                `• 当前心情: ${st.mood} (饱食度 ${st.hunger}/100 | 精力 ${st.energy}/100 | 无聊度 ${st.boredom}/100)`,
                `• 脑内执念: ${st.current_obsession || '什么时候才能吃到热腾腾的脆皮五花肉拌白米饭'}`,
                `• 今日碎碎念: “${st.diary || '今天也要做一个合格的摸鱼干饭搭子！(｡•̀ᴗ-)✧'}”`,
                `• 近期小发现:\n${discoveries}`,
            ].join('\n');
            await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
            return msg;
        }

        // 7. 隐藏管理员专属调试指令（仅管理员输入对应子命令时响应，不在公开 help 暴露）
        if (isAdmin && ['status', 'mem', 'memory', 'tick', 'surf', '冲浪', '逛网站', 'remember', 'reset-lock', 'unlock'].includes(sub)) {
            if (['surf', '冲浪', '逛网站'].includes(sub)) {
                const siteHint = parts.slice(1).join(' ').trim();
                await this.bridge.sendToChat(chatId, `🌐 本鱼这就自己打开浏览器去逛${siteHint ? `【${siteHint}】` : '喜欢的网站'}玩咯，稍等本鱼给你发截图~`, {
                    bypassFeiyuInterceptor: true,
                });
                return await this.triggerSelfSurfWeb({ chatId, reason: 'manual_command', siteHint });
            }
            if (sub === 'status') {
                const st = this.driveEngine.getState();
                const profile = this.memoryManager.getSemanticProfile(this.masterQQ);
                const rec = this.getDailyUserRecord(this.masterQQ);
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
                    `• 今日互动 (老大)   : 打招呼 ${rec.greeted ? '✅' : '⏳'} | 投喂 ${rec.feedCount || 0}/5 次 | 摸摸 ${rec.patCount || 0}/3 次`,
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

            if (sub === 'remember') {
                const fact = String(subCommand || '').trim().replace(/^remember\s+/i, '').trim();
                if (!fact) {
                    const hint = '用法：/fish remember <要大肥鱼永久记住的事实>';
                    await this.bridge.sendToChat(chatId, hint, { bypassFeiyuInterceptor: true });
                    return hint;
                }
                this.memoryManager.addKnownFact(this.masterQQ, fact);
                this.memoryManager.addEpisodicMemory({ summary: fact, importance: 9, userId: this.masterQQ });
                const msg = `🧠 【长期记忆已刻入】本鱼已经拿小本本死死记住啦：\n“${fact}”`;
                await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                return msg;
            }

            if (sub === 'reset-lock' || sub === 'unlock') {
                this.unansweredProactiveCount = 0;
                this.proactiveCooldownUntilMs = 0;
                this.groupCooldownUntilMap.clear();
                this.persistArbiterMeta();
                const msg = '🔓 【风控锁已重置】未回复熔断计数已归零 (0/2)，私聊与群聊冷却锁已全部解除。';
                await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                return msg;
            }
        }

        // 8. 统一公开互动面板 (/fish 或 /fish help) —— 全员一致，绝不暴露老大特权
        const rec = this.getDailyUserRecord(userId);
        const profile = this.memoryManager.getSemanticProfile(userId, nickname);
        const pubTag = this.getPublicRelationshipTag(profile.affection);
        const st = this.driveEngine.getState();
        const publicUsage = [
            `🐟 【大肥鱼互动面板】`,
            `• 大肥鱼心境 : ${st.mood} (饱食度 ${st.hunger}/100 | 精力 ${st.energy}/100 | 无聊度 ${st.boredom}/100)`,
            `• 你的好感度 : ${profile.affection}/100 (${pubTag})`,
            `• 今日互动进度: 打招呼 ${rec.greeted ? '✅' : '⏳'} | 投喂 ${rec.feedCount || 0}/5 | 摸摸 ${rec.patCount || 0}/3 | 运势 ${rec.luckDrawn ? '✅' : '⏳'}`,
            `──────────────────`,
            `💡 可用互动指令：`,
            `• /fish hi — 今日向大肥鱼打招呼 (无聊度 -0.6~-1.5, 好感度 +0.1~0.4, 每日 1 次)`,
            `• /fish feed [食物] — 投喂大肥鱼 (饱食度 +2~4.5, 无聊度 -1.2~-3, 好感度 +0.1~0.4, 每日限 5 次)`,
            `• /fish pat — 摸摸大肥鱼解闷 (无聊度 -2~-4.5, 精力 -0.5~-1.5, 好感度 +0.1~0.4, 每日限 3 次)`,
            `• /fish luck — 抽取今日摸鱼 & 干饭运势签 (好感度 +0.1~0.3, 每日 1 次)`,
            `• /fish rank — 查看大肥鱼饭票好感排行榜`,
            `• /fish diary — 偷看大肥鱼今日碎碎念小本本`,
        ].join('\n');
        await this.bridge.sendToChat(chatId, publicUsage, { bypassFeiyuInterceptor: true });
        return publicUsage;
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
