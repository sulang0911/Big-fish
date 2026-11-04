import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { searchDouyin } from './browser-douyin.js';

export function getBrowserPath() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('未检测到本地 Chrome 或 Edge 浏览器！');
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
                await fs.promises.writeFile(dest, buf);
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

export async function searchDouyinMeme(keyword = '傲娇') {
    const memesDir = 'D:\\deepseek-harness\\memes';
    await fs.promises.mkdir(memesDir, { recursive: true });

    // 1. 优先调用真实抖音搜索 (方案 1)
    try {
        const searchKw = keyword.includes('表情包') ? keyword : `${keyword} 表情包`;
        const dyRes = await searchDouyin(searchKw);
        if (dyRes.success && Array.isArray(dyRes.items) && dyRes.items.length > 0) {
            const validCovers = dyRes.items.filter(it => it.coverUrl && it.coverUrl.startsWith('http'));
            if (validCovers.length > 0) {
                const picked = validCovers[Math.floor(Math.random() * Math.min(validCovers.length, 4))];
                const safeKw = keyword.replace(/[\\/:*?"<>|]/g, '_');
                const filename = `douyin_${safeKw}_${Date.now()}.jpg`;
                const savePath = path.join(memesDir, filename);

                const buf = await downloadFile(picked.coverUrl, savePath);
                return {
                    success: true,
                    filePath: savePath,
                    filename,
                    url: picked.coverUrl,
                    base64: buf.toString('base64'),
                    pageScreenshotBase64: dyRes.pageScreenshotBase64,
                    source: 'douyin_real',
                    videoTitle: picked.title,
                    videoAuthor: picked.author,
                    videoUrl: picked.url
                };
            }
        }
    } catch (dyErr) {
        console.warn('[dsh-onebot] 真实抖音表情包搜索异常，启动兜底引擎:', dyErr.message);
    }

    // 2. 兜底方案：使用聚合无头搜索
    const exePath = getBrowserPath();
    const browser = await puppeteer.launch({
        executablePath: exePath,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const query = `抖音 ${keyword} 表情包`;
        const searchUrl = 'https://pic.sogou.com/pics?query=' + encodeURIComponent(query);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));

        const imgUrls = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('img'));
            return imgs.map(i => i.src)
                .filter(s => s && s.startsWith('http') && !s.includes('logo') && !s.includes('icon') && !s.includes('query=') && !s.includes('header'));
        });

        if (imgUrls.length === 0) {
            throw new Error(`未找到关键词 "${keyword}" 的抖音表情包`);
        }

        // 随机挑选前 15 个中的一个，增加多样性
        const pickPool = imgUrls.slice(0, 15);
        const selectedUrl = pickPool[Math.floor(Math.random() * pickPool.length)];

        // 确定扩展名（默认 .jpg，检测是否包含 gif）
        const ext = selectedUrl.toLowerCase().includes('.gif') ? 'gif' : 'jpg';
        const safeKw = keyword.replace(/[\\/:*?"<>|]/g, '_');
        const filename = `douyin_${safeKw}_${Date.now()}.${ext}`;
        const savePath = path.join(memesDir, filename);

        let pageScreenshotBase64 = null;
        try {
            const pageBuf = await page.screenshot({ type: 'jpeg', quality: 75 });
            pageScreenshotBase64 = pageBuf.toString('base64');
        } catch {}

        const buf = await downloadFile(selectedUrl, savePath);
        return {
            success: true,
            filePath: savePath,
            filename,
            url: selectedUrl,
            base64: buf.toString('base64'),
            pageScreenshotBase64
        };
    } finally {
        await browser.close().catch(() => {});
    }
}
