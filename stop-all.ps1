# ============================================================
# AI月老 - 停止核心服务
# 只停本项目自己的进程（按命令行特征精确匹配），不动你机器上的其他程序
# 用法: 双击「停止AI月老.bat」或 powershell -File stop-all.ps1
# ============================================================
$ROOT = "D:\xm\aiyuelao"

Write-Host "停止 看门狗..."
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*watchdog.ps1*" -and $_.Name -eq "powershell.exe" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "停止 匹配中心 (8016)..."
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -like "python*" -and $_.CommandLine -like "*match-center*uvicorn*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "停止 wang-ai-agent 后端 (8123)..."
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "java.exe" -and $_.CommandLine -like "*wang-ai-agent*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "停止 ANL 后端 (3001)..."
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*server-minimal*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "停止 前端 (ANL 5176 / wang 5175)..."
Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -like "*vite*" -and
        ($_.CommandLine -like "*aiyuelao*")
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "停止 MySQL (3306)..."
& "$ROOT\tools\mysql-extracted\mysql-8.0.42-winx64\bin\mysqladmin.exe" -uroot -p123456 shutdown 2>$null
Start-Sleep 2
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "mysqld.exe" -and $_.CommandLine -like "*aiyuelao*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "全部服务已停止。"
