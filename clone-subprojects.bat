@echo off
rem 拉取 5 个子项目到 projects\ 下(脚本可在新机重复执行)
setlocal cd /d "%~dp0"
for %%s in (GlowMeet ai-powered-matching-algorithm shidduch-app ANL) do (
  if not exist "projects\%%s\.git" (
    echo cloning %%s ...
    git clone https://gitee.com/fengyanlin/%%s.git "projects\%%s" || git clone https://github.com/yishui111/%%s.git "projects\%%s"
  ) else (echo %%s already exists)
)
if not exist "projects\wang-ai-agent\.git" (
  echo cloning wang-ai-agent ...
  git clone https://github.com/Uwilldoit/wang-ai-agent.git "projects\wang-ai-agent"
) else (echo wang-ai-agent already exists)
echo done.
pause
