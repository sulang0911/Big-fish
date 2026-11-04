[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$BaseDir = $PSScriptRoot
if (-not $BaseDir) { $BaseDir = "D:\deepseek-harness" }

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "        大肥鱼 (Big-Fish) 一键环境安装与部署       " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# 1. 检查 Node.js 环境
Write-Host "`n[1/5] 检查 Node.js 环境..." -ForegroundColor Yellow
try {
    $nodeVer = node -v
    Write-Host "  ✓ 检测到 Node.js 版本: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "  ✗ 未检测到 Node.js，请先前往 https://nodejs.org/ 下载安装 Node.js (LTS 版本)！" -ForegroundColor Red
    pause
    exit 1
}

# 2. 安装项目依赖
Write-Host "`n[2/5] 正在安装 DSH 核心依赖..." -ForegroundColor Yellow
cd $BaseDir
npm install --no-audit --no-fund
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ 核心依赖安装成功。" -ForegroundColor Green
} else {
    Write-Host "  ✗ npm install 失败，请检查网络或代理设置！" -ForegroundColor Red
}

# 3. 部署 DSH 配置、插件与傲娇人设
Write-Host "`n[3/5] 正在同步大肥鱼配置与专属音色插件..." -ForegroundColor Yellow
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$webProfileDir = Join-Path $dshHome "profiles\web"
$webModulesDir = Join-Path $webProfileDir "node_modules"
$personaStorageDir = Join-Path $dshHome "storages\dsh-persona-dafeiyu"

# 确保目录结构存在
New-Item -Path $webModulesDir -ItemType Directory -Force | Out-Null
New-Item -Path $personaStorageDir -ItemType Directory -Force | Out-Null

# 同步插件与配置
$pluginSrc = Join-Path $BaseDir "plugins\dsh-onebot-qq"
$pluginDst = Join-Path $webModulesDir "dsh-onebot-qq"
if (Test-Path $pluginSrc) {
    Copy-Item -Path $pluginSrc -Destination $webModulesDir -Recurse -Force
    Write-Host "  ✓ 已挂载 dsh-onebot-qq 语音强化插件。" -ForegroundColor Green
}

$personaSrc = Join-Path $BaseDir "persona\personas.json"
if (Test-Path $personaSrc) {
    Copy-Item -Path $personaSrc -Destination (Join-Path $personaStorageDir "personas.json") -Force
    Write-Host "  ✓ 已同步「傲娇跟屁虫」人设文件。" -ForegroundColor Green
}

$patchSrc = Join-Path $BaseDir "config\cordis.patch.yml"
if (Test-Path $patchSrc) {
    Copy-Item -Path $patchSrc -Destination (Join-Path $webProfileDir "cordis.patch.yml") -Force
    Write-Host "  ✓ 已应用 cordis.patch.yml 桥接配置。" -ForegroundColor Green
}

# 4. 检查 NapCat 与 GPT-SoVITS
Write-Host "`n[4/5] 检查 QQ 框架与语音模型..." -ForegroundColor Yellow
$napcatDir = Join-Path $BaseDir "NapCat"
if (Test-Path $napcatDir) {
    Write-Host "  ✓ 检测到 NapCat 目录就绪。" -ForegroundColor Green
} else {
    Write-Host "  ! 提示: 未检测到 NapCat 目录，请从 NapCatQQ 官方下载放入: $napcatDir" -ForegroundColor DarkYellow
}

$sovitsCandidates = @(
    "D:\ollama\GPT-SoVITS-v2pro\GPT-SoVITS-v2pro-20250604",
    "C:\ollama\GPT-SoVITS-v2pro\GPT-SoVITS-v2pro-20250604",
    (Join-Path $BaseDir "GPT-SoVITS")
) | Where-Object { Test-Path $_ }
if ($sovitsCandidates) {
    Write-Host "  ✓ 检测到 GPT-SoVITS 语音服务目录: $($sovitsCandidates[0])" -ForegroundColor Green
} else {
    Write-Host "  ! 提示: 未检测到 GPT-SoVITS 语音模型目录。如需语音功能，请下载整合包并放置在 D:\ollama 或项目根目录。" -ForegroundColor DarkYellow
}

# 5. 创建桌面快捷方式
Write-Host "`n[5/5] 创建桌面快捷方式..." -ForegroundColor Yellow
$desktop = [System.Environment]::GetFolderPath('Desktop')
$wsh = New-Object -ComObject WScript.Shell

$s1 = $wsh.CreateShortcut((Join-Path $desktop "启动大肥鱼.lnk"))
$s1.TargetPath = Join-Path $BaseDir "启动大肥鱼.bat"
$s1.WorkingDirectory = $BaseDir
$s1.Description = "一键启动大肥鱼 (QQ机器人 + 语音大模型 + DeepSeek大脑)"
$s1.Save()

$s2 = $wsh.CreateShortcut((Join-Path $desktop "停止大肥鱼.lnk"))
$s2.TargetPath = Join-Path $BaseDir "停止大肥鱼.bat"
$s2.WorkingDirectory = $BaseDir
$s2.Description = "一键停止大肥鱼并释放显存与后台进程"
$s2.Save()

$s3 = $wsh.CreateShortcut((Join-Path $desktop "扫码登录大肥鱼QQ.lnk"))
$s3.TargetPath = Join-Path $BaseDir "qq-login.html"
$s3.WorkingDirectory = $BaseDir
$s3.Description = "查看大肥鱼 QQ 小号登录二维码"
$s3.Save()

Write-Host "  ✓ 已在桌面创建「启动大肥鱼」「停止大肥鱼」「扫码登录大肥鱼QQ」快捷方式！" -ForegroundColor Green

Write-Host "`n===================================================" -ForegroundColor Cyan
Write-Host "          大肥鱼所有环境已安装配置完成！          " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Start-Sleep -Seconds 3