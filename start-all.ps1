# ============================================================
# AI月老 - 一键启动全部服务（原生进程，无 Docker）
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

function Start-Hidden($exe, $argList, $cwd, $outLog, $errLog) {
    Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $cwd `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

function Start-BashDetached($bashCwd, $cmd) {
    Start-Process -FilePath "C:\Program Files\Git\bin\bash.exe" `
        -ArgumentList "-c", "cd '$bashCwd' && ($cmd &)" `
        -WindowStyle Hidden
}

# ---- 1. MongoDB ----
if (Test-NetPort 27017) {
    Write-Host "[1/9] MongoDB 已在线，跳过"
} else {
    Write-Host "[1/9] 启动 MongoDB (27017)..."
    Start-Process -FilePath "$ROOT\tools\mongodb-extracted\mongodb-win32-x86_64-windows-8.0.12\bin\mongod.exe" `
        -ArgumentList "--dbpath","$ROOT\data\mongo","--port","27017","--wiredTigerCacheSizeGB","0.25","--bind_ip","127.0.0.1" `
        -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mongodb.log" -RedirectStandardError "$LOGS\mongodb-err.log"
    Start-Sleep 6
}

# ---- 2. MySQL ----
if (Test-NetPort 3306) {
    Write-Host "[2/9] MySQL 已在线，跳过"
} else {
    Write-Host "[2/9] 启动 MySQL (3306)..."
    Start-Process -FilePath "$ROOT\tools\mysql-extracted\mysql-8.0.42-winx64\bin\mysqld.exe" `
        -ArgumentList "--no-defaults","--datadir=D:/xm/aiyuelao/data/mysql","--port=3306","--console" `
        -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mysql.log" -RedirectStandardError "$LOGS\mysql-err.log"
    Start-Sleep 6
}

# ---- 3. ANL 后端 ----
if (Test-NetPort 3001) {
    Write-Host "[3/9] ANL后端 已在线，跳过"
} else {
    Write-Host "[3/9] 启动 ANL 后端 (3001, 内存模式)..."
    Start-Hidden "node" "server-minimal.js" "$ROOT\projects\ANL\backend" "$LOGS\anl-backend.log" "$LOGS\anl-backend-err.log"
    Start-Sleep 3
}

# ---- 4. ANL 前端 ----
if (Test-NetPort 5176) {
    Write-Host "[4/9] ANL前端 已在线，跳过"
} else {
    Write-Host "[4/9] 启动 ANL 前端 (5176)..."
    Start-BashDetached "/d/xm/aiyuelao/projects/ANL" "npm run dev > /d/xm/aiyuelao/logs/anl-frontend.log 2>&1"
    Start-Sleep 3
}

# ---- 5. 匹配引擎 + 匹配中心 ----
if (Test-NetPort 8014) {
    Write-Host "[5/9] 匹配引擎 已在线，跳过"
} else {
    Write-Host "[5/9] 启动 AI 匹配引擎 (8014)..."
    Start-Hidden "$ROOT\projects\ai-powered-matching-algorithm\.venv\Scripts\python.exe" `
        @("-m","uvicorn","main:app","--host","127.0.0.1","--port","8014") `
        "$ROOT\projects\ai-powered-matching-algorithm" "$LOGS\matching-algo.log" "$LOGS\matching-algo-err.log"
}
if (Test-NetPort 8016) {
    Write-Host "      匹配中心 已在线，跳过"
} else {
    Write-Host "      启动 匹配中心 (8016, 三层漏斗打分核心)..."
    Start-Hidden "$ROOT\match-center\.venv\Scripts\python.exe" `
        @("-m","uvicorn","main:app","--host","127.0.0.1","--port","8016") `
        "$ROOT\match-center" "$LOGS\match-center.log" "$LOGS\match-center-err.log"
}

# ---- 6. GlowMeet ----
if (Test-NetPort 8013) {
    Write-Host "[6/9] GlowMeet后端 已在线，跳过"
} else {
    Write-Host "[6/9] 启动 GlowMeet 后端 (8013, 内存模式)..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "$ROOT\projects\GlowMeet\backend\glowmeet.exe"
    $psi.WorkingDirectory = "$ROOT\projects\GlowMeet\backend"
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $false; $psi.RedirectStandardError = $false
    $psi.EnvironmentVariables["PERSISTENCE"] = "memory"
    $psi.EnvironmentVariables["PORT"] = "8013"
    $psi.EnvironmentVariables["X_CLIENT_ID"] = "dev-client-id"
    $psi.EnvironmentVariables["X_CLIENT_SECRET"] = "dev-client-secret"
    $psi.EnvironmentVariables["X_REDIRECT_URL"] = "http://localhost:3000/auth/x/callback"
    $psi.EnvironmentVariables["APP_JWT_SECRET"] = "dev-secret"
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}
if (Test-NetPort 3000) {
    Write-Host "      GlowMeet前端 已在线，跳过"
} else {
    Write-Host "      启动 GlowMeet 前端 (3000)..."
    Start-BashDetached "/d/xm/aiyuelao/projects/GlowMeet/web" "npm run dev > /d/xm/aiyuelao/logs/glowmeet-web.log 2>&1"
    Start-Sleep 3
}

# ---- 7. Shidduch ----
if (Test-NetPort 8015) {
    Write-Host "[7/9] Shidduch后端 已在线，跳过"
} else {
    Write-Host "[7/9] 启动 Shidduch 后端 (8015)..."
    Start-Hidden "$ROOT\projects\shidduch-app\backend\.venv\Scripts\python.exe" `
        @("-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8015") `
        "$ROOT\projects\shidduch-app\backend" "$LOGS\shidduch-backend.log" "$LOGS\shidduch-backend-err.log"
}
if (Test-NetPort 5174) {
    Write-Host "      Shidduch前端 已在线，跳过"
} else {
    Write-Host "      启动 Shidduch 前端 (5174)..."
    Start-BashDetached "/d/xm/aiyuelao/projects/shidduch-app/frontend" "npm run dev > /d/xm/aiyuelao/logs/shidduch-frontend.log 2>&1"
    Start-Sleep 3
}

# ---- 8. wang-ai-agent 后端 ----
if (Test-NetPort 8123) {
    Write-Host "[8/9] wang后端 已在线，跳过"
} else {
    Write-Host "[8/9] 启动 wang-ai-agent 后端 (8123)..."
    $jar = Get-ChildItem "$ROOT\projects\wang-ai-agent\target\wang-ai-agent-*.jar" -Exclude "*.original" | Select-Object -First 1
    if ($jar) {
        Start-Hidden "$ROOT\tools\jdk21-extracted\jdk-21.0.12.1+1\bin\java.exe" `
            @("-jar", $jar.FullName) "$ROOT\projects\wang-ai-agent" "$LOGS\wang-backend.log" "$LOGS\wang-backend-err.log"
    } else {
        Write-Host "  !! 未找到 jar，跳过（先执行 mvnw package）"
    }
}

