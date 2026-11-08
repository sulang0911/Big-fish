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
const USER_COMPRESS_LOG_THRESHOLD = 10;
const USER_COMPRESS_CHAR_THRESHOLD = 450;
const USER_IMPORTANT_CAP = 15;
const USER_NORMAL_CAP = 8;

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
        this.llmUserCompressor = options.llmUserCompressor || null;
        this.isCompressing = false;
        this.compressingUsers = new Set();
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
            this.db = new DatabaseSync(this.dbPath, { timeout: 8000 });
            try { this.db.exec('PRAGMA busy_timeout = 8000;'); } catch {}
            try { this.db.exec('PRAGMA journal_mode = WAL;'); } catch {}
            try { this.db.exec('PRAGMA synchronous = NORMAL;'); } catch {}
            this.db.exec(`

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

                CREATE TABLE IF NOT EXISTS user_memories (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    tier TEXT NOT NULL DEFAULT 'normal',
                    importance INTEGER NOT NULL DEFAULT 5,
                    content TEXT NOT NULL,
                    chat_id TEXT NOT NULL DEFAULT '',
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_user_memories_uid_tier ON user_memories(user_id, tier, importance DESC, updated_at_ms DESC);
            `);
            try { this.db.exec("ALTER TABLE user_profiles ADD COLUMN pet_nickname TEXT NOT NULL DEFAULT ''"); } catch {}
            try { this.db.exec("ALTER TABLE user_profiles ADD COLUMN rolling_summary TEXT NOT NULL DEFAULT ''"); } catch {}
            try { this.db.exec("ALTER TABLE user_profiles ADD COLUMN important_memories_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
            try { this.db.exec("ALTER TABLE user_profiles ADD COLUMN normal_memories_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
            try { this.db.exec("ALTER TABLE raw_interaction_logs ADD COLUMN user_compressed INTEGER NOT NULL DEFAULT 0"); } catch {}
            try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_raw_logs_user_comp ON raw_interaction_logs(user_id, user_compressed, ts ASC)"); } catch {}

            // 首次启动时将旧版 JSON 中的 users 与 episodic 平滑同步至 SQLite，并从 SQLite 加载最新状态
            this._syncStateWithSqliteOnBoot();
        } catch (err) {
            console.warn('[MemoryManager] SQLite 初始化失败，退回纯 JSON 模式:', err.message);
            this.db = null;
        }
    }

    close() {
        if (this.db) {
            try { this.db.close(); } catch {}
            this.db = null;
        }
    }

    _syncStateWithSqliteOnBoot() {
        if (!this.db) return;
        const DIRTY_MEM_REGEX = /(投喂过本鱼.*(?:米饭了就应该|米饭了不是|不完的米饭|两格漫画里)|配好就好了|开黄腔说“|性骚扰说“|上次内设|内射|内设你)/i;
        // 清理非数字 QQ 号脏档案与历史污染记忆（在进程自身启动时清洗内存与 SQLite，防止内存回写复发）
        try {
            this.db.prepare("DELETE FROM user_profiles WHERE user_id NOT GLOB '[0-9]*'").run();
            for (const row of this.db.prepare('SELECT id, content FROM user_memories').all()) {
                if (DIRTY_MEM_REGEX.test(String(row.content || ''))) {
                    this.db.prepare('DELETE FROM user_memories WHERE id = ?').run(row.id);
                }
            }
            for (const row of this.db.prepare('SELECT group_id, lore_json FROM group_lore').all()) {
                let loreArr = [];
                try { loreArr = JSON.parse(row.lore_json || '[]'); } catch {}
                if (Array.isArray(loreArr)) {
                    const filtered = loreArr.filter(item => !DIRTY_MEM_REGEX.test(String(item || '')));
                    if (filtered.length !== loreArr.length) {
                        this.db.prepare('UPDATE group_lore SET lore_json = ? WHERE group_id = ?').run(JSON.stringify(filtered), row.group_id);
                    }
                }
            }
            for (const row of this.db.prepare("SELECT id, content FROM raw_interaction_logs WHERE role = 'assistant'").all()) {
                if (/(上次内设|内射)/i.test(String(row.content || ''))) {
                    this.db.prepare('UPDATE raw_interaction_logs SET content = ? WHERE id = ?').run(
                        String(row.content).replace(/(?:上次内设|内射)/g, '上次口出狂言'),
                        row.id
                    );
                }
            }
        } catch {}
        for (const k of Object.keys(this.state.users || {})) {
            if (!/^\d{5,12}$/.test(k)) {
                delete this.state.users[k];
                continue;
            }
            const u = this.state.users[k];
            if (u && typeof u === 'object') {
                if (Array.isArray(u.known_facts)) u.known_facts = u.known_facts.filter(m => !DIRTY_MEM_REGEX.test(String(m)));
                if (Array.isArray(u.important_memories)) u.important_memories = u.important_memories.filter(m => !DIRTY_MEM_REGEX.test(String(m)));
                if (Array.isArray(u.normal_memories)) u.normal_memories = u.normal_memories.filter(m => !DIRTY_MEM_REGEX.test(String(m)));
                if (u.pending_followup_hint && DIRTY_MEM_REGEX.test(String(u.pending_followup_hint.topic || ''))) {
                    delete u.pending_followup_hint;
                }
            }
        }
        // 1. 将 JSON 中已有的 users 写入 SQLite (INSERT OR IGNORE)
        const insertUser = this.db.prepare(`
            INSERT OR IGNORE INTO user_profiles (user_id, nickname, affection, relationship_tag, known_facts_json, last_interaction_time, last_interaction_ts, last_late_night_ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [uid, u] of Object.entries(this.state.users || {})) {
            if (!u || typeof u !== 'object' || !/^\d{5,12}$/.test(uid)) continue;
            const cleanNick = String(u.nickname || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
            const validNick = (cleanNick && cleanNick.length <= 20 && !/(提醒我|分钟后|小时后)/.test(cleanNick))
                ? cleanNick
                : `群友_${uid.slice(-4)}`;
            u.nickname = validNick;
            insertUser.run(
                String(uid),
                validNick,
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

        // 3. 从 SQLite 反向读取合并回内存缓存（若 JSON 中某用户时间戳更新，则先将 JSON 最新记忆回写至 SQLite，防止回滚丢失）
        const updateNewerJsonToDb = this.db.prepare(`
            UPDATE user_profiles
            SET nickname = ?, affection = ?, relationship_tag = ?, known_facts_json = ?,
                rolling_summary = ?, important_memories_json = ?, normal_memories_json = ?,
                last_interaction_time = ?, last_interaction_ts = ?
            WHERE user_id = ?
        `);
        const dbUsers = this.db.prepare('SELECT * FROM user_profiles').all();
        for (const row of dbUsers) {
            if (!/^\d{5,12}$/.test(String(row.user_id))) continue;
            const jsonUser = this.state.users[row.user_id];
            const jsonTs = Number(jsonUser?.last_interaction_ts || 0);
            const dbTs = Number(row.last_interaction_ts || 0);
            let facts = [];
            let importantMems = [];
            let normalMems = [];
            try { facts = JSON.parse(row.known_facts_json || '[]'); } catch {}
            try { importantMems = JSON.parse(row.important_memories_json || '[]'); } catch {}
            try { normalMems = JSON.parse(row.normal_memories_json || '[]'); } catch {}

            if (jsonUser && jsonTs > dbTs) {
                if (Array.isArray(jsonUser.known_facts) && jsonUser.known_facts.length > 0) facts = jsonUser.known_facts;
                if (Array.isArray(jsonUser.important_memories) && jsonUser.important_memories.length > 0) importantMems = jsonUser.important_memories;
                if (Array.isArray(jsonUser.normal_memories) && jsonUser.normal_memories.length > 0) normalMems = jsonUser.normal_memories;
            }
            const hadDirtyInDb = [...facts, ...importantMems, ...normalMems].some(m => DIRTY_MEM_REGEX.test(String(m)));
            facts = facts.filter(m => !DIRTY_MEM_REGEX.test(String(m)));
            importantMems = importantMems.filter(m => !DIRTY_MEM_REGEX.test(String(m)));
            normalMems = normalMems.filter(m => !DIRTY_MEM_REGEX.test(String(m)));
            if (importantMems.length === 0 && facts.length > 0) {
                importantMems = facts.slice(0, USER_IMPORTANT_CAP);
            }
            const rawNick = String((jsonTs > dbTs && jsonUser?.nickname) ? jsonUser.nickname : (row.nickname || '')).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
            const safeNick = (rawNick && rawNick.length <= 20 && !/(提醒我|分钟后|小时后)/.test(rawNick))
                ? rawNick
                : `群友_${String(row.user_id).slice(-4)}`;
            const mergedAffection = jsonTs > dbTs && Number.isFinite(Number(jsonUser?.affection)) ? Number(jsonUser.affection) : row.affection;
            const mergedRelTag = (jsonTs > dbTs && jsonUser?.relationship_tag) ? jsonUser.relationship_tag : row.relationship_tag;
            const mergedSummary = (jsonTs > dbTs && jsonUser?.rolling_summary) ? jsonUser.rolling_summary : (row.rolling_summary || jsonUser?.rolling_summary || '');
            const mergedTime = jsonTs > dbTs ? (jsonUser.last_interaction_time || row.last_interaction_time) : row.last_interaction_time;
            const mergedTs = Math.max(jsonTs, dbTs);

            if (jsonTs > dbTs || safeNick !== row.nickname || hadDirtyInDb) {
                try {
                    updateNewerJsonToDb.run(
                        safeNick,
                        mergedAffection,
                        mergedRelTag,
                        JSON.stringify(facts),
                        mergedSummary,
                        JSON.stringify(importantMems),
                        JSON.stringify(normalMems),
                        mergedTime,
                        mergedTs,
                        row.user_id,
                    );
                } catch {}
            }
            const rawPet = row.pet_nickname || jsonUser?.pet_nickname || '';
            const safePet = (rawPet && !this.isGenericCategoryNickname(rawPet))
                ? rawPet
                : (String(row.user_id) === this.masterQQ ? '老大' : this.derivePersonalNick(safeNick, row.user_id));
            this.state.users[row.user_id] = {
                ...(jsonUser || {}),
                user_id: row.user_id,
                nickname: safeNick,
                pet_nickname: safePet,
                affection: mergedAffection,
                relationship_tag: mergedRelTag,
                known_facts: facts,
                rolling_summary: mergedSummary,
                important_memories: importantMems,
                normal_memories: normalMems,
                last_interaction_time: mergedTime,
                last_interaction_ts: mergedTs,
                last_late_night_ts: Math.max(Number(jsonUser?.last_late_night_ts || 0), Number(row.last_late_night_ts || 0)),
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
        this.save();
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
                INSERT INTO user_profiles (user_id, nickname, pet_nickname, affection, relationship_tag, known_facts_json, rolling_summary, important_memories_json, normal_memories_json, last_interaction_time, last_interaction_ts, last_late_night_ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    nickname = excluded.nickname,
                    pet_nickname = excluded.pet_nickname,
                    affection = excluded.affection,
                    relationship_tag = excluded.relationship_tag,
                    known_facts_json = excluded.known_facts_json,
                    rolling_summary = excluded.rolling_summary,
                    important_memories_json = excluded.important_memories_json,
                    normal_memories_json = excluded.normal_memories_json,
                    last_interaction_time = excluded.last_interaction_time,
                    last_interaction_ts = excluded.last_interaction_ts,
                    last_late_night_ts = excluded.last_late_night_ts
            `);
            for (const [uid, u] of Object.entries(this.state.users || {})) {
                if (!u || typeof u !== 'object') continue;
                const impList = Array.isArray(u.important_memories) && u.important_memories.length > 0
                    ? u.important_memories
                    : (Array.isArray(u.known_facts) ? u.known_facts : []);
                const normList = Array.isArray(u.normal_memories) ? u.normal_memories : [];
                upsertUser.run(
                    String(uid),
                    String(u.nickname || uid),
                    String(u.pet_nickname || ''),
                    Number(u.affection ?? 55),
                    String(u.relationship_tag || '群友/饭票候选'),
                    JSON.stringify(impList),
                    String(u.rolling_summary || ''),
                    JSON.stringify(impList),
                    JSON.stringify(normList),
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

                // 按人独立统计未压缩流水：当该用户未压缩发言满 10 条或累计字数 >= 450 字时，自动触发该用户的记忆分级压缩
                if (role === 'user' && /^\d{5,12}$/.test(userId) && !this.compressingUsers.has(userId)) {
                    const uRow = this.db.prepare(`
                        SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(content)), 0) AS chars
                        FROM raw_interaction_logs
                        WHERE user_id = ? AND role = 'user' AND user_compressed = 0
                    `).get(userId);
                    if (uRow && (Number(uRow.cnt) >= USER_COMPRESS_LOG_THRESHOLD || Number(uRow.chars) >= USER_COMPRESS_CHAR_THRESHOLD)) {
                        void this.compressUserMemory(userId);
                    }
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

    /**
     * 当入站纯图片消息 (`[图片]`) 随后完成视觉识别 (`[图片: ... 视觉画面描述: ...]`) 时，
     * 同步刷新最近一条 Working Memory 与 SQLite 流水，避免记忆里只留下空壳 `[图片]`
     */
    updateLatestWorkingMemoryText(chatId, userId, newText) {
        const clean = String(newText || '').replace(/\r?\n/g, ' ').trim().slice(0, 300);
        if (!chatId || !clean) return;
        const list = this.working.get(chatId) || [];
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].role === 'user' && String(list[i].userId) === String(userId)) {
                list[i].text = clean;
                break;
            }
        }
        if (this.db) {
            try {
                const latestRow = this.db.prepare(`
                    SELECT id FROM raw_interaction_logs
                    WHERE chat_id = ? AND user_id = ? AND role = 'user'
                    ORDER BY id DESC LIMIT 1
                `).get(String(chatId), String(userId));
                if (latestRow?.id) {
                    this.db.prepare('UPDATE raw_interaction_logs SET content = ? WHERE id = ?').run(clean, latestRow.id);
                }
            } catch {}
        }
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

            // 若压缩过程中提炼出了高重要度的长期事件，按真实归属人存入长期情景记忆库与个人分级记忆库
            for (const ep of extractedEpisodic) {
                if (ep && ep.summary && Number(ep.importance) >= 5) {
                    let targetUid = ep.user_id && /^\d{5,12}$/.test(String(ep.user_id)) ? String(ep.user_id) : '';
                    if (!targetUid) {
                        const matchedLog = [...rawLogs].reverse().find(
                            r => r.role === 'user' && /^\d{5,12}$/.test(String(r.user_id)) && r.nickname && ep.summary.includes(r.nickname)
                        );
                        targetUid = matchedLog ? String(matchedLog.user_id) : this.masterQQ;
                    }
                    const imp = Number(ep.importance) || 6;
                    this.addUserMemory(targetUid, {
                        content: `[${dayKey}] ${ep.summary}`,
                        importance: imp,
                    });
                    if (imp >= 7) {
                        this.addEpisodicMemory({
                            userId: targetUid,
                            summary: `[${dayKey}] ${ep.summary}`,
                            importance: imp,
                        });
                    }
                }
            }

            // 若压缩过程中提炼出了群梗黑话或群友印象，顺带存入对应群的 group_lore 表（按发言人所在群精准归属，杜绝跨群串台）
            if (extractedGroupLore.length > 0) {
                const groupChats = [...new Set(rawLogs.map(r => r.chat_id).filter(c => String(c).startsWith('group:')))];
                for (const lore of extractedGroupLore) {
                    const matchedGroupLog = [...rawLogs].reverse().find(
                        r => String(r.chat_id).startsWith('group:') && r.nickname && lore.includes(r.nickname)
                    );
                    const targetGroup = matchedGroupLog?.chat_id || groupChats[0] || 'group:434137389';
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

        // 提取今天尚未压缩的最近 6 条交互流水作为实时暂时记忆（严格限定当前会话 chat_id，标注说话人 QQ 号防串台）
        const recentUncompressed = chatId
            ? this.db.prepare(`
                SELECT time_str, user_id, nickname, role, content FROM raw_interaction_logs
                WHERE day_key = ? AND chat_id = ?
                ORDER BY ts DESC LIMIT 6
            `).all(todayKey, String(chatId)).reverse()
            : this.db.prepare(`
                SELECT time_str, user_id, nickname, role, content FROM raw_interaction_logs
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
                    if (r.role === 'assistant') return `[${r.time_str} 大肥鱼(我)] ${r.content}`;
                    return `[${r.time_str} ${r.nickname}(QQ:${r.user_id})] ${r.content}`;
                });
                lines.push(`  - 本会话刚刚的实时流水:\n    ${rawLines.join('\n    ')}`);
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
        const userMemImportant = this.db.prepare("SELECT COUNT(*) AS c FROM user_memories WHERE tier = 'important'").get()?.c || 0;
        const userMemNormal = this.db.prepare("SELECT COUNT(*) AS c FROM user_memories WHERE tier = 'normal'").get()?.c || 0;
        return {
            sqliteEnabled: true,
            dbPath: this.dbPath,
            userCount,
            userMemTotal: userMemImportant + userMemNormal,
            userMemImportant,
            userMemNormal,
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
        // 拒绝将单纯讨要五花肉/白米饭的口水话写入群梗库，防止回音室死循环
        if (/(五花肉|白米饭|拌饭|加餐)/.test(clean)) return false;

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
        const uid = String(userId || '').replace(/^(private|group):/i, '').trim();
        if (!/^\d{5,12}$/.test(uid)) return null;
        const isMaster = uid === this.masterQQ;
        const cleanNick = String(fallbackNickname || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
        const isValidNick = Boolean(
            cleanNick &&
            cleanNick !== uid &&
            !cleanNick.startsWith('群友_') &&
            cleanNick.length <= 20 &&
            !/(提醒我|分钟后|小时后)/.test(cleanNick)
        );
        if (!this.state.users[uid]) {
            this.state.users[uid] = {
                user_id: uid,
                nickname: isMaster ? '老大' : (isValidNick ? cleanNick : `群友_${uid.slice(-4)}`),
                affection: isMaster ? 92 : 55,
                relationship_tag: isMaster ? '首席饲主/老大' : '群友/饭票候选',
                known_facts: isMaster ? ['大肥鱼的首席饲主（老大）'] : [],
                rolling_summary: '',
                important_memories: isMaster ? ['大肥鱼的首席饲主（老大）'] : [],
                normal_memories: [],
                last_interaction_time: new Date().toISOString(),
                last_interaction_ts: Date.now(),
                last_late_night_ts: 0,
            };
            this.save();
        } else if (isValidNick && !isMaster) {
            const prevNick = String(this.state.users[uid].nickname || '').trim();
            if (
                prevNick &&
                prevNick !== cleanNick &&
                prevNick !== uid &&
                !prevNick.startsWith('群友_') &&
                ((this.state.users[uid].important_memories?.length || 0) > 0 || (this.state.users[uid].normal_memories?.length || 0) > 0 || Boolean(this.state.users[uid].rolling_summary))
            ) {
                const nowMs = this.now();
                this.state.users[uid].pending_rename_hint = {
                    oldName: prevNick,
                    newName: cleanNick,
                    ts: nowMs,
                };
                const normList = Array.isArray(this.state.users[uid].normal_memories) ? this.state.users[uid].normal_memories : [];
                const renameFact = `曾用昵称「${prevNick}」，后改名为「${cleanNick}」`;
                if (!normList.includes(renameFact)) {
                    normList.unshift(renameFact);
                    this.state.users[uid].normal_memories = normList.slice(0, 8);
                }
            }
            this.state.users[uid].nickname = cleanNick;
        }
        if (!Array.isArray(this.state.users[uid].important_memories)) {
            this.state.users[uid].important_memories = Array.isArray(this.state.users[uid].known_facts)
                ? [...this.state.users[uid].known_facts]
                : [];
        }
        if (!Array.isArray(this.state.users[uid].normal_memories)) {
            this.state.users[uid].normal_memories = [];
        }
        return this.state.users[uid];
    }

    touchUserInteraction(userId, nickname = '') {
        const uid = String(userId || '').replace(/^(private|group):/i, '').trim();
        const existingPrevTs = Number(this.state.users?.[uid]?.last_interaction_ts || 0);
        const profile = this.getUserProfile(userId, nickname);
        if (!profile) return null;
        const now = this.now();
        // 跨天/长间隔“记挂追问”检测：若距上次冒泡超过 6 小时，且有值得记挂的近期事件，生成本轮一次性问候提示
        if (existingPrevTs > 0 && (now - existingPrevTs) >= 6 * 3600_000) {
            const gapHours = Math.round(((now - existingPrevTs) / 3600_000) * 10) / 10;
            const candidates = [
                ...(profile.normal_memories || []),
                ...(profile.important_memories || []),
            ].filter(m => m && !/^(大肥鱼的首席饲主|拥有电脑最高控制权限|投喂过本鱼吃|曾用昵称)|(?:开黄腔|口出低俗狂言|痛骂|下头|生小鱼|生小鲸鱼|欺负|记入小本本|记仇|死鱼|笨鱼|骚鱼)/i.test(String(m)));
            const followupTopic = candidates.find(m => /(问题|找不到|报错|bug|熬夜|生病|感冒|头疼|考试|面试|上班|加班|折腾|设置|账户|密码|渲染|建模|游戏|深渊|抽卡)/i.test(m))
                || candidates[0]
                || '';
            if (followupTopic) {
                profile.pending_followup_hint = {
                    gapHours,
                    topic: String(followupTopic).slice(0, 70),
                    ts: now,
                };
            }
        }
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

    clearPendingUserTurnHints(userId) {
        const uid = String(userId || '').replace(/^(private|group):/i, '').trim();
        const u = this.state.users?.[uid];
        if (!u) return;
        if (u.pending_rename_hint || u.pending_followup_hint) {
            delete u.pending_rename_hint;
            delete u.pending_followup_hint;
        }
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
        this.addUserMemory(userId, { content: fact, importance: 8, tier: 'important' });
    }

    /**
     * 按人分别存放分级记忆（分为 `important` 重要记忆 [importance 7..10] 与 `normal` 一般记忆 [importance 1..6]）
     * @param {string} userId
     * @param {{ content: string, importance?: number, tier?: 'important' | 'normal', chatId?: string, nickname?: string }} entry
     */
    addUserMemory(userId, entry = {}) {
        const uid = String(userId || '').replace(/^(private|group):/i, '').trim();
        if (!/^\d{5,12}$/.test(uid)) return null;
        const clean = String(entry.content || entry.summary || '').replace(/\r?\n/g, ' ').trim().slice(0, 120);
        if (!clean) return null;

        const profile = this.getUserProfile(uid, entry.nickname || '');
        if (!profile) return null;

        const importance = Math.max(1, Math.min(10, Math.round(Number(entry.importance) || (entry.tier === 'important' ? 8 : 5))));
        const tier = entry.tier || (importance >= 7 ? 'important' : 'normal');
        const now = this.now();

        if (tier === 'important') {
            const list = Array.isArray(profile.important_memories) ? profile.important_memories : [];
            const filtered = list.filter(item => item !== clean && computeKeywordMatch(item, clean) < 0.72);
            filtered.unshift(clean);
            profile.important_memories = filtered.slice(0, USER_IMPORTANT_CAP);
            profile.known_facts = [...profile.important_memories];
        } else {
            // 若该信息已经在重要记忆中存在，则不重复塞入一般记忆
            const impList = Array.isArray(profile.important_memories) ? profile.important_memories : [];
            if (impList.some(item => item === clean || computeKeywordMatch(item, clean) >= 0.72)) {
                return profile;
            }
            const list = Array.isArray(profile.normal_memories) ? profile.normal_memories : [];
            const filtered = list.filter(item => item !== clean && computeKeywordMatch(item, clean) < 0.72);
            filtered.unshift(clean);
            profile.normal_memories = filtered;
        }

        if (this.db) {
            try {
                const memId = `um_${uid}_${now}_${Math.random().toString(36).slice(2, 6)}`;
                this.db.prepare(`
                    INSERT INTO user_memories (id, user_id, tier, importance, content, chat_id, created_at_ms, updated_at_ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(memId, uid, tier, importance, clean, String(entry.chatId || ''), now, now);
            } catch {}
        }

        this.save();

        // 若该用户的「一般记忆」条数超过上限 (8 条) 或总字数过大，自动触发该用户的记忆压缩
        const normChars = (profile.normal_memories || []).join('').length;
        if (((profile.normal_memories || []).length > USER_NORMAL_CAP || normChars > 360) && !this.compressingUsers.has(uid)) {
            void this.compressUserMemory(uid);
        }
        return profile;
    }

    /**
     * 按人独立压缩记忆 (`compressUserMemory`)：
     * 将某用户的未压缩聊天流水与过多的「一般记忆」合并浓缩为 `rolling_summary` (<=120字)，
     * 并筛选划分出「重要记忆 (`important`, 永久保留)」与精简的「一般记忆 (`normal`, 近期日常)」。
     */
    async compressUserMemory(userId, opts = {}) {
        const uid = String(userId || '').replace(/^(private|group):/i, '').trim();
        if (!/^\d{5,12}$/.test(uid) || !this.db || this.compressingUsers.has(uid)) return null;
        this.compressingUsers.add(uid);

        try {
            const rawLogs = opts.forceAll
                ? this.db.prepare("SELECT * FROM raw_interaction_logs WHERE user_id = ? AND role = 'user' ORDER BY ts DESC LIMIT 30").all(uid).reverse()
                : this.db.prepare("SELECT * FROM raw_interaction_logs WHERE user_id = ? AND role = 'user' AND user_compressed = 0 ORDER BY ts ASC LIMIT 30").all(uid);

            const profile = this.getUserProfile(uid, rawLogs[rawLogs.length - 1]?.nickname || '');
            if (!profile) return null;
            if (rawLogs.length === 0 && (profile.normal_memories || []).length <= USER_NORMAL_CAP && profile.rolling_summary) {
                return profile;
            }

            let compressedRes = null;
            if (typeof this.llmUserCompressor === 'function') {
                try {
                    compressedRes = await this.llmUserCompressor(uid, profile, rawLogs);
                } catch (err) {
                    console.warn(`[MemoryManager] 用户(${uid}) LLM 记忆压缩降级至本地规则:`, err.message);
                }
            }

            const impArr = compressedRes?.important_memories || compressedRes?.important;
            const normArr = compressedRes?.normal_memories || compressedRes?.normal;
            if (!compressedRes || (!compressedRes.rolling_summary && !Array.isArray(impArr) && !Array.isArray(normArr))) {
                compressedRes = this._buildRuleBasedUserCompression(uid, profile, rawLogs);
            }

            const finalImpArr = compressedRes.important_memories || compressedRes.important;
            const finalNormArr = compressedRes.normal_memories || compressedRes.normal;

            if (typeof compressedRes.rolling_summary === 'string' && compressedRes.rolling_summary.trim()) {
                profile.rolling_summary = compressedRes.rolling_summary.trim().slice(0, 120);
            }
            if (Array.isArray(finalImpArr) && finalImpArr.length > 0) {
                const mergedImp = [...finalImpArr.map(s => String(s).trim()).filter(Boolean), ...(profile.important_memories || [])];
                const dedupImp = [];
                for (const item of mergedImp) {
                    if (!dedupImp.some(x => x === item || computeKeywordMatch(x, item) >= 0.72)) {
                        dedupImp.push(item.slice(0, 80));
                    }
                }
                profile.important_memories = dedupImp.slice(0, USER_IMPORTANT_CAP);
                profile.known_facts = [...profile.important_memories];
            }
            if (Array.isArray(finalNormArr)) {
                const dedupNorm = [];
                for (const rawItem of finalNormArr) {
                    const item = String(rawItem || '').trim().slice(0, 70);
                    if (!item) continue;
                    if ((profile.important_memories || []).some(x => x === item || computeKeywordMatch(x, item) >= 0.72)) continue;
                    if (!dedupNorm.some(x => x === item || computeKeywordMatch(x, item) >= 0.72)) {
                        dedupNorm.push(item);
                    }
                }
                profile.normal_memories = dedupNorm.slice(0, 6);
            }
            if (compressedRes.pet_nickname && uid !== this.masterQQ) {
                this.setPetNickname(uid, compressedRes.pet_nickname, profile.nickname);
            } else if (!profile.pet_nickname && uid !== this.masterQQ) {
                this.setPetNickname(uid, this.derivePersonalNick(profile.nickname, uid), profile.nickname);
            }

            if (this.db) {
                try {
                    const now = this.now();
                    this.db.prepare('DELETE FROM user_memories WHERE user_id = ?').run(uid);
                    const insMem = this.db.prepare(`
                        INSERT INTO user_memories (id, user_id, tier, importance, content, chat_id, created_at_ms, updated_at_ms)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    for (const [idx, item] of (profile.important_memories || []).entries()) {
                        insMem.run(`um_${uid}_imp_${idx}_${now}`, uid, 'important', 8, item, '', now - idx, now);
                    }
                    for (const [idx, item] of (profile.normal_memories || []).entries()) {
                        insMem.run(`um_${uid}_norm_${idx}_${now}`, uid, 'normal', 5, item, '', now - idx, now);
                    }
                } catch {}
            }

            if (rawLogs.length > 0) {
                const maxId = rawLogs[rawLogs.length - 1]?.id;
                if (maxId !== undefined) {
                    this.db.prepare('UPDATE raw_interaction_logs SET user_compressed = 1 WHERE user_id = ? AND id <= ?').run(uid, maxId);
                }
            }

            this.save();
            return profile;
        } finally {
            this.compressingUsers.delete(uid);
        }
    }

    _buildRuleBasedUserCompression(uid, profile, rawLogs = []) {
        const important = [...(profile.important_memories || [])];
        const normal = [];
        const snippets = [];

        for (const r of rawLogs) {
            const txt = String(r.content || '').replace(/\r?\n/g, ' ').trim();
            if (!txt || txt.startsWith('/')) continue;
            snippets.push(txt.slice(0, 26));
            if (/(投喂|请你吃|给你吃|五花肉|白米饭|红烧肉|奶茶|喜欢|讨厌|最爱|我是|我在|工作|上班|上学|生日|约定|提醒我)/i.test(txt)) {
                important.unshift(`曾对本鱼说：“${txt.slice(0, 38)}”`);
            } else if (txt.length >= 2) {
                normal.unshift(`[${r.day_key || '近期'}] 聊了：“${txt.slice(0, 32)}”`);
            }
        }
        for (const oldNorm of (profile.normal_memories || [])) {
            normal.push(oldNorm);
        }

        const uniqueTopics = [...new Set(snippets)].slice(-4);
        const rolling_summary = uniqueTopics.length > 0
            ? `近期共互动 ${rawLogs.length} 次，主要聊过：${uniqueTopics.join('；')}`.slice(0, 120)
            : (profile.rolling_summary || `群内熟面孔（好感度 ${profile.affection}/100）`);

        return {
            rolling_summary,
            important: important.slice(0, USER_IMPORTANT_CAP),
            normal: normal.slice(0, 6),
        };
    }

    /**
     * 批量扫描并压缩所有存在历史流水但尚未生成个人分级记忆的群友档案
     */
    async compressAllUsersIfNeeded(opts = {}) {
        if (!this.db) return [];
        const rows = this.db.prepare(`
            SELECT user_id, COUNT(*) AS cnt
            FROM raw_interaction_logs
            WHERE role = 'user' AND user_id GLOB '[0-9]*'
            GROUP BY user_id
            HAVING cnt >= 1
            ORDER BY cnt DESC
        `).all();
        const updated = [];
        for (const r of rows) {
            const uid = String(r.user_id);
            const prof = this.getUserProfile(uid);
            const hasTiered = Boolean(prof?.rolling_summary || (prof?.important_memories?.length > 0) || (prof?.normal_memories?.length > 0));
            if (opts.forceAll || !hasTiered || r.cnt >= USER_COMPRESS_LOG_THRESHOLD) {
                const res = await this.compressUserMemory(uid, { forceAll: true });
                if (res) updated.push(uid);
            }
        }
        return updated;
    }

    /**
     * 按 QQ 号或昵称模糊查找用户档案（供 `/fish mem <QQ或昵称>` 检索）
     */
    findUserByQuery(query) {
        const q = String(query || '').trim();
        if (!q) return null;
        if (/^\d{5,12}$/.test(q)) {
            return this.getUserProfile(q);
        }
        const allUsers = Object.values(this.state.users || {});
        return allUsers.find(
            u => u && (
                String(u.nickname || '').toLowerCase().includes(q.toLowerCase()) ||
                String(u.public_nickname || '').toLowerCase().includes(q.toLowerCase()) ||
                String(u.pet_nickname || '').toLowerCase().includes(q.toLowerCase())
            )
        ) || null;
    }

    /**
     * 获取当前全库已被其他群友占用的专属外号列表（防止不同群友撞名）
     */
    getTakenPetNicknames(excludeUserId = '') {
        const ex = String(excludeUserId || '');
        const taken = new Set();
        for (const [uid, u] of Object.entries(this.state.users || {})) {
            if (uid === ex || !u?.pet_nickname) continue;
            taken.add(String(u.pet_nickname).trim());
        }
        return [...taken];
    }

    /**
     * 判断某个外号是否属于同质化的大类标签或生硬缝合的怪异动宾词组（禁止将此类词当作个人称呼）
     */
    isGenericCategoryNickname(nick) {
        const s = String(nick || '').trim();
        if (!s) return true;
        return /^(记仇榜常客|烤鱼狂魔|炖鱼大厨|下头怪|五花肉菩萨|熬夜冠军|熟人群友|普通路人|铁杆饭票|饭票候选|群友|臭肥鱼|肥鱼|大肥鱼|本鱼|损友|小损友|投喂员)$/i.test(s)
            || /(记仇榜|常客|饭票候选|熟人群友|普通路人|臭肥鱼|撸尾|嫌鱼|烤鱼|胖鲸|亏损户|圆券|回戳鱼|鱼片)/.test(s);
    }

    /**
     * 从群友本人的 QQ 昵称提取自然、顺口的人类简称/昵称（绝不暴力截断成半截残词）
     */
    derivePersonalNick(nickname, userId = '') {
        const uid = String(userId || '');
        if (uid === this.masterQQ) return '老大';
        const raw0 = String(nickname || '')
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}❤✨⭐🌙🔥💧🐟🐾🥕🍑]/gu, '')
            .replace(/^群友_/, '')
            .trim();
        if (!raw0 || /^\d+$/.test(raw0)) return `鱼友${uid.slice(-2) || '号'}`;
        if (/^\([●•·_\-—]+\)$/.test(raw0)) return '大白';

        const raw = raw0.replace(/^[-_~～—·•\s]+|[-_~～—·•\s]+$/g, '').trim();
        if (!raw) return raw0.slice(0, 4);

        // 纯英文昵称（如 Haruhi, Marshmello, CeciliaMak, Doy）：保留完整单词或首段驼峰，绝不截成 3 个字母
        if (/^[A-Za-z0-9_.\s]+$/.test(raw)) {
            const camel = raw.match(/^[A-Z][a-z]{2,9}/);
            if (camel && raw.length > 8) return camel[0];
            return raw.slice(0, 10);
        }

        // 常见前后缀剥离（如“团子客服娘” -> “团子”，“被冷空气袭击” -> “冷空气”，“亏损香辣豆干” -> “香辣豆干”）
        if (/^被(.+?)(?:袭击|打败|封印|包围)$/.test(raw)) {
            return raw.replace(/^被(.+?)(?:袭击|打败|封印|包围)$/, '$1');
        }
        if (/^(.{2,4})(?:客服娘|客服|酱|君|大人|先生|女士)$/.test(raw)) {
            return raw.replace(/^(.{2,4})(?:客服娘|客服|酱|君|大人|先生|女士)$/, '$1');
        }
        if (/^(?:亏损|盈利|野生|迷路|暴躁|安静)(.{2,4})$/.test(raw)) {
            return raw.replace(/^(?:亏损|盈利|野生|迷路|暴躁|安静)(.{2,4})$/, '$1');
        }
        if (raw.includes(' ')) {
            const firstPart = raw.split(/\s+/)[0];
            if (firstPart.length >= 2 && firstPart.length <= 4) return firstPart;
        }
        if (raw.includes('的')) {
            const parts = raw.split('的').map(s => s.trim()).filter(Boolean);
            const tail = parts[parts.length - 1];
            if (tail && tail.length >= 2 && tail.length <= 4 && !/^(致意|你)$/.test(tail)) {
                return tail;
            }
            if (parts[0] && parts[0].length >= 2 && parts[0].length <= 4) {
                return parts[0];
            }
        }
        if (/^是(.+?)[诶呀呢啊啦]?$/.test(raw)) {
            return raw.replace(/^是(.+?)[诶呀呢啊啦]?$/, '$1').slice(0, 4);
        }
        if (/^(.+)了个\1$/.test(raw)) {
            return `阿${raw[0]}`;
        }
        if (raw.length <= 4) return raw;
        return raw.slice(0, 4);
    }

    setPetNickname(userId, petNickname, fallbackNickname = '') {
        const uid = String(userId || '').replace(/^(private|group):/i, '').trim();
        const profile = this.getUserProfile(uid, fallbackNickname);
        if (!profile) return null;
        if (uid === this.masterQQ) {
            profile.pet_nickname = '老大';
            this.save();
            return '老大';
        }
        let clean = String(petNickname || '').replace(/[\r\n"“”'‘’「」【】]/g, '').trim().slice(0, 12);
        const taken = new Set(this.getTakenPetNicknames(uid));

        // 若传入的是通用大类词或已被其他群友占用，则自动回退为绑定本人昵称的唯一简称
        if (!clean || this.isGenericCategoryNickname(clean) || taken.has(clean)) {
            const baseShort = this.derivePersonalNick(profile.nickname || fallbackNickname, uid);
            clean = !taken.has(baseShort) ? baseShort : `${baseShort}(${uid.slice(-2)})`;
        }
        profile.pet_nickname = clean;
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
                        this.setPetNickname(uid, res.pet_nickname, profile.nickname);
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
        const isMaster = String(profile.user_id) === String(this.masterQQ);
        const impMems = Array.isArray(profile.important_memories) && profile.important_memories.length > 0
            ? profile.important_memories
            : (Array.isArray(profile.known_facts) ? profile.known_facts : []);
        const normMems = Array.isArray(profile.normal_memories) ? profile.normal_memories : [];
        const impLines = impMems.length > 0
            ? impMems.slice(0, 8).map((f, i) => `  ${i + 1}. ${f}`).join('\n')
            : '  （暂未收录重要长期事实，待聊天中发掘）';
        const normLines = normMems.length > 0
            ? normMems.slice(0, 5).map((f, i) => `  ${i + 1}. ${f}`).join('\n')
            : '';

        const shortNick = this.derivePersonalNick(profile.nickname, profile.user_id);
        const validPetNick = (profile.pet_nickname && !this.isGenericCategoryNickname(profile.pet_nickname))
            ? profile.pet_nickname
            : shortNick;
        const attitudeGuide = isMaster
            ? '最偏爱、最信任的首席饲主（老大），嘴硬心软、爱撒娇讨夸奖'
            : (profile.affection >= 75
                ? '铁杆熟人，态度亲近熟稔、可以傲娇护短或开玩笑'
                : (profile.affection >= 50
                    ? '日常熟面孔群友，态度随性自然、机灵接梗互怼'
                    : '老爱逗鱼/惹本鱼炸毛的损友，态度傲娇嫌弃、随时准备拿尾巴抽ta'));
        const summaryLine = profile.rolling_summary
            ? `- 近期浓缩印象 (rolling_summary): ${profile.rolling_summary}`
            : '';
        const nowMs = this.now();
        const renameHint = profile.pending_rename_hint && (nowMs - (profile.pending_rename_hint.ts || 0)) < 30_000
            ? `🕵️‍♀️【熟人改名换马甲察觉彩蛋】：你敏锐发现这位熟人刚刚把昵称从「${profile.pending_rename_hint.oldName}」改成了「${profile.pending_rename_hint.newName}」！请在回应正事的同时，顺嘴傲娇调侃半句ta换名字/换马甲的事（如“哟，${profile.pending_rename_hint.oldName}你咋突然改名叫${profile.pending_rename_hint.newName}啦，以为换个马甲本鱼就不认识你了吗”），本轮调侃一次即可！`
            : '';
        const followupHint = profile.pending_followup_hint && (nowMs - (profile.pending_followup_hint.ts || 0)) < 30_000
            ? `🌙【跨天/久别记挂追问提示】：这是对方时隔 ${profile.pending_followup_hint.gapHours} 小时后第一次冒泡！你脑海里记挂着上次跟ta有关的事：「${profile.pending_followup_hint.topic}」。如果当前对方只是日常打招呼或闲聊，你可以顺嘴傲娇关心/追问半句那件事后续怎么样了；如果对方正在问十万火急的新正事，则优先回答新正事！`
            : '';
        return [
            `【当前对话目标 QQ 用户专属档案 (Per-User Isolated Memory)】`,
            `- 用户 QQ: ${profile.user_id}`,
            `- 原始昵称: ${profile.nickname}`,
            `- 🗣️【专属称呼指南 (千人千面，拒绝强行打卡)】：${isMaster ? '称呼ta为「老大」（但不用每句话都喊）' : `平时水群接话请直接顺着话茬自然回话（不必句句带称呼，更严禁在句子中间生硬插入四字外号造成病句！）；只有需要专门喊ta时，才自然喊一声「${validPetNick}」（或原名简称「${shortNick}」）。`}`,
            `- 🎭【说话态度定位 (仅决定语气，严禁当称呼喊出口)】：${profile.relationship_tag}（好感度 ${profile.affection}/100 —— ${attitudeGuide}）`,
            ...(summaryLine ? [summaryLine] : []),
            `- 🔴 重要记忆 (Important, 永久核心事实):\n${impLines}`,
            ...(normLines ? [`- 🔵 一般记忆 (Normal, 近期日常互动):\n${normLines}`] : []),
            ...(renameHint ? [renameHint] : []),
            ...(followupHint ? [followupHint] : []),
        ].join('\n');
    }

    /**
     * 群聊跨人档案检索：当群友 A 在聊天中提及/八卦群友 B（或 B 刚在前 3 句内跟 A 搭话）时，
     * 自动附上被提及群友 B 的浓缩印象与重要记忆，解决“群里聊到别人时肥鱼一问三不知”的问题。
     */
    formatMentionedGroupUsersForPrompt(chatId, currentUserId, queryText = '') {
        if (!chatId || !String(chatId).startsWith('group:')) return '';
        const curUid = String(currentUserId || '').trim();
        const recent = this.getWorkingMemory(chatId, 5);
        const searchCorpus = [
            String(queryText || ''),
            ...recent.slice(-3).map(m => `${m.nickname || ''} ${m.text || ''}`),
        ].join(' ');
        if (!searchCorpus.trim()) return '';

        const matchedUsers = [];
        const seenUids = new Set([curUid, 'self', 'unknown']);

        // 1. 先检查当前消息文本是否直接点名了某个群友的昵称/简称/专属外号/QQ号
        for (const [uid, u] of Object.entries(this.state.users || {})) {
            if (seenUids.has(uid) || !u) continue;
            const rawNick = String(u.nickname || '').trim();
            const shortNick = this.derivePersonalNick(rawNick, uid);
            const petNick = String(u.pet_nickname || '').trim();
            const candidates = [rawNick, shortNick, petNick, uid].filter(s => s && s.length >= 2 && !s.startsWith('群友_') && !s.startsWith('小鱼干'));
            if (candidates.some(token => queryText.includes(token))) {
                matchedUsers.push(u);
                seenUids.add(uid);
                if (matchedUsers.length >= 2) break;
            }
        }

        // 2. 若未满 2 人，再补充本群最近 3 条消息内刚发过言的其他在场群友（仅限有记忆沉淀的群友）
        if (matchedUsers.length < 2) {
            for (let i = recent.length - 1; i >= 0; i--) {
                const m = recent[i];
                const uid = String(m?.userId || '');
                if (!uid || seenUids.has(uid)) continue;
                const u = this.state.users?.[uid];
                if (u && (u.rolling_summary || (u.important_memories?.length > 0))) {
                    matchedUsers.push(u);
                    seenUids.add(uid);
                    if (matchedUsers.length >= 2) break;
                }
            }
        }

        if (matchedUsers.length === 0) return '';
        const blocks = matchedUsers.map(u => {
            const shortNick = this.derivePersonalNick(u.nickname, u.user_id);
            const imp = (u.important_memories || u.known_facts || []).slice(0, 3).join('；') || '暂无特别记录';
            return `  • [${u.nickname} (QQ:${u.user_id} | 简称/外号:「${u.pet_nickname || shortNick}」 | 好感:${u.affection}/100)] 印象: ${u.rolling_summary || '群内熟人'} | 核心记忆: ${imp}`;
        });
        return `【👥 本轮顺带提及/在场的其他群友档案（供八卦/对比/接梗参考，注意区分谁是当前说话人）】\n${blocks.join('\n')}`;
    }

    /**
     * 获取指定群聊最近活跃的 2~3 位熟人群友摘要（供群冷场主动暖场 `triggerGroupIdleBubble` 使用，严格按群隔离）
     */
    getRecentGroupActiveUsersSummary(chatId, limit = 3) {
        if (!this.db || !chatId || !String(chatId).startsWith('group:')) return '';
        try {
            const rows = this.db.prepare(`
                SELECT user_id, MAX(nickname) AS nick, MAX(ts) AS last_ts
                FROM raw_interaction_logs
                WHERE chat_id = ? AND role = 'user' AND user_id GLOB '[0-9]*'
                GROUP BY user_id
                ORDER BY last_ts DESC
                LIMIT ?
            `).all(String(chatId), limit);
            if (!rows || rows.length === 0) return '';
            const items = rows.map(r => {
                const u = this.getUserProfile(r.user_id, r.nick);
                const callName = u?.pet_nickname || this.derivePersonalNick(u?.nickname || r.nick, r.user_id);
                const recentNorm = (u?.normal_memories || [])[0] || u?.rolling_summary?.slice(0, 35) || '常在群里摸鱼';
                return `「${callName}」(原名:${u?.nickname || r.nick}，${recentNorm})`;
            });
            return `本群近期常驻熟面孔：${items.join('、')}`;
        } catch {
            return '';
        }
    }
}
