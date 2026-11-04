@echo off
chcp 65001 >nul
title 大肥鱼抖音登录助手
cd /d "D:\deepseek-harness"
echo ====================================================
echo 正在为大肥鱼启动 Chrome 窗口...
echo 请在弹出的浏览器中，使用手机【抖音 APP 扫一扫】完成登录。
echo 登录完成后，登录态将永久保存在大肥鱼专属目录中！
echo ====================================================
node login-douyin.js
pause
