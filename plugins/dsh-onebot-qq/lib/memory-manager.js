/**
 * Step 3 (v3.1 升级版): 基于 SQLite (`node:sqlite`) 的大肥鱼四层记忆数据库与每日压缩系统 (MemoryManager)
 *
 * 四层记忆架构：
 * 1. Raw Interaction Logs (`raw_interaction_logs` 表 - 原始交互流水暂存层):
 *    - 记录每天的用户发言 (`user`)、大肥鱼回复 (`assistant`) 与关键生活事件 (`event`: 投喂/摸鱼/上网冲浪/闹别扭)
 *    - 支撑“今日暂时记忆”，并在压缩后自动标记 `compressed = 1`；超过 7 天的已压缩原始流水自动清理
 * 2. Daily Digests (`daily_digests` 表 - 每日记忆压缩摘要层):
 *    - 提取每天主要干了什么事情 (`summary` + `highlights` 列表)
 *    - 支持日内满 24 条流水自动增量压缩 + 深夜睡眠期/跨天自动归档压缩，让大肥鱼拥有跨天/跨时段的连续暂时记忆
 * 3. Episodic Memory (`episodic_memories` 表 - 长期情景记忆库):
 *    - `importance >= 6` 落盘，支持指数衰减 + 双字词根相关性检索 (`retrieveEpisodicMemories`) 与关键词/日期搜索 (`searchMemories`)
 * 4. Semantic Memory (`user_profiles` 表 - QQ 用户专属长期档案):
 *    - 按 `user_id` 独立存储 `nickname, affection, relationship_tag, known_facts`
 *
 * @module dsh-onebot/memory-manager
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_MASTER_QQ = '2536218596';
const DEFAULT_STORAGE_DIR = join(homedir(), '.dsh', 'storages', 'dsh-persona-dafeiyu');
const MEMORY_STORE_PATH = join(DEFAULT_STORAGE_DIR, 'feiyu_memory.json');
const MEMORY_DB_PATH = join(DEFAULT_STORAGE_DIR, 'feiyu_memory.db');
const WORKING_MEMORY_CAP = 20;
const EPISODIC_MAX_PER_USER = 120;
const INTRADAY_COMPRESS_THRESHOLD = 24;

export function toDayKey(tsOrDate = Date.now()) {
    const d = tsOrDate instanceof Date ? tsOrDate : new Date(tsOrDate);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 从自然语言查询中解析相对日期或指定日期（如“昨天”、“前天”、“大前天”、“3天前”、“上周五”、“11月5日”）
 * @param {string} queryText
 * @param {number} [nowMs]
 * @returns {Array<{ label: string, dayKey: string }>}
 */
export function resolveRelativeDatesFromQuery(queryText, nowMs = Date.now()) {
    const q = String(queryText || '').trim();
    if (!q) return [];
    const results = [];
    const seen = new Set();
    const addOffset = (label, daysAgo) => {
        const dayKey = toDayKey(nowMs - daysAgo * 86_400_000);
        if (!seen.has(dayKey)) {
            seen.add(dayKey);
            results.push({ label, dayKey });
        }
    };

    if (/(大前天)/.test(q)) addOffset('大前天', 3);
    if (/(前天|前日)/.test(q) && !/大前天/.test(q)) addOffset('前天', 2);
    if (/(昨天|昨日|昨晚|昨儿)/.test(q)) addOffset('昨天', 1);
    if (/(今天|今日|刚才|刚刚|上午|下午|早上)/.test(q)) addOffset('今天', 0);

    const daysAgoMatch = q.match(/(\d+)\s*天前/);
    if (daysAgoMatch) {
        const n = Number(daysAgoMatch[1]);
        if (n >= 1 && n <= 60) addOffset(`${n}天前`, n);
    }

    const cnDigitMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const lastWeekMatch = q.match(/上周([一二三四五六日天])?/);
    if (lastWeekMatch) {
        const nowDate = new Date(nowMs);
        const curDay = nowDate.getDay() || 7; // 1..7
        if (lastWeekMatch[1] && cnDigitMap[lastWeekMatch[1]] !== undefined) {
            const targetDay = cnDigitMap[lastWeekMatch[1]] || 7;
            const daysAgo = curDay + (7 - targetDay);
            addOffset(`上周${lastWeekMatch[1]}`, daysAgo);
        } else {
            addOffset('上周', 7);
        }
    }

    const isoMatch = q.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
        const dk = `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-${String(isoMatch[3]).padStart(2, '0')}`;
        if (!seen.has(dk)) {
            seen.add(dk);
            results.push({ label: dk, dayKey: dk });
        }
    }

    const mdMatch = q.match(/(\d{1,2})月(\d{1,2})[日号]/);
    if (mdMatch) {
        const year = new Date(nowMs).getFullYear();
        const dk = `${year}-${String(mdMatch[1]).padStart(2, '0')}-${String(mdMatch[2]).padStart(2, '0')}`;
        if (!seen.has(dk)) {
            seen.add(dk);
            results.push({ label: `${mdMatch[1]}月${mdMatch[2]}日`, dayKey: dk });
        }
    }

    return results;
}

/**
 * 从自然语言对话中识别“定时提醒/约定备忘”（如“30分钟后提醒我干活”、“过半小时喊我起床”、“今晚8点提醒我打深渊”）
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {{ dueAtMs: number, delayMinutes: number, task: string } | null}
 */
