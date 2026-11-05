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

    const localFiles = (await fs.promises.readdir(memesDir).catch(() => []))
        .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

    const kw = (keyword || '').toLowerCase().trim();
    const isGeneral = !kw || ['大肥鱼', '肥鱼', '开心飞鱼', '飞鱼', '表情包'].includes(kw);

    // 1. 优先从本地已质检的正版大肥鱼表情包库中匹配
    if (localFiles.length > 0) {
        if (isGeneral) {
            const pickName = localFiles[Math.floor(Math.random() * localFiles.length)];
            const pickPath = path.join(memesDir, pickName);
            const buf = await fs.promises.readFile(pickPath);
            return {
                success: true,
                filePath: pickPath,
                filename: pickName,
                url: '',
                base64: buf.toString('base64'),
                pageScreenshotBase64: null,
                source: 'local_verified'
            };
        }
        const matched = localFiles.filter(f => f.toLowerCase().includes(kw));
        if (matched.length > 0) {
            const pickName = matched[Math.floor(Math.random() * matched.length)];
            const pickPath = path.join(memesDir, pickName);
            const buf = await fs.promises.readFile(pickPath);
            return {
                success: true,
                filePath: pickPath,
                filename: pickName,
                url: '',
                base64: buf.toString('base64'),
                pageScreenshotBase64: null,
                source: 'local_verified'
            };
        }
    }

    // 2. 本地未命中特定情绪时，前往真实抖音搜索并经 minicpm-v 视觉质检
    try {
        const searchKw = keyword.includes('大肥鱼') ? keyword : `大肥鱼 ${keyword} 表情包`;
        const dyRes = await searchDouyin(searchKw, { saveMemes: true });
        if (dyRes.success && dyRes.savedFiles && dyRes.savedFiles.length > 0) {
            const sampleName = dyRes.savedFiles[0];
            const samplePath = path.join(memesDir, sampleName);
            if (fs.existsSync(samplePath)) {
                const buf = await fs.promises.readFile(samplePath);
                return {
                    success: true,
                    filePath: samplePath,
                    filename: sampleName,
                    url: '',
                    base64: buf.toString('base64'),
                    pageScreenshotBase64: dyRes.pageScreenshotBase64,
                    source: 'douyin_real_verified'
                };
            }
        }
    } catch (dyErr) {
        console.warn('[dsh-onebot] 真实抖音表情包搜索异常，启动正版兜底:', dyErr.message);
    }

    // 3. 兜底方案：从本地正版大肥鱼表情包库随机选一张，绝不乱发
    if (localFiles.length > 0) {
        const pickName = localFiles[Math.floor(Math.random() * localFiles.length)];
        const pickPath = path.join(memesDir, pickName);
        const buf = await fs.promises.readFile(pickPath);
        return {
            success: true,
            filePath: pickPath,
            filename: pickName,
            url: '',
            base64: buf.toString('base64'),
            pageScreenshotBase64: null,
            source: 'local_verified_fallback'
        };
    }
    throw new Error(`未在抖音或本地表情包库中找到与 "${keyword}" 相关的表情包`);
}
