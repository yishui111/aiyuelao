# ============================================================
# AI月老 - 服务看门狗（每 30 秒巡检，服务挂掉自动重启）
# 监控：MySQL + ANL(前后端) + 匹配中心 + wang-ai-agent(前后端)
# 用法: powershell -ExecutionPolicy Bypass -File D:\xm\aiyuelao\watchdog.ps1
# 日志: D:\xm\aiyuelao\logs\watchdog.log
# ============================================================
$ROOT = "D:\xm\aiyuelao"
$LOGS = "$ROOT\logs"
New-Item -ItemType Directory -Force -Path $LOGS | Out-Null

function Test-Url($url) {
    # 用 curl.exe 检测（--noproxy 不走系统代理，避免代理软件开启时误判）
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

# ---- 解析 node 绝对路径（看门狗环境可能没有用户 PATH，裸 "node" 会静默启动失败）----
$script:NODE_EXE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $script:NODE_EXE) {
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    $candidates += Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Depth 4 -Filter node.exe `
        -ErrorAction SilentlyContinue | Select-Object -First 3 -ExpandProperty FullName
    $script:NODE_EXE = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
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
    if (-not (Test-NetPort 3306)) {
        Start-Process -FilePath "$ROOT\tools\mysql-extracted\mysql-8.0.42-winx64\bin\mysqld.exe" `
            -ArgumentList "--no-defaults","--datadir=D:/xm/aiyuelao/data/mysql","--port=3306","--console" `
            -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mysql.log" -RedirectStandardError "$LOGS\mysql-err.log"
        $revived += "MySQL"
        Start-Sleep 6
    }

    # ---- 后端 ----
    if (-not (Test-Url "http://127.0.0.1:3001/api/health")) {
        if ($script:NODE_EXE) {
            Start-Hidden $script:NODE_EXE "server-minimal.js" "$ROOT\projects\ANL\backend" "$LOGS\anl-backend.log" "$LOGS\anl-backend-err.log"
            $revived += "ANL后端"
        } else {
            $line = "{0} [看门狗] 找不到 node.exe，无法拉起 ANL后端" -f (Get-Date -Format "HH:mm:ss")
            Add-Content -Path "$LOGS\watchdog.log" -Value $line
        }
    }
    if (-not (Test-Url "http://127.0.0.1:8016/health")) {
        Start-Hidden "$ROOT\match-center\.venv\Scripts\python.exe" `
            @("-m","uvicorn","main:app","--host","127.0.0.1","--port","8016") `
            "$ROOT\match-center" "$LOGS\match-center.log" "$LOGS\match-center-err.log"
        $revived += "匹配中心"
    }
    if (-not (Test-Url "http://127.0.0.1:8123/api/health/ok")) {
        $jar = Get-ChildItem "$ROOT\projects\wang-ai-agent\target\wang-ai-agent-*.jar" -Exclude "*.original" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($jar) {
            Start-Hidden "$ROOT\tools\jdk21-extracted\jdk-21.0.12.1+1\bin\java.exe" `
                @("-jar", $jar.FullName) "$ROOT\projects\wang-ai-agent" "$LOGS\wang-backend.log" "$LOGS\wang-backend-err.log"
            $revived += "wang后端"
        }
    }

    # ---- 前端（vite，bash 分离式）----
    if (-not (Test-Url "http://127.0.0.1:5176/")) {
        Start-BashDetached "/d/xm/aiyuelao/projects/ANL" "npm run dev > /d/xm/aiyuelao/logs/anl-frontend.log 2>&1"
        $revived += "ANL前端"
    }
    if (-not (Test-Url "http://127.0.0.1:5175/")) {
        Start-BashDetached "/d/xm/aiyuelao/projects/wang-ai-agent/wang-ai-agent-frontend" "npm run dev > /d/xm/aiyuelao/logs/wang-frontend.log 2>&1"
        $revived += "wang前端"
    }

    if ($revived.Count -gt 0) {
        $line = "{0} [看门狗] 自动重启: {1}" -f (Get-Date -Format "HH:mm:ss"), ($revived -join ", ")
        Write-Output $line
        Add-Content -Path "$LOGS\watchdog.log" -Value $line
    }

    Start-Sleep 30
}
