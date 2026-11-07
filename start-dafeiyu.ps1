[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$BaseDir = $PSScriptRoot
if (-not $BaseDir) { $BaseDir = "D:\deepseek-harness" }

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   正在启动大肥鱼 (QQ + 语音 + 视觉 + 大脑 + 守护)  " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# 1. 检查并启动 NapCat QQ (3001)
$conn3001 = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if (-not $conn3001) {
    $napcatDir = Join-Path $BaseDir "napcat"
    if (-not (Test-Path $napcatDir)) {
        $napcatDir = Join-Path $BaseDir "NapCat"
    }
    if (Test-Path $napcatDir) {
        Write-Host "[1/5] 正在启动 NapCat QQ (无弹窗静默模式)..." -ForegroundColor Yellow
        Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "launcher.bat", "-q", "2163178914") -WorkingDirectory $napcatDir -WindowStyle Hidden
        
        $waited = 0
        $openedQR = $false
        while ($waited -lt 60) {
            $conn3001 = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
            if ($conn3001) {
                Write-Host "[1/5] NapCat QQ 已就绪并登录 (端口: 3001)。" -ForegroundColor Green
                break
            }
            $qrPath = Join-Path $napcatDir "cache\qrcode.png"
            if (-not $openedQR -and (Test-Path $qrPath)) {
                $qrAge = (Get-Date) - (Get-Item $qrPath).LastWriteTime
                if ($qrAge.TotalSeconds -lt 120) {
                    Write-Host "[1/5] 检测到 QQ 需要扫码，已为你打开浏览器扫码页面..." -ForegroundColor Yellow
                    $loginHtml = Join-Path $BaseDir "qq-login.html"
                    Start-Process $loginHtml
                    $openedQR = $true
                }
            }
            Start-Sleep -Seconds 2
            $waited += 2
        }
    } else {
        Write-Host "[1/5] 未找到 NapCat 目录，请先配置 NapCat！" -ForegroundColor Red
    }
} else {
    Write-Host "[1/5] NapCat QQ 已在运行中 (端口: 3001)。" -ForegroundColor Green
}

# 2. 检查并启动 IndexTTS-2.5 语音服务 (9880)
$conn9880 = Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue
if (-not $conn9880) {
    $indexTtsDir = "D:\IndexTTS-2.5"
    $indexTtsPython = Join-Path $indexTtsDir ".venv\Scripts\python.exe"
    $indexTtsServer = Join-Path $indexTtsDir "api_server.py"
    if ((Test-Path $indexTtsPython) -and (Test-Path $indexTtsServer)) {
        Write-Host "[2/5] 正在启动 IndexTTS-2.5 语音服务 (无弹窗静默模式)..." -ForegroundColor Yellow
        Start-Process -FilePath $indexTtsPython -ArgumentList @($indexTtsServer) -WorkingDirectory $indexTtsDir -WindowStyle Hidden
        Start-Sleep -Seconds 3
        Write-Host "[2/5] IndexTTS-2.5 语音服务已启动 (端口: 9880)。" -ForegroundColor Green
    } else {
        Write-Host "[2/5] 提示: 未检测到本地 IndexTTS-2.5 目录，语音服务跳过。" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[2/5] IndexTTS-2.5 语音服务已在运行中 (端口: 9880)。" -ForegroundColor Green
}

# 3. 检查并启动 Ollama 本地视觉服务 (11434)
$conn11434 = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
if (-not $conn11434) {
    $ollamaExe = (Get-Command "ollama.exe" -ErrorAction SilentlyContinue).Source
    if (-not $ollamaExe) {
        $ollamaExe = "C:\Users\25362\AppData\Local\Programs\Ollama\ollama.exe"
    }
    if (Test-Path $ollamaExe) {
        Write-Host "[3/5] 正在启动 Ollama 本地视觉服务 (端口: 11434)..." -ForegroundColor Yellow
        Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden
        
        $waited = 0
        while ($waited -lt 15) {
            $conn11434 = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
            if ($conn11434) {
                Write-Host "[3/5] Ollama 本地视觉服务已就绪 (端口: 11434)。" -ForegroundColor Green
                break
            }
            Start-Sleep -Seconds 1
            $waited += 1
        }
    }
} else {
    Write-Host "[3/5] Ollama 本地视觉服务已在运行中 (端口: 11434)。" -ForegroundColor Green
}

# 4. 检查并启动 DeepSeek Harness (3080)
$srcPluginLib = Join-Path $BaseDir "plugins\dsh-onebot-qq\lib"
$dstPluginLib = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\dsh-onebot-qq\lib"
if ((Test-Path $srcPluginLib) -and (Test-Path $dstPluginLib)) {
    Copy-Item -Path (Join-Path $srcPluginLib "*") -Destination $dstPluginLib -Recurse -Force -ErrorAction SilentlyContinue
}
$conn3080 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if (-not $conn3080) {
    # 清理上次强制停止可能残留的 credentials 文件锁，防止启动 30 秒后因锁超时自动掉线退出
    $dshHomeDir = Join-Path $env:USERPROFILE ".dsh"
    if (Test-Path $dshHomeDir) {
        Get-ChildItem -Path $dshHomeDir -Filter ".credentials.yaml.lock*" -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }
    $dshBin = Join-Path $BaseDir "node_modules\@deepseek-ai\dsh\lib\bin.js"
    if (Test-Path $dshBin) {
        $nodeExe = (Get-Command "node.exe" -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) { $nodeExe = "C:\Program Files\nodejs\node.exe" }
        Write-Host "[4/5] 正在启动大肥鱼大脑 DSH (无弹窗静默模式)..." -ForegroundColor Yellow
        Start-Process -FilePath $nodeExe -ArgumentList @($dshBin, "web", "--no-open") -WorkingDirectory $BaseDir -WindowStyle Hidden
        
        $waited = 0
        while ($waited -lt 20) {
            $conn3080 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
            if ($conn3080) {
                Write-Host "[4/5] 大肥鱼大脑 DSH 已就绪 (端口: 3080)。" -ForegroundColor Green
                break
            }
            Start-Sleep -Seconds 1
            $waited += 1
        }
    } else {
        Write-Host "[4/5] 未找到 DSH 依赖，请在 $BaseDir 执行 npm install！" -ForegroundColor Red
    }
} else {
    Write-Host "[4/5] 大肥鱼大脑 DSH 已在运行中 (端口: 3080)。" -ForegroundColor Green
}

# 5. 检查并启动 Watchdog 防掉线看门狗
$dshHomeDir = Join-Path $env:USERPROFILE ".dsh"
$pidFile = Join-Path $dshHomeDir "watchdog.pid"
$watchdogAlive = $false
if (Test-Path $pidFile) {
    $wdPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if ($wdPid -and (Get-Process -Id $wdPid -ErrorAction SilentlyContinue)) {
        $watchdogAlive = $true
    }
}
if (-not $watchdogAlive) {
    $watchdogScript = Join-Path $BaseDir "watchdog-dafeiyu.ps1"
    if (Test-Path $watchdogScript) {
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $watchdogScript) -WorkingDirectory $BaseDir -WindowStyle Hidden
        Write-Host "[5/5] 后台防掉线看门狗 (Watchdog) 已启动。" -ForegroundColor Green
    }
} else {
    Write-Host "[5/5] 后台防掉线看门狗 (Watchdog) 已在守护中。" -ForegroundColor Green
}

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   大肥鱼启动完成！所有日志弹窗已全部在后台隐藏！ " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Start-Sleep -Seconds 3
