@echo off
chcp 65001 >nul
title AI月老 - 启动中
echo ================================================
echo    AI月老 - 正在启动全部服务，请稍等约 40 秒
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
echo.
echo ================================================
echo    启动完成。本窗口可以关闭，不影响服务运行。
echo    停止服务请双击「停止AI月老.bat」
echo ================================================
pause
