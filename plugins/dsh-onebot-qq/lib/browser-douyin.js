import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, readdirSync, promises as fsPromises } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { describeImage, inspectAndVerifyMeme } from './vision.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'C:\\Users\\25362\\.dsh\\chrome-douyin-profile';
const MEMES_DIR = 'D:\\deepseek-harness\\memes';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true });
}
if (!existsSync(MEMES_DIR)) {
    mkdirSync(MEMES_DIR, { recursive: true });
}

// 串行队列锁：防止并发调用时 Chrome 报 "The browser is already running" 冲突
let browserQueue = Promise.resolve();
function runExclusive(fn) {
    const next = browserQueue.then(fn, fn);
    browserQueue = next.catch(() => {});
    return next;
}

export function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const headers = {
            'User-Agent': USER_AGENT,
            'Referer': 'https://www.douyin.com/'
        };
        const req = client.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP status ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', async () => {
                const buf = Buffer.concat(chunks);
                await fsPromises.writeFile(dest, buf);
                resolve(buf);
            });
        });
        req.on('error', reject);
        req.setTimeout(12000, () => {
            req.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

/**
 * 真实模拟真人在抖音搜索框内输入并搜索关键词 (方案 1)
 * 流程：通过真实已登录 Chrome 访问主页建立合法 Session 与 Token ->
 * 聚焦搜索框模拟人工打字输入关键词 -> 按回车搜索 ->
 * 拦截接口返回精准结构化数据并截取完整真实搜索网页截图。
 * 同时自动将抓取到的表情包/视频封面批量保存进本地大肥鱼表情包库。
 */
async function _searchDouyin(keyword, options = {}) {
    let browser = null;
    try {
        console.log(`[dsh-onebot] 大肥鱼在后台为老大真实搜索抖音: "${keyword}"...`);
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: 'new',
            userDataDir: PROFILE_DIR,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                `--user-agent=${USER_AGENT}`,
                '--mute-audio',
                '--window-size=1280,800',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        const searchItems = [];
        page.on('response', async resp => {
            const u = resp.url();
            if (u.includes('search/single') || u.includes('search/item')) {
                try {
                    const json = await resp.json();
                    if (Array.isArray(json.data)) {
                        for (const it of json.data) {
                            const info = it.aweme_info || it;
                            if (info && (info.desc || info.aweme_id)) {
                                const cover = info.video?.cover?.url_list?.[0] || info.video?.origin_cover?.url_list?.[0] || null;
                                searchItems.push({
                                    title: (info.desc || '短视频').replace(/\n+/g, ' ').slice(0, 100),
                                    author: info.author?.nickname ? `@${info.author.nickname}` : '@未知作者',
                                    aweme_id: info.aweme_id,
                                    url: info.aweme_id ? `https://www.douyin.com/video/${info.aweme_id}` : '',
                                    diggCount: info.statistics?.digg_count || 0,
                                    coverUrl: cover
                                });
                            }
                        }
                    }
                } catch {}
            }
        });

        // 1. 访问抖音主页建立合法 Cookie 与 Token 会话
        await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 2800));

        // 2. 找到搜索框
        const input = await page.$('input[data-e2e="searchbar-input"], input[placeholder*="搜索"], input[type="text"]');
        if (!input) {
            throw new Error('未在抖音主页找到搜索框');
        }

        // 3. 点击聚焦搜索框
        await input.click();
        await new Promise(r => setTimeout(r, 400));

        // 4. 模拟真人打字输入关键词
        await page.keyboard.type(keyword, { delay: 90 });
        await new Promise(r => setTimeout(r, 500));

        // 5. 按 Enter 提交搜索
        await page.keyboard.press('Enter');

        // 6. 等待搜索结果渲染与接口返回
        await new Promise(r => setTimeout(r, 5000));

        // 补充：若接口拦截未抓到足够封面，直接从页面 DOM 提取抖音结果图片（含图文表情包与视频封面）
        if (searchItems.length === 0) {
            try {
                const domImgs = await page.$$eval('img', imgs =>
                    imgs
                        .map(img => ({
                            src: img.currentSrc || img.src || '',
                            alt: img.alt || '',
                            w: img.naturalWidth || img.width || 0,
                            h: img.naturalHeight || img.height || 0,
                        }))
                        .filter(it => it.src.startsWith('http') && (it.src.includes('douyinpic') || it.src.includes('byteimg')) && it.w >= 100 && it.h >= 100)
                );
                for (let idx = 0; idx < domImgs.length && idx < 10; idx++) {
                    searchItems.push({
                        title: domImgs[idx].alt || `${keyword}_${idx + 1}`,
                        author: '@抖音表情包',
                        aweme_id: `dom_${Date.now()}_${idx}`,
                        url: 'https://www.douyin.com/',
                        diggCount: 0,
                        coverUrl: domImgs[idx].src,
                    });
                }
            } catch {}
        }

        // 7. 截取真实搜索结果网页截图
        let screenshotBase64 = null;
        try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
            screenshotBase64 = buf.toString('base64');
        } catch (e) {
            console.warn('[dsh-onebot] 搜索结果截图失败:', e.message);
        }

        console.log(`[dsh-onebot] 抖音搜索 "${keyword}" 成功，抓取到 ${searchItems.length} 条真实结果。`);

        // 8. 抖音表情包严格视觉质检与去重保存：
        // 必须同时满足：(a) MD5 未在本地库重复；(b) 包含纯正大肥鱼特征；(c) 视觉识别出的表情/图中文字与目标名称一致。
        // 若不符则立即抛弃删除临时文件，并自动向下滚动页面重新获取新候选图二次质检！
        let savedCount = 0;
        const savedFiles = [];
        if (options.saveMemes !== false && searchItems.length > 0) {
            const otherDir = path.join(MEMES_DIR, 'other_memes');
            if (!existsSync(otherDir)) mkdirSync(otherDir, { recursive: true });

            const emotionTag = String(options.emotionTag || keyword || '')
                .replace(/大肥鱼|肥鱼|表情包/g, '')
                .replace(/[\\/:*?"<>|#@\s]/g, '')
                .trim() || '新心情';

            // 计算当前本地表情包库所有图片的 MD5 集合，严禁同一张图换壳重复保存
            const existingHashes = new Set();
            try {
                const existingImgs = readdirSync(MEMES_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
                for (const ef of existingImgs) {
                    try {
                        const h = crypto.createHash('md5').update(readFileSync(path.join(MEMES_DIR, ef))).digest('hex');
                        existingHashes.add(h);
                    } catch {}
                }
            } catch {}

            const indexPath = path.join(MEMES_DIR, 'index.json');
            let indexData = [];
            if (existsSync(indexPath)) {
                try {
                    indexData = JSON.parse(await fsPromises.readFile(indexPath, 'utf8'));
                    if (!Array.isArray(indexData)) indexData = [];
                } catch {
                    indexData = [];
                }
            }

            const seenUrls = new Set();
            const verifyBatch = async (candidates) => {
                for (let i = 0; i < candidates.length; i++) {
                    const it = candidates[i];
                    if (!it.coverUrl || !it.coverUrl.startsWith('http') || seenUrls.has(it.coverUrl)) continue;
                    seenUrls.add(it.coverUrl);

                    const idPart = it.aweme_id || `${Date.now()}_${i}`;
                    const tempDest = path.join(otherDir, `temp_${idPart}.jpg`);
                    try {
                        const buf = await downloadFile(it.coverUrl, tempDest);
                        const md5 = crypto.createHash('md5').update(buf).digest('hex');
                        if (existingHashes.has(md5)) {
                            await fsPromises.unlink(tempDest).catch(() => {});
                            console.log(`[dsh-onebot][表情包去重] 候选图已在本地库存在 (MD5=${md5.slice(0, 8)})，抛弃跳过`);
                            continue;
                        }

                        // 调用视觉模型识别特征、图中文字与真实情绪，校验是否与 emotionTag 相符
                        const verifyRes = await inspectAndVerifyMeme(tempDest, emotionTag);
                        if (!verifyRes.pass) {
                            await fsPromises.unlink(tempDest).catch(() => {});
                            console.log(`[dsh-onebot][表情包质检未通过] 抛弃候选图 (原因: ${verifyRes.reason})`);
                            continue;
                        }

                        const verifiedTag = verifyRes.trueTag || emotionTag;
                        const realFilename = `dafeiyu_douyin_${emotionTag}_${verifiedTag}_${Date.now()}.jpg`;
                        const realDest = path.join(MEMES_DIR, realFilename);
                        await fsPromises.rename(tempDest, realDest);
                        existingHashes.add(md5);
                        savedCount++;
                        savedFiles.push(realFilename);
                        indexData.push({
                            file: realFilename,
                            newName: realFilename,
                            emotion: [...new Set([emotionTag, ...(verifyRes.inferredTags || [verifiedTag])])].join(' '),
                            desc: verifyRes.desc,
                        });
                        console.log(`[dsh-onebot][表情包质检通过] 成功入库: ${realFilename} (${verifyRes.desc.slice(0, 50)})`);
                        if (savedCount >= 2) break;
                    } catch (e) {
                        await fsPromises.unlink(tempDest).catch(() => {});
                        console.warn(`[dsh-onebot] 下载或质检表情包失败:`, e.message);
                    }
                }
            };

            await verifyBatch(searchItems);

            // 若首批候选全部因“不含大肥鱼特征”或“画面/文字与名称不符”被抛弃，自动下拉滚动页面加载新图重新获取！
            if (savedCount === 0) {
                console.log(`[dsh-onebot] 首批候选表情包均不符合「${emotionTag}」，正在向下滚动页面重新获取新一批候选图...`);
                try {
                    await page.evaluate(() => window.scrollBy(0, 1800));
                    await new Promise(r => setTimeout(r, 3200));
                    const moreDomImgs = await page.$$eval('img', imgs =>
                        imgs
                            .map(img => ({
                                src: img.currentSrc || img.src || '',
                                alt: img.alt || '',
                                w: img.naturalWidth || img.width || 0,
                                h: img.naturalHeight || img.height || 0,
                            }))
                            .filter(it => it.src.startsWith('http') && (it.src.includes('douyinpic') || it.src.includes('byteimg')) && it.w >= 100 && it.h >= 100)
                    );
                    const retryItems = moreDomImgs.slice(0, 12).map((img, idx) => ({
                        title: img.alt || `${emotionTag}_retry_${idx + 1}`,
                        author: '@抖音表情包',
                        aweme_id: `retry_${Date.now()}_${idx}`,
                        url: 'https://www.douyin.com/',
                        diggCount: 0,
                        coverUrl: img.src,
                    }));
                    await verifyBatch(retryItems);
                } catch (retryErr) {
                    console.warn('[dsh-onebot] 重新滚动获取候选表情包失败:', retryErr.message);
                }
            }

            if (savedCount > 0) {
                try {
                    await fsPromises.writeFile(indexPath, JSON.stringify(indexData, null, 2), 'utf8');
                } catch (idxErr) {
                    console.warn('[dsh-onebot] 更新 memes/index.json 失败:', idxErr.message);
                }
                console.log(`[dsh-onebot] 已从抖音爬取并通过视觉质检 ${savedCount} 张「${emotionTag}」表情包入库: ${MEMES_DIR}`);
            }
        }

        return {
            success: true,
            keyword,
            items: searchItems.slice(0, 8),
            savedCount,
            savedFiles,
            pageScreenshotBase64: screenshotBase64
        };
    } catch (err) {
        console.warn(`[dsh-onebot] 抖音搜索异常:`, err.message);
        return {
            success: false,
            keyword,
            error: err.message,
            items: [],
            savedCount: 0,
            savedFiles: [],
            pageScreenshotBase64: null
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch {}
        }
    }
}

export function searchDouyin(keyword, options = {}) {
    return runExclusive(() => _searchDouyin(keyword, options));
}

/**
 * 大肥鱼后台自主刷抖音
 * 像真人一样在后台静默打开抖音、静音播放、随机往下刷 2~4 个短视频，
 * 并抓取一条真正好看/好玩的视频信息（标题、作者、链接、截图帧）。
 */
async function _browseDouyinFeed(options = {}) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: 'new',
            userDataDir: PROFILE_DIR,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                `--user-agent=${USER_AGENT}`,
                '--mute-audio', // 后台静音，不打扰老大
                '--window-size=1280,800',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // 访问抖音主页或精选
        await page.goto('https://www.douyin.com/', { 
            waitUntil: 'domcontentloaded', 
            timeout: 20000 
        });

        // 等待页面与首个视频加载
        await new Promise(r => setTimeout(r, 3500));

        // 随机下划翻看 2~4 个视频，模拟真人驻足观看
        const scrollCount = 2 + Math.floor(Math.random() * 3);
        console.log(`[dsh-onebot] 大肥鱼开始在后台摸鱼刷抖音（翻看 ${scrollCount} 个视频）...`);

        for (let i = 0; i < scrollCount; i++) {
            // 每条视频看 3~6 秒
            const watchMs = 3000 + Math.floor(Math.random() * 3000);
            await new Promise(r => setTimeout(r, watchMs));
            
            // 按下方向键切换下一个视频
            await page.keyboard.press('ArrowDown');
        }

        // 等待当前视频信息稳定
        await new Promise(r => setTimeout(r, 2500));

        // 提取当前正在播放的视频信息
        const videoData = await page.evaluate(() => {
            let title = '';
            let author = '';

            // 1. 尝试从常见视频信息容器获取
            const detailEl = document.querySelector('[data-e2e="video-detail"], .video-info-detail, .accountContainer, [data-e2e="feed-active-video"]');
            
            // 抓取标题与标签
            const titleEls = Array.from(document.querySelectorAll('h1, [data-e2e="video-title"], .title, span.title, .video-desc'));
            for (const el of titleEls) {
                const t = (el.innerText || '').trim();
                if (t.length > 3 && t.length < 150 && !t.includes('登录') && !t.includes('服务出现异常')) {
                    title = t;
                    break;
                }
            }

            // 抓取作者
            const authorEls = Array.from(document.querySelectorAll('[data-e2e="feed-author"], .author-name, a[href*="/user/"]'));
            for (const el of authorEls) {
                const a = (el.innerText || '').trim();
                if (a.length > 1 && a.length < 30 && (a.startsWith('@') || el.getAttribute('href')?.includes('/user/'))) {
                    author = a.startsWith('@') ? a : ('@' + a);
                    break;
                }
            }

            // 兜底提取文案中的 #话题 或有意义文案
            if (!title) {
                const allSpans = Array.from(document.querySelectorAll('span, p, a'));
                for (const el of allSpans) {
                    const txt = (el.innerText || '').trim();
                    if (txt.includes('#') && txt.length > 5 && txt.length < 100) {
                        title = txt;
                        break;
                    }
                }
            }

            // 尝试提取具体短视频链接
            let videoUrl = window.location.href;
            const videoLinkEl = document.querySelector('a[href*="/video/"]');
            if (videoLinkEl && videoLinkEl.href) {
                videoUrl = videoLinkEl.href;
            }

            return {
                title: title.replace(/\n+/g, ' ').slice(0, 100),
                author: author || '@抖音网友',
                url: videoUrl
            };
        });

        // 截取当前视频画面的帧（转成 base64 准备作为表情/画面发给老大）
        let screenshotBase64 = null;
        try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 75 });
            screenshotBase64 = buf.toString('base64');
        } catch {}

        console.log(`[dsh-onebot] 大肥鱼刷到了短视频: ${videoData.title || '(无标题)'} (${videoData.author})`);

        return {
            title: videoData.title,
            author: videoData.author,
            url: videoData.url,
            screenshotBase64
        };
    } catch (err) {
        console.warn('[dsh-onebot] 刷视频流程异常:', err.message);
        return null;
    } finally {
        if (browser) {
            try { await browser.close(); } catch {}
        }
    }
}

