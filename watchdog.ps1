# ============================================================
# AI月老 - 服务看门狗（每 30 秒巡检，服务挂掉自动重启）
# 用法: powershell -ExecutionPolicy Bypass -File D:\xm\aiyuelao\watchdog.ps1
# 日志: D:\xm\aiyuelao\logs\watchdog.log
# ============================================================
$ROOT = "D:\xm\aiyuelao"
$LOGS = "$ROOT\logs"
New-Item -ItemType Directory -Force -Path $LOGS | Out-Null

function Test-Url($url) {
    # 用 curl.exe 检测（不走系统代理，避免代理软件开启时误判）
    $code = & curl.exe -s -o NUL -w "%{http_code}" --noproxy "*" --max-time 6 $url 2>$null
    return ($code -ge 200 -and $code -lt 500)
}

function Test-NetPort($port) {
    try {
        $tcp = New-Object Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

# 后端类：直接 Start-Process（经实测稳定）
function Start-Hidden($exe, $argList, $cwd, $outLog, $errLog) {
    Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $cwd `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

# 前端/Java 类：bash 完全分离式启动（cmd 包装会被连带回收，实测 bash 方式最稳定）
function Start-BashDetached($bashCwd, $cmd) {
    Start-Process -FilePath "C:\Program Files\Git\bin\bash.exe" `
        -ArgumentList "-c", "cd '$bashCwd' && ($cmd &)" `
        -WindowStyle Hidden
}

while ($true) {
    $revived = @()

    # ---- 数据库 ----
    if (-not (Test-NetPort 27017)) {
        Start-Process -FilePath "$ROOT\tools\mongodb-extracted\mongodb-win32-x86_64-windows-8.0.12\bin\mongod.exe" `
            -ArgumentList "--dbpath","$ROOT\data\mongo","--port","27017","--wiredTigerCacheSizeGB","0.25","--bind_ip","127.0.0.1" `
            -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mongodb.log" -RedirectStandardError "$LOGS\mongodb-err.log"
        $revived += "MongoDB"
        Start-Sleep 5
    }
    if (-not (Test-NetPort 3306)) {
        Start-Process -FilePath "$ROOT\tools\mysql-extracted\mysql-8.0.42-winx64\bin\mysqld.exe" `
            -ArgumentList "--no-defaults","--datadir=D:/xm/aiyuelao/data/mysql","--port=3306","--console" `
            -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mysql.log" -RedirectStandardError "$LOGS\mysql-err.log"
        $revived += "MySQL"
        Start-Sleep 6
    }

    # ---- 后端 ----
    if (-not (Test-Url "http://localhost:3001/api/health")) {
        Start-Hidden "node" "server-minimal.js" "$ROOT\projects\ANL\backend" "$LOGS\anl-backend.log" "$LOGS\anl-backend-err.log"
        $revived += "ANL后端"
    }
    if (-not (Test-Url "http://127.0.0.1:8014/docs")) {
        Start-Hidden "$ROOT\projects\ai-powered-matching-algorithm\.venv\Scripts\python.exe" `
            @("-m","uvicorn","main:app","--host","127.0.0.1","--port","8014") `
            "$ROOT\projects\ai-powered-matching-algorithm" "$LOGS\matching-algo.log" "$LOGS\matching-algo-err.log"
        $revived += "匹配引擎"
    }
    if (-not (Test-Url "http://127.0.0.1:8016/health")) {
        Start-Hidden "$ROOT\match-center\.venv\Scripts\python.exe" `
            @("-m","uvicorn","main:app","--host","127.0.0.1","--port","8016") `
            "$ROOT\match-center" "$LOGS\match-center.log" "$LOGS\match-center-err.log"
        $revived += "匹配中心"
    }
    if (-not (Test-Url "http://localhost:8013/health")) {
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
        $revived += "GlowMeet后端"
    }
    if (-not (Test-Url "http://127.0.0.1:8015/health/ready")) {
        Start-Hidden "$ROOT\projects\shidduch-app\backend\.venv\Scripts\python.exe" `
            @("-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8015") `
            "$ROOT\projects\shidduch-app\backend" "$LOGS\shidduch-backend.log" "$LOGS\shidduch-backend-err.log"
        $revived += "Shidduch后端"
    }
    if (-not (Test-Url "http://localhost:8123/api/health/ok")) {
        Start-BashDetached "/d/xm/aiyuelao/projects/wang-ai-agent" `
            '"/d/xm/aiyuelao/tools/jdk21-extracted/jdk-21.0.12.1+1/bin/java.exe" -jar target/wang-ai-agent-0.0.1-SNAPSHOT.jar > /d/xm/aiyuelao/logs/wang-backend.log 2>&1'
        $revived += "wang后端"
    }

    # ---- 前端（vite，bash 分离式）----
    if (-not (Test-Url "http://localhost:5176/")) {
        Start-BashDetached "/d/xm/aiyuelao/projects/ANL" "npm run dev > /d/xm/aiyuelao/logs/anl-frontend.log 2>&1"
        $revived += "ANL前端"
    }
    if (-not (Test-Url "http://localhost:3000/")) {
        Start-BashDetached "/d/xm/aiyuelao/projects/GlowMeet/web" "npm run dev > /d/xm/aiyuelao/logs/glowmeet-web.log 2>&1"
        $revived += "GlowMeet前端"
    }
    if (-not (Test-Url "http://localhost:5174/")) {
        Start-BashDetached "/d/xm/aiyuelao/projects/shidduch-app/frontend" "npm run dev > /d/xm/aiyuelao/logs/shidduch-frontend.log 2>&1"
        $revived += "Shidduch前端"
    }
    # 2026-09-07 应用户要求停用 wang 前端(5175)的自动拉起：用户不希望它自动启动
    # if (-not (Test-Url "http://localhost:5175/")) {
    #     Start-BashDetached "/d/xm/aiyuelao/projects/wang-ai-agent/wang-ai-agent-frontend" "npm run dev > /d/xm/aiyuelao/logs/wang-frontend.log 2>&1"
    #     $revived += "wang前端"
    # }

    if ($revived.Count -gt 0) {
        $line = "{0} [看门狗] 自动重启: {1}" -f (Get-Date -Format "HH:mm:ss"), ($revived -join ", ")
        Write-Output $line
        Add-Content -Path "$LOGS\watchdog.log" -Value $line
    }

    Start-Sleep 30
}
