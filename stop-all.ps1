# AI月老 - 停止全部服务
Write-Host "Stopping MongoDB..."
Get-Process -Name mongod -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Stopping MySQL..."
& "D:\xm\aiyuelao\tools\mysql-extracted\mysql-8.0.42-winx64\bin\mysqladmin.exe" -uroot -p123456 shutdown 2>$null
Start-Sleep 2
Get-Process -Name mysqld -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Stopping GlowMeet backend..."
Get-Process -Name glowmeet -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Stopping Java (wang-ai-agent)..."
Get-Process -Name java -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Stopping Python services (uvicorn)..."
Get-CimInstance Win32_Process | Where-Object { $_.Name -like "python*" -and $_.CommandLine -like "*uvicorn*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Stopping Node services (ANL/Vite)..."
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and ($_.CommandLine -like "*server-minimal*" -or $_.CommandLine -like "*vite*") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "All services stopped."
