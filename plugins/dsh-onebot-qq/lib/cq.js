/**
 * OneBot 11 message parsing: CQ-code unescaping, segment-array → text/media
 * extraction, mention detection, and face-id → emoji mapping. Ported from the
 * Hermes onebot_utils.py (CQ parsing half). Pure functions, no I/O.
 * @module dsh-onebot/cq
 */
/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export function cqUnescape(value) {
    return value
        .replaceAll('&#91;', '[')
        .replaceAll('&#93;', ']')
        .replaceAll('&#44;', ',')
        .replaceAll('&amp;', '&');
}
/** 腾讯 QQ 官方黄脸表情 (QFace) ID -> 中文语义+Emoji 映射表（修正原表将 id=112 [菜刀] 误映射为 💛 的 Bug） */
const FACE_EMOJI = {
    '0': '[惊讶😮]', '1': '[撇嘴😒]', '2': '[色😍]', '3': '[发呆😐]', '4': '[得意😎]', '5': '[流泪😢]', '6': '[害羞😊]', '7': '[闭嘴🤐]',
    '8': '[睡😴]', '9': '[大哭😭]', '10': '[尴尬😅]', '11': '[发怒😡]', '12': '[调皮😜]', '13': '[呲牙😁]', '14': '[微笑🙂]', '15': '[难过☹️]',
    '16': '[酷😎]', '18': '[抓狂😫]', '19': '[吐🤮]', '20': '[偷笑🤭]', '21': '[可爱🥰]', '22': '[白眼🙄]', '23': '[傲慢😤]', '24': '[饥饿🤤]',
    '25': '[困😪]', '26': '[惊恐😱]', '27': '[流汗😓]', '28': '[憨笑😄]', '29': '[悠闲😌]', '30': '[奋斗💪]', '31': '[咒骂🤬]', '32': '[疑问❓]',
    '33': '[嘘🤫]', '34': '[晕😵]', '35': '[折磨😩]', '36': '[衰💀]', '37': '[骷髅💀]', '38': '[敲打🔨]', '39': '[再见👋]', '41': '[发抖🥶]',
    '42': '[爱情💑]', '43': '[跳跳🕺]', '46': '[猪头🐷]', '49': '[拥抱🤗]', '53': '[蛋糕🎂]', '54': '[闪电⚡]', '55': '[炸弹💣]', '56': '[刀🗡️]',
    '57': '[足球⚽]', '59': '[便便💩]', '60': '[咖啡☕]', '61': '[饭🍚]', '63': '[玫瑰🌹]', '64': '[凋谢🥀]', '66': '[爱心❤️]', '67': '[心碎💔]',
    '69': '[礼物🎁]', '74': '[太阳☀️]', '75': '[月亮🌙]', '76': '[赞👍]', '77': '[踩👎]', '78': '[握手🤝]', '79': '[胜利✌️]', '85': '[飞吻😘]',
    '86': '[怄火💢]', '89': '[西瓜🍉]', '96': '[冷汗😰]', '97': '[擦汗😅]', '98': '[抠鼻🤏]', '99': '[鼓掌👏]', '100': '[糗大了😖]', '101': '[坏笑😏]',
    '102': '[左哼哼😤]', '103': '[右哼哼😤]', '104': '[哈欠🥱]', '105': '[鄙视😒]', '106': '[委屈🥺]', '107': '[快哭了😢]', '108': '[阴险😈]', '109': '[亲亲😘]',
    '110': '[吓😱]', '111': '[可怜🥺]', '112': '[菜刀🔪]', '113': '[啤酒🍺]', '114': '[篮球🏀]', '115': '[乒乓🏓]', '116': '[示爱💋]', '117': '[瓢虫🐞]',
    '118': '[抱拳🙏]', '119': '[勾引🤙]', '120': '[拳头👊]', '121': '[差劲👎]', '122': '[爱你🤟]', '123': '[NO🙅]', '124': '[OK👌]', '125': '[转圈💫]',
    '126': '[磕头🙇]', '127': '[回头👀]', '128': '[跳绳]', '129': '[挥手👋]', '130': '[激动🤩]', '131': '[街舞🕺]', '132': '[献吻💋]', '136': '[双喜囍]',
    '137': '[鞭炮🧨]', '138': '[灯笼🏮]', '140': '[K歌🎤]', '144': '[喝彩🎉]', '145': '[祈祷🙏]', '146': '[爆筋💢]', '147': '[棒棒糖🍭]', '148': '[喝奶🍼]',
    '151': '[飞机✈️]', '158': '[钞票💵]', '168': '[药💊]', '169': '[手枪🔫]', '171': '[茶🍵]', '172': '[眨眼睛😉]', '173': '[泪奔😭]', '174': '[无奈摊手🤷]',
    '175': '[卖萌🥰]', '176': '[小纠结😣]', '177': '[喷血🩸]', '178': '[斜眼笑😏]', '179': '[doge🐶]', '180': '[惊喜🤩]', '181': '[骚扰😏]', '182': '[笑哭😂]',
    '183': '[我最美💁‍♀️]', '185': '[羊驼🦙]', '187': '[幽灵👻]', '188': '[蛋🥚]', '190': '[菊花🌼]', '192': '[红包🧧]', '193': '[大笑😆]', '194': '[不开心🙁]',
    '197': '[冷漠😑]', '198': '[呃😅]', '199': '[好棒👍]', '200': '[拜托🙏]', '201': '[点赞👍]', '202': '[无聊😑]', '203': '[托脸🥰]', '204': '[吃😋]',
    '205': '[送花💐]', '206': '[害怕😨]', '207': '[花痴😍]', '208': '[小样儿😏]', '210': '[飙泪😭]', '211': '[我不看🙈]', '212': '[托腮🤔]', '214': '[啵啵😘]',
    '215': '[糊脸]', '216': '[拍头🤦]', '217': '[扯一扯]', '218': '[舔一舔👅]', '219': '[蹭一蹭]', '220': '[拽炸天😎]', '221': '[顶呱呱👍]', '222': '[抱抱🤗]',
    '223': '[暴击👊]', '224': '[开枪🔫]', '225': '[撩一撩]', '226': '[拍桌😂]', '227': '[拍手👏]', '228': '[恭喜🙏]', '229': '[干杯🍻]', '230': '[嘲讽😏]',
    '231': '[哼😤]', '262': '[脑阔疼🤯]', '263': '[沧桑🚬]', '264': '[捂脸🤦]', '265': '[辣眼睛🙈]', '266': '[哦哟😏]', '267': '[头秃👨‍🦲]', '268': '[问号脸❓]',
    '269': '[暗中观察👀]', '270': '[emm😐]', '271': '[吃瓜🍉]', '272': '[呵呵哒🙂]', '273': '[我酸了🍋]', '274': '[太南了😩]', '276': '[辣椒🌶️]', '277': '[汪汪🐶]',
    '278': '[汗😓]', '279': '[打脸👋]', '280': '[击掌🙌]', '281': '[无眼笑😆]', '282': '[敬礼🫡]', '283': '[狂笑🤣]', '284': '[面无表情😐]', '285': '[摸鱼🐟]',
    '286': '[魔鬼笑😈]', '287': '[哦😐]', '288': '[请🙏]', '289': '[睁眼👀]', '290': '[敲开心🥳]', '291': '[震惊😱]', '292': '[让我康康👀]', '293': '[摸锦鲤🐟]',
    '294': '[期待🤩]', '295': '[拿到红包🧧]', '296': '[真好👍]', '297': '[拜谢🙏]', '298': '[元宝]', '299': '[牛啊🐮]', '300': '[胖三斤]', '301': '[好闪✨]',
    '302': '[左拜年]', '303': '[右拜年]', '305': '[右亲亲😘]', '306': '[牛气冲天🐮]', '307': '[喵喵🐱]', '311': '[打call📣]', '312': '[变形]', '314': '[仔细分析🧐]',
    '317': '[菜汪🐶]', '318': '[崇拜🤩]', '319': '[比心🫶]', '320': '[庆祝🎉]', '323': '[嫌弃😒]', '324': '[吃糖🍬]', '325': '[惊吓😱]', '326': '[生气😡]',
    '332': '[举牌]', '333': '[烟花🎆]', '334': '[虎虎生威🐯]', '336': '[豹富]', '337': '[花朵脸🌸]', '338': '[我想开了]', '339': '[舔屏😍]', '341': '[打招呼👋]',
    '342': '[酸Q]', '343': '[我方了]', '344': '[大怨种]', '345': '[红包多多🧧]', '346': '[你真棒棒👍]', '347': '[大展宏兔🐰]', '349': '[坚强]', '350': '[贴贴🥰]',
    '351': '[敲打🔨]', '352': '[咦❓]', '353': '[拜托🙏]', '354': '[尊嘟假嘟😮]', '355': '[耶✌️]', '356': '[666🤙]', '357': '[裂开🫠]',
};
/** Map a QQ face id (or segment data) to an explicit Chinese+emoji tag. */
export function faceToEmoji(id, segData) {
    const key = String(id ?? '');
    if (FACE_EMOJI[key]) return FACE_EMOJI[key];
    const rawText = segData?.raw?.faceText || segData?.text || '';
    if (typeof rawText === 'string' && rawText.trim()) {
        const clean = rawText.replace(/^\/|^\[|\]$/g, '').trim();
        if (clean) return `[${clean}]`;
    }
    return '😀';
}
const CQ_AT_RE = /\[CQ:at,qq=([^,\]]+)\]/g;
/**
 * Detect explicit @bot / @all only; a reply segment never implies an @.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @returns whether this message explicitly mentions the known bot.
 */
