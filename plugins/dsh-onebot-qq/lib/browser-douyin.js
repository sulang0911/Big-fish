import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'C:\\Users\\25362\\.dsh\\chrome-douyin-profile';

if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true });
}

/**
 * 大肥鱼后台自主刷抖音
 * 像真人一样在后台静默打开抖音、静音播放、随机往下刷 2~4 个短视频，
 * 并抓取一条真正好看/好玩的视频信息（标题、作者、链接、截图帧）。
 */
export async function browseDouyinFeed(options = {}) {
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
                '--mute-audio', // 后台静音，不打扰老大
                '--window-size=1280,800',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
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

            return {
                title: title.replace(/\n+/g, ' ').slice(0, 100),
                author: author || '@抖音网友',
                url: window.location.href
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