export function browseDouyinFeed(options = {}) {
    return runExclusive(() => _browseDouyinFeed(options));
}

/**
 * 大肥鱼最喜欢自己逛的摸鱼网站池
 */
export const FAVORITE_SITES = [
    { id: 'bilibili', aliases: ['b站', 'bilibili', '哔哩哔哩', '番剧'], name: '哔哩哔哩 (B站)', url: 'https://www.bilibili.com/', category: '美食区/沙雕视频/番剧' },
    { id: 'xiaohongshu', aliases: ['小红书', 'xhs', 'rednote'], name: '小红书', url: 'https://www.xiaohongshu.com/explore', category: '神仙吃法/甜品探店/萌宠' },
    { id: 'xiachufang', aliases: ['下厨房', '菜谱', '做饭', '五花肉'], name: '下厨房美食网', url: 'https://www.xiachufang.com/', category: '脆皮五花肉与红烧肉绝密食谱' },
    { id: 'weibo', aliases: ['微博', '热搜', '吃瓜'], name: '微博热搜榜', url: 'https://s.weibo.com/top/summary', category: '今日摸鱼吃瓜热榜' },
    { id: 'douyin', aliases: ['抖音', '短视频'], name: '抖音精选', url: 'https://www.douyin.com/', category: '搞笑短视频/大肥鱼热梗' },
    { id: 'zhihu', aliases: ['知乎', 'zhihu'], name: '知乎热榜', url: 'https://www.zhihu.com/billboard', category: '脑洞故事与摸鱼问答' },
];

