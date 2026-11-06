[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "             正在停止大肥鱼服务...                 " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# 1. 停止指定端口的服务 (3080: DSH, 9880: GPT-SoVITS, 3001: NapCat)
$ports = @(3080, 9880, 3001)
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            $pidToKill = $conn.OwningProcess
            if ($pidToKill -gt 0) {
                $proc = Get-Process -Id $pidToKill -ErrorAction SilentlyContinue
                $procName = if ($proc) { $proc.ProcessName } else { "PID $pidToKill" }
                Write-Host "正在停止端口 $port 上的服务: $procName (PID: $pidToKill)..." -ForegroundColor Yellow
                Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# 2. 清理可能残留的 NapCat 进程与 DSH 残留文件锁
Get-Process -Name "NapCatWinBootMain" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "QQ" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*NapCat*" } | Stop-Process -Force -ErrorAction SilentlyContinue
$dshHomeDir = Join-Path $env:USERPROFILE ".dsh"
if (Test-Path $dshHomeDir) {
    Get-ChildItem -Path $dshHomeDir -Filter ".credentials.yaml.lock*" -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Host "===================================================" -ForegroundColor Green
Write-Host "       大肥鱼及其所有后台服务已停止，显存已释放！   " -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
Start-Sleep -Seconds 2
