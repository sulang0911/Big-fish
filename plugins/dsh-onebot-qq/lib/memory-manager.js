/**
 * Step 3: 支持 QQ 多用户的三层记忆系统 (MemoryManager)
 * - Working Memory (会话工作记忆): 按 private:<user_id> / group:<group_id> 隔离，保留最近 20 条消息
 * - Semantic Memory (QQ 用户专属档案): 按 user_id 独立存储 nickname, affection(0-100), relationship_tag, known_facts, last_interaction_time
 * - Episodic Memory (长期情景记忆库): importance >= 6 落盘，支持指数衰减检索 Top-3 与后台异步反思合并 (Reflection)
 * @module dsh-onebot/memory-manager
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_MASTER_QQ = '2536218596';
const MEMORY_STORE_PATH = join(homedir(), '.dsh', 'storages', 'dsh-persona-dafeiyu', 'feiyu_memory.json');
const WORKING_MEMORY_CAP = 20;
const EPISODIC_MAX_PER_USER = 80;

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
        this.masterQQ = String(options.masterQQ || DEFAULT_MASTER_QQ);
        this.now = options.now || (() => Date.now());
        this.llmReflector = options.llmReflector || null;
        this.working = new Map(); // chatId -> Array<{ userId, nickname, time, text, ts, messageId }>
        this.state = this._load();
        if (!this.state.meta) this.state.meta = {};
        if (!this.state.driveState) this.state.driveState = null;
        this.data = this.state;
        this._ensureMasterProfile();
    }

    _load() {
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
            console.warn('[MemoryManager] 保存记忆库失败:', err.message);
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

    // ── 1. Working Memory (会话工作记忆，保留最近 15~20 条) ──────────────────
    addWorkingMemory(chatId, entry) {
        if (!chatId || !entry) return;
        const list = this.working.get(chatId) || [];
        const now = entry.ts || Date.now();
        const timeStr = entry.time || new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        list.push({
            userId: String(entry.userId || ''),
            nickname: String(entry.nickname || entry.userId || '未知'),
            time: timeStr,
            text: String(entry.text || '').replace(/\r?\n/g, ' ').trim().slice(0, 200),
            ts: now,
            messageId: entry.messageId ? String(entry.messageId) : undefined,
        });
        while (list.length > WORKING_MEMORY_CAP) {
            list.shift();
        }
        this.working.set(chatId, list);
    }

    getWorkingMemory(chatId, limit = 15) {
        const list = this.working.get(chatId) || [];
        return list.slice(-limit);
    }

    // ── 2. Semantic Memory (QQ 用户专属档案) ─────────────────────────────────
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
        // 记录深夜熬夜活动 (00:00 ~ 04:30 或 23:30 之后)
        if (hour < 5 || (hour === 23 && min >= 30)) {
            profile.last_late_night_ts = now;
        }
        this.save();
        return profile;
    }

    updateAffection(userId, delta = 0) {
        const profile = this.getUserProfile(userId);
        if (!profile) return 50;
        const d = Math.max(-5, Math.min(5, Math.round(Number(delta) || 0)));
        profile.affection = Math.max(0, Math.min(100, (profile.affection ?? 50) + d));
        if (String(userId) === this.masterQQ) {
            profile.relationship_tag = '首席饲主/老大';
            profile.affection = Math.max(60, profile.affection); // 老大保底亲密度
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

    // ── 3. Episodic Memory (长期情景记忆与指数衰减检索) ────────────────────────
    saveEpisodicMemory(userId, memoryObj) {
        if (!memoryObj || !memoryObj.should_save) return false;
        const importance = Math.round(Number(memoryObj.importance) || 0);
        const summary = String(memoryObj.summary || '').trim();
        if (importance < 6 || !summary) return false;

        const uid = String(userId || this.masterQQ);
        const now = Date.now();
        // 去重：如果最近已有高度相似的 summary 则更新时间戳与重要度
        const existing = this.state.episodic.find(
            m => m.user_id === uid && (m.summary === summary || computeKeywordMatch(m.summary, summary) > 0.8)
        );
        if (existing) {
            existing.importance = Math.max(existing.importance, Math.min(10, importance));
            existing.last_accessed_at = now;
            existing.summary = summary;
            this.save();
            return true;
        }

        this.state.episodic.unshift({
            id: `ep_${now}_${Math.random().toString(36).slice(2, 6)}`,
            user_id: uid,
            summary: summary.slice(0, 150),
            importance: Math.min(10, Math.max(6, importance)),
            created_at: now,
            last_accessed_at: now,
        });
        this.pruneMemories(uid);
        this.save();
        return true;
    }

    /**
     * 指数衰减检索算法：
     * Score = 0.4 * e^(-0.05 * Δt) + 0.4 * (Importance / 10) + 0.2 * KeywordMatch
     * 其中 Δt 为距离上次访问的小时数；命中的 Top-K 记忆自动刷新 last_accessed_at
     * 兼容 (queryText, topK, userId) 与 (userId, queryText, topK) 两种调用签名
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
        if (candidates.length === 0) return [];

        const scored = candidates.map(mem => {
            const rawLast = mem.last_accessed_at_ms ?? (typeof mem.last_accessed_at === 'number' ? mem.last_accessed_at : Date.parse(mem.last_accessed_at || mem.created_at || ''));
            const lastTime = Number.isFinite(rawLast) ? rawLast : now;
            const deltaHours = Math.max(0, (now - lastTime) / 3_600_000);
            const recencyScore = Math.exp(-0.05 * deltaHours);
            const importanceScore = Math.min(10, Math.max(1, mem.importance || 6)) / 10;
            const kwScore = computeKeywordMatch(queryText, mem.summary);
            const score = 0.4 * recencyScore + 0.4 * importanceScore + 0.2 * kwScore;
            return { mem, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, topK);
        if (touchOnHit && top.length > 0) {
            const isoNow = new Date(now).toISOString();
            for (const item of top) {
                item.mem.last_accessed_at = isoNow;
                item.mem.last_accessed_at_ms = now;
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

    /**
     * 记忆容量淘汰：清理低重要度且超过 14 天未访问的陈旧记忆，或超出单用户上限的尾部记忆
     */
    pruneMemories(userId) {
        const now = Date.now();
        const fourteenDaysMs = 14 * 24 * 3_600_000;
        this.state.episodic = this.state.episodic.filter(m => {
            const ageMs = now - (m.last_accessed_at || m.created_at || now);
            if ((m.importance || 6) <= 6 && ageMs > fourteenDaysMs) return false;
            return true;
        });

        if (userId) {
            const uid = String(userId);
            const userMems = this.state.episodic.filter(m => m.user_id === uid);
            if (userMems.length > EPISODIC_MAX_PER_USER) {
                const keepIds = new Set(
                    userMems
                        .sort((a, b) => (b.importance - a.importance) || (b.last_accessed_at - a.last_accessed_at))
                        .slice(0, EPISODIC_MAX_PER_USER)
                        .map(m => m.id)
                );
                this.state.episodic = this.state.episodic.filter(m => m.user_id !== uid || keepIds.has(m.id));
            }
        }
    }

    /**
     * 后台异步反思 (Reflection)：将碎片情景记忆归纳合并进用户的 known_facts 画像中
     */
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

    /**
     * 当某用户情景记忆累积达到阈值且距上次反思 >= 6 小时，后台异步触发画像提炼
     */
    async maybeTriggerReflection(userId) {
        const uid = String(userId || this.masterQQ);
        const now = this.now();
        if (now - (this.state.lastReflectionAt || 0) < 6 * 3600_000) return false;
        const userMems = this.state.episodic.filter(m => !m.user_id || m.user_id === uid);
        if (userMems.length < 5 || userMems.length % 5 !== 0) return false;
        if (typeof this.llmReflector === 'function') {
            try {
                const profile = this.getUserProfile(uid);
                const mergedFacts = await this.llmReflector(uid, profile, [
                    ...(profile?.known_facts || []),
                    ...userMems.slice(0, 10).map(m => m.summary),
                ]);
                if (Array.isArray(mergedFacts) && mergedFacts.length > 0 && profile) {
                    profile.known_facts = mergedFacts.map(f => String(f).trim()).filter(Boolean).slice(0, 10);
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

    applyAffectionDelta(userId, delta = 0) {
        return this.updateAffection(userId, delta);
    }

    addEpisodicMemory(entry = {}) {
        if (!entry || typeof entry !== 'object') return null;
        const importance = Math.round(Number(entry.importance) || 0);
        const summary = String(entry.summary || '').trim();
        if (importance < 6 || !summary) return null;
        const uid = String(entry.userId || entry.user_id || this.masterQQ);
        const now = this.now();
        const item = {
            id: `ep_${now}_${Math.random().toString(36).slice(2, 6)}`,
            user_id: uid,
            summary: summary.slice(0, 150),
            importance: Math.min(10, Math.max(6, importance)),
            created_at: new Date(now).toISOString(),
            created_at_ms: now,
            last_accessed_at: new Date(now).toISOString(),
            last_accessed_at_ms: now,
        };
        this.state.episodic.unshift(item);
        this.pruneMemories(uid);
        this.save();
        return item;
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
        return [
            `【目标 QQ 用户长期画像 (Semantic Memory)】`,
            `- 用户 QQ: ${profile.user_id}`,
            `- 称呼/昵称: ${profile.nickname}`,
            `- 关系定位: ${profile.relationship_tag}`,
            `- 当前好感度 (affection): ${profile.affection}/100`,
            `- 长期事实与习惯 (known_facts):\n${facts}`,
        ].join('\n');
    }
}
