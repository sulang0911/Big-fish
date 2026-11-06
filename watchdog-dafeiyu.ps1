[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$BaseDir = $PSScriptRoot
if (-not $BaseDir) { $BaseDir = "D:\deepseek-harness" }

$dshHomeDir = Join-Path $env:USERPROFILE ".dsh"
$logDir = Join-Path $dshHomeDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$pidFile = Join-Path $dshHomeDir "watchdog.pid"
$logFile = Join-Path $logDir "watchdog.log"

Set-Content -Path $pidFile -Value $PID -Encoding ASCII -Force

function Write-WatchdogLog([string]$msg) {
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8 -ErrorAction SilentlyContinue
}

Write-WatchdogLog "Watchdog started (PID: $PID)"

while ($true) {
    Start-Sleep -Seconds 45
    if (-not (Test-Path $pidFile)) {
        Write-WatchdogLog "PID file removed, Watchdog exiting cleanly."
        break
    }
    $recordedPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if ($recordedPid -and ($recordedPid -ne "$PID")) {
        Write-WatchdogLog "New Watchdog instance ($recordedPid) took over, exiting."
        break
    }

    # 1. 守护 DSH 大脑 (端口 3080)
    $conn3080 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
    if (-not $conn3080) {
        Write-WatchdogLog "Port 3080 (DSH) down! Cleaning lock files and restarting..."
        if (Test-Path $dshHomeDir) {
            Get-ChildItem -Path $dshHomeDir -Filter ".credentials.yaml.lock*" -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        }
        $dshBin = Join-Path $BaseDir "node_modules\@deepseek-ai\dsh\lib\bin.js"
        $nodeExe = (Get-Command "node.exe" -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) { $nodeExe = "C:\Program Files\nodejs\node.exe" }
        if (Test-Path $dshBin) {
            Start-Process -FilePath $nodeExe -ArgumentList @($dshBin, "web", "--no-open") -WorkingDirectory $BaseDir -WindowStyle Hidden
            Write-WatchdogLog "Triggered DSH restart on port 3080."
        }
    }

    # 2. 守护 NapCat QQ (端口 3001)
    $conn3001 = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
    if (-not $conn3001) {
        $napcatDir = Join-Path $BaseDir "napcat"
        if (-not (Test-Path $napcatDir)) { $napcatDir = Join-Path $BaseDir "NapCat" }
        if (Test-Path $napcatDir) {
            Write-WatchdogLog "Port 3001 (NapCat) down! Restarting launcher.bat..."
            Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "launcher.bat", "-q", "2163178914") -WorkingDirectory $napcatDir -WindowStyle Hidden
        }
    }
}
