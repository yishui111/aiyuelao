#!/bin/bash
# AI月老 — 停止全部服务
echo "停止 Node/Vite 服务..."
powershell -Command 'Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force'
echo "停止 Python 服务（uvicorn）..."
powershell -Command 'Get-CimInstance Win32_Process -Filter "Name=''python.exe''" | Where-Object {$_.CommandLine -like "*uvicorn*"} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
echo "停止 GlowMeet 后端..."
powershell -Command 'Get-Process -Name glowmeet -ErrorAction SilentlyContinue | Stop-Process -Force'
echo "停止 Java（wang-ai-agent）..."
powershell -Command 'Get-Process -Name java -ErrorAction SilentlyContinue | Stop-Process -Force'
echo "停止 MongoDB..."
powershell -Command 'Get-Process -Name mongod -ErrorAction SilentlyContinue | Stop-Process -Force'
echo "停止 MySQL..."
"D:/xm/aiyuelao/tools/mysql-extracted/mysql-8.0.42-winx64/bin/mysqladmin.exe" -uroot -p123456 shutdown 2>/dev/null || powershell -Command 'Get-Process -Name mysqld -ErrorAction SilentlyContinue | Stop-Process -Force'
echo "全部服务已停止。"