export function detectExplicitMention(segments, raw, selfId, botQQ) {
    const bot = selfId !== '' ? selfId : botQQ;
    if (bot === '')
        return false;
    if (segments !== undefined) {
        if (segments.some(seg => seg.type === 'at' && (String(seg.data.qq) === bot || seg.data.qq === 'all'))) {
            return true;
        }
    }
    CQ_AT_RE.lastIndex = 0;
    for (const m of raw.matchAll(CQ_AT_RE)) {
        if (m[1] === bot || m[1] === 'all')
            return true;
    }
    // 文本级@或呼叫唤醒（支持用户在群里直接打字 @肥鱼本鱼、@肥鱼、@大肥鱼、@开心飞鱼）
    const text = segments !== undefined
        ? segments.filter(s => s.type === 'text').map(s => s.data.text ?? '').join('')
        : (raw || '');
    if (/@(肥鱼本鱼|肥鱼|大肥鱼|开心飞鱼)/i.test(text)) {
        return true;
    }
    return false;
}
/**
 * Detect explicit mentions or a reply with a known bot author, fail-closed.
 * A standard OneBot reply contains only an id; the inbound group gate must
 * resolve its author through get_msg before allowing a reply-only trigger.
 * @param segments - preferred OneBot segment array.
 * @param raw - CQ string fallback.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured fallback bot QQ id.
 * @returns false for replies whose author cannot be determined synchronously.
 */
