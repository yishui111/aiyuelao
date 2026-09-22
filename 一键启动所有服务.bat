@echo off
chcp 65001 >nul
title 一键启动所有服务
echo ================================================
echo    微聊/AI月老 - 一键启动全部服务（含数据库）
echo    MySQL + 微聊后端 + ANL + 匹配中心 + wang-ai-agent
echo ================================================
echo.
rem 已管理员运行时自动放行 3002 端口（手机连接必需，只需成功一次）
net session >nul 2>&1
if %errorlevel%==0 (
  netsh advfirewall firewall add rule name="微聊后端(3002)" dir=in action=allow protocol=TCP localport=3002 >nul 2>&1
  echo [防火墙] 已放行 3002 端口
) else (
  echo [防火墙] 当前非管理员权限，跳过放行（手机连不上时：右键本bat-以管理员身份运行一次）
)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
echo.
echo ================================================
echo    启动完成，本窗口别关（最小化即可）。
echo    手机测试步骤看根目录《两台手机测试步骤.md》
echo    停止服务请双击「停止AI月老.bat」
echo ================================================
pause
