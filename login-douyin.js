const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const profileDir = 'C:\\Users\\25362\\.dsh\\chrome-douyin-profile';
if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

console.log('====================================================');
console.log('正在为大肥鱼启动抖音登录窗口...');
console.log('请在弹出的 Chrome 窗口中，使用【抖音 APP 扫一扫】完成登录。');
console.log('登录成功后，此窗口会自动保存登录态并关闭。');
console.log('====================================================');

(async () => {
    try {
        const browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: false,
            userDataDir: profileDir,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--start-maximized'
            ]
        });

        const pages = await browser.pages();
        const page = pages[0] || (await browser.newPage());

        await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });

        let loggedIn = false;
        const checkInterval = setInterval(async () => {
            try {
                if (browser.process()?.killed) {
                    clearInterval(checkInterval);
                    return;
                }

                const isLogin = await page.evaluate(() => {
                    const cookies = document.cookie || '';
                    if (cookies.includes('LOGIN_STATUS=1') || cookies.includes('passport_auth_status=1') || cookies.includes('sessionid=')) {
                        return true;
                    }
                    const avatar = document.querySelector('header img, [data-e2e="user-info"], .avatar, .header-avatar');
                    const loginBtn = document.querySelector('button:has-text("登录"), .header-login-btn');
                    if (avatar && !loginBtn) return true;
                    return false;
                });

                if (isLogin) {
                    loggedIn = true;
                    clearInterval(checkInterval);
                    console.log('====================================================');
                    console.log('🎉 检测到抖音登录成功！登录态已成功保存至专属目录。');
                    console.log('大肥鱼已获得自主刷视频权限！窗口将在 3 秒后自动关闭...');
                    console.log('====================================================');
                    setTimeout(async () => {
                        try { await browser.close(); } catch {}
                        process.exit(0);
                    }, 3000);
                }
            } catch {
                // 页面跳转时忽略错误
            }
        }, 2000);

        browser.on('disconnected', () => {
            clearInterval(checkInterval);
            if (!loggedIn) {
                console.log('浏览器窗口已关闭。如果已扫码成功，登录态也会自动保留。');
            }
            process.exit(0);
        });
    } catch (err) {
        console.error('启动失败:', err);
    }
})();