export function parseNaturalReminder(text, nowMs = Date.now()) {
    const clean = String(text || '').replace(/^@\S+\s*/, '').trim();
    if (!clean || clean.startsWith('/')) return null;
    if (!/(提醒我|喊我|叫我|通知我|记得叫|别忘了叫)/.test(clean)) return null;

    const cnNum = { '半': 0.5, '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十五': 15, '二十': 20, '三十': 30 };
    const toNumber = s => {
        if (!s) return NaN;
        if (cnNum[s] !== undefined) return cnNum[s];
        return Number(s);
    };

    // 1. 匹配相对时长：“过半小时提醒我XX”、“30分钟后叫我XX”、“2小时后喊我XX”、“1个半小时后提醒我XX”
    const relHalfHour = clean.match(/(?:过|等)?\s*([一两二三四五1-5])\s*个半小时(?:后|之后|以后)?\s*(?:提醒我|喊我|叫我|通知我|记得叫我?)(.+)/);
    if (relHalfHour) {
        const hrs = toNumber(relHalfHour[1]) + 0.5;
        const task = relHalfHour[2].replace(/^[去把一下个，,。！!~～\s]+|[。！!~～呢吧啦呀]+$/g, '').trim() || '办正事';
        const delayMinutes = Math.round(hrs * 60);
        return { dueAtMs: nowMs + delayMinutes * 60_000, delayMinutes, task };
    }

    const relMatch = clean.match(/(?:过|等)?\s*(\d+(?:\.\d+)?|半|一|两|二|三|四|五|六|七|八|九|十|十五|二十|三十)\s*(?:个)?(分钟|分|小时|钟头|秒)(?:后|之后|以后)?\s*(?:提醒我|喊我|叫我|通知我|记得叫我?)(.+)/);
    if (relMatch) {
        const val = toNumber(relMatch[1]);
        const unit = relMatch[2];
        const task = relMatch[3].replace(/^[去把一下个，,。！!~～\s]+|[。！!~～呢吧啦呀]+$/g, '').trim() || '办正事';
        if (Number.isFinite(val) && val > 0) {
            const multMs = unit === '秒' ? 1000 : (unit === '小时' || unit === '钟头') ? 3600_000 : 60_000;
            const deltaMs = Math.min(24 * 3600_000, Math.max(10_000, Math.round(val * multMs)));
            return {
                dueAtMs: nowMs + deltaMs,
                delayMinutes: Math.max(1, Math.round(deltaMs / 60_000)),
                task,
            };
        }
    }

    // 2. 匹配具体时刻：“今晚8点提醒我打深渊”、“下午4点半叫我开会”、“20:30提醒我喝水”
    const clockMatch = clean.match(/(今晚|今天|早上|上午|中午|下午|晚上|夜里|凌晨)?\s*(\d{1,2}|一|两|二|三|四|五|六|七|八|九|十|十一|十二)(?:点|:|：)(\d{1,2}|半)?(?:分)?\s*(?:提醒我|喊我|叫我|通知我|记得叫我?)(.+)/);
    if (clockMatch) {
        const period = clockMatch[1] || '';
        let hour = toNumber(clockMatch[2]);
        const minRaw = clockMatch[3];
        const minute = minRaw === '半' ? 30 : (minRaw ? Number(minRaw) : 0);
        const task = clockMatch[4].replace(/^[去把一下个，,。！!~～\s]+|[。！!~～呢吧啦呀]+$/g, '').trim() || '办正事';
        if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
            if ((/下午|晚上|今晚|夜里/.test(period) || (!period && hour <= 11 && new Date(nowMs).getHours() >= 12)) && hour < 12) {
                hour += 12;
            }
            const target = new Date(nowMs);
            target.setHours(hour, minute, 0, 0);
            if (target.getTime() <= nowMs) {
                target.setTime(target.getTime() + 86_400_000);
            }
            const deltaMs = target.getTime() - nowMs;
            return {
                dueAtMs: target.getTime(),
                delayMinutes: Math.max(1, Math.round(deltaMs / 60_000)),
                task,
            };
        }
    }

    return null;
}

