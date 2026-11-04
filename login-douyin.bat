@echo off
chcp 65001 >nul
title DaFeiYu Douyin Login
cd /d "D:\deepseek-harness"
set NODE_PATH=D:\deepseek-harness\node_modules
echo ====================================================
echo Starting Chrome for Douyin QR Login...
echo Please scan the QR code with your Douyin APP.
echo ====================================================
node "D:\deepseek-harness\login-douyin.js"
pause