export function detectMention(segments, raw, selfId, botQQ) {
    if (detectExplicitMention(segments, raw, selfId, botQQ))
        return true;
    const bot = selfId !== '' ? selfId : botQQ;
    if (bot === '')
        return false;
    const list = segments !== undefined ? segments : parseCqString(raw);
    // A bare reply id contains no author information and cannot imply mention.
    return list.some(seg => seg.type === 'reply' && String(seg.data.qq ?? '') === bot);
}
/** Split a raw CQ string into segments; used only when no segment array exists. */
export function parseCqString(raw) {
    const segments = [];
    const re = /\[CQ:([a-z]+),([^\]]*)\]/g;
    let last = 0;
    for (const m of raw.matchAll(re)) {
        if (m.index !== undefined && m.index > last) {
            segments.push({ type: 'text', data: { text: raw.slice(last, m.index) } });
        }
        const data = {};
        for (const pair of m[2].split(',')) {
            const eq = pair.indexOf('=');
            if (eq > 0)
                data[pair.slice(0, eq)] = cqUnescape(pair.slice(eq + 1));
        }
        segments.push({ type: m[1], data });
        last = (m.index ?? 0) + m[0].length;
    }
    if (last < raw.length) {
        segments.push({ type: 'text', data: { text: raw.slice(last) } });
    }
    return segments;
}
/**
 * Parse a OneBot message (segment array preferred, CQ string fallback) into
 * text + media references. Media appear as placeholders in the text; media.ts
 * resolves each ref to a local path afterwards.
 * @param segments - message segment array (preferred).
 * @param raw - raw CQ string (fallback / complement).
 * @returns parsed text, media refs, and the quoted message id.
 */
