/**
 * Inbound pipeline (M2-D1-PR4): the OneBot-11 → agent-turn path. Two pieces:
 * `normalizeOneBot11`, the pure protocol-adaptation seam that reduces one
 * raw message event to a neutral NormalizedInbound (null = not processable),
 * and `InboundPipeline`, which runs the normalized message through the
 * policy gate → mention gate → command router → media resolution →
 * quote/forward expansion → rate limit → turn dispatch. Extracted verbatim
 * from bridge.ts — gate order, prefix assembly, media annotation and
 * rate-limit behavior are identical; the bridge keeps same-name facade
 * methods so the onFrame call site, the command table and the M2-T0
 * pipeline-order overrides keep working unchanged.
 * @module dsh-onebot/inbound
 */
import { writeFile } from 'node:fs/promises';
import { extForInboundName } from './media.js';
import { transcriptLabel } from './stt.js';
import { describeImage } from './vision.js';
import { cqUnescape, detectExplicitMention, detectMention, parseMessage, segmentText } from './cq.js';
import { buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, groupAllowed, RESTRICTED_PREFIX, sanitizeNickname, wrapUserMessage, } from './chat.js';
import { describeError } from './errors.js';
import { currentTrace, TRACE_REASONS } from './trace.js';
import { buildDynamicTurnContext } from './action-protocol.js';
/**
 * Reduce one raw OneBot 11 event to the neutral inbound shape, or null when
 * the event is not a processable chat message (notice/recall, meta, unknown
 * message_type, or a missing sender id). Pure: no I/O, no state — the
 * connection's self_id learning stays in the transport layer and the
 * ignoreSelf comparison stays in the pipeline (both are runtime state).
 */
export function normalizeOneBot11(event) {
    const messageType = event.message_type;
    if (messageType !== 'private' && messageType !== 'group')
        return null;
    const userId = String(event.user_id ?? '');
    if (userId === '')
        return null;
    const kind = messageType === 'private' ? 'private' : 'group';
    const groupId = kind === 'group' ? String(event.group_id ?? '') : '';
    const chatId = buildChatId(kind, kind === 'private' ? userId : groupId);
    const segments = Array.isArray(event.message) ? event.message : undefined;
    const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '');
    const messageId = event.message_id === undefined || event.message_id === null
        ? undefined
        : String(event.message_id);
    const parsed = parseMessage(segments, raw);
    const sender = event.sender ?? {};
    const nickname = typeof sender.card === 'string' && sender.card !== ''
        ? sender.card
        : typeof sender.nickname === 'string' && sender.nickname !== ''
            ? sender.nickname
            : userId;
    return {
        kind,
        userId,
        groupId,
        chatId,
        segments,
        raw,
        text: parsed.text,
        media: parsed.media,
        replyId: parsed.replyId,
        forwardId: parsed.forwardId,
        messageId,
        nickname,
    };
}
/** W2-②: default (chatId, message_id) dedup window, aligned with the MIT
 * competitor's dedupWindowSeconds (300s). */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** W2-②: max entries kept in the dedup window map (LRU-evicted beyond this)
 * so a flood of distinct message_ids cannot grow memory unbounded. */
export const DEDUP_MAX_ENTRIES = 4096;
/**
 * The inbound pipeline: one normalized OneBot event → one agent turn.
 * Owns media resolution, quote/forward expansion and the B7 rate limit;
 * turn dispatch stays behind the context callback.
 */
