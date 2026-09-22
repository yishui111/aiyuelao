# ============================================================
# AI月老 - 一键启动核心服务（原生进程，无 Docker）
#
# 收敛后的服务清单（7 项）：
#   MySQL 3306             wang-ai-agent 对话记忆 + 微聊数据库
#   ANL 后端 3001          主壳（内存模式 server-minimal.js，约跑步仍在用）
#   ANL 前端 5176          React + Vite
#   匹配中心 8016          三层漏斗打分核心
#   wang 后端 8123         AI 分身对话（Spring Boot）
#   wang 前端 5175         Vue3
#   微聊后端 3002          仿微信服务（好友/聊天/位置/朋友圈，MySQL 持久化）
#
# 每个服务启动前先探测端口，已在线自动跳过，可安全重复执行
# 用法: 双击「启动AI月老.bat」或 powershell -File start-all.ps1
# ============================================================
$ROOT = "D:\xm\aiyuelao"
$LOGS = "$ROOT\logs"
New-Item -ItemType Directory -Force -Path $LOGS | Out-Null

function Test-NetPort($port) {
    try {
        $tcp = New-Object Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

# 后端类：直接 Start-Process（脱离控制台，实测稳定）
function Start-Hidden($exe, $argList, $cwd, $outLog, $errLog) {
    Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $cwd `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

# 前端类：bash 完全分离式启动（cmd 包装会被连带回收，实测 bash 方式最稳定）
function Start-BashDetached($bashCwd, $cmd) {
    Start-Process -FilePath "C:\Program Files\Git\bin\bash.exe" `
        -ArgumentList "-c", "cd '$bashCwd' && ($cmd &)" `
        -WindowStyle Hidden
}

# ---- 1. MySQL（wang-ai-agent 依赖）----
if (Test-NetPort 3306) {
    Write-Host "[1/7] MySQL 已在线，跳过"
} else {
    Write-Host "[1/7] 启动 MySQL (3306)..."
    Start-Process -FilePath "$ROOT\tools\mysql-extracted\mysql-8.0.42-winx64\bin\mysqld.exe" `
        -ArgumentList "--no-defaults","--datadir=D:/xm/aiyuelao/data/mysql","--port=3306","--console" `
        -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mysql.log" -RedirectStandardError "$LOGS\mysql-err.log"
    Start-Sleep 6
}

# ---- 2. ANL 后端 ----
if (Test-NetPort 3001) {
    Write-Host "[2/7] ANL后端 已在线，跳过"
} else {
    Write-Host "[2/7] 启动 ANL 后端 (3001, 内存模式)..."
    Start-Hidden "node" "server-minimal.js" "$ROOT\projects\ANL\backend" "$LOGS\anl-backend.log" "$LOGS\anl-backend-err.log"
    Start-Sleep 3
}

# ---- 3. ANL 前端 ----
if (Test-NetPort 5176) {
    Write-Host "[3/7] ANL前端 已在线，跳过"
} else {
    Write-Host "[3/7] 启动 ANL 前端 (5176)..."
    Start-BashDetached "/d/xm/aiyuelao/projects/ANL" "npm run dev > /d/xm/aiyuelao/logs/anl-frontend.log 2>&1"
    Start-Sleep 3
}

# ---- 4. 匹配中心（三层漏斗打分核心）----
if (Test-NetPort 8016) {
    Write-Host "[4/7] 匹配中心 已在线，跳过"
} else {
    Write-Host "[4/7] 启动 匹配中心 (8016, 三层漏斗打分核心)..."
    Start-Hidden "$ROOT\match-center\.venv\Scripts\python.exe" `
        @("-m","uvicorn","main:app","--host","127.0.0.1","--port","8016") `
        "$ROOT\match-center" "$LOGS\match-center.log" "$LOGS\match-center-err.log"
}

# ---- 5. wang-ai-agent 后端 ----
if (Test-NetPort 8123) {
    Write-Host "[5/7] wang后端 已在线，跳过"
} else {
    Write-Host "[5/7] 启动 wang-ai-agent 后端 (8123)..."
    $jar = Get-ChildItem "$ROOT\projects\wang-ai-agent\target\wang-ai-agent-*.jar" -Exclude "*.original" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jar) {
        Start-Hidden "$ROOT\tools\jdk21-extracted\jdk-21.0.12.1+1\bin\java.exe" `
            @("-jar", $jar.FullName) "$ROOT\projects\wang-ai-agent" "$LOGS\wang-backend.log" "$LOGS\wang-backend-err.log"
    } else {
        Write-Host "  !! 未找到 jar，跳过（先在 projects\wang-ai-agent 执行 mvnw package）"
    }
}

# ---- 6. wang-ai-agent 前端 ----
if (Test-NetPort 5175) {
    Write-Host "[6/7] wang前端 已在线，跳过"
} else {
    Write-Host "[6/7] 启动 wang-ai-agent 前端 (5175)..."
    Start-BashDetached "/d/xm/aiyuelao/projects/wang-ai-agent/wang-ai-agent-frontend" "npm run dev > /d/xm/aiyuelao/logs/wang-frontend.log 2>&1"
}

# ---- 7. 微聊后端（仿微信：好友/单聊群聊/实时位置/朋友圈）----
if (Test-NetPort 3002) {
    Write-Host "[7/7] 微聊后端 已在线，跳过"
} else {
    Write-Host "[7/7] 启动 微聊后端 (3002, MySQL 持久化)..."
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { $nodeExe = "$env:ProgramFiles\nodejs\node.exe" }
    Start-Hidden $nodeExe "$ROOT\wechat-backend\src\index.js" "$ROOT\wechat-backend" "$LOGS\weiliao-backend.log" "$LOGS\weiliao-backend-err.log"
}

# ---- 看门狗（若未运行）----
$wd = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*watchdog.ps1*" -and $_.Name -eq "powershell.exe" }
if (-not $wd) {
    Start-Process -FilePath "powershell" -ArgumentList "-ExecutionPolicy","Bypass","-File","$ROOT\watchdog.ps1" -WindowStyle Hidden
    Write-Host "看门狗已启动（每30秒自动巡检，服务挂掉自动重启）"
} else {
    Write-Host "看门狗已在运行"
}

# ---- 自检（curl.exe + --noproxy，避免系统代理造成误判）----
Write-Host ""
Write-Host "全部指令已执行，等待 25 秒后自检..."
Start-Sleep 25
$checks = @(
    @{n="ANL后端";   u="http://127.0.0.1:3001/api/health"},
    @{n="ANL前端";   u="http://127.0.0.1:5176/"},
    @{n="匹配中心";  u="http://127.0.0.1:8016/health"},
    @{n="wang后端";  u="http://127.0.0.1:8123/api/health/ok"},
    @{n="wang前端";  u="http://127.0.0.1:5175/"},
    @{n="微聊后端";  u="http://127.0.0.1:3002/api/health"}
)
$fail = 0
foreach ($c in $checks) {
    $code = & curl.exe -s -o NUL -w "%{http_code}" --noproxy "*" --max-time 8 $c.u 2>$null
    if ($code -eq "200") {
        Write-Host ("  OK   " + $c.n + " -> HTTP " + $code)
    } else {
        $fail++
        Write-Host ("  FAIL " + $c.n + " (" + $c.u + " -> HTTP " + $code + ")")
    }
}
Write-Host ""
if ($fail -eq 0) { Write-Host "全部服务在线 ✓  浏览器打开 http://localhost:5176 即可使用" }
else { Write-Host "有 $fail 个服务未就绪，30 秒后看门狗会自动补齐，或再次运行本脚本" }
Write-Host "停止服务：双击「停止AI月老.bat」"