export function pickFavoriteSite(siteHint = '') {
    const clean = String(siteHint || '').trim().toLowerCase();
    if (/^https?:\/\//i.test(clean)) {
        return { id: 'custom', name: clean, url: String(siteHint).trim(), category: '自选网站' };
    }
    if (clean) {
        for (const site of FAVORITE_SITES) {
            if (site.id === clean || site.name.toLowerCase().includes(clean) || site.aliases.some(a => clean.includes(a))) {
                return site;
            }
        }
    }
    return FAVORITE_SITES[Math.floor(Math.random() * FAVORITE_SITES.length)];
}

/**
 * 大肥鱼自主打开浏览器逛喜欢的网站：
 * - 若检测到目标网站弹出登录框 / 二维码 / 强制跳转到登录页（needsLogin=true），
 *   自动截取登录二维码/窗口画面发给老大，并在桌面弹出可见 Chrome 窗口请老大帮忙登录；
 * - 若无需登录或已登录，模拟真人滚动浏览，提取感兴趣的标题并截图记录到小本本。
 */
async function _browseFavoriteSite(options = {}) {
    const site = pickFavoriteSite(options.siteHint);
    let browser = null;
    let needsLogin = false;
    try {
        console.log(`[dsh-onebot] 大肥鱼正在打开浏览器自主闲逛: ${site.name} (${site.url})...`);
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: options.visible ? false : 'new',
            userDataDir: PROFILE_DIR,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                `--user-agent=${USER_AGENT}`,
                '--mute-audio',
                '--window-size=1280,820',
                '--disable-gpu',
            ],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 820 });
        await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 22_000 });
        await new Promise(r => setTimeout(r, 3200));

        // 1. 检测是否被登录墙 / 扫码登录弹窗拦截
        const loginCheck = await page.evaluate(() => {
            const href = window.location.href.toLowerCase();
            const isLoginUrl = /(?:\/login|passport\.|signin|auth|accounts\.|\.com\/account)/i.test(href);

            // 检查显著的居中登录弹窗或遮罩
            const modalSelectors = [
                '.login-modal', '.login-container', '.reds-modal', '.bili-mini-mask',
                '[class*="login-modal"]', '[class*="loginModal"]', '[class*="LoginModal"]',
                '[id*="login-modal"]', '.signFlowModal', '.Modal-wrapper',
            ];
            let hasLoginModal = false;
            let modalHint = '';
            for (const sel of modalSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    if (rect.width > 180 && rect.height > 180 && style.display !== 'none' && style.visibility !== 'hidden') {
                        const txt = (el.innerText || '').trim();
                        if (/(扫码登录|请先登录|登录后|立即登录|验证码登录|密码登录|手机号登录|微信登录)/i.test(txt)) {
                            hasLoginModal = true;
                            modalHint = txt.replace(/\s+/g, ' ').slice(0, 60);
                            break;
                        }
                    }
                }
            }

            // 检查整页正文中是否几乎只有登录提示而没有实质内容列表
            const bodyText = (document.body?.innerText || '').trim();
            const bareLoginWall = bodyText.length < 600 && /(扫码登录|请登录|登录后查看|立即登录)/i.test(bodyText);

            return {
                needsLogin: Boolean(isLoginUrl || hasLoginModal || bareLoginWall),
                reason: isLoginUrl ? '网页跳转到了登录页' : (hasLoginModal ? `弹出登录框 (${modalHint})` : (bareLoginWall ? '页面要求登录后浏览' : '')),
                currentUrl: window.location.href,
            };
        });

        needsLogin = loginCheck.needsLogin;

        if (!needsLogin) {
            // 模拟大肥鱼开心往下滚屏浏览 2 次
            for (let i = 0; i < 2; i++) {
                await page.evaluate(() => window.scrollBy({ top: 420, behavior: 'smooth' }));
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        // 2. 提取页面上看到的有趣标题 / 美食 / 话题，并挑选一条最感兴趣的点进去沉浸式吃瓜
        const pageExtract = await page.evaluate(() => {
            const selectors = [
                '.bili-video-card__info--tit',
                '.title',
                'h1', 'h2', 'h3',
                '.name',
                'td.td-02 a',
                '.HotItem-title',
                'a[title]',
            ];
            const seen = new Set();
            const list = [];
            const links = [];
            for (const sel of selectors) {
                for (const el of document.querySelectorAll(sel)) {
                    const raw = (el.getAttribute('title') || el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (
                        raw.length >= 5 &&
                        raw.length <= 65 &&
                        !/(登录|注册|客服|隐私政策|备案|举报|客户端|下载|顶部|刷新)/i.test(raw) &&
                        !seen.has(raw)
                    ) {
                        seen.add(raw);
                        list.push(raw);
                        const anchor = el.tagName === 'A' ? el : el.closest('a');
                        const href = anchor?.href || '';
                        if (href.startsWith('http') && !/(login|passport|signin|javascript:)/i.test(href)) {
                            links.push({ title: raw, url: href });
                        }
                        if (list.length >= 6) break;
                    }
                }
                if (list.length >= 6) break;
            }
            return { headlines: list, links };
        });
        const headlines = pageExtract.headlines || [];
        let deepSnippet = '';
        let visitedTitle = headlines[0] || '';

        // 2.5 若无需登录且找到了具体帖子/视频链接，随机挑前 3 条中的 1 条点进去沉浸式浏览详情
        if (!needsLogin && Array.isArray(pageExtract.links) && pageExtract.links.length > 0) {
            const topCandidates = pageExtract.links.slice(0, 3);
            const picked = topCandidates[Math.floor(Math.random() * topCandidates.length)];
            if (picked?.url) {
                try {
                    visitedTitle = picked.title;
                    await page.goto(picked.url, { waitUntil: 'domcontentloaded', timeout: 10_000 });
                    await new Promise(r => setTimeout(r, 2000));
                    deepSnippet = await page.evaluate(() => {
                        const descSelectors = [
                            '.desc-info-text', '.video-desc', '.RichContent-inner',
                            'article', '.content', '.recipe-desc', 'meta[name="description"]',
                            'p',
                        ];
                        for (const sel of descSelectors) {
                            const el = document.querySelector(sel);
                            if (!el) continue;
                            const txt = (el.getAttribute?.('content') || el.innerText || '').replace(/\s+/g, ' ').trim();
                            if (txt.length >= 15 && !/(扫码登录|请先登录|隐私政策|ICP备)/i.test(txt)) {
                                return txt.slice(0, 140);
                            }
                        }
                        return '';
                    });
                } catch {}
            }
        }

        // 3. 截取网页画面（如果是登录拦截，截图里刚好包含二维码/登录框）
        let screenshotBase64 = null;
        try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
            screenshotBase64 = buf.toString('base64');
        } catch {}

        return {
            success: true,
            siteId: site.id,
            siteName: site.name,
            url: loginCheck.currentUrl || site.url,
            category: site.category,
            needsLogin,
            loginReason: loginCheck.reason,
            headlines,
            visitedTitle,
            deepSnippet,
            screenshotBase64,
        };
    } catch (err) {
        console.warn(`[dsh-onebot] 大肥鱼逛网站 (${site.name}) 异常:`, err.message);
        return {
            success: false,
            siteId: site.id,
            siteName: site.name,
            url: site.url,
            category: site.category,
            needsLogin: false,
            error: err.message,
            headlines: [],
            screenshotBase64: null,
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch {}
        }
        // 若检测到需要登录，且允许在桌面弹出真实浏览器窗口供老大扫码/输入账号，释放锁后拉起可见 Chrome
        if (needsLogin && options.openDesktopOnLogin !== false && existsSync(CHROME_PATH)) {
            try {
                const child = spawn(CHROME_PATH, [
                    `--user-data-dir=${PROFILE_DIR}`,
                    '--new-window',
                    site.url,
                ], { detached: true, stdio: 'ignore' });
                child.unref();
                console.log(`[dsh-onebot] 已在桌面为老大打开可见 Chrome 登录窗口: ${site.url}`);
            } catch (e) {
                console.warn('[dsh-onebot] 拉起桌面登录窗口失败:', e.message);
            }
        }
    }
}

export function browseFavoriteSite(options = {}) {
    return runExclusive(() => _browseFavoriteSite(options));
}