export class InboundPipeline {
    ctx;
    /** W2-② dedup knobs (see InboundPipelineOptions). */
    dedupMaxEntries;
    now;
    /** W2-② dedup window state: "chatId#messageId" → first-seen epoch ms, in
     * insertion order (Map) so the oldest entry is the LRU victim. */
    seenMessages = new Map();
    /** 群聊近期消息滑动缓存: groupId → Array<{ time, label, text }> */
    recentGroupMessages = new Map();
    /** 群聊复读机队形检测缓存: groupId → { text, senders: Set, count, lastRepeatedText, lastRepeatAt } */
    groupRepeatState = new Map();
    /** 同用户图片识图期间追发文字合流槽: "${chatId}:${userId}" → { extraTexts: string[], latestMessageId?: string } */
    pendingVisionTurns = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.dedupMaxEntries = options.dedupMaxEntries ?? DEDUP_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
    }
    /** W1/T5 health snapshot: how many message_ids are currently held in the
     * dedup window (LRU-capped; see DEDUP_MAX_ENTRIES). */
    get dedupWindowEntries() {
        return this.seenMessages.size;
    }
    async processInbound(inbound) {
        if (this.duplicated(inbound))
            return;
        const { kind, userId, groupId, chatId } = inbound;
        if (kind === 'group' && groupId) {
            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const sNick = sanitizeNickname(inbound.nickname) || userId;
            const cleanText = (inbound.text || '').replace(/\r?\n/g, ' ').trim();
            if (cleanText) {
                const list = this.recentGroupMessages.get(groupId) || [];
                list.push({ time: timeStr, label: sNick, text: cleanText.slice(0, 100) });
                if (list.length > 20) list.shift();
                this.recentGroupMessages.set(groupId, list);
            }
        }
        if (this.ctx.config.ignoreSelf && this.ctx.selfId() !== '' && userId === this.ctx.selfId()) {
            // pipeline-hooks.md #5: this drop used to be fully silent.
            this.ctx.log('debug', '机器人自己的消息已忽略: ' + chatId);
            currentTrace()?.emit('self', { ok: false, reason: TRACE_REASONS.inboundSelf });
            return;
        }
        const policy = this.ctx.policy;
        if (kind === 'private') {
            if (!dmAllowed(userId, policy)) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                return;
            }
        }
        else {
            if (!groupAllowed(groupId, policy)) {
                this.ctx.log('debug', 'ignoring group message from non-allowed group ' + groupId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundGroupBlocked });
                return;
            }
        }
        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';
        
        // 提取消息纯文本
        const textContent = inbound.segments !== undefined
            ? inbound.segments.filter(s => s.type === 'text').map(s => s.data.text ?? '').join('')
            : (inbound.raw || '');

        const feiyu = this.ctx.feiyu?.();
        const activityText = textContent.trim() ? textContent : (inbound.text || '');
        const activityRes = feiyu
            ? feiyu.notifyUserActivity(chatId, activityText, userId, inbound.nickname, inbound.messageId)
            : undefined;
        if (feiyu && inbound.messageId !== undefined && typeof feiyu.maybeReactEmojiToMessage === 'function') {
            void feiyu.maybeReactEmojiToMessage(inbound.messageId, activityText, isAdmin, kind);
        }

        // 群聊唤醒准则：老大或群友在群聊中喊肥鱼执行工具任务（唱歌/画画/换音色/老大系统指令）时走完整 Agent 通道；日常喊肥鱼名字闲聊则交由下方 evaluateGroupLurkAndChime 走灵动多气泡秒回通道
        const botNamePattern = /(肥鱼|飞鱼|大肥鱼|小肥鱼|胖鱼|鱼鱼|呆鱼|傻鱼|笨鱼|臭鱼|死鱼|丑鱼|胖头鱼|蓝鲸|鲸鱼|鲸鲸|开心飞鱼|本鱼|鱼来|鱼出来|鱼呢|小鱼|(?:^|[，,。！？!?\s])鱼(?:[，,、！!？?\s]|你|本鱼|截至|今天|昨天|刚才|怎么|为什么|为啥|干嘛|在吗|能|会|帮|吃|喝|睡|醒|看|说|讲|唱|画))/i;
        const publicMediaToolPattern = /(唱歌|点歌|唱首|唱个|唱一首|唱支|来首歌|来一首|哼一首|给我唱|用.*声音唱|用.*音色唱|唱《|(?:^|[，。！？\s]|肥鱼|飞鱼|本鱼|声音|音色)唱(?!反调|衰|高调|双簧|白脸|红脸|黑脸)\S+|我的歌呢|歌呢|怎么不唱|还没唱|画画|画个|画张|画一只|画幅|生成图片|生图|自拍|自画像|什么音色|音色库|有哪些音色|有哪些声音|(?:切换|换成?|改用|变成).*(?:芭芭拉|可莉|芙宁娜|胡桃|神里|绫华|雷电|将军|八重|神子|迪奥娜|纳西妲|音色|声音))/i;
        const adminToolPattern = /(打开|浏览器|搜索|查一下|看看|截图|执行|运行|代码|文件|天气|帮我|切换.*(?:音色|声音|芭芭拉|可莉|芙宁娜|胡桃|神里|绫华|雷电|将军|八重|神子|迪奥娜|纳西妲)|换.*(?:音色|声音|芭芭拉|可莉|芙宁娜|胡桃|神里|绫华|雷电|将军|八重|神子|迪奥娜|纳西妲))/i;
        const adminCalledByName = (isAdmin || botNamePattern.test(textContent) || Boolean(feiyu?.isGroupConvoActive?.(chatId))) && (
            publicMediaToolPattern.test(textContent) ||
            (isAdmin && adminToolPattern.test(textContent))
        );
        const isPublicFishCommand = /^\s*(?:@\d+\s*)?\/fish(?:\s|$)/i.test(inbound.text || textContent);
        const userVisionKey = `${chatId}:${userId}`;
        const hasInboundImg = Array.isArray(inbound.media) && inbound.media.some(m => m.kind === 'image');
        const pendingVision = this.pendingVisionTurns.get(userVisionKey);
        if (pendingVision && !hasInboundImg && !isPublicFishCommand && textContent.trim()) {
            pendingVision.extraTexts.push(textContent.trim());
            if (inbound.messageId !== undefined) pendingVision.latestMessageId = inbound.messageId;
            this.ctx.log('info', `[图文合流] 检测到 ${inbound.nickname || userId} 在图片识图期间追发文字 ("${textContent.trim()}")，已自动合并入图片回合一并回复！`);
            return;
        }

        const requireMentionForThisMessage = kind === 'group' && this.ctx.config.requireMention;
        const isExplicitMention = adminCalledByName
            || isPublicFishCommand
            || detectExplicitMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);

        let mentioned = isExplicitMention || detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);
        let verifiedQuote;
        let mentionDropReason = TRACE_REASONS.inboundUnmentioned;
        if (requireMentionForThisMessage && !isExplicitMention) {
            mentioned = false;
            const bot = this.ctx.selfId() || this.ctx.config.botQQ;
            if (bot !== '' && inbound.replyId !== undefined) {
                const messageId = numericReplyId(inbound.replyId);
                if (messageId === undefined) {
                    mentionDropReason = TRACE_REASONS.quoteInvalidId;
                }
                else {
                    try {
                        // The reply segment's optional qq is not authoritative. Resolve the
                        // original author before commands, media I/O or busy-turn dispatch.
                        verifiedQuote = await this.ctx.call('get_msg', { message_id: messageId });
                        const author = String(verifiedQuote?.sender?.user_id ?? '');
                        mentioned = author === bot;
                        // Stable reasons preserve trace same-cause dedup while distinguishing
                        // an unavailable original from missing or non-bot author information.
                        if (verifiedQuote == null) {
                            mentionDropReason = TRACE_REASONS.inboundReplyLookupFailed;
                        }
                        else if (author === '') {
                            mentionDropReason = TRACE_REASONS.inboundReplyAuthorUnknown;
                        }
                        else if (!mentioned) {
                            mentionDropReason = TRACE_REASONS.inboundReplyOtherAuthor;
                        }
                    }
                    catch (error) {
                        // Deleted/unknown quotes and lookup failures must never wake the bot.
                        mentionDropReason = TRACE_REASONS.inboundReplyLookupFailed;
                        this.ctx.log('debug', '引用作者校验失败，未唤醒机器人: ' + describeError(error));
                    }
                }
            }
        }
        if (adminCalledByName) {
            mentioned = true;
            this.ctx.log('info', `[老大呼叫] 检测到老大在群 ${groupId} 喊肥鱼昵称 ("${textContent.trim()}"), 唤醒回复！`);
        }
        if (requireMentionForThisMessage && !mentioned) {
            // 人类本质：群聊“复读机 +1”队形检测（当群内 >=2 位群友或连续 3 条刷相同短句时，自动跟队形复读一次）
            const cleanGroupText = (inbound.text || textContent || '').replace(/\r?\n/g, ' ').trim();
            if (cleanGroupText && cleanGroupText.length >= 1 && cleanGroupText.length <= 35 && !cleanGroupText.startsWith('/')) {
                const nowMs = this.now();
                let rep = this.groupRepeatState.get(groupId);
                if (!rep || rep.text !== cleanGroupText) {
                    rep = {
                        text: cleanGroupText,
                        senders: new Set([userId]),
                        count: 1,
                        lastRepeatedText: rep?.lastRepeatedText || '',
                        lastRepeatAt: rep?.lastRepeatAt || 0,
                    };
                    this.groupRepeatState.set(groupId, rep);
                } else {
                    rep.senders.add(userId);
                    rep.count += 1;
                    if (
                        (rep.senders.size >= 2 || rep.count >= 3) &&
                        rep.lastRepeatedText !== cleanGroupText &&
                        (nowMs - rep.lastRepeatAt) > 2 * 60_000
                    ) {
                        rep.lastRepeatedText = cleanGroupText;
                        rep.lastRepeatAt = nowMs;
                        this.ctx.log('info', `[群聊复读机 +1] 检测到群 ${groupId} 队形 ("${cleanGroupText}")，跟风复读一次！`);
                        await this.ctx.sendToChat(chatId, cleanGroupText);
                        return;
                    }
                }
            }
            if (feiyu) {
                let chimeInbound = inbound;
                const hasImg = Array.isArray(inbound.media) && inbound.media.some(m => m.kind === 'image');
                const shouldResolveMediaForChime = (hasImg || inbound.replyId !== undefined) && (
                    isAdmin ||
                    hasImg ||
                    feiyu.isGroupConvoActive?.(chatId, userId) ||
                    /(肥鱼|飞鱼|大肥鱼|五花肉|好吃|夜宵|烧烤|火锅|奶茶|干饭|饿|图|看|吃|投喂|喂|饭|肉|菜|给|赏|请)/i.test(textContent)
                );
                if (shouldResolveMediaForChime) {
                    const visionSlot = hasImg ? { extraTexts: [], latestMessageId: inbound.messageId } : null;
                    if (visionSlot) this.pendingVisionTurns.set(userVisionKey, visionSlot);
                    try {
                        let chimeBody = hasImg && this.ctx.buildBody
                            ? await this.ctx.buildBody(inbound.text, inbound.media, chatId)
                            : inbound.text;
                        if (visionSlot && visionSlot.extraTexts.length > 0) {
                            chimeBody = [chimeBody, ...visionSlot.extraTexts].filter(Boolean).join(' ');
                        }
                        const chimeQuote = inbound.replyId !== undefined && this.ctx.expandQuote
                            ? await this.ctx.expandQuote(inbound.replyId, verifiedQuote)
                            : '';
                        const combinedChimeText = [chimeQuote, chimeBody].filter(Boolean).join('\n');
                        if (combinedChimeText) {
                            chimeInbound = {
                                ...inbound,
                                messageId: visionSlot?.latestMessageId ?? inbound.messageId,
                                text: combinedChimeText,
                            };
                            feiyu.memoryManager?.updateLatestWorkingMemoryText?.(chatId, userId, combinedChimeText);
                        }
                    } catch {} finally {
                        if (visionSlot && this.pendingVisionTurns.get(userVisionKey) === visionSlot) {
                            this.pendingVisionTurns.delete(userVisionKey);
                        }
                    }
                }
                if (await feiyu.evaluateGroupLurkAndChime(chimeInbound)) {
                    return;
                }
            }
            const chimeProb = typeof this.ctx.config.randomChimeProbability === 'number'
                ? this.ctx.config.randomChimeProbability
                : 0;
            const roll = Math.random();
            if (chimeProb > 0 && roll < chimeProb) {
                this.ctx.log('info', `[群聊插话] 群友未@肥鱼，命中 ${Math.round(chimeProb * 100)}% 随机插话几率 (roll=${roll.toFixed(3)})，触发回复！`);
            } else {
                this.ctx.log('debug', mentionDropReason + ': ' + groupId + ` (群聊消息未@机器人，免打扰已忽略)`);
                currentTrace()?.emit('mention', { ok: false, reason: mentionDropReason });
                return;
            }
        }
        // M3-D5 identity whitelist: the sanitized nickname feeds the single-line
        // prefix, the <user_message> attribute and lastNickname — one value,
        // provably line-safe and markup-free for all three surfaces.
        const nickname = sanitizeNickname(inbound.nickname);
        // B8c: lazy idle eviction before processing each inbound message (flush →
        // dispose → remove; the mapping is kept so the chat can resume).
        await this.ctx.sweepIdleChats();
        // A new user message starts a fresh reply cycle: drop any unmerged loop
        // residue from the previous cycle so interims never merge across turns.
        const priorChat = this.ctx.getChat(chatId);
        if (priorChat !== undefined) {
            priorChat.loopBuffer = [];
            priorChat.loopPending = null;
        }
        // Fire-and-forget temp cleanup on each inbound.
        void this.ctx.media.cleanupExpired();
        // Route commands before media/quote expansion. A reply-only group trigger
        // must already have passed author verification above; explicit @ commands
        // and private commands still avoid quote I/O. Register images lazily for /ocr.
        for (const ref of inbound.media) {
            if (ref.kind === 'image')
                this.ctx.getSettings(chatId).pendingImageRef = ref;
        }
        if (await this.ctx.tryHandleCommand(chatId, inbound.text, userId, nickname)) {
            currentTrace()?.emit('command', { ok: true, reason: TRACE_REASONS.inboundCommand });
            return;
        }
        const mainVisionSlot = hasInboundImg ? { extraTexts: [], latestMessageId: inbound.messageId } : null;
        if (mainVisionSlot) this.pendingVisionTurns.set(userVisionKey, mainVisionSlot);
        let body;
        try {
            body = await this.ctx.buildBody(inbound.text, inbound.media, chatId);
            if (mainVisionSlot && mainVisionSlot.extraTexts.length > 0) {
                body = [body, ...mainVisionSlot.extraTexts].filter(Boolean).join(' ');
            }
        } finally {
            if (mainVisionSlot && this.pendingVisionTurns.get(userVisionKey) === mainVisionSlot) {
                this.pendingVisionTurns.delete(userVisionKey);
            }
        }
        let quote = '';
        if (inbound.replyId !== undefined) {
            // Keep the bridge's expansion seam while reusing this message's lookup.
            quote = await this.ctx.expandQuote(inbound.replyId, verifiedQuote);
        }
        let forward = '';
        if (inbound.forwardId !== undefined) {
            const expansion = await this.expandForward(inbound.forwardId);
            forward = expansion.text;
            if (expansion.media.length > 0) {
                // Forward-embedded images ride the same buildBody pipeline (their
                // '[图片]' placeholders are inline in the expansion text). Preserve
                // the pre-routing /ocr ref so a direct image in the same message
                // stays the /ocr target.
                const pending = this.ctx.getSettings(chatId).pendingImageRef;
                forward = await this.ctx.buildBody(expansion.text, expansion.media, chatId);
                this.ctx.getSettings(chatId).pendingImageRef = pending;
            }
        }
        if (this.rateLimited(chatId))
            return;
        // M3-D5: the whole sender-controlled payload (body + quote/forward
        // expansions) enters the prompt inside the <user_message> boundary, so
        // forged prefix lines, restricted-member tags and system-prompt-like text
        // stay pure data. The framework-generated group prefix and
        // RESTRICTED_PREFIX remain outside — the only trusted metadata.
        const content = [forward, quote, body].filter(part => part !== '').join('\n');
        if (content.trim() === '') {
            // pipeline-hooks.md #17: this drop used to be fully silent.
            this.ctx.log('debug', '消息展开后无有效文本内容，已丢弃: ' + chatId);
            currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.inboundEmptyContent });
            return;
        }
        let final = wrapUserMessage(content, userId, nickname);
        if (kind === 'group') {
            const prefix = buildGroupMessagePrefix(nickname, userId, mentioned);
            const restricted = (!isAdmin && this.ctx.config.restrictedMemberPrefix) ? RESTRICTED_PREFIX : '';

            // 自动加载群聊最近上下文（最近 6~10 条群友发言），彻底杜绝无上下文或驴头不对马嘴
            let contextBlock = '';
            try {
                let historyLines = [];
                // 1. 优先调用 OneBot 接口拉取真实群历史（包含其他群友、图片、表情及自己之前发言）
                const historyData = await this.ctx.call('get_group_msg_history', {
                    group_id: Number(groupId),
                    count: 12
                }).catch(() => null);
                const rawMsgs = Array.isArray(historyData?.messages) ? historyData.messages : [];
                for (const m of rawMsgs) {
                    if (inbound.messageId && String(m.message_id) === String(inbound.messageId)) continue;
                    const sender = m.sender || {};
                    const sNick = sender.card || sender.nickname || String(sender.user_id || m.user_id || '');
                    const isSelf = String(sender.user_id) === String(this.ctx.selfId() || this.ctx.config.botQQ);
                    const label = isSelf ? '肥鱼本鱼(我)' : sNick;
                    const parsed = parseMessage(Array.isArray(m.message) ? m.message : undefined, typeof m.raw_message === 'string' ? m.raw_message : '');
                    const cleanText = cqUnescape(parsed.text || '').replace(/\r?\n/g, ' ').trim();
                    if (!cleanText) continue;
                    const timeStr = m.time ? new Date(m.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                    historyLines.push(`[${timeStr} ${label}]: ${cleanText.slice(0, 100)}`);
                }
                // 2. 若 API 未能拉取到，优先融合 MemoryManager 的群聊 Working Memory 与内存滑动历史兜底
                if (historyLines.length === 0) {
                    const wmList = feiyu?.memoryManager ? feiyu.memoryManager.getWorkingMemory(chatId, 10) : [];
                    if (wmList.length > 0) {
                        for (const item of wmList) {
                            historyLines.push(`[${item.time} ${item.nickname}]: ${item.text}`);
                        }
                    } else {
                        const fallbackList = this.recentGroupMessages.get(groupId) || [];
                        for (const item of fallbackList) {
                            historyLines.push(`[${item.time} ${item.label}]: ${item.text}`);
                        }
                    }
                }
                if (historyLines.length > 0) {
                    const recentSlice = historyLines.slice(-8);
                    contextBlock = '【群聊前文背景（供理解对话上下文，无需逐条回复）】：\n' + recentSlice.join('\n') + '\n---\n';
                }
            } catch (err) {
                this.ctx.log('debug', '获取群聊上下文失败: ' + describeError(err));
            }
            final = contextBlock + restricted + prefix + final;
        }
        const role = isAdmin ? 'admin' : 'member';
        const plain = inbound.media.length === 0 && inbound.replyId === undefined && inbound.forwardId === undefined;

        if (feiyu) {
            const dynamicTail = buildDynamicTurnContext({
                driveEngine: feiyu.driveEngine,
                memoryManager: feiyu.memoryManager,
                chatId,
                userId,
                nickname,
                queryText: content,
                wokeUpFromSleep: Boolean(activityRes?.wokeUpFromSleep),
                envContext: typeof feiyu.getEnvironmentContext === 'function' ? feiyu.getEnvironmentContext() : null,
            });
            final = final + '\n' + dynamicTail;
        }

        // 轻量级快慢双通道分流器 (Fast/Tool Router)：
        // 若无需调用重型系统/浏览器/语音工具，统一走 Feiyu 快速拟人多气泡通道 (handleFastChatTurn)，消除私聊/@ 与群插话的回复风格割裂
        const activeChat = this.ctx.getChat(chatId);
        const isChatBusy = activeChat !== undefined && activeChat.busy === true;
        const hasNonImageMedia = Array.isArray(inbound.media) && inbound.media.some(m => m.kind !== 'image' && m.kind !== 'voice');
        const needsHeavyAgentTools = hasNonImageMedia
            || inbound.forwardId !== undefined
            || Boolean(activityRes?.wokeUpFromSleep)
            || publicMediaToolPattern.test(content)
            || adminToolPattern.test(content)
            || /(打开浏览器|去逛|搜索|搜一下|查一下|百度|谷歌|截图|截个图|看下桌面|看下屏幕|执行|运行|写代码|改代码|看下文件|创建文件|删除文件|查天气)/i.test(content);

        if (kind === 'private' && plain && !isChatBusy && feiyu?.debounceBuffer) {
            feiyu.debounceBuffer.push(
                chatId,
                {
                    chatId,
                    userId,
                    nickname,
                    text: content,
                    messageId: inbound.messageId,
                    meta: { role, wokeUpFromSleep: Boolean(activityRes?.wokeUpFromSleep), needsHeavyAgentTools },
                },
                async (mergedPayload) => {
                    if (
                        !mergedPayload.meta?.needsHeavyAgentTools &&
                        typeof feiyu.handleFastChatTurn === 'function' &&
                        await feiyu.handleFastChatTurn({
                            chatId: mergedPayload.chatId,
                            userId: mergedPayload.userId,
                            nickname: mergedPayload.nickname,
                            text: mergedPayload.text,
                            messageId: mergedPayload.messageId,
                            isGroup: false,
                            wokeUpFromSleep: Boolean(mergedPayload.meta?.wokeUpFromSleep),
                        })
                    ) {
                        return;
                    }
                    const mergedWrapped = wrapUserMessage(mergedPayload.text, mergedPayload.userId, mergedPayload.nickname);
                    const tail = buildDynamicTurnContext({
                        driveEngine: feiyu.driveEngine,
                        memoryManager: feiyu.memoryManager,
                        chatId: mergedPayload.chatId,
                        userId: mergedPayload.userId,
                        nickname: mergedPayload.nickname,
                        queryText: mergedPayload.text,
                        wokeUpFromSleep: Boolean(mergedPayload.meta?.wokeUpFromSleep),
                        envContext: typeof feiyu.getEnvironmentContext === 'function' ? feiyu.getEnvironmentContext() : null,
                    });
                    const mergedFinal = mergedWrapped + '\n' + tail;
                    if (this.ctx.interceptBusyTurn !== undefined
                        && await this.ctx.interceptBusyTurn(mergedPayload.chatId, mergedFinal, mergedPayload.meta?.role || role, mergedPayload.nickname, true)) {
                        return;
                    }
                    await this.ctx.dispatchFollowup(mergedPayload.chatId, mergedFinal, mergedPayload.meta?.role || role, mergedPayload.nickname);
                }
            );
            return;
        }

        let fastTurnText = content;
        if (
            kind === 'group' &&
            !needsHeavyAgentTools &&
            !isChatBusy &&
            textContent.trim() === '' &&
            !hasInboundImg &&
            inbound.replyId === undefined &&
            /^@\d+\s*$/.test(content.trim())
        ) {
            const bareAtTime = feiyu?.lastUserMessageAtMap?.get(userVisionKey) || Date.now();
            await new Promise(r => setTimeout(r, 2200));
            const latestTime = feiyu?.lastUserMessageAtMap?.get(userVisionKey) || bareAtTime;
            if (latestTime > bareAtTime || this.pendingVisionTurns.has(userVisionKey)) {
                this.ctx.log('info', `[空@合流] 检测到 ${nickname} 发送空@后紧接着发了后续消息/图片，已自动让位合并！`);
                return;
            }
            fastTurnText = '[群友单纯@呼叫了你一下，还没说具体啥事，请用1条简短傲娇气泡问ta喊本鱼干嘛，严禁脑补对方发了生鱼片或图片！]';
        }

        if (
            !needsHeavyAgentTools &&
            !isChatBusy &&
            typeof feiyu?.handleFastChatTurn === 'function' &&
            await feiyu.handleFastChatTurn({
                chatId,
                groupId,
                userId,
                nickname,
                text: fastTurnText,
                messageId: mainVisionSlot?.latestMessageId ?? inbound.messageId,
                isGroup: kind === 'group',
                wokeUpFromSleep: Boolean(activityRes?.wokeUpFromSleep),
            })
        ) {
            return;
        }

        if (this.ctx.interceptBusyTurn !== undefined
            && await this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain)) {
            return;
        }
        await this.ctx.dispatchFollowup(chatId, final, role, nickname);
    }
    /** W2-②: (chatId, message_id) sliding-window dedup against OneBot
     * re-delivery (reconnect replay / ws retry). Runs before every other gate
     * so a redelivered message can neither re-trigger a command nor reset the
     * loop residue; only events that normalize to processable chat messages
     * reach this — notice/meta/request events never enter the pipeline (see
     * docs/m1-characterization/pipeline-hooks.md #1/#3). Events without a
     * message_id are not deduped (nothing to key on). Window entries live in
     * an LRU-capped map: hits refresh recency (keeping the first-seen time, so
     * the window opens at first delivery), the oldest entry is evicted beyond
     * the cap. Returns true when the delivery must be silently skipped. */
    duplicated(inbound) {
        const windowSeconds = this.ctx.config.dedupWindowSeconds ?? DEFAULT_DEDUP_WINDOW_SECONDS;
        if (windowSeconds <= 0)
            return false;
        if (inbound.messageId === undefined || inbound.messageId === '')
            return false;
        const now = this.now();
        const key = inbound.chatId + '#' + inbound.messageId;
        const seenAt = this.seenMessages.get(key);
        if (seenAt !== undefined && now - seenAt < windowSeconds * 1000) {
            this.seenMessages.delete(key);
            this.seenMessages.set(key, seenAt);
            this.ctx.log('debug', 'dedup hit in ' + inbound.chatId + ': message_id ' + inbound.messageId
                + ' redelivered within ' + windowSeconds + 's window, message skipped');
            currentTrace()?.emit('dedup', { ok: false, reason: TRACE_REASONS.inboundDedup });
            return true;
        }
        this.seenMessages.delete(key);
        while (this.seenMessages.size >= this.dedupMaxEntries) {
            const oldest = this.seenMessages.keys().next().value;
            if (oldest === undefined)
                break;
            this.seenMessages.delete(oldest);
        }
        this.seenMessages.set(key, now);
        return false;
    }
    /** B7: sliding-window inbound rate limit for normal (non-command) messages.
     * Commands consumed by tryHandleCommand never reach this. Returns true when
     * the message must be dropped; at most one notice is sent per window. */
    rateLimited(chatId) {
        const limit = this.ctx.config.rateLimitPerMinute ?? 30;
        if (limit <= 0)
            return false;
        const chat = this.ctx.getChat(chatId);
        if (chat === undefined)
            return false;
        const now = Date.now();
        chat.dispatchTimes = chat.dispatchTimes.filter(t => now - t < 60_000);
        if (chat.dispatchTimes.length < limit) {
            chat.dispatchTimes.push(now);
            return false;
        }
        // pipeline-hooks.md #16: the drop decision itself used to be silent (only
        // the user-facing notice text existed).
        currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateLimited });
        if (chat.rateLimitNoticeAt === undefined || now - chat.rateLimitNoticeAt >= 60_000) {
            chat.rateLimitNoticeAt = now;
            void this.ctx.sendToChat(chatId, '⏳ 消息太频繁，请稍后再试。').catch((error) => {
                this.ctx.log('debug', '限流提示发送失败: ' + describeError(error));
                currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateNoticeFailed });
            });
        }
        return true;
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    async buildBody(text, media, chatId) {
        if (media.length === 0)
            return text;
        let out = text;
        for (const ref of media) {
            const placeholder = placeholderFor(ref);
            const idx = out.indexOf(placeholder);
            const annotation = await this.resolveMediaRef(ref, chatId);
            if (idx >= 0 && annotation !== '') {
                out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length);
            }
            else if (idx >= 0) {
                // pipeline-hooks.md #10: a failed resolution used to leave the
                // placeholder silently unresolved.
                this.ctx.log('debug', '媒体解析失败，占位符保留原文: ' + placeholder);
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.mediaResolveFailed });
            }
        }
        return out;
    }
    /** Resolve one media ref to a text annotation with a local path. */
    async resolveMediaRef(ref, chatId) {
        if (ref.kind === 'file') {
            return await this.resolveNasFile(ref);
        }
        const resolved = await this.ctx.media.resolve(ref, async (kind, file) => {
            if (kind === 'image') {
                const data = await this.ctx.call('get_image', { file });
                return { url: data.url, file: data.file };
            }
            if (kind === 'voice') {
                const data = await this.ctx.call('get_record', { file, out_format: 'mp3' });
                return { file: data.file };
            }
            return undefined;
        });
        if (resolved === undefined)
            return '';
        switch (resolved.kind) {
            case 'image': {
                // Remember the most recent inbound image for /ocr (survives /new);
                // consume the pre-routing pending ref so /ocr never re-resolves it.
                const settings = this.ctx.getSettings(chatId);
                settings.lastImagePath = resolved.path;
                settings.pendingImageRef = undefined;
                let visualNote = '';
                try {
                    const desc = await describeImage(resolved.path);
                    if (desc) {
                        visualNote = ` （视觉画面描述: ${desc}）`;
                    }
                } catch {}
                return `[图片:${resolved.path}${visualNote}]`;
            }
            case 'voice': {
                if (this.ctx.transcriber.enabled) {
                    try {
                        const text = await Promise.race([
                            this.ctx.transcriber.transcribe(resolved.path),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('stt_inline_timeout')), 8000)),
                        ]);
                        const label = transcriptLabel(text);
                        if (label !== '') {
                            return `[语音] ${label}`;
                        }
                    } catch (err) {
                        if (err?.message === 'stt_inline_timeout') {
                            void this.transcribeLater(resolved.path, chatId);
                        } else {
                            this.ctx.log('debug', 'inline STT fallback to [语音]: ' + describeError(err));
                        }
                    }
                }
                return '[语音]';
            }
            case 'video':
                return '[视频:' + resolved.path + ']';
            default:
                return '[文件:' + resolved.path + ']';
        }
    }
    /** M3-D4c: transcribe in the background and deliver the labeled transcript
     * into the chat's turn (steer at the running turn's nearest step boundary,
     * or a new turn when the agent is idle). Failure keeps [语音] as final. */
    async transcribeLater(path, chatId) {
        try {
            const text = await this.ctx.transcriber.transcribe(path);
            if (transcriptLabel(text) === '') {
                this.ctx.log('debug', '语音转写结果为空: ' + path);
                currentTrace()?.emit('transcribe', { ok: false, reason: TRACE_REASONS.sttEmpty });
                return;
            }
            this.ctx.steerTranscript(chatId, text);
        }
        catch (error) {
            this.ctx.log('warn', 'STT failed: ' + describeError(error));
            currentTrace()?.emit('transcribe', { ok: false, reason: '语音转写失败: ' + describeError(error) });
        }
    }
    /**
     * Expand a quote through get_msg, or reuse its already verified response.
     * @param messageId - quoted OneBot message id.
     * @param verifiedData - optional response fetched by this inbound message's gate.
     * @returns the existing [引用] text, or an empty string when expansion fails.
     */
    async expandQuote(messageId, verifiedData) {
        const numericId = numericReplyId(messageId);
        if (numericId === undefined) {
            // An invalid quote must not block explicit @ / private entry points;
            // omit only its expansion and avoid an unusable get_msg request.
            this.ctx.log('debug', TRACE_REASONS.quoteInvalidId);
            currentTrace()?.emit('quote', { ok: false, reason: TRACE_REASONS.quoteInvalidId });
            return '';
        }
        try {
            // Local to one message: no cross-chat cache or shared mutable quote state.
            const data = verifiedData ?? await this.ctx.call('get_msg', { message_id: numericId });
            const segments = Array.isArray(data.message) ? data.message : undefined;
            const raw = typeof data.raw_message === 'string' ? data.raw_message : '';
            const text = cqUnescape(segmentText(segments, raw));
            if (text.trim() === '')
                return '';
            const name = data.sender?.nickname ?? '';
            return '[引用]' + (name !== '' ? name + ': ' : '') + text;
        }
        catch (error) {
            this.ctx.log('debug', 'quote expansion failed: ' + describeError(error));
            currentTrace()?.emit('quote', { ok: false, reason: '引用消息展开失败，已降级为空引用: ' + describeError(error) });
            return '';
        }
    }
    /**
     * Fetch an inbound QQ file to a local path. NapCat's get_file may return
     * container-internal paths unreachable from this host, so:
     *   1. prefer the private-file direct link (get_private_file_url → HTTP
     *      CDN download, works for private chats);
     *   2. fall back to get_file base64 / http-url payloads.
     * Returns the [文件:path] annotation, or '' when disabled/failed.
     */
    async resolveNasFile(ref) {
        const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file';
        // The sender-controlled name never becomes the on-disk path (it could
        // otherwise overwrite chat-sessions.json etc.); only a whitelisted
        // extension survives into the fresh media_* name.
        const ext = extForInboundName(name);
        // Streaming size cap for both URL branches below (0 = uncapped).
        const maxBytes = this.ctx.config.maxInboundFileBytes > 0 ? this.ctx.config.maxInboundFileBytes : undefined;
        const fid = ref.fileId ?? ref.file ?? '';
        if (fid === '')
            return '';
        try {
            // 1. Private-chat direct link (works without any container access).
            const direct = await this.ctx.call('get_private_file_url', { file_id: fid });
            if (direct.url !== undefined && direct.url !== '') {
                try {
                    const localPath = await this.ctx.media.downloadUrl(direct.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via direct link: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_private_file_url failed (falling back to get_file): ' + describeError(error));
        }
        // 2. get_file: with NapCat's file server enabled it returns a `base64`
        //    payload or an http(s) `url`; otherwise a container path we cannot reach.
        try {
            const data = await this.ctx.call('get_file', { file: fid });
            const size = Number(data.file_size ?? 0);
            if (this.ctx.config.maxInboundFileBytes > 0 && size > this.ctx.config.maxInboundFileBytes) {
                this.ctx.log('warn', 'qq file too large (' + size + 'B), skipping fetch');
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileTooLarge });
                return '';
            }
            if (data.base64 !== undefined && data.base64 !== '') {
                const localPath = await this.writeMediaFile(Buffer.from(data.base64, 'base64'), ext);
                if (localPath !== '') {
                    this.ctx.log('info', 'qq file fetched via get_file base64: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
            }
            if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
                try {
                    const localPath = await this.ctx.media.downloadUrl(data.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via get_file url: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_file base64/url path failed: ' + describeError(error));
        }
        this.ctx.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid);
        currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileFailed });
        return '';
    }
    /** Write bytes into the media dir under a fresh unpredictable name; returns the path or ''. */
    async writeMediaFile(buffer, ext) {
        try {
            // freshPath mints media_<ts>_<uuid><ext>: inbound data can never land
            // on a known name (chat-sessions.json etc.) no matter what the sender
            // chose as the file name.
            await this.ctx.media.ensure();
            const localPath = this.ctx.media.freshPath(ext);
            await writeFile(localPath, buffer);
            return localPath;
        }
        catch (error) {
            this.ctx.log('warn', 'media write failed: ' + describeError(error));
            return '';
        }
    }
    /**
     * Expand a combined-forward id into "name: content" lines, collecting
     * embedded image segments into the media list (they flow through the same
     * buildBody pipeline as inbound media). Failure or an empty expansion no
     * longer returns a silent placeholder: the resId plus a short reason
     * (api-error / empty-response / no-text-nodes) stays in the model context
     * so it can self-serve via the whitelisted get_forward_msg tool.
     */
    async expandForward(forwardId) {
        try {
            // NapCat's get_forward_msg accepts `message_id` or `id`; sending both
            // also covers go-cqhttp-style implementations. Its response nodes are
            // OneBot node segments: { type: 'node', data: { nickname, user_id,
            // message: [...] } } — the flat `sender`/`content` shape is kept as a
            // fallback for other implementations.
            const data = await this.ctx.call('get_forward_msg', { id: forwardId, message_id: forwardId });
            const nodes = data.messages ?? [];
            const lines = [];
            const media = [];
            for (const node of nodes) {
                const nodeData = node.data;
                const name = nodeData?.nickname ?? node.sender?.nickname
                    ?? String(nodeData?.user_id ?? node.sender?.user_id ?? '未知');
                // NapCat v4 puts the message at the TOP level of the node (no data
                // wrapper); OneBot node segments keep data.message/data.content, and
                // go-cqhttp-style implementations use the flat sender/content shape.
                const text = nodeContentText(nodeData?.message ?? nodeData?.content ?? node.message ?? node.content, name, media, lines);
                if (text !== '')
                    lines.push(name + ': ' + text);
            }
            if (lines.length === 0) {
                const reason = nodes.length === 0 ? 'empty-response' : 'no-text-nodes';
                currentTrace()?.emit('forward', { ok: false, reason: '合并转发未展开: ' + reason });
                return { text: '[合并转发 id=' + forwardId + ' 未展开: ' + reason + ']', media };
            }
            return { text: '[合并转发]\n' + truncateForwardLines(lines).join('\n'), media };
        }
        catch (error) {
            this.ctx.log('info', 'forward expansion failed: resId=' + forwardId + ': ' + describeError(error));
            currentTrace()?.emit('forward', { ok: false, reason: '合并转发展开失败: ' + describeError(error) });
            return { text: '[合并转发 id=' + forwardId + ' 未展开: api-error]', media: [] };
        }
    }
}
/**
 * Parse a decimal reply id without producing NaN or rounding an integer.
 * @param messageId - raw OneBot reply id (signed ids remain supported).
 * @returns the exact numeric id, or undefined when no safe request can be made.
 */
function numericReplyId(messageId) {
    // Keep negative int32 ids and safe larger adapter ids; reject coercions such
    // as empty strings, whitespace, hexadecimal, fractions and exponent notation.
    // Some adapters send numeric segment fields despite the string-valued type.
    const raw = String(messageId);
    if (raw.trim() !== raw || !/^-?\d+$/.test(raw))
        return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}
/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref) {
    switch (ref.kind) {
        case 'image': return '[图片]';
        case 'voice': return '[语音]';
        case 'video': return '[视频]';
        default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]';
    }
}
/** Combined-forward expansion caps: at most 50 node lines / 8000 characters. */
const FORWARD_MAX_LINES = 50;
const FORWARD_MAX_CHARS = 8000;
/**
 * Cap expanded forward lines at 50 nodes / 8000 characters so a huge merged
 * forward cannot flood the model context. The dropped tail is announced with
 * a marker pointing at the whitelisted get_forward_msg self-serve tool.
 */
