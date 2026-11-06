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
import { MemoryManager, DEFAULT_MASTER_QQ, parseNaturalReminder } from './memory-manager.js';
import { DriveEngine, MessageDebounceBuffer, PokeAggregator, TEASE_BULLY_REGEX, SEXUAL_HARASS_REGEX } from './drive-engine.js';
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

/**
 * 探测老大当前在电脑上运行的游戏、创作软件或前台窗口标题（大肥鱼与老大共处同一台电脑的时空感知）
 */
export async function detectBossPcActivity() {
    try {
        const psCmd = 'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 12 ProcessName, MainWindowTitle | ConvertTo-Json -Compress"';
        const { stdout } = await execAsync(psCmd, { timeout: 2500 });
        const raw = JSON.parse(stdout.trim() || '[]');
        const list = Array.isArray(raw) ? raw : [raw];
        const activities = [];
        for (const item of list) {
            const name = String(item?.ProcessName || '').toLowerCase();
            const title = String(item?.MainWindowTitle || '').trim();
            if (!name && !title) continue;
            if (/dazstudio/i.test(name) || /daz studio/i.test(title)) {
                activities.push('正在用 Daz Studio 捏人/做 3D 渲染');
            } else if (/yuanshen|genshin/i.test(name)) {
                activities.push('正在玩《原神》');
            } else if (/starrail/i.test(name)) {
                activities.push('正在玩《崩坏：星穹铁道》');
            } else if (/client-win64-shipping/i.test(name) || /鸣潮|wuthering/i.test(title)) {
                activities.push('正在玩《鸣潮》');
            } else if (/zenlesszonezero/i.test(name)) {
                activities.push('正在玩《绝区零》');
            } else if (/blender/i.test(name)) {
                activities.push('正在用 Blender 建模');
            } else if (/code|cursor|windsurf|idea64|pycharm/i.test(name)) {
                activities.push(`正在写代码 (${title.slice(0, 35)})`);
            } else if (/potplayer|vlc|mpv/i.test(name)) {
                activities.push(`正在看视频 (${title.slice(0, 30)})`);
            } else if (/cloudmusic|qqmusic|spotify/i.test(name)) {
                activities.push(`正在听歌 (${title.slice(0, 30)})`);
            } else if (/chrome|msedge|firefox/i.test(name) && title && !/新标签页|New Tab|抖音/i.test(title)) {
                const cleanTitle = title.replace(/\s*-\s*(Google Chrome|Microsoft​ Edge|Mozilla Firefox).*$/i, '').trim();
                if (cleanTitle) activities.push(`浏览器开着「${cleanTitle.slice(0, 28)}」`);
            }
        }
        const unique = [...new Set(activities)];
        return unique.length > 0 ? unique.slice(0, 2).join('；') : '电脑桌面挂机摸鱼中';
    } catch {
        return '';
    }
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
            : ['group:434137389'];
        this.idleHours = options.idleHours ?? 2.0;
        this.groupLastActivityMap = new Map();
        this.groupIdleThresholdMap = new Map();
        this.startTime = Date.now();
        this.now = options.now ?? (() => Date.now());
        this.log = options.log ?? ((level, msg) => bridge?.deps?.log?.(level, msg) ?? console.log(`[FeiyuArbiter][${level}] ${msg}`));

        // 1. 初始化四层 SQLite 记忆数据库与每日压缩管理器 (Step 3)
        this.memoryManager = options.memoryManager ?? new MemoryManager({
            filePath: options.memoryFilePath,
            dbPath: options.memoryDbPath,
            masterQQ: this.masterQQ,
            now: this.now,
            llmReflector: (userId, profile, facts) => this.reflectProfileViaLLM(userId, profile, facts),
            llmDailyCompressor: (dayKey, existingDigest, rawLogs) => this.compressDailyMemoryViaLLM(dayKey, existingDigest, rawLogs),
        });

        // 从 SQLite 恢复各监听群最近一次发言时间戳，防止服务重启后 2~2.5h 冷场计时器归零
        for (const gid of this.groupChats) {
            try {
                const row = this.memoryManager?.db?.prepare('SELECT MAX(ts) AS last_ts FROM raw_interaction_logs WHERE chat_id = ?').get(gid);
                if (row?.last_ts && Number(row.last_ts) > 0) {
                    this.groupLastActivityMap.set(gid, Number(row.last_ts));
                }
            } catch {}
        }

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

        // 群聊插话冷却、活跃对话延续窗口与近期消息时间戳统计
        this.groupCooldownUntilMap = new Map();
        this.activeGroupConvoMap = new Map(); // chatId -> { userId, nickname, expiresAt, turns }
        this.groupBurstTimestamps = new Map();
        this.isGroupChimeRunning = false;

        // Fetch 注入点（方便单测 mock）
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

        // 时空与电脑环境感知缓存
        this.cachedPcActivity = '电脑桌面摸鱼中';
        this.cachedWeather = '';
        this.lastEnvRefreshAt = 0;
        this.lastWeatherRefreshAt = 0;
        this.lastEmojiReactAt = 0;
        this.driveEngine.envContext = { pcActivity: this.cachedPcActivity, weather: this.cachedWeather };
    }

    start() {
        this.driveEngine.start();
        void this.refreshEnvironmentCache();
        this.log('info', `[FeiyuArbiter] v3.0 自主数字生命引擎已启动 (master=${this.masterChatId}, unanswered=${this.unansweredProactiveCount}/2)`);
    }

    getEnvironmentContext() {
        return {
            pcActivity: this.cachedPcActivity || '',
            weather: this.cachedWeather || '',
        };
    }

    async refreshEnvironmentCache() {
        const nowMs = this.now();
        if (nowMs - this.lastEnvRefreshAt >= 60_000) {
            this.lastEnvRefreshAt = nowMs;
            const pcAct = await detectBossPcActivity();
            if (pcAct) this.cachedPcActivity = pcAct;
        }
        if (!this.cachedWeather || (nowMs - this.lastWeatherRefreshAt) >= 60 * 60_000) {
            this.lastWeatherRefreshAt = nowMs;
            try {
                const res = await this.fetchImpl('https://wttr.in/?format=%C+%t&lang=zh', {
                    signal: AbortSignal.timeout(3000),
                });
                if (res.ok) {
                    const txt = (await res.text()).trim();
                    if (txt && txt.length <= 30 && !txt.includes('<')) {
                        this.cachedWeather = txt;
                    }
                }
            } catch {}
        }
        this.driveEngine.envContext = this.getEnvironmentContext();
        return this.driveEngine.envContext;
    }

    /**
     * 给收到的 QQ 消息顺手贴一个表情回应 (NapCat `set_msg_emoji_like`)
     */
    async maybeReactEmojiToMessage(messageId, text = '', isAdmin = false, kind = 'private', forceReact = false) {
        const msgId = Number(messageId);
        if (!Number.isFinite(msgId) || msgId <= 0) return false;
        const clean = String(text || '').trim();
        if (!clean || clean.startsWith('/')) return false;

        const nowMs = this.now();
        // 避免频繁贴表情刷屏，至少间隔 25 秒
        if (!forceReact && nowMs - this.lastEmojiReactAt < 25_000) return false;

        let emojiId = null;
        if (this.driveEngine.isSulking(nowMs)) {
            // 闹别扭记小本本时，给对方消息贴个傲娇翻白眼(38)或哼唧表情
            if (forceReact || Math.random() < 0.55) emojiId = '38';
        } else if (/(五花肉|白米饭|红烧肉|奶茶|夜宵|烧烤|火锅|好吃|投喂|干饭|加餐)/i.test(clean)) {
            if (forceReact || Math.random() < 0.5) emojiId = ['66', '319', '76'][Math.floor(Math.random() * 3)];
        } else if (/(可爱|乖|聪明|真棒|喜欢肥鱼|喜欢本鱼|摸摸|抱抱|爱你|贴贴)/i.test(clean)) {
            if (forceReact || Math.random() < 0.65) emojiId = ['66', '49', '319'][Math.floor(Math.random() * 3)];
        } else if (isAdmin && kind === 'private' && (forceReact || Math.random() < 0.22)) {
            emojiId = ['76', '66', '175', '285'][Math.floor(Math.random() * 4)];
        } else if (kind === 'group' && /(哈哈|笑死|666|牛逼|绝了|摸鱼)/i.test(clean) && (forceReact || Math.random() < 0.25)) {
            emojiId = ['76', '285'][Math.floor(Math.random() * 2)];
        }

        if (!emojiId) return false;
        this.lastEmojiReactAt = nowMs;
        try {
            const callFn = this.bridge?.guardedConnectionCall
                ? (act, p) => this.bridge.guardedConnectionCall(act, p)
                : (act, p) => this.bridge?.deps?.connection?.call?.(act, p);
            await callFn('set_msg_emoji_like', {
                message_id: msgId,
                emoji_id: String(emojiId),
            });
            this.log('info', `[FeiyuEmojiLike] 已给消息 ${msgId} 贴表情回应 (emoji_id=${emojiId})`);
            return true;
        } catch {
            return false;
        }
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
            // 若在群聊中有人欺负/调侃或性骚扰大肥鱼，自动记录进该群的群梗共同记忆库 (group_lore) 并给群友起专属外号 (Item 6)
            const cleanGrpText = String(text).replace(/\r?\n/g, ' ').trim();
            if (SEXUAL_HARASS_REGEX.test(cleanGrpText)) {
                if (String(chatId).startsWith('group:')) {
                    this.memoryManager.addGroupLore?.(
                        chatId,
                        `群友 ${nickname || resolvedUserId} 曾对本鱼开黄腔/性骚扰说“${cleanGrpText.slice(0, 24)}”，已被本鱼痛骂回击并打入下头黑名单`
                    );
                }
                if (resolvedUserId && resolvedUserId !== this.masterQQ) {
                    this.memoryManager.applyAffectionDelta?.(resolvedUserId, -5, nickname);
                    this.memoryManager.setPetNickname?.(resolvedUserId, '下头怪', nickname);
                }
                this.driveEngine.enterSulking(`刚才被下头怪 ${nickname || resolvedUserId} 开黄腔冒犯了，正在炸毛拿大尾巴抽人`);
            } else if (TEASE_BULLY_REGEX.test(cleanGrpText)) {
                if (String(chatId).startsWith('group:')) {
                    this.memoryManager.addGroupLore?.(
                        chatId,
                        `群友 ${nickname || resolvedUserId} 曾调侃/欺负本鱼说“${cleanGrpText.slice(0, 24)}”，已被记入小本本`
                    );
                }
                if (resolvedUserId && resolvedUserId !== this.masterQQ) {
                    const petNick = /烤/.test(cleanGrpText)
                        ? '烤鱼狂魔'
                        : /炖|蒸|红烧/.test(cleanGrpText)
                            ? '炖鱼大厨'
                            : '记仇榜常客';
                    this.memoryManager.setPetNickname?.(resolvedUserId, petNick, nickname);
                }
            }

            // Item 5: 自动识别对话中的自然语言定时提醒/约定（如“30分钟后提醒我干活”、“今晚8点喊我打深渊”）
            const parsedReminder = parseNaturalReminder(cleanGrpText, nowMs);
            if (parsedReminder && typeof this.memoryManager.addReminder === 'function') {
                this.memoryManager.addReminder({
                    chatId,
                    userId: resolvedUserId || this.masterQQ,
                    nickname: nickname || resolvedUserId,
                    task: parsedReminder.task,
                    dueAtMs: parsedReminder.dueAtMs,
                    delayMinutes: parsedReminder.delayMinutes,
                });
                this.memoryManager.recordDailyEvent(
                    `大肥鱼记下了定时备忘：${parsedReminder.delayMinutes}分钟后提醒 ${nickname || resolvedUserId}「${parsedReminder.task}」`,
                    chatId,
                    resolvedUserId
                );
                this.log('info', `[FeiyuReminder] 已捕获自然语言定时提醒: ${parsedReminder.delayMinutes}min -> "${parsedReminder.task}"`);
            }
        }

        const interactionRes = this.driveEngine.onUserMessage(text, new Date(nowMs));
        return interactionRes;
    }

    /**
     * 判断指定群聊是否正处于 3 分钟“连续对话余温窗口”内
     */
    isGroupConvoActive(chatId) {
        const activeConvo = this.activeGroupConvoMap.get(chatId);
        return Boolean(activeConvo && this.now() < activeConvo.expiresAt && activeConvo.turns < 6);
    }

    /**
     * 统一快速拟人多气泡回复通道 (`handleFastChatTurn`)：
     * 用于处理无需调用重型系统工具的私聊消息、群聊 `@` 消息、引用回复消息与图文互动，
     * 消除慢速单条 Agent 通道与灵动双气泡快通道之间的割裂感！
     * @param {{ chatId: string, groupId?: string, userId: string, nickname: string, text: string, messageId?: string, isGroup?: boolean, wokeUpFromSleep?: boolean }} payload
     * @returns {Promise<boolean>} - 返回 true 表示已成功通过快通道完成拟人多气泡回复
     */
    async handleFastChatTurn(payload) {
        const { chatId, groupId, userId, nickname, text, messageId, isGroup, wokeUpFromSleep } = payload;
        const cleanText = String(text || '').trim();
        if (!cleanText) return false;

        // 严禁在纯文本插话通道拦截点歌/唱歌/换音色/画画请求（此类必须走完整 Agent 工具流调用 qq_sing_song / qq_switch_voice / qq_generate_image）
        if (/(唱歌|点歌|唱首|唱个|唱一首|唱支|来首歌|来一首|哼一首|给我唱|用.*声音唱|用.*音色唱|唱《|(?:^|[，。！？\s]|肥鱼|飞鱼|本鱼|声音|音色)唱(?!反调|衰|高调|双簧|白脸|红脸|黑脸)\S+|我的歌呢|歌呢|怎么不唱|还没唱|画画|画个|画张|画一只|画幅|生成图片|生图|自拍|自画像|什么音色|音色库|(?:切换|换成?|改用|变成).*(?:芭芭拉|可莉|芙宁娜|胡桃|神里|绫华|雷电|将军|八重|神子|迪奥娜|纳西妲|音色|声音))/i.test(cleanText)) {
            return false;
        }

        try {
            const recentMsgs = this.memoryManager.getWorkingMemory(chatId).slice(-10);
            const historyBlock = recentMsgs
                .map(m => `[${m.nickname || m.userId}]: ${m.text}`)
                .join('\n');

            const hasImage = /\[图片:|视觉画面描述:/i.test(cleanText);
            const prompt = [
                isGroup
                    ? `【群聊点名 / @ / 引用互动（群号：${groupId || chatId}）】`
                    : `【私聊实时对话（对方：${nickname}(${userId})）】`,
                `对方刚刚发来消息："${cleanText}"`,
                ...(historyBlock ? [`近期对话上下文：\n${historyBlock}`] : []),
                `回复准则：`,
                `1. 请务必将 reply_decision 设为 "send_message"（若对方发来搞笑图想斗图，也可设 qq_action.type = "send_meme" 或 reply_decision = "meme_only"）。`,
                `2. 以傲娇、机灵、爱吃白米饭和五花肉的小蓝鲸“大肥鱼”口吻，拆分为 1~3 条简短自然的气泡（每条 <= 25 字，句尾绝不加句号），像真人秒回微信/QQ一样有灵气！（聊美食/投喂时可开心馋五花肉和白米饭，聊其他话题时自然顺着话题接梗，不要句句硬扯五花肉）`,
                ...(hasImage ? [`3. 对方消息中包含图片/表情包（见“视觉画面描述”），请结合图片画面内容进行流口水、吐槽或配表情包斗图！`] : []),
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId,
                    userId,
                    nickname,
                    queryText: cleanText,
                    wokeUpFromSleep: Boolean(wokeUpFromSleep),
                    eventPayload: { event: isGroup ? 'group_fast_turn' : 'private_fast_turn', hasImage },
                    envContext: this.getEnvironmentContext(),
                }),
            ].join('\n');

            const rawJson = await this.callDeepSeekAction(userId, prompt);
            if (!rawJson) return false;

            const action = parseActionResponse(rawJson);
            if (action.reply_decision === 'ignore' && (!action.messages || action.messages.length === 0)) {
                return false;
            }

            if (isGroup) {
                const activeConvo = this.activeGroupConvoMap.get(chatId);
                this.activeGroupConvoMap.set(chatId, {
                    userId,
                    nickname,
                    expiresAt: this.now() + 3 * 60_000,
                    turns: (activeConvo?.userId === userId ? (activeConvo.turns || 0) : 0) + 1,
                });
            }

            this.driveEngine.applyStatDelta({ boredom: -this.randFloat(6, 14) });
            const forceVoice = /(发语音|说句语音|用语音|语音说|讲句语音|听你声音|语音哄|发条语音)/i.test(cleanText);
            const snap = this.driveEngine.getState();
            const baseVoiceProb = isGroup ? 0.25 : 0.30;
            const voiceProbability = (snap.sulking || snap.wokenUpGrumpy || snap.hunger < 25) ? 0.42 : baseVoiceProb;
            await this.dispatcher.dispatch(chatId, action, {
                userId,
                replyToMessageId: messageId,
                forceVoice,
                voiceProbability,
            });
            return true;
        } catch (err) {
            this.log('debug', `[FeiyuArbiter] handleFastChatTurn 异常降级: ${err?.message || err}`);
            return false;
        }
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
        if (count >= 3) {
            this.driveEngine.enterSulking(`刚才被 ${userId} 连续狂戳了 ${count} 下脑门，气鼓鼓记小本本中`);
        }

        const prompt = [
            `用户 (QQ: ${userId}) 刚刚在 5 秒内连续戳了你 ${count} 下！`,
            count >= 3
                ? '你被戳得脸颊鼓起、呆毛炸立，非常傲娇不服气（已经记进小本本闹别扭了），请立刻在 JSON 中输出 1~2 条短气泡吐槽并设置 qq_action.type = "poke" 反戳回去（或发 angry/fish_slap 表情包）！'
                : '请根据你当前的心情和生理状态，输出 JSON 动作协议回应这次戳一戳（可以傲娇哼唧、讨食、或者反戳回去）。',
            buildDynamicTurnContext({
                driveEngine: this.driveEngine,
                memoryManager: this.memoryManager,
                chatId,
                userId,
                queryText: '戳一戳',
                eventPayload: pokePayload,
                wokeUpFromSleep,
                envContext: this.getEnvironmentContext(),
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
        void this.refreshEnvironmentCache();
        await this.checkDueReminders();
        if (typeof this.memoryManager?.autoCompressPastDaysIfNeeded === 'function') {
            void this.memoryManager.autoCompressPastDaysIfNeeded();
        }
        // 进入深夜睡眠期 (01:30 ~ 07:30) 时，若今日还有未压缩的互动流水，自动提炼总结今日主要干了什么
        if (this.driveEngine.isSleeping(new Date(this.now())) && typeof this.memoryManager?.getDatabaseStats === 'function') {
            const dbStats = this.memoryManager.getDatabaseStats();
            if (dbStats.rawUncompressed > 0) {
                void this.memoryManager.compressDailyMemory();
            }
        }
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
     * 检查并触发已到期的“鱼脑备忘录”定时提醒 (Item 5)
     */
    async checkDueReminders() {
        if (typeof this.memoryManager?.popDueReminders !== 'function') return [];
        const dueList = this.memoryManager.popDueReminders(this.now());
        if (!Array.isArray(dueList) || dueList.length === 0) return [];

        const triggered = [];
        for (const r of dueList) {
            try {
                const isMaster = String(r.user_id) === this.masterQQ;
                const callName = isMaster ? '老大老大' : (this.memoryManager.getUserProfile(r.user_id)?.pet_nickname || r.nickname || r.user_id);
                const bubble1 = `⏰ 叮咚！本鱼的备忘录小闹钟响啦！`;
                const bubble2 = `${callName}，你之前交代本鱼到点提醒你的：【${r.task}】！快去搞定捏，不许拖延！`;
                await this.dispatcher.sendTextBubble(r.chat_id, bubble1, {});
                await this.dispatcher.sleep(900);
                await this.dispatcher.sendTextBubble(r.chat_id, bubble2, {});
                await this.dispatcher.sendPoke(r.chat_id, r.user_id);
                this.log('info', `[FeiyuReminder] 已向 ${r.chat_id} 触发到期提醒: "${r.task}"`);
                triggered.push(r);
            } catch (err) {
                this.log('warn', `[FeiyuReminder] 发送到期提醒失败: ${err?.message || err}`);
            }
        }
        return triggered;
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
                    this.driveEngine.applyStatDelta({ boredom: -25 });
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

            await this.refreshEnvironmentCache();
            const envCtx = this.getEnvironmentContext();
            const hwBrief = await getSystemHardwareBrief();
            const prompt = [
                `【系统内部事件：proactive_dm_tick（主动找老大私聊破冰）】`,
                `触发原因：${reason}`,
                `顺带感知到的电脑状态：${hwBrief}`,
                ...(envCtx.pcActivity ? [`感知到老大当前电脑画面：${envCtx.pcActivity}`] : []),
                `请以大肥鱼的傲娇/贪吃/粘人本色，主动给老大发 1~3 条短气泡（每条 <= 25 字，句尾不加句号），可以撒娇抱怨无聊、讨要脆皮五花肉/白米饭、吐槽/关心老大正在玩的软件或游戏、或者顺便提一句帮老大巡检了电脑状态。`,
                `必须严格输出 JSON Action Schema！`,
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId: targetChatId,
                    userId: this.masterQQ,
                    queryText: reason,
                    eventPayload: { event: 'proactive_dm_tick', reason, force },
                    envContext: envCtx,
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
            this.memoryManager.recordDailyEvent(`大肥鱼自己打开浏览器逛了【${res.siteName}】，看到了 ${topicText}`, targetChatId, this.masterQQ);

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

        // 严禁在纯文本插话通道拦截点歌/唱歌/换音色/画画请求（此类必须走完整 Agent 工具流调用 qq_sing_song / qq_switch_voice / qq_generate_image）
        if (/(唱歌|点歌|唱首|唱个|唱一首|唱支|来首歌|来一首|哼一首|给我唱|用.*声音唱|用.*音色唱|唱《|(?:^|[，。！？\s]|肥鱼|飞鱼|本鱼|声音|音色)唱(?!反调|衰|高调|双簧|白脸|红脸|黑脸)\S+|我的歌呢|歌呢|怎么不唱|还没唱|画画|画个|画张|画一只|画幅|生成图片|生图|自拍|自画像|什么音色|音色库|(?:切换|换成?|改用|变成).*(?:芭芭拉|可莉|芙宁娜|胡桃|神里|绫华|雷电|将军|八重|神子|迪奥娜|纳西妲|音色|声音))/i.test(cleanText)) {
            return false;
        }

        const nowMs = this.now();
        // 记录最近 60 秒内的群消息时间戳（用于判断热聊刷屏）
        const tsList = (this.groupBurstTimestamps.get(groupId) || []).filter(t => nowMs - t < 60_000);
        tsList.push(nowMs);
        this.groupBurstTimestamps.set(groupId, tsList);

        // 睡眠中、精力不足 (energy <= 30) 或正在插话中，保持安静潜水（但若有人直接点名喊肥鱼则哪怕犯困也会哼唧回应）
        const calledByName = /(肥鱼|飞鱼|大肥鱼|小肥鱼|胖鱼|鱼鱼|呆鱼|蓝鲸|鲸鱼|鲸鲸|开心飞鱼|本鱼)/i.test(cleanText) && !/^\/fish(?:\s|$)/i.test(cleanText);
        const activeConvo = this.activeGroupConvoMap.get(chatId);
        const isFollowUpConvo = Boolean(
            activeConvo &&
            nowMs < activeConvo.expiresAt &&
            activeConvo.turns < 6 &&
            !cleanText.startsWith('/') &&
            (activeConvo.userId === userId || SEXUAL_HARASS_REGEX.test(cleanText) || /(你|你们|烤|炖|红烧|清蒸|吃|香|臭|五花肉|略略略|哈哈|鱼)/i.test(cleanText))
        );

        if (!calledByName && !isFollowUpConvo) {
            if (this.driveEngine.isSleeping(new Date(nowMs))) return false;
            if (this.driveEngine.state.energy <= 30) return false;
        }
        if (this.isGroupChimeRunning) return false;

        // 检查群插话冷却（仅对“无人点名且非连续对话”的野生潜水插话生效；被点名或处于 3 分钟连续对话余温期时直接穿透冷却！）
        const cooldownUntil = this.groupCooldownUntilMap.get(chatId) || 0;
        if (!calledByName && !isFollowUpConvo && nowMs < cooldownUntil) return false;

        const hasImage = /\[图片:|视觉画面描述:/i.test(cleanText);
        const hitInterestKeyword = GROUP_INTEREST_REGEX.test(cleanText) || hasImage;
        const isHotBurst = tsList.length >= 5;
        const boredom = Number(this.driveEngine.state.boredom) || 0;
        const isHighBoredomChime = boredom >= 65 && !/^\/fish(?:\s|$)/i.test(cleanText);

        if (!calledByName && !isFollowUpConvo && !hitInterestKeyword && !isHotBurst && !isHighBoredomChime) return false;

        // 若被点名喊肥鱼或处于 3 分钟连续对话追问期，100% 触发评估；否则按常规兴趣概率评估
        if (!calledByName && !isFollowUpConvo) {
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
        }

        this.isGroupChimeRunning = true;
        try {
            const recentMsgs = this.memoryManager.getWorkingMemory(chatId).slice(-10);
            const historyBlock = recentMsgs
                .map(m => `[${m.nickname || m.userId}]: ${m.text}`)
                .join('\n');

            const isHarass = SEXUAL_HARASS_REGEX.test(cleanText);
            const prompt = [
                `【系统内部事件：group_chime_in_check（群聊互动与插话评估）】`,
                `当前群号：${groupId}，刚刚群友 [${nickname}(${userId})] 说了："${cleanText}"`,
                `近期群聊上下文：\n${historyBlock}`,
                ...(isHarass ? [`🚨【反性骚扰回击指令】检测到该群友正在对你开黄腔/性骚扰/问猥琐下头问题！绝对禁止呆呆傻傻顺着问题正经回答或科普，也严禁设为 ignore！必须将 reply_decision 设为 "send_message"，立刻开启毒舌暴躁模式，用犀利嫌弃的口吻连发 1~2 条短气泡狠狠痛骂回击对方（喊ta「下头怪」），并将 qq_action.type 设为 "send_meme" (meme_tag="尾巴拍" 或 "生气")！`] : []),
                ...(hasImage ? [`🖼️【视觉感知提示】群友消息中包含图片或表情包（见其中的“视觉画面描述”），你可以针对图片内容吐槽，或者设置 reply_decision = "meme_only" / qq_action.type = "send_meme" 发表情包跟对方斗图！`] : []),
                ...(calledByName
                    ? [`🎯【点名呼叫触发】群友刚刚直接点名喊了你（"${cleanText}"）！请务必将 reply_decision 设为 "send_message"，以傲娇鲜活的大肥鱼口吻分成 1~2 条超短气泡（每条 <= 20 字，不加句号）回应对方！`]
                    : isFollowUpConvo
                        ? [`⚡【连续对话追问余温中】你刚刚才和群友 [${activeConvo.nickname || userId}] 搭过话/斗过嘴，现在对方紧接着发了："${cleanText}"！只要对方是在接你的话茬、发图斗图、调侃你（比如要把你烤了/炖了）、追问你或继续和你互动，请务必将 reply_decision 设为 "send_message"（或 "meme_only" 斗图），用 1~2 条超短傲娇气泡回怼或接梗！只有当对方明显转头去跟别人聊完全无关的事情时才设为 "ignore"。`]
                        : [
                            `当前你的无聊度为 ${boredom}/100${boredom >= 65 ? '（你现在挺无聊的，很想找群友搭话吐槽！）' : ''}。`,
                            `判断准则：`,
                            `1. 如果群友在聊美食（如五花肉/白米饭/夜宵）、游戏、摸鱼、日常趣事、晒图，或者提到了本鱼/老大，又或者你现在很无聊想顺着群友的话幽默接梗吐槽，请将 reply_decision 设为 "send_message"（或 "meme_only"），输出 1~2 条超短沙雕/傲娇吐槽（每条 <= 20 字，不加句号；非美食话题不要句句硬扯五花肉）。`,
                            `2. 如果话题严肃、或者插话会显得突兀打扰别人，请务必将 reply_decision 设为 "ignore"，保持高冷潜水！`,
                        ]),
                buildDynamicTurnContext({
                    driveEngine: this.driveEngine,
                    memoryManager: this.memoryManager,
                    chatId,
                    userId,
                    nickname,
                    queryText: cleanText,
                    eventPayload: { event: 'group_chime_in_check', calledByName, isFollowUpConvo, hitInterestKeyword, isHotBurst, boredom },
                    envContext: this.getEnvironmentContext(),
                }),
            ].join('\n');

            const rawJson = await this.callDeepSeekAction(userId, prompt);
            if (!rawJson) return false;

            const action = parseActionResponse(rawJson);
            if (action.reply_decision === 'ignore') {
                this.log('debug', `[FeiyuArbiter] 群 ${groupId} 插话评估结果: ignore (${action.inner_thought})`);
                if (isFollowUpConvo && activeConvo?.userId === userId) {
                    this.activeGroupConvoMap.delete(chatId);
                }
                return true;
            }

            // 开启/续期 3 分钟的“群聊连续对话余温窗口”，让群友后续的追问（如“把你烤了”、“大肥鱼”）能顺畅接上话！
            this.activeGroupConvoMap.set(chatId, {
                userId,
                nickname,
                expiresAt: this.now() + 3 * 60_000,
                turns: (activeConvo?.userId === userId ? (activeConvo.turns || 0) : 0) + 1,
            });

            // 仅在非点名、非连续对话的“野生潜水插话”时设置 8 ~ 15 分钟冷却，避免把正在进行的对话锁死
            if (!calledByName && !isFollowUpConvo) {
                const groupCooldownMs = (8 + Math.floor(Math.random() * 8)) * 60_000;
                this.groupCooldownUntilMap.set(chatId, this.now() + groupCooldownMs);
            }
            this.driveEngine.applyStatDelta({ boredom: -this.randFloat(8, 16) });
            const forceVoice = /(发语音|说句语音|用语音|语音说|讲句语音|听你声音|语音哄|发条语音)/i.test(cleanText);
            const snap = this.driveEngine.getState();
            const voiceProbability = (snap.sulking || snap.wokenUpGrumpy || snap.hunger < 25) ? 0.38 : 0.25;

            await this.dispatcher.dispatch(chatId, action, {
                userId,
                replyToMessageId: inbound.messageId,
                forceVoice,
                voiceProbability,
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

            const wasSulking = this.driveEngine.isSulking();
            this.driveEngine.applyStatDelta({ hunger: hungerDelta, energy: energyDelta, boredom: boredomDelta });
            this.driveEngine.clearSulking();
            const updatedProfile = this.memoryManager.applyAffectionDelta(userId, affectionDelta, nickname);
            this.memoryManager.recordDailyEvent(`${nickname} 投喂了大肥鱼一份「${foodName}」${wasSulking ? '（并把闹别扭的大肥鱼哄好了）' : ''}`, chatId, userId);
            if (String(chatId).startsWith('group:') && rec.feedCount >= 2) {
                this.memoryManager.addGroupLore?.(chatId, `群友 ${nickname} 经常投喂本鱼好吃的（如「${foodName}」），是群里的热心饭票`);
            }
            if (userId !== this.masterQQ && rec.feedCount >= 2) {
                this.memoryManager.setPetNickname?.(userId, '五花肉菩萨', nickname);
            }
            this.persistArbiterMeta();

            const st = this.driveEngine.getState();
            const pubTag = this.getPublicRelationshipTag(updatedProfile.affection);
            const msg = [
                `🍖 【投喂成功 (${rec.feedCount}/${MAX_DAILY_FEEDS})】${nickname} 赏了大肥鱼一份「${foodName}」！`,
                ...(wasSulking ? [`• 💢➡️💖 哄好成功: 哼，看在「${foodName}」的份上，本鱼把小本本上的仇划掉原谅你啦！`] : []),
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

            const wasSulking = this.driveEngine.isSulking();
            this.driveEngine.applyStatDelta({ boredom: boredomDelta, energy: energyDelta });
            this.driveEngine.clearSulking();
            const updatedProfile = this.memoryManager.applyAffectionDelta(userId, affectionDelta, nickname);
            this.memoryManager.recordDailyEvent(`${nickname} 顺毛摸了摸大肥鱼的脑袋${wasSulking ? '（把闹别扭的大肥鱼哄好了）' : ''}`, chatId, userId);
            if (userId !== this.masterQQ && rec.patCount >= 2) {
                this.memoryManager.setPetNickname?.(userId, '盘呆毛怪', nickname);
            }
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
                ...(wasSulking ? [`• 💢➡️💖 哄好成功: 被你顺毛摸舒服了，本鱼傲娇地把记仇小本本收起来原谅你咯~`] : []),
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
            const recentDigests = this.memoryManager.getRecentDailyDigests?.(2) || [];
            const digestLines = recentDigests.length > 0
                ? recentDigests.map(d => `  - [${d.day_key}] ${d.summary}`).join('\n')
                : '  - 今天的经历还在小脑瓜里酝酿中~';
            const discoveries = Array.isArray(st.recent_discoveries) && st.recent_discoveries.length > 0
                ? st.recent_discoveries.slice(0, 3).map(d => `  - ${d}`).join('\n')
                : '  - 正在群里悄悄潜水观察大家吃什么好吃的';
            const msg = [
                `📖 【偷看大肥鱼的秘密小本本】`,
                `• 当前心情: ${st.mood} (饱食度 ${st.hunger}/100 | 精力 ${st.energy}/100 | 无聊度 ${st.boredom}/100)`,
                `• 记仇状态: ${st.sulking ? `💢 正在闹别扭记小本本中！（原因：${st.sulkingReason || '不给五花肉还欺负本鱼'}，快发 /fish feed 哄好本鱼！）` : '🟢 心情尚可，小本本上暂时没有记仇'}`,
                `• 脑内执念: ${st.current_obsession || '什么时候才能吃到热腾腾的脆皮五花肉拌白米饭'}`,
                `• 今日碎碎念: “${st.diary || '今天也要做一个合格的摸鱼干饭搭子！(｡•̀ᴗ-)✧'}”`,
                `• 每日主要干了啥:\n${digestLines}`,
                `• 近期小发现:\n${discoveries}`,
            ].join('\n');
            await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
            return msg;
        }

        // 7. 隐藏管理员专属调试指令（仅管理员输入对应子命令时响应，不在公开 help 暴露）
        if (isAdmin && ['status', 'mem', 'memory', 'compress', '压缩', 'search', '回忆', 'tick', 'surf', '冲浪', '逛网站', 'remember', 'reset-lock', 'unlock'].includes(sub)) {
            if (['surf', '冲浪', '逛网站'].includes(sub)) {
                const siteHint = parts.slice(1).join(' ').trim();
                await this.bridge.sendToChat(chatId, `🌐 本鱼这就自己打开浏览器去逛${siteHint ? `【${siteHint}】` : '喜欢的网站'}玩咯，稍等本鱼给你发截图~`, {
                    bypassFeiyuInterceptor: true,
                });
                return await this.triggerSelfSurfWeb({ chatId, reason: 'manual_command', siteHint });
            }
            if (['compress', '压缩'].includes(sub)) {
                const targetDay = parts[1]?.trim() || undefined;
                const digest = await this.memoryManager.compressDailyMemory(targetDay, { forceAll: true });
                if (!digest) {
                    const msg = '📭 当前日期还没有可压缩的互动流水记录捏~';
                    await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                    return msg;
                }
                const hlLines = (digest.highlights || []).map((h, i) => `  ${i + 1}. ${h}`).join('\n') || '  （无具体条目）';
                const msg = [
                    `🗜️ 【大肥鱼每日记忆压缩完成 (${digest.day_key})】`,
                    `• 累计压缩流水: ${digest.msg_count} 条`,
                    `• 当日浓缩总结: ${digest.summary}`,
                    `• 主要干了什么:\n${hlLines}`,
                ].join('\n');
                await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                return msg;
            }
            if (['search', '回忆'].includes(sub)) {
                const kw = parts.slice(1).join(' ').trim();
                if (!kw) {
                    const hint = '用法：/fish search <关键词> （或 /fish 回忆 <关键词>）';
                    await this.bridge.sendToChat(chatId, hint, { bypassFeiyuInterceptor: true });
                    return hint;
                }
                const res = this.memoryManager.searchMemories(kw, 5);
                const epPart = res.episodic.length > 0
                    ? res.episodic.map(e => `  - [重要度:${e.importance}] ${e.summary}`).join('\n')
                    : '  （未命中长期情景记忆）';
                const dgPart = res.digests.length > 0
                    ? res.digests.map(d => `  - [${d.day_key}] ${d.summary}`).join('\n')
                    : '  （未命中每日摘要）';
                const logPart = res.logs.length > 0
                    ? res.logs.map(l => `  - [${l.day_key} ${l.time_str} ${l.nickname}] ${l.content}`).join('\n')
                    : '  （未命中近期原始流水）';
                const msg = [
                    `🔍 【大肥鱼 SQLite 记忆库检索: "${kw}"】`,
                    `▍匹配的每日压缩摘要:\n${dgPart}`,
                    `▍匹配的长期情景记忆:\n${epPart}`,
                    `▍匹配的近期原始流水:\n${logPart}`,
                ].join('\n');
                await this.bridge.sendToChat(chatId, msg, { bypassFeiyuInterceptor: true });
                return msg;
            }
            if (sub === 'status') {
                await this.refreshEnvironmentCache();
                const envCtx = this.getEnvironmentContext();
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
                    `• 记小本本 (sulking): ${st.sulking ? `💢 闹别扭中 (${st.sulkingReason})` : '🟢 未记仇'}`,
                    `• 饱食度 (hunger)   : ${st.hunger} / 100 ${st.hunger < 20 ? '⚠️(饿扁讨食中)' : ''}`,
                    `• 精力值 (energy)   : ${st.energy} / 100`,
                    `• 无聊度 (boredom)  : ${st.boredom} / 100 ${st.boredom > 85 ? '🔥(渴望找老大)' : ''}`,
                    `• 老大好感度        : ${profile.affection} / 100 (${profile.relationship_tag})`,
                    `• 今日互动 (老大)   : 打招呼 ${rec.greeted ? '✅' : '⏳'} | 投喂 ${rec.feedCount || 0}/5 次 | 摸摸 ${rec.patCount || 0}/3 次`,
                    `• 电脑前台感知      : ${envCtx.pcActivity || '未检测到特定应用'}`,
                    `• 窗外实时天气      : ${envCtx.weather || '暂未获取'}`,
                    `• 未回复熔断计数    : ${this.unansweredProactiveCount} / 2 ${circuitLocked ? '🔒(已触发防骚扰熔断，待老大回复解锁)' : '🟢(正常)'}`,
                    `• 主动破冰冷却锁    : ${cooldownRemainMin > 0 ? `⏳ 剩余 ${cooldownRemainMin} 分钟` : '🟢 已就绪'}`,
                ].join('\n');

                await this.bridge.sendToChat(chatId, report, { bypassFeiyuInterceptor: true });
                return report;
            }

            if (sub === 'mem' || sub === 'memory') {
                const profile = this.memoryManager.getSemanticProfile(this.masterQQ);
                const dbStats = this.memoryManager.getDatabaseStats?.() || {};
                const recentDigests = this.memoryManager.getRecentDailyDigests?.(3) || [];
                const digestLines = recentDigests.length > 0
                    ? recentDigests.map(d => {
                        const hl = (d.highlights || []).slice(0, 3).join('；');
                        return `  • [${d.day_key} | ${d.msg_count}条流水] ${d.summary}${hl ? `\n    ↳ 要点: ${hl}` : ''}`;
                    }).join('\n')
                    : '  （暂无已生成的每日压缩摘要，可发 /fish compress 立即提炼今日记忆）';

                const recentEp = this.memoryManager.getRecentEpisodicMemories(5);
                const epLines = recentEp.length > 0
                    ? recentEp.map((m, idx) => `  ${idx + 1}. [重要度:${m.importance}/10 | ${String(m.created_at || '').slice(0, 10)}] ${m.summary}`).join('\n')
                    : '  （暂无已沉淀的高重要度情景记忆）';

                const primaryGroup = this.groupChats[0] || 'group:434137389';
                const groupLoreList = this.memoryManager.getGroupLore?.(primaryGroup) || [];
                const loreLines = groupLoreList.length > 0
                    ? groupLoreList.slice(0, 5).map((item, idx) => `  ${idx + 1}. ${item}`).join('\n')
                    : '  （暂无群梗记录，群友与大肥鱼斗嘴或多次投喂后会自动生成）';

                const pendingRems = this.memoryManager.getPendingReminders?.() || [];
                const remLines = pendingRems.length > 0
                    ? pendingRems.slice(0, 5).map((r, idx) => {
                        const dueStr = new Date(r.due_at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
                        return `  ${idx + 1}. [${dueStr} | ${r.nickname}] ${r.task}`;
                    }).join('\n')
                    : '  （暂无待触发的定时提醒，说“X分钟后提醒我...”即可登记）';

                const report = [
                    '🧠 【大肥鱼 SQLite 四层记忆数据库面板 (/fish mem)】',
                    `▍数据库状态 (SQLite WAL)`,
                    `• 存储引擎  : ${dbStats.sqliteEnabled ? '🟢 node:sqlite (feiyu_memory.db)' : '🟡 JSON Fallback'}`,
                    `• 表数据统计: 用户档案 ${dbStats.userCount ?? 0} 人 | 群梗库 ${dbStats.groupLoreCount ?? 0} 群 | 待办提醒 ${dbStats.reminderPendingCount ?? 0} 条 | 每日摘要 ${dbStats.digestCount ?? 0} 天 | 长期记忆 ${dbStats.epCount ?? 0} 条 | 原始流水 ${dbStats.rawTotal ?? 0} 条 (待压缩 ${dbStats.rawUncompressed ?? 0} 条)`,
                    '',
                    '▍鱼脑定时备忘录 (Pending Reminders)',
                    remLines,
                    '',
                    '▍近期每日压缩摘要 (Daily Digests - 每天主要干了什么)',
                    digestLines,
                    '',
                    `▍群聊共同记忆与群梗黑话 (${primaryGroup})`,
                    loreLines,
                    '',
                    '▍语义记忆 (Semantic Memory - 老大档案)',
                    `• QQ / 称呼 : ${profile.user_id} (${profile.nickname}) | 好感度: ${profile.affection}/100`,
                    `• 核心画像  :\n  - ${(profile.known_facts || []).slice(0, 6).join('\n  - ')}`,
                    '',
                    '▍最近 5 条长期情景记忆 (Episodic Memory)',
                    epLines,
                    '──────────────────',
                    '💡 记忆管理指令：/fish compress (手动压缩提炼今日记忆) | /fish search <关键词> (搜索历史记忆) | /fish remember <事实>',
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
        const petNickDisplay = profile.pet_nickname ? ` | 专属外号: 「${profile.pet_nickname}」` : '';
        const publicUsage = [
            `🐟 【大肥鱼互动面板】`,
            `• 大肥鱼心境 : ${st.mood} (饱食度 ${st.hunger}/100 | 精力 ${st.energy}/100 | 无聊度 ${st.boredom}/100)`,
            `• 你的好感度 : ${profile.affection}/100 (${pubTag}${petNickDisplay})`,
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
                            content: '你是傲娇小蓝鲸“大肥鱼”的记忆提炼器。请将关于目标用户的多条碎片事实合并为不超过 6 条精炼特征，并根据ta与大肥鱼的互动习惯给ta起一个 3~5 字的可爱/傲娇专属外号（pet_nickname，如“五花肉菩萨”、“烤鱼狂魔”、“熬夜冠军”），输出 JSON: {"known_facts": ["事实1", "事实2"], "pet_nickname": "专属外号"}',
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
            return Array.isArray(parsed.known_facts) ? parsed : null;
        } catch {
            return null;
        }
    }

    /**
     * 异步压缩提炼大肥鱼每日记忆 (`compressDailyMemory` LLM 回调)
     */
    async compressDailyMemoryViaLLM(dayKey, existingDigest, rawLogs) {
        const apiKey = getDeepSeekApiKey();
        if (!apiKey) return null;
        try {
            const logText = (rawLogs || [])
                .slice(-40)
                .map(r => `[${r.time_str} ${r.role === 'event' ? '事件' : r.nickname}] ${r.content}`)
                .join('\n');
            const prevSummary = existingDigest?.summary || '（无）';
            const prevHighlights = JSON.stringify(existingDigest?.highlights || []);

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
                            content: [
                                '你是傲娇贪吃的小蓝鲸“大肥鱼”的每日记忆压缩器。',
                                '请将当天已有的阶段总结与最新交互流水合并压缩，提炼出今天主要干了什么事情。',
                                '必须严格输出 JSON 对象：',
                                '{"summary": "以大肥鱼第一人称（本鱼）写的今日浓缩总结，不超过100字", "highlights": ["带时间或主体的关键事项1", "事项2"], "episodic": [{"summary": "若包含值得长期永久铭记的重要事件则提取，否则留空数组", "importance": 8}], "group_lore": ["若流水中有群友与大肥鱼的有趣群梗、外号或恩怨（如某群友总想烤肥鱼、某群友常投喂），提取1~2条，否则留空数组"]}',
                            ].join('\n'),
                        },
                        {
                            role: 'user',
                            content: `日期：${dayKey}\n当日已有阶段总结：${prevSummary}\n当日已有事项要点：${prevHighlights}\n最新交互流水：\n${logText}`,
                        },
                    ],
                    temperature: 0.3,
                    max_tokens: 450,
                }),
                signal: AbortSignal.timeout(18_000),
            });
            if (!res.ok) return null;
            const data = await res.json();
            return JSON.parse(data.choices?.[0]?.message?.content || '{}');
        } catch {
            return null;
        }
    }
}
