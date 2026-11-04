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

    // 2. 兜底方案：绝不使用第三方搜狗泛化搜索，直接从本地大肥鱼表情包库挑选最匹配的表情包！
    const localFiles = (await fs.promises.readdir(memesDir).catch(() => []))
        .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

    if (localFiles.length > 0) {
        const kw = keyword.toLowerCase();
        const matched = localFiles.filter(f => f.toLowerCase().includes(kw));
        const pickName = matched.length > 0
            ? matched[Math.floor(Math.random() * matched.length)]
            : localFiles[Math.floor(Math.random() * localFiles.length)];
        const pickPath = path.join(memesDir, pickName);
        const buf = await fs.promises.readFile(pickPath);
        return {
            success: true,
            filePath: pickPath,
            filename: pickName,
            url: '',
            base64: buf.toString('base64'),
            pageScreenshotBase64: null,
            source: 'local_library'
        };
    }
    throw new Error(`未在抖音或本地表情包库中找到与 "${keyword}" 相关的表情包`);
}
