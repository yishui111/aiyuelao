@echo off
chcp 65001 >nul
title AI月老 - 停止中
echo ================================================
echo    AI月老 - 正在停止全部服务与看门狗...
echo ================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog.ps1*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"
echo.
echo ================================================
echo    全部服务与看门狗已停止。
echo ================================================
pause
