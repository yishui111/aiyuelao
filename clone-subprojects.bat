@echo off
chcp 65001 >nul
rem ============================================================
rem 还原 AI月老 的两个核心子项目到 projects\ 下
rem 优先使用本地 bundle（离线、含全部本地改动，精确还原）
rem 若无 bundle 再回退到自有 fork / 上游仓库
rem 可在新机重复执行，已存在的会跳过
rem ============================================================
setlocal
cd /d "%~dp0"

set BUNDLE_DIR=_archive\subprojects-bundle

for %%s in (ANL wang-ai-agent) do (
  if exist "projects\%%s\.git" (
    echo [跳过] %%s 已存在
  ) else if exist "%BUNDLE_DIR%\%%s.bundle" (
    echo [bundle] 从本地备份还原 %%s ...
    git clone "%BUNDLE_DIR%\%%s.bundle" "projects\%%s"
  ) else (
    echo [远端] 本地无 bundle，尝试从自有 fork 克隆 %%s ...
    git clone https://gitee.com/fengyanlin/%%s.git "projects\%%s" 2>nul || ^
    git clone https://github.com/yishui111/%%s.git "projects\%%s" 2>nul || ^
    echo   !! %%s 克隆失败：请手动放置 %BUNDLE_DIR%\%%s.bundle 后重试
  )
)

echo.
echo 完成。下一步：参考 README.md 的「新机部署」章节准备 tools\ 与依赖。
pause
