[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$BaseDir = $PSScriptRoot
if (-not $BaseDir) { $BaseDir = "D:\deepseek-harness" }

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "         正在启动大肥鱼 (QQ + 语音 + 大脑)        " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# 1. 检查并启动 NapCat QQ (3001)
$conn3001 = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if (-not $conn3001) {
    $napcatDir = Join-Path $BaseDir "NapCat"
    if (Test-Path $napcatDir) {
        Write-Host "[1/3] 正在启动 NapCat QQ (无弹窗静默模式)..." -ForegroundColor Yellow
        Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "launcher.bat", "-q", "2163178914") -WorkingDirectory $napcatDir -WindowStyle Hidden
        
        # 轮询等待端口 3001 开启，如果需要扫码则自动弹窗
        $waited = 0
        $openedQR = $false
        while ($waited -lt 60) {
            $conn3001 = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
            if ($conn3001) {
                Write-Host "[1/3] NapCat QQ 已就绪并登录 (端口: 3001)。" -ForegroundColor Green
                break
            }
            $qrPath = Join-Path $napcatDir "cache\qrcode.png"
            if (-not $openedQR -and (Test-Path $qrPath)) {
                $qrAge = (Get-Date) - (Get-Item $qrPath).LastWriteTime
                if ($qrAge.TotalSeconds -lt 120) {
                    Write-Host "[1/3] 检测到 QQ 需要扫码，已为你打开浏览器扫码页面..." -ForegroundColor Yellow
                    $loginHtml = Join-Path $BaseDir "qq-login.html"
                    Start-Process $loginHtml
                    $openedQR = $true
                }
            }
            Start-Sleep -Seconds 2
            $waited += 2
        }
    } else {
        Write-Host "[1/3] 未找到 NapCat 目录，请先运行 install.ps1 配置 NapCat！" -ForegroundColor Red
    }
} else {
    Write-Host "[1/3] NapCat QQ 已在运行中 (端口: 3001)。" -ForegroundColor Green
}

# 2. 检查并启动 GPT-SoVITS 语音服务 (9880)
$conn9880 = Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue
if (-not $conn9880) {
    $sovitsCandidates = @(
        $env:GPT_SOVITS_HOME,
        "D:\ollama\GPT-SoVITS-v2pro\GPT-SoVITS-v2pro-20250604",
        "C:\ollama\GPT-SoVITS-v2pro\GPT-SoVITS-v2pro-20250604",
        (Join-Path $BaseDir "GPT-SoVITS"),
        (Join-Path $BaseDir "..\GPT-SoVITS")
    ) | Where-Object { $_ -and (Test-Path $_) }
    
    if ($sovitsCandidates) {
        $sovitsDir = $sovitsCandidates[0]
        $pythonExe = Join-Path $sovitsDir "runtime\python.exe"
        if (Test-Path $pythonExe) {
            Write-Host "[2/3] 正在启动 GPT-SoVITS 语音服务 (无弹窗静默模式)..." -ForegroundColor Yellow
            Start-Process -FilePath $pythonExe -ArgumentList @("api_v2.py", "-a", "127.0.0.1", "-p", "9880", "-c", "GPT_SoVITS/configs/tts_infer.yaml") -WorkingDirectory $sovitsDir -WindowStyle Hidden
            Start-Sleep -Seconds 3
        } else {
            Write-Host "[2/3] 警告: 未在 $sovitsDir 找到 runtime\python.exe，语音服务跳过。" -ForegroundColor Red
        }
    } else {
        Write-Host "[2/3] 提示: 未检测到本地 GPT-SoVITS 目录，若需要语音请参考 README 下载放置。" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[2/3] GPT-SoVITS 语音服务已在运行中 (端口: 9880)。" -ForegroundColor Green
}

# 3. 检查并启动 DeepSeek Harness (3080)
$conn3080 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if (-not $conn3080) {
    $dshBin = Join-Path $BaseDir "node_modules\@deepseek-ai\dsh\lib\bin.js"
    if (Test-Path $dshBin) {
        Write-Host "[3/3] 正在启动大肥鱼大脑 DSH (无弹窗静默模式)..." -ForegroundColor Yellow
        Start-Process -FilePath "node" -ArgumentList @($dshBin, "web", "--no-open") -WorkingDirectory $BaseDir -WindowStyle Hidden
        Start-Sleep -Seconds 2
    } else {
        Write-Host "[3/3] 未找到 DSH 依赖，请在 $BaseDir 执行 npm install！" -ForegroundColor Red
    }
} else {
    Write-Host "[3/3] 大肥鱼大脑 DSH 已在运行中 (端口: 3080)。" -ForegroundColor Green
}

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   大肥鱼启动完成！所有日志弹窗已全部在后台隐藏！ " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Start-Sleep -Seconds 2