# ---- 9. wang-ai-agent 前端 ----
if (Test-NetPort 5175) {
    Write-Host "[9/9] wang前端 已在线，跳过"
} else {
    Write-Host "[9/9] 启动 wang-ai-agent 前端 (5175)..."
    Start-BashDetached "/d/xm/aiyuelao/projects/wang-ai-agent/wang-ai-agent-frontend" "npm run dev > /d/xm/aiyuelao/logs/wang-frontend.log 2>&1"
}

# ---- 看门狗（若未运行）----
$wd = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*watchdog.ps1*" -and $_.Name -eq "powershell.exe" }
if (-not $wd) {
    Start-Process -FilePath "powershell" -ArgumentList "-ExecutionPolicy","Bypass","-File","$ROOT\watchdog.ps1" -WindowStyle Hidden
    Write-Host "看门狗已启动（每30秒自动巡检，服务挂掉自动重启）"
} else {
    Write-Host "看门狗已在运行"
}

# ---- 自检 ----
Write-Host ""
Write-Host "全部指令已执行，等待 25 秒后自检..."
Start-Sleep 25
$checks = @(
    @{n="ANL后端"; u="http://127.0.0.1:3001/api/health"},
    @{n="ANL前端"; u="http://127.0.0.1:5176/"},
    @{n="匹配引擎"; u="http://127.0.0.1:8014/docs"},
    @{n="匹配中心"; u="http://127.0.0.1:8016/health"},
    @{n="GlowMeet后端"; u="http://127.0.0.1:8013/health"},
    @{n="GlowMeet前端"; u="http://127.0.0.1:3000/"},
    @{n="Shidduch后端"; u="http://127.0.0.1:8015/health/ready"},
    @{n="Shidduch前端"; u="http://127.0.0.1:5174/"},
    @{n="wang后端"; u="http://127.0.0.1:8123/api/health/ok"},
    @{n="wang前端"; u="http://127.0.0.1:5175/"}
)
$fail = 0
foreach ($c in $checks) {
    try {
        $r = Invoke-WebRequest -Uri $c.u -UseBasicParsing -TimeoutSec 6
        Write-Host ("  OK  " + $c.n + " -> HTTP " + $r.StatusCode)
    } catch {
        $fail++
        Write-Host ("  FAIL " + $c.n + " (" + $c.u + ")")
    }
}
Write-Host ""
if ($fail -eq 0) { Write-Host "全部服务在线 ✓  浏览器打开对应端口即可使用" }
else { Write-Host "有 $fail 个服务未就绪，30 秒后看门狗会自动补齐，或再次运行本脚本" }
Write-Host "停止服务：双击「停止AI月老.bat」"