export function parseMessage(segments, raw) {
    const textParts = [];
    const media = [];
    let replyId;
    let forwardId;
    const appendImage = (data) => {
        const subType = data.sub_type ?? data['sub-type'];
        if (subType === '1') {
            textParts.push('[表情包]');
            return;
        }
        media.push({ kind: 'image', url: data.url || undefined, file: data.file || undefined, subType });
        textParts.push('[图片]');
    };
    const list = segments !== undefined && segments.length > 0 ? segments : parseCqString(raw);
    for (const seg of list) {
        switch (seg.type) {
            case 'text':
                if (seg.data.text !== '')
                    textParts.push(seg.data.text);
                break;
            case 'image':
                appendImage(seg.data);
                break;
            case 'face':
                textParts.push(faceToEmoji(seg.data.id ?? '', seg.data));
                break;
            case 'record':
                media.push({ kind: 'voice', url: seg.data.url || undefined, file: seg.data.file || undefined });
                textParts.push('[语音]');
                break;
            case 'video':
                media.push({ kind: 'video', url: seg.data.url || undefined, file: seg.data.file || undefined });
                textParts.push('[视频]');
                break;
            case 'file':
                // NapCat's file segment: `file` holds the file NAME (not a path),
                // `file_id` the real id, `name` is usually absent. Keep the raw
                // fields for media.ts; the display name falls back to `file`.
                media.push({
                    kind: 'file',
                    url: seg.data.url || undefined,
                    file: seg.data.file || undefined,
                    fileId: seg.data.file_id || undefined,
                    name: seg.data.name || seg.data.file || undefined,
                });
                textParts.push(seg.data.name || seg.data.file ? `[文件:${seg.data.name || seg.data.file}]` : '[文件]');
                break;
            case 'at': {
                const qq = seg.data.qq ?? '';
                textParts.push(qq === 'all' ? '@全体成员' : `@${qq}`);
                break;
            }
            case 'reply':
                if (seg.data.id !== undefined) {
                    replyId = seg.data.id;
                    textParts.push('[引用]');
                }
                break;
            case 'forward':
                // NapCat uses `id`; go-cqhttp-style implementations may use `resId`.
                if (seg.data.id !== undefined || seg.data.resId !== undefined) {
                    forwardId = seg.data.id ?? seg.data.resId;
                    textParts.push('[合并转发]');
                }
                break;
            case 'json': {
                let cardText = '[卡片]';
                try {
                    let d = seg.data?.data;
                    if (typeof d === 'string') {
                        d = JSON.parse(d);
                    }
                    if (d && typeof d === 'object') {
                        const prompt = d.prompt || '';
                        const meta = d.meta ? Object.values(d.meta)[0] : null;
                        const title = meta?.title || d.title || '';
                        const desc = meta?.desc || meta?.summary || d.desc || '';
                        const url = meta?.qqdocurl || meta?.jumpUrl || meta?.url || d.url || '';
                        const parts = [];
                        if (prompt) parts.push(prompt);
                        if (title && !prompt.includes(title)) parts.push(`标题: ${title}`);
                        if (desc && !prompt.includes(desc)) parts.push(`描述: ${desc}`);
                        if (url) parts.push(`链接: ${url}`);
                        if (parts.length > 0) {
                            cardText = `[卡片: ${parts.join(' | ')}]`;
                        }
                    }
                } catch {}
                textParts.push(cardText);
                break;
            }
            case 'xml': {
                let cardText = '[卡片]';
                try {
                    const xml = String(seg.data?.data || '');
                    const titleMatch = xml.match(/<title>([^<]+)<\/title>/i);
                    const summaryMatch = xml.match(/<summary>([^<]+)<\/summary>/i);
                    const urlMatch = xml.match(/url="([^"]+)"/i) || xml.match(/<url>([^<]+)<\/url>/i);
                    const parts = [];
                    if (titleMatch) parts.push(`标题: ${titleMatch[1]}`);
                    if (summaryMatch) parts.push(`描述: ${summaryMatch[1]}`);
                    if (urlMatch) parts.push(`链接: ${urlMatch[1]}`);
                    if (parts.length > 0) {
                        cardText = `[卡片: ${parts.join(' | ')}]`;
                    }
                } catch {}
                textParts.push(cardText);
                break;
            }
            case 'poke':
                textParts.push('[戳一戳]');
                break;
            case 'contact':
                textParts.push(seg.data.name ? `[联系人:${seg.data.name}]` : '[联系人]');
                break;
            case 'location':
                textParts.push('[位置]');
                break;
            case 'share':
                textParts.push(seg.data.title ? `[分享:${seg.data.title}]` : '[分享]');
                break;
            default:
                // Unknown segment types keep their placeholder role; no crash.
                textParts.push(`[${seg.type}]`);
                break;
        }
    }
    const text = textParts.join('').trim();
    return { text, media, replyId, forwardId };
}
/** Extract the plain text of a quoted (get_msg) message for [引用] expansion. */
export function segmentText(segments, raw) {
    return parseMessage(segments, raw).text;
}
/** Marker regex shared with split.ts (outbound [[qq_forward]]). */
export const FORWARD_BLOCK_RE = /\[\[qq_forward\]\]([\s\S]*?)\[\[\/qq_forward\]\]/g;