function extractBigrams(text) {
    const clean = String(text || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
    const set = new Set();
    for (let i = 0; i < clean.length - 1; i++) {
        set.add(clean.slice(i, i + 2));
    }
    if (set.size === 0 && clean.length === 1) set.add(clean);
    return set;
}

export function computeKeywordMatch(queryText, summaryText) {
    if (!queryText || !summaryText) return 0;
    const qSet = extractBigrams(queryText);
    const sSet = extractBigrams(summaryText);
    if (qSet.size === 0 || sSet.size === 0) return 0;
    let hits = 0;
    for (const token of qSet) {
        if (sSet.has(token)) hits += 1;
    }
    return Math.min(1, hits / Math.max(1, Math.min(qSet.size, 6)));
}

export class MemoryManager {
    constructor(options = {}) {
        this.storePath = options.storePath || options.filePath || MEMORY_STORE_PATH;
        this.dbPath = options.dbPath || (
            this.storePath.endsWith('.json')
                ? this.storePath.replace(/\.json$/i, '.db')
                : `${this.storePath}.db`
        ) || MEMORY_DB_PATH;
        this.masterQQ = String(options.masterQQ || DEFAULT_MASTER_QQ);
        this.now = options.now || (() => Date.now());
        this.llmReflector = options.llmReflector || null;
        this.llmDailyCompressor = options.llmDailyCompressor || null;
        this.isCompressing = false;
        this.working = new Map(); // chatId -> Array<{ role, userId, nickname, time, text, ts, messageId }>

        this.state = this._loadJsonFallback();
        if (!this.state.meta) this.state.meta = {};
        if (!this.state.driveState) this.state.driveState = null;
        this.data = this.state;

        this._initSqliteDb();
        this._ensureMasterProfile();
    }

    _initSqliteDb() {
        try {
            mkdirSync(dirname(this.dbPath), { recursive: true });
            this.db = new DatabaseSync(this.dbPath);
            this.db.exec(`
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;

                CREATE TABLE IF NOT EXISTS user_profiles (
                    user_id TEXT PRIMARY KEY,
                    nickname TEXT NOT NULL,
                    affection REAL NOT NULL DEFAULT 55,
                    relationship_tag TEXT NOT NULL DEFAULT '群友/饭票候选',
                    known_facts_json TEXT NOT NULL DEFAULT '[]',
                    last_interaction_time TEXT,
                    last_interaction_ts INTEGER DEFAULT 0,
                    last_late_night_ts INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS episodic_memories (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    importance INTEGER NOT NULL DEFAULT 6,
                    created_at TEXT,
                    created_at_ms INTEGER NOT NULL,
                    last_accessed_at TEXT,
                    last_accessed_at_ms INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_episodic_user_ts ON episodic_memories(user_id, last_accessed_at_ms DESC);

                CREATE TABLE IF NOT EXISTS raw_interaction_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day_key TEXT NOT NULL,
                    ts INTEGER NOT NULL,
                    time_str TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    nickname TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    content TEXT NOT NULL,
                    compressed INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_raw_logs_day_ts ON raw_interaction_logs(day_key, compressed, ts ASC);

                CREATE TABLE IF NOT EXISTS daily_digests (
                    day_key TEXT PRIMARY KEY,
                    summary TEXT NOT NULL,
                    highlights_json TEXT NOT NULL DEFAULT '[]',
                    msg_count INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS group_lore (
                    group_id TEXT PRIMARY KEY,
                    lore_json TEXT NOT NULL DEFAULT '[]',
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS reminders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    nickname TEXT NOT NULL,
                    task TEXT NOT NULL,
                    due_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    triggered INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(triggered, due_at ASC);

                CREATE TABLE IF NOT EXISTS kv_meta (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );
            `);
            try {
                this.db.exec("ALTER TABLE user_profiles ADD COLUMN pet_nickname TEXT NOT NULL DEFAULT ''");
            } catch {}

            // 首次启动时将旧版 JSON 中的 users 与 episodic 平滑同步至 SQLite，并从 SQLite 加载最新状态
            this._syncStateWithSqliteOnBoot();
        } catch (err) {
            console.warn('[MemoryManager] SQLite 初始化失败，退回纯 JSON 模式:', err.message);
            this.db = null;
        }
    }

    _syncStateWithSqliteOnBoot() {
        if (!this.db) return;
        // 1. 将 JSON 中已有的 users 写入 SQLite (INSERT OR IGNORE)
        const insertUser = this.db.prepare(`
            INSERT OR IGNORE INTO user_profiles (user_id, nickname, affection, relationship_tag, known_facts_json, last_interaction_time, last_interaction_ts, last_late_night_ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [uid, u] of Object.entries(this.state.users || {})) {
            if (!u || typeof u !== 'object') continue;
            insertUser.run(
                String(uid),
                String(u.nickname || uid),
                Number(u.affection ?? 55),
                String(u.relationship_tag || '群友/饭票候选'),
                JSON.stringify(Array.isArray(u.known_facts) ? u.known_facts : []),
                String(u.last_interaction_time || new Date().toISOString()),
                Number(u.last_interaction_ts || Date.now()),
                Number(u.last_late_night_ts || 0),
            );
        }

        // 2. 将 JSON 中已有的 episodic 写入 SQLite (INSERT OR IGNORE)
        const insertEp = this.db.prepare(`
            INSERT OR IGNORE INTO episodic_memories (id, user_id, summary, importance, created_at, created_at_ms, last_accessed_at, last_accessed_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const ep of this.state.episodic || []) {
            if (!ep || !ep.summary) continue;
            const createdMs = Number(ep.created_at_ms || (typeof ep.created_at === 'number' ? ep.created_at : Date.parse(ep.created_at || '')) || Date.now());
            const accessedMs = Number(ep.last_accessed_at_ms || (typeof ep.last_accessed_at === 'number' ? ep.last_accessed_at : Date.parse(ep.last_accessed_at || '')) || createdMs);
            insertEp.run(
                String(ep.id || `ep_${createdMs}_${Math.random().toString(36).slice(2, 6)}`),
                String(ep.user_id || this.masterQQ),
                String(ep.summary).slice(0, 200),
                Number(ep.importance || 6),
                new Date(createdMs).toISOString(),
                createdMs,
                new Date(accessedMs).toISOString(),
                accessedMs,
            );
        }

        // 3. 从 SQLite 反向读取合并回内存缓存，确保两边完全一致
        const dbUsers = this.db.prepare('SELECT * FROM user_profiles').all();
        for (const row of dbUsers) {
            let facts = [];
            try { facts = JSON.parse(row.known_facts_json || '[]'); } catch {}
            this.state.users[row.user_id] = {
                ...(this.state.users[row.user_id] || {}),
                user_id: row.user_id,
                nickname: row.nickname,
                pet_nickname: row.pet_nickname || this.state.users[row.user_id]?.pet_nickname || '',
                affection: row.affection,
                relationship_tag: row.relationship_tag,
                known_facts: facts,
                last_interaction_time: row.last_interaction_time,
                last_interaction_ts: row.last_interaction_ts,
                last_late_night_ts: row.last_late_night_ts,
            };
        }

        const dbEps = this.db.prepare('SELECT * FROM episodic_memories ORDER BY created_at_ms DESC LIMIT 300').all();
        if (dbEps.length > 0) {
            this.state.episodic = dbEps.map(row => ({
                id: row.id,
                user_id: row.user_id,
                summary: row.summary,
                importance: row.importance,
                created_at: row.created_at || new Date(row.created_at_ms).toISOString(),
                created_at_ms: row.created_at_ms,
                last_accessed_at: row.last_accessed_at || new Date(row.last_accessed_at_ms).toISOString(),
                last_accessed_at_ms: row.last_accessed_at_ms,
            }));
        }

        // 4. 加载 recentWorkingMemory（重启后依然保留今天最近几条会话工作记忆）
        const todayKey = toDayKey(this.now());
        const recentRows = this.db.prepare(`
            SELECT chat_id, user_id, nickname, time_str, role, content, ts
            FROM raw_interaction_logs
            WHERE day_key = ?
            ORDER BY ts DESC
            LIMIT 30
        `).all(todayKey).reverse();
        for (const r of recentRows) {
            const list = this.working.get(r.chat_id) || [];
            list.push({
                role: r.role,
                userId: r.user_id,
                nickname: r.nickname,
                time: r.time_str,
                text: r.content,
                ts: r.ts,
            });
            while (list.length > WORKING_MEMORY_CAP) list.shift();
            this.working.set(r.chat_id, list);
        }
    }

    _loadJsonFallback() {
        try {
            if (existsSync(this.storePath)) {
                const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
                if (raw && typeof raw === 'object') {
                    return {
                        version: 3,
                        users: raw.users && typeof raw.users === 'object' ? raw.users : {},
                        episodic: Array.isArray(raw.episodic) ? raw.episodic : [],
                        lastReflectionAt: raw.lastReflectionAt || 0,
                        meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
                        driveState: raw.driveState || null,
                    };
                }
            }
        } catch (err) {
            console.warn('[MemoryManager] 读取记忆库失败，初始化空库:', err.message);
        }
        return { version: 3, users: {}, episodic: [], lastReflectionAt: 0 };
    }

    save() {
        try {
            mkdirSync(dirname(this.storePath), { recursive: true });
            const tmp = `${this.storePath}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
            renameSync(tmp, this.storePath);
        } catch (err) {
            console.warn('[MemoryManager] 保存 JSON 记忆快照失败:', err.message);
        }
        this._syncMemoryStateToSqlite();
    }

    _syncMemoryStateToSqlite() {
        if (!this.db) return;
        try {
            const upsertUser = this.db.prepare(`
                INSERT INTO user_profiles (user_id, nickname, pet_nickname, affection, relationship_tag, known_facts_json, last_interaction_time, last_interaction_ts, last_late_night_ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    nickname = excluded.nickname,
                    pet_nickname = excluded.pet_nickname,
                    affection = excluded.affection,
                    relationship_tag = excluded.relationship_tag,
                    known_facts_json = excluded.known_facts_json,
                    last_interaction_time = excluded.last_interaction_time,
                    last_interaction_ts = excluded.last_interaction_ts,
                    last_late_night_ts = excluded.last_late_night_ts
            `);
            for (const [uid, u] of Object.entries(this.state.users || {})) {
                if (!u || typeof u !== 'object') continue;
                upsertUser.run(
                    String(uid),
                    String(u.nickname || uid),
                    String(u.pet_nickname || ''),
                    Number(u.affection ?? 55),
                    String(u.relationship_tag || '群友/饭票候选'),
                    JSON.stringify(Array.isArray(u.known_facts) ? u.known_facts : []),
                    String(u.last_interaction_time || new Date().toISOString()),
                    Number(u.last_interaction_ts || Date.now()),
                    Number(u.last_late_night_ts || 0),
                );
            }
        } catch (err) {
            console.warn('[MemoryManager] SQLite 同步用户画像失败:', err.message);
        }
    }

    _ensureMasterProfile() {
        if (!this.state.users[this.masterQQ]) {
            this.state.users[this.masterQQ] = {
                user_id: this.masterQQ,
                nickname: '老大',
                affection: 92,
                relationship_tag: '首席饲主/老大',
                known_facts: [
                    '大肥鱼最信任的首席饲主（老大）',
                    '拥有电脑最高控制权限，经常带着大肥鱼一起摸鱼干饭',
                ],
                last_interaction_time: new Date().toISOString(),
                last_interaction_ts: Date.now(),
                last_late_night_ts: 0,
            };
            this.save();
        }
    }

    // ── 1. Working Memory & Raw Interaction Logs (会话工作记忆 + 每日原始流水落盘) ──
    addWorkingMemory(chatId, entry) {
        if (!chatId || !entry) return;
        const cleanText = String(entry.text || '').replace(/\r?\n/g, ' ').trim().slice(0, 220);
        if (!cleanText) return;
        const list = this.working.get(chatId) || [];
        const now = entry.ts || this.now();
        const timeStr = entry.time || new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const role = String(entry.role || 'user');
        const userId = String(entry.userId || (role === 'assistant' ? 'feiyu' : 'unknown'));
        const nickname = String(entry.nickname || (role === 'assistant' ? '大肥鱼' : userId));

        list.push({
            role,
            userId,
            nickname,
            time: timeStr,
            text: cleanText,
            ts: now,
            messageId: entry.messageId ? String(entry.messageId) : undefined,
        });
        while (list.length > WORKING_MEMORY_CAP) {
            list.shift();
        }
        this.working.set(chatId, list);

        // 同步写入 SQLite 每日原始交互流水表，供后续提炼“每天主要干了什么”
        if (this.db && !cleanText.startsWith('/fish')) {
            try {
                const dayKey = toDayKey(now);
                this.db.prepare(`
                    INSERT INTO raw_interaction_logs (day_key, ts, time_str, chat_id, user_id, nickname, role, content, compressed)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
                `).run(dayKey, now, timeStr, String(chatId), userId, nickname, role, cleanText);

                // 检查今日未压缩流水是否达到阈值 (24 条)，若达到则后台异步触发一次阶段压缩
                const row = this.db.prepare(`
                    SELECT COUNT(*) AS cnt FROM raw_interaction_logs WHERE day_key = ? AND compressed = 0
                `).get(dayKey);
                if (row && Number(row.cnt) >= INTRADAY_COMPRESS_THRESHOLD && !this.isCompressing) {
                    void this.compressDailyMemory(dayKey);
                }
            } catch (err) {
                console.warn('[MemoryManager] 写入 raw_interaction_logs 失败:', err.message);
            }
        }
    }

    /**
     * 记录大肥鱼今日发生的关键事件（如：被投喂五花肉、被顺毛摸鱼头、自己逛了B站/小红书、闹别扭/被哄好）
     */
    recordDailyEvent(eventText, chatId = `private:${DEFAULT_MASTER_QQ}`, userId = DEFAULT_MASTER_QQ) {
        const clean = String(eventText || '').trim();
        if (!clean) return;
        this.addWorkingMemory(chatId, {
            role: 'event',
            userId: String(userId || this.masterQQ),
            nickname: '事件记录',
            text: clean,
            ts: this.now(),
        });
    }

    getWorkingMemory(chatId, limit = 15) {
        const list = this.working.get(chatId) || [];
        return list.slice(-limit);
    }

    // ── 2. 每日记忆压缩机制 (Daily Memory Compression & Temporary Digest) ────────
    /**
     * 将指定日期 (`YYYY-MM-DD`) 的未压缩流水提炼为“当日主要干了什么”的压缩记忆 (`daily_digests`)
     * @param {string} [targetDayKey] - 默认今天
     * @param {{ forceAll?: boolean }} [opts]
     */
    async compressDailyMemory(targetDayKey, opts = {}) {
        if (!this.db || this.isCompressing) return null;
        const dayKey = targetDayKey || toDayKey(this.now());
        this.isCompressing = true;

        try {
            const rawLogs = opts.forceAll
                ? this.db.prepare('SELECT * FROM raw_interaction_logs WHERE day_key = ? ORDER BY ts ASC').all(dayKey)
                : this.db.prepare('SELECT * FROM raw_interaction_logs WHERE day_key = ? AND compressed = 0 ORDER BY ts ASC').all(dayKey);

            const existingDigest = this.getDailyDigest(dayKey);
            if (rawLogs.length === 0) {
                return existingDigest;
            }

            let summary = '';
            let highlights = [];
            let extractedEpisodic = [];
            let extractedGroupLore = [];

            // 1. 优先尝试调用 LLM 进行智能压缩提炼
            if (typeof this.llmDailyCompressor === 'function') {
                try {
                    const llmRes = await this.llmDailyCompressor(dayKey, existingDigest, rawLogs);
                    if (llmRes && typeof llmRes.summary === 'string' && llmRes.summary.trim()) {
                        summary = llmRes.summary.trim().slice(0, 180);
                        if (Array.isArray(llmRes.highlights)) {
                            highlights = llmRes.highlights.map(h => String(h).trim()).filter(Boolean).slice(0, 6);
                        }
                        if (Array.isArray(llmRes.episodic)) {
                            extractedEpisodic = llmRes.episodic;
                        }
                        if (Array.isArray(llmRes.group_lore)) {
                            extractedGroupLore = llmRes.group_lore.map(g => String(g).trim()).filter(Boolean);
                        }
                    }
                } catch (err) {
                    console.warn('[MemoryManager] LLM 每日记忆压缩降级至本地规则:', err.message);
                }
            }

            // 2. 本地规则兜底提炼（当无 LLM 或请求超时时，零 Token 自动提取当天关键事件与对话摘要）
            if (!summary) {
                const fallback = this._buildRuleBasedDailyDigest(dayKey, existingDigest, rawLogs);
                summary = fallback.summary;
                highlights = fallback.highlights;
            }

            const totalCountRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM raw_interaction_logs WHERE day_key = ?').get(dayKey);
            const totalMsgCount = Number(totalCountRow?.cnt || rawLogs.length);
            const nowMs = this.now();

            this.db.prepare(`
                INSERT INTO daily_digests (day_key, summary, highlights_json, msg_count, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(day_key) DO UPDATE SET
                    summary = excluded.summary,
                    highlights_json = excluded.highlights_json,
                    msg_count = excluded.msg_count,
                    updated_at = excluded.updated_at
            `).run(dayKey, summary, JSON.stringify(highlights), totalMsgCount, nowMs);

            // 标记这批原始流水为已压缩 (compressed = 1)
            const maxId = rawLogs[rawLogs.length - 1]?.id;
            if (maxId !== undefined) {
                this.db.prepare('UPDATE raw_interaction_logs SET compressed = 1 WHERE day_key = ? AND id <= ?').run(dayKey, maxId);
            }

            // 若压缩过程中提炼出了高重要度的长期事件，顺带存入长期情景记忆库
            for (const ep of extractedEpisodic) {
                if (ep && ep.summary && Number(ep.importance) >= 7) {
                    this.addEpisodicMemory({
                        userId: this.masterQQ,
                        summary: `[${dayKey}] ${ep.summary}`,
                        importance: Number(ep.importance),
                    });
                }
            }

            // 若压缩过程中提炼出了群梗黑话或群友印象，顺带存入对应群的 group_lore 表
            if (extractedGroupLore.length > 0) {
                const groupChats = [...new Set(rawLogs.map(r => r.chat_id).filter(c => String(c).startsWith('group:')))];
                const targetGroup = groupChats[0] || 'group:927066977';
                for (const lore of extractedGroupLore) {
                    this.addGroupLore(targetGroup, lore);
                }
            }

            // 自动清理 7 天前已压缩的原始流水，保持 SQLite 轻量高效
            const sevenDaysAgoMs = nowMs - 7 * 24 * 3600_000;
            this.db.prepare('DELETE FROM raw_interaction_logs WHERE compressed = 1 AND ts < ?').run(sevenDaysAgoMs);

            return {
                day_key: dayKey,
                summary,
                highlights,
                msg_count: totalMsgCount,
                updated_at: nowMs,
            };
        } finally {
            this.isCompressing = false;
        }
    }

    _buildRuleBasedDailyDigest(dayKey, existingDigest, rawLogs) {
        const prevHighlights = Array.isArray(existingDigest?.highlights) ? existingDigest.highlights : [];
        const eventItems = [];
        const userTopics = [];

        for (const r of rawLogs) {
            if (r.role === 'event') {
                eventItems.push(`${r.time_str} ${r.content}`);
            } else if (r.role === 'user' && r.content.length >= 2) {
                userTopics.push(`${r.time_str} ${r.nickname}: "${r.content.slice(0, 28)}"`);
            }
        }

        const mergedHighlights = [
            ...prevHighlights,
            ...eventItems.slice(-4),
            ...userTopics.slice(-3),
        ].slice(-6);

        const uniqueHighlights = [...new Set(mergedHighlights)];
        const summaryParts = [];
        if (existingDigest?.summary && !existingDigest.summary.includes('主要互动：')) {
            summaryParts.push(existingDigest.summary);
        }
        if (eventItems.length > 0) {
            summaryParts.push(`今日事件：${eventItems.slice(-3).join('；')}`);
        }
        if (userTopics.length > 0) {
            summaryParts.push(`近期聊了：${userTopics.slice(-2).join('、')}`);
        }
        const summary = summaryParts.join(' | ').slice(0, 160) || `${dayKey} 共互动了 ${rawLogs.length} 条消息，度过了愉快摸鱼的一天。`;
        return { summary, highlights: uniqueHighlights };
    }

    /**
     * 后台定时检查：自动将昨天及之前未压缩的跨天流水归档压缩为每日摘要
     */
    async autoCompressPastDaysIfNeeded() {
        if (!this.db || this.isCompressing) return [];
        const todayKey = toDayKey(this.now());
        const pendingDays = this.db.prepare(`
            SELECT DISTINCT day_key FROM raw_interaction_logs
            WHERE day_key < ? AND compressed = 0
            ORDER BY day_key ASC
            LIMIT 3
        `).all(todayKey);

        const results = [];
        for (const row of pendingDays) {
            const res = await this.compressDailyMemory(row.day_key, { forceAll: true });
            if (res) results.push(res);
        }
        return results;
    }

    getDailyDigest(dayKey) {
        if (!this.db) return null;
        const row = this.db.prepare('SELECT * FROM daily_digests WHERE day_key = ?').get(dayKey);
        if (!row) return null;
        let highlights = [];
        try { highlights = JSON.parse(row.highlights_json || '[]'); } catch {}
        return {
            day_key: row.day_key,
            summary: row.summary,
            highlights,
            msg_count: row.msg_count,
            updated_at: row.updated_at,
        };
    }

    getRecentDailyDigests(limit = 4) {
        if (!this.db) return [];
        const rows = this.db.prepare('SELECT * FROM daily_digests ORDER BY day_key DESC LIMIT ?').all(limit);
        return rows.map(row => {
            let highlights = [];
            try { highlights = JSON.parse(row.highlights_json || '[]'); } catch {}
            return {
                day_key: row.day_key,
                summary: row.summary,
                highlights,
                msg_count: row.msg_count,
                updated_at: row.updated_at,
            };
        });
    }

    /**
     * 格式化“近期每日摘要 + 今日暂时记忆”供每轮 Prompt 注入，让大肥鱼清楚记得今天和前几天主要干了什么
     */
    formatTemporaryAndDailyMemoryForPrompt(chatId = '') {
        if (!this.db) return '';
        const todayKey = toDayKey(this.now());
        const digests = this.getRecentDailyDigests(4);
        const todayDigest = digests.find(d => d.day_key === todayKey);
        const pastDigests = digests.filter(d => d.day_key !== todayKey).slice(0, 3);

        // 提取今天尚未压缩的最近 6 条交互流水作为实时暂时记忆
        const recentUncompressed = chatId
            ? this.db.prepare(`
                SELECT time_str, nickname, role, content FROM raw_interaction_logs
                WHERE day_key = ? AND (chat_id = ? OR role = 'event')
                ORDER BY ts DESC LIMIT 6
            `).all(todayKey, String(chatId)).reverse()
            : this.db.prepare(`
                SELECT time_str, nickname, role, content FROM raw_interaction_logs
                WHERE day_key = ?
                ORDER BY ts DESC LIMIT 6
            `).all(todayKey).reverse();

        const lines = [];
        if (pastDigests.length > 0) {
            lines.push('【前几天主要干了什么 (Recent Daily Digests)】');
            for (const d of pastDigests) {
                const hl = d.highlights.length > 0 ? `（要点：${d.highlights.slice(0, 3).join('；')}）` : '';
                lines.push(`  - [${d.day_key}] ${d.summary}${hl}`);
            }
        }

        if (todayDigest || recentUncompressed.length > 0) {
            lines.push(`【今日暂时记忆 (${todayKey} 今天干了什么 & 刚才的互动)】`);
            if (todayDigest) {
                lines.push(`  - 今日阶段小结: ${todayDigest.summary}`);
                if (todayDigest.highlights.length > 0) {
                    lines.push(`  - 今日主要事项: ${todayDigest.highlights.slice(0, 4).join('；')}`);
                }
            }
            if (recentUncompressed.length > 0) {
                const rawLines = recentUncompressed.map(r => {
                    if (r.role === 'event') return `[${r.time_str} 事件] ${r.content}`;
                    if (r.role === 'assistant') return `[${r.time_str} 大肥鱼] ${r.content}`;
                    return `[${r.time_str} ${r.nickname}] ${r.content}`;
                });
                lines.push(`  - 刚刚的实时流水:\n    ${rawLines.join('\n    ')}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * 跨表全文/关键词搜索历史记忆（同时搜索 `episodic_memories`、`daily_digests` 与 `raw_interaction_logs`）
     */
    searchMemories(query, limit = 8) {
        const q = String(query || '').trim();
        if (!q || !this.db) return { episodic: [], digests: [], logs: [] };
        const likePat = `%${q}%`;

        const episodic = this.db.prepare(`
            SELECT id, user_id, summary, importance, created_at_ms
            FROM episodic_memories
            WHERE summary LIKE ?
            ORDER BY importance DESC, created_at_ms DESC
            LIMIT ?
        `).all(likePat, limit);

        const digests = this.db.prepare(`
            SELECT day_key, summary, highlights_json, msg_count
            FROM daily_digests
            WHERE summary LIKE ? OR highlights_json LIKE ? OR day_key LIKE ?
            ORDER BY day_key DESC
            LIMIT ?
        `).all(likePat, likePat, likePat, limit).map(r => ({
            ...r,
            highlights: JSON.parse(r.highlights_json || '[]'),
        }));

        const logs = this.db.prepare(`
            SELECT day_key, time_str, nickname, role, content
            FROM raw_interaction_logs
            WHERE content LIKE ?
            ORDER BY ts DESC
            LIMIT ?
        `).all(likePat, limit);

        return { episodic, digests, logs };
    }

    getDatabaseStats() {
        if (!this.db) return { sqliteEnabled: false };
        const epCount = this.db.prepare('SELECT COUNT(*) AS c FROM episodic_memories').get()?.c || 0;
        const digestCount = this.db.prepare('SELECT COUNT(*) AS c FROM daily_digests').get()?.c || 0;
        const rawTotal = this.db.prepare('SELECT COUNT(*) AS c FROM raw_interaction_logs').get()?.c || 0;
        const rawUncompressed = this.db.prepare('SELECT COUNT(*) AS c FROM raw_interaction_logs WHERE compressed = 0').get()?.c || 0;
        const userCount = this.db.prepare('SELECT COUNT(*) AS c FROM user_profiles').get()?.c || 0;
        const groupLoreCount = this.db.prepare('SELECT COUNT(*) AS c FROM group_lore').get()?.c || 0;
        const reminderPendingCount = this.db.prepare('SELECT COUNT(*) AS c FROM reminders WHERE triggered = 0').get()?.c || 0;
        return {
            sqliteEnabled: true,
            dbPath: this.dbPath,
            userCount,
            epCount,
            digestCount,
            rawTotal,
            rawUncompressed,
            groupLoreCount,
            reminderPendingCount,
        };
    }

    // ── 2.5 Group Shared Lore (群聊共同记忆与群梗黑话库) ──────────────────────
    getGroupLore(groupIdOrChatId) {
        if (!this.db || !groupIdOrChatId) return [];
        const gid = String(groupIdOrChatId).replace(/^group:/i, '').trim();
        if (!gid) return [];
        try {
            const row = this.db.prepare('SELECT lore_json FROM group_lore WHERE group_id = ?').get(gid);
            if (!row) return [];
            const parsed = JSON.parse(row.lore_json || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    addGroupLore(groupIdOrChatId, loreFact) {
        if (!this.db || !groupIdOrChatId || !loreFact) return false;
        const gid = String(groupIdOrChatId).replace(/^group:/i, '').trim();
        const clean = String(loreFact).replace(/\r?\n/g, ' ').trim().slice(0, 120);
        if (!gid || !clean) return false;

        try {
            const existing = this.getGroupLore(gid);
            // 去重：若已有高度相似的群梗则更新到最前
            const filtered = existing.filter(item => item !== clean && computeKeywordMatch(item, clean) < 0.8);
            filtered.unshift(clean);
            const updated = filtered.slice(0, 10);
            this.db.prepare(`
                INSERT INTO group_lore (group_id, lore_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(group_id) DO UPDATE SET
                    lore_json = excluded.lore_json,
                    updated_at = excluded.updated_at
            `).run(gid, JSON.stringify(updated), this.now());
            return true;
        } catch (err) {
            console.warn('[MemoryManager] 写入 group_lore 失败:', err.message);
            return false;
        }
    }

    formatGroupLoreForPrompt(chatId) {
        if (!chatId || !String(chatId).startsWith('group:')) return '';
        const loreList = this.getGroupLore(chatId);
        if (loreList.length === 0) return '';
        const lines = loreList.slice(0, 6).map((item, i) => `  ${i + 1}. ${item}`);
        return `【本群共同记忆与群梗黑话 (Group Shared Lore)】\n${lines.join('\n')}`;
    }

    // ── 2.8 Reminders (鱼脑定时备忘录) ────────────────────────────────────────
    addReminder({ chatId, userId, nickname, task, dueAtMs, delayMinutes }) {
        if (!this.db || !task) return null;
        const now = this.now();
        const due = Number(dueAtMs) || (now + (Math.max(1, Number(delayMinutes) || 10) * 60_000));
        const cleanTask = String(task).replace(/\r?\n/g, ' ').trim().slice(0, 100);
        const cId = String(chatId || `private:${userId || this.masterQQ}`);
        const uId = String(userId || this.masterQQ);
        const nick = String(nickname || uId);

        // 防止 10 秒内重复写入完全相同的提醒
        const dup = this.db.prepare(`
            SELECT id FROM reminders WHERE chat_id = ? AND task = ? AND triggered = 0 AND ABS(due_at - ?) < 60000
        `).get(cId, cleanTask, due);
        if (dup) return dup;

        const info = this.db.prepare(`
            INSERT INTO reminders (chat_id, user_id, nickname, task, due_at, created_at, triggered)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `).run(cId, uId, nick, cleanTask, due, now);
        return {
            id: Number(info.lastInsertRowid),
            chat_id: cId,
            user_id: uId,
            nickname: nick,
            task: cleanTask,
            due_at: due,
        };
    }

    popDueReminders(nowMs = this.now()) {
        if (!this.db) return [];
        const rows = this.db.prepare(`
            SELECT * FROM reminders WHERE triggered = 0 AND due_at <= ? ORDER BY due_at ASC LIMIT 10
        `).all(nowMs);
        if (rows.length > 0) {
            const stmt = this.db.prepare('UPDATE reminders SET triggered = 1 WHERE id = ?');
            for (const r of rows) {
                stmt.run(r.id);
            }
        }
        return rows;
    }

    getPendingReminders(chatId = '') {
        if (!this.db) return [];
        if (chatId) {
            return this.db.prepare('SELECT * FROM reminders WHERE triggered = 0 AND chat_id = ? ORDER BY due_at ASC').all(String(chatId));
        }
        return this.db.prepare('SELECT * FROM reminders WHERE triggered = 0 ORDER BY due_at ASC').all();
    }

    // ── 3. Semantic Memory (QQ 用户专属档案) ─────────────────────────────────
    getUserProfile(userId, fallbackNickname = '') {
        const uid = String(userId || '').trim();
        if (!uid) return null;
        const isMaster = uid === this.masterQQ;
        if (!this.state.users[uid]) {
            this.state.users[uid] = {
                user_id: uid,
                nickname: fallbackNickname || (isMaster ? '老大' : `群友_${uid.slice(-4)}`),
                affection: isMaster ? 92 : 55,
                relationship_tag: isMaster ? '首席饲主/老大' : '群友/饭票候选',
                known_facts: isMaster ? ['大肥鱼的首席饲主（老大）'] : [],
                last_interaction_time: new Date().toISOString(),
                last_interaction_ts: Date.now(),
                last_late_night_ts: 0,
            };
            this.save();
        } else if (fallbackNickname && fallbackNickname !== uid && !isMaster) {
            this.state.users[uid].nickname = fallbackNickname;
        }
        return this.state.users[uid];
    }

    touchUserInteraction(userId, nickname = '') {
        const profile = this.getUserProfile(userId, nickname);
        if (!profile) return null;
        const now = this.now();
        profile.last_interaction_time = new Date(now).toISOString();
        profile.last_interaction_ts = now;
        const hour = new Date(now).getHours();
        const min = new Date(now).getMinutes();
        if (hour < 5 || (hour === 23 && min >= 30)) {
            profile.last_late_night_ts = now;
        }
        this.save();
        return profile;
    }

    updateAffection(userId, delta = 0, fallbackNickname = '') {
        const profile = this.getUserProfile(userId, fallbackNickname);
        if (!profile) return 50;
        const d = Math.max(-10, Math.min(10, Math.round((Number(delta) || 0) * 10) / 10));
        profile.affection = Math.max(0, Math.min(100, Math.round(((profile.affection ?? 50) + d) * 10) / 10));
        if (String(userId) === this.masterQQ) {
            profile.relationship_tag = '首席饲主/老大';
            profile.affection = Math.max(60, profile.affection);
        } else if (profile.affection >= 80) {
            profile.relationship_tag = '铁杆饭票/挚友';
        } else if (profile.affection >= 50) {
            profile.relationship_tag = '熟人群友';
        } else {
            profile.relationship_tag = '普通路人';
        }
        this.save();
        return profile.affection;
    }

    addKnownFact(userId, fact) {
        const clean = String(fact || '').trim();
        if (!clean) return;
        const profile = this.getUserProfile(userId);
        if (!profile) return;
        if (!Array.isArray(profile.known_facts)) profile.known_facts = [];
        if (!profile.known_facts.includes(clean)) {
            profile.known_facts.unshift(clean);
            profile.known_facts = profile.known_facts.slice(0, 15);
            this.save();
        }
    }

    setPetNickname(userId, petNickname, fallbackNickname = '') {
        const clean = String(petNickname || '').replace(/[\r\n"“”'‘’「」【】]/g, '').trim().slice(0, 14);
        if (!clean) return null;
        const profile = this.getUserProfile(userId, fallbackNickname);
        if (!profile) return null;
        if (String(userId) === this.masterQQ) {
            profile.pet_nickname = '老大';
        } else {
            profile.pet_nickname = clean;
        }
        this.save();
        return profile.pet_nickname;
    }

    // ── 4. Episodic Memory (长期情景记忆与指数衰减检索) ────────────────────────
    saveEpisodicMemory(userId, memoryObj) {
        if (!memoryObj || !memoryObj.should_save) return false;
        const importance = Math.round(Number(memoryObj.importance) || 0);
        const summary = String(memoryObj.summary || '').trim();
        if (importance < 6 || !summary) return false;
        return Boolean(this.addEpisodicMemory({ userId, summary, importance }));
    }

    addEpisodicMemory(entry = {}) {
        if (!entry || typeof entry !== 'object') return null;
        const importance = Math.round(Number(entry.importance) || 0);
        const summary = String(entry.summary || '').trim();
        if (importance < 6 || !summary) return null;
        const uid = String(entry.userId || entry.user_id || this.masterQQ);
        const now = this.now();

        // 去重：如果已有高度相似的 summary 则更新时间戳与重要度
        const existing = this.state.episodic.find(
            m => m.user_id === uid && (m.summary === summary || computeKeywordMatch(m.summary, summary) > 0.8)
        );
        if (existing) {
            existing.importance = Math.max(existing.importance, Math.min(10, importance));
            existing.last_accessed_at = new Date(now).toISOString();
            existing.last_accessed_at_ms = now;
            existing.summary = summary.slice(0, 180);
            if (this.db) {
                this.db.prepare(`
                    UPDATE episodic_memories
                    SET importance = ?, last_accessed_at = ?, last_accessed_at_ms = ?, summary = ?
                    WHERE id = ?
                `).run(existing.importance, existing.last_accessed_at, now, existing.summary, existing.id);
            }
            this.save();
            return existing;
        }

        const item = {
            id: `ep_${now}_${Math.random().toString(36).slice(2, 6)}`,
            user_id: uid,
            summary: summary.slice(0, 180),
            importance: Math.min(10, Math.max(6, importance)),
            created_at: new Date(now).toISOString(),
            created_at_ms: now,
            last_accessed_at: new Date(now).toISOString(),
            last_accessed_at_ms: now,
        };
        this.state.episodic.unshift(item);
        if (this.db) {
            this.db.prepare(`
                INSERT OR REPLACE INTO episodic_memories (id, user_id, summary, importance, created_at, created_at_ms, last_accessed_at, last_accessed_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(item.id, item.user_id, item.summary, item.importance, item.created_at, item.created_at_ms, item.last_accessed_at, item.last_accessed_at_ms);
        }
        this.pruneMemories(uid);
        this.save();
        return item;
    }

    /**
     * 指数衰减检索算法（同时检索 `episodic_memories` 与历史 `daily_digests`）：
     * Score = 0.4 * e^(-0.05 * Δt) + 0.4 * (Importance / 10) + 0.2 * KeywordMatch
     */
    retrieveEpisodicMemories(arg1 = '', arg2 = 3, arg3 = undefined, touchOnHit = true) {
        let uid;
        let queryText;
        let topK;
        if (typeof arg2 === 'number') {
            queryText = String(arg1 || '');
            topK = arg2;
            uid = String(arg3 || this.masterQQ);
        } else {
            uid = String(arg1 || this.masterQQ);
            queryText = String(arg2 || '');
            topK = typeof arg3 === 'number' ? arg3 : 3;
        }
        const now = this.now();
        const candidates = this.state.episodic.filter(m => !m.user_id || m.user_id === uid);

        const scored = candidates.map(mem => {
            const rawLast = mem.last_accessed_at_ms ?? (typeof mem.last_accessed_at === 'number' ? mem.last_accessed_at : Date.parse(mem.last_accessed_at || mem.created_at || ''));
            const lastTime = Number.isFinite(rawLast) ? rawLast : now;
            const deltaHours = Math.max(0, (now - lastTime) / 3_600_000);
            const recencyScore = Math.exp(-0.05 * deltaHours);
            const importanceScore = Math.min(10, Math.max(1, mem.importance || 6)) / 10;
            const kwScore = computeKeywordMatch(queryText, mem.summary);
            const score = 0.4 * recencyScore + 0.4 * importanceScore + 0.2 * kwScore;
            return { mem, score, isDigest: false };
        });

        // 同时检索 SQLite 中的历史每日摘要（含自然语言相对日期精准回溯，如“昨天/前天/上周” + 关键词匹配）
        if (this.db && queryText) {
            const matchedDates = resolveRelativeDatesFromQuery(queryText, now);
            const matchedDayKeys = new Set();

            for (const { label, dayKey } of matchedDates) {
                matchedDayKeys.add(dayKey);
                const exactDigest = this.getDailyDigest(dayKey);
                if (exactDigest) {
                    const hlText = exactDigest.highlights?.length > 0 ? `（主要事项：${exactDigest.highlights.join('；')}）` : '';
                    scored.push({
                        mem: {
                            id: `date_digest_${dayKey}`,
                            user_id: uid,
                            summary: `[${label}(${dayKey}) 记忆回溯] ${exactDigest.summary}${hlText}`,
                            importance: 9,
                            created_at: dayKey,
                        },
                        score: 0.99,
                        isDigest: true,
                    });
                } else {
                    // 若该日期尚未生成压缩摘要，直接从 raw_interaction_logs 实时提取当天流水
                    const dayLogs = this.db.prepare(`
                        SELECT time_str, nickname, role, content FROM raw_interaction_logs
                        WHERE day_key = ? ORDER BY ts DESC LIMIT 8
                    `).all(dayKey).reverse();
                    if (dayLogs.length > 0) {
                        const snippet = dayLogs.map(r => `${r.time_str} ${r.nickname}:${r.content.slice(0, 22)}`).join('；');
                        scored.push({
                            mem: {
                                id: `date_raw_${dayKey}`,
                                user_id: uid,
                                summary: `[${label}(${dayKey}) 原始记忆回溯] ${snippet}`,
                                importance: 8,
                                created_at: dayKey,
                            },
                            score: 0.96,
                            isDigest: true,
                        });
                    }
                }
            }

            const digests = this.getRecentDailyDigests(14);
            for (const d of digests) {
                if (matchedDayKeys.has(d.day_key)) continue;
                const combinedText = `${d.day_key} ${d.summary} ${(d.highlights || []).join(' ')}`;
                const kwScore = computeKeywordMatch(queryText, combinedText);
                if (kwScore >= 0.25) {
                    const deltaHours = Math.max(0, (now - (d.updated_at || now)) / 3_600_000);
                    const recencyScore = Math.exp(-0.03 * deltaHours);
                    const score = 0.35 * recencyScore + 0.35 * 0.8 + 0.3 * kwScore;
                    scored.push({
                        mem: {
                            id: `digest_${d.day_key}`,
                            user_id: uid,
                            summary: `[${d.day_key} 每日记忆摘要] ${d.summary}`,
                            importance: 8,
                            created_at: d.day_key,
                        },
                        score,
                        isDigest: true,
                    });
                }
            }
        }

        if (scored.length === 0) return [];
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, topK);
        if (touchOnHit && top.length > 0) {
            const isoNow = new Date(now).toISOString();
            for (const item of top) {
                if (!item.isDigest) {
                    item.mem.last_accessed_at = isoNow;
                    item.mem.last_accessed_at_ms = now;
                    if (this.db && item.mem.id) {
                        this.db.prepare('UPDATE episodic_memories SET last_accessed_at = ?, last_accessed_at_ms = ? WHERE id = ?')
                            .run(isoNow, now, item.mem.id);
                    }
                }
            }
            this.save();
        }
        return top.map(item => ({
            ...item.mem,
            score: Number(item.score.toFixed(3)),
        }));
    }

    getRecentEpisodicMemories(arg1 = 5, arg2 = 5) {
        if (typeof arg1 === 'number') {
            return this.state.episodic.slice(0, arg1);
        }
        const uid = String(arg1 || this.masterQQ);
        return this.state.episodic
            .filter(m => !m.user_id || m.user_id === uid)
            .slice(0, arg2);
    }

    pruneMemories(userId) {
        const now = this.now();
        const fourteenDaysMs = 14 * 24 * 3_600_000;
        this.state.episodic = this.state.episodic.filter(m => {
            const lastMs = m.last_accessed_at_ms || Date.parse(m.last_accessed_at || '') || now;
            const ageMs = now - lastMs;
            if ((m.importance || 6) <= 6 && ageMs > fourteenDaysMs) {
                if (this.db && m.id) {
                    this.db.prepare('DELETE FROM episodic_memories WHERE id = ?').run(m.id);
                }
                return false;
            }
            return true;
        });

        if (userId) {
            const uid = String(userId);
            const userMems = this.state.episodic.filter(m => m.user_id === uid);
            if (userMems.length > EPISODIC_MAX_PER_USER) {
                const keepIds = new Set(
                    userMems
                        .sort((a, b) => (b.importance - a.importance) || ((b.last_accessed_at_ms || 0) - (a.last_accessed_at_ms || 0)))
                        .slice(0, EPISODIC_MAX_PER_USER)
                        .map(m => m.id)
                );
                this.state.episodic = this.state.episodic.filter(m => {
                    if (m.user_id === uid && !keepIds.has(m.id)) {
                        if (this.db && m.id) {
                            this.db.prepare('DELETE FROM episodic_memories WHERE id = ?').run(m.id);
                        }
                        return false;
                    }
                    return true;
                });
            }
        }
    }

    async reflectUserProfile(userId, llmCaller) {
        const uid = String(userId || this.masterQQ);
        const profile = this.getUserProfile(uid);
        const recentEpisodic = this.state.episodic.filter(m => m.user_id === uid).slice(0, 12);
        if (!profile || recentEpisodic.length < 3 || typeof llmCaller !== 'function') return false;

        try {
            const prompt = `请根据以下关于用户(${profile.nickname})的已知画像与近期情景记忆碎片，归纳合并出 3~6 条最核心的长期事实画像（包含作息、喜好、近期关注的重要事件），每条不超过25字，以 JSON 数组格式输出，如 ["事实1", "事实2"]：\n已知画像：${JSON.stringify(profile.known_facts)}\n近期情景记忆：${JSON.stringify(recentEpisodic.map(e => e.summary))}`;
            const raw = await llmCaller(prompt);
            const match = String(raw || '').match(/\[[\s\S]*\]/);
            if (match) {
                const facts = JSON.parse(match[0]);
                if (Array.isArray(facts) && facts.length > 0) {
                    profile.known_facts = facts.map(f => String(f).trim()).filter(Boolean).slice(0, 10);
                    this.state.lastReflectionAt = Date.now();
                    this.save();
                    return true;
                }
            }
        } catch (err) {
            console.warn('[MemoryManager] 异步反思合并异常:', err.message);
        }
        return false;
    }

    async maybeTriggerReflection(userId) {
        const uid = String(userId || this.masterQQ);
        const now = this.now();
        if (now - (this.state.lastReflectionAt || 0) < 6 * 3600_000) return false;
        const userMems = this.state.episodic.filter(m => !m.user_id || m.user_id === uid);
        if (userMems.length < 5 || userMems.length % 5 !== 0) return false;
        if (typeof this.llmReflector === 'function') {
            try {
                const profile = this.getUserProfile(uid);
                const res = await this.llmReflector(uid, profile, [
                    ...(profile?.known_facts || []),
                    ...userMems.slice(0, 10).map(m => m.summary),
                ]);
                const mergedFacts = Array.isArray(res) ? res : res?.known_facts;
                if (Array.isArray(mergedFacts) && mergedFacts.length > 0 && profile) {
                    profile.known_facts = mergedFacts.map(f => String(f).trim()).filter(Boolean).slice(0, 10);
                    if (res?.pet_nickname && uid !== this.masterQQ) {
                        profile.pet_nickname = String(res.pet_nickname).trim().slice(0, 12);
                    }
                    this.state.lastReflectionAt = now;
                    this.save();
                    return true;
                }
            } catch {}
        }
        return false;
    }

    saveSync() {
        this.save();
    }

    getPersistedDriveState() {
        return this.state.driveState || null;
    }

    saveDriveState(driveState) {
        this.state.driveState = { ...driveState };
        this.save();
    }

    getSemanticProfile(userId, fallbackNickname = '') {
        return this.getUserProfile(userId, fallbackNickname);
    }

    applyAffectionDelta(userId, delta = 0, fallbackNickname = '') {
        this.updateAffection(userId, delta, fallbackNickname);
        return this.getUserProfile(userId, fallbackNickname);
    }

    formatSemanticProfileForPrompt(userId, nickname = '') {
        return this.formatStaticUserProfilePrompt(userId, nickname);
    }

    formatEpisodicMemoriesForPrompt(memories = []) {
        if (!Array.isArray(memories) || memories.length === 0) return '';
        const lines = memories.map((m, i) => `  ${i + 1}. [重要度:${m.importance}/10] ${m.summary}`);
        return `【唤醒的长期情景记忆 (Top-${memories.length} Episodic Memories)】\n${lines.join('\n')}`;
    }

    formatStaticUserProfilePrompt(userId, nickname = '') {
        const profile = this.getUserProfile(userId, nickname);
        if (!profile) return '';
        const facts = Array.isArray(profile.known_facts) && profile.known_facts.length > 0
            ? profile.known_facts.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
            : '  （暂未收录特殊偏好，待聊天中发掘）';
        const petNickLine = profile.pet_nickname && profile.user_id !== this.masterQQ
            ? `- 本鱼给ta起的专属外号 (pet_nickname): 「${profile.pet_nickname}」（聊天时可自然喊这个专属外号调侃ta！）`
            : '';
        return [
            `【目标 QQ 用户长期画像 (Semantic Memory)】`,
            `- 用户 QQ: ${profile.user_id}`,
            `- 称呼/昵称: ${profile.nickname}`,
            ...(petNickLine ? [petNickLine] : []),
            `- 关系定位: ${profile.relationship_tag}`,
            `- 当前好感度 (affection): ${profile.affection}/100`,
            `- 长期事实与习惯 (known_facts):\n${facts}`,
        ].join('\n');
    }
}