function truncateForwardLines(lines) {
    const kept = [];
    let used = 0;
    for (const line of lines) {
        if (kept.length >= FORWARD_MAX_LINES || used + line.length + 1 > FORWARD_MAX_CHARS) {
            const remaining = lines.length - kept.length;
            kept.push('(已截断，剩余 ' + remaining + ' 节点，可用 get_forward_msg 自查)');
            return kept;
        }
        kept.push(line);
        used += line.length + 1;
    }
    return kept;
}
/**
 * Extract text from a forward-node content (segment array or CQ string).
 * Image segments are collected into `media` and contribute a '[图片]'
 * placeholder (annotated by buildBody like inbound media, `name` carries the
 * owning node's nickname). Nested node segments recurse: their text joins
 * `lines` as their own "name: text" entry instead of being swallowed as
 * '[非文本]'.
 */
function nodeContentText(content, ownerName, media, lines) {
    if (Array.isArray(content)) {
        return content
            .map(seg => {
            const s = seg;
            if (s?.type === 'text')
                return String(s.data?.text ?? '');
            if (s?.type === 'face')
                return '😀';
            if (s?.type === 'image') {
                media.push({
                    kind: 'image',
                    url: typeof s.data?.url === 'string' && s.data.url !== '' ? s.data.url : undefined,
                    file: typeof s.data?.file === 'string' && s.data.file !== '' ? s.data.file : undefined,
                    name: ownerName,
                });
                return '[图片]';
            }
            if (s?.type === 'node' && typeof s.data === 'object' && s.data !== null) {
                const nested = s.data;
                const nestedName = nested.nickname ?? String(nested.user_id ?? ownerName);
                const nestedText = nodeContentText(nested.message ?? nested.content, nestedName, media, lines);
                if (nestedText !== '')
                    lines.push(nestedName + ': ' + nestedText);
                return '';
            }
            return '[非文本]';
        })
            .join('')
            .trim();
    }
    if (typeof content === 'string')
        return content.trim();
    return '';
}
