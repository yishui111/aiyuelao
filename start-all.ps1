# ============================================================
# AI月老 - 一键启动全部服务（原生进程，无 Docker，完全脱离控制台）
# 用法: powershell -ExecutionPolicy Bypass -File D:\xm\aiyuelao\start-all.ps1
# ============================================================
$ROOT = "D:\xm\aiyuelao"
$LOGS = "$ROOT\logs"
New-Item -ItemType Directory -Force -Path $LOGS | Out-Null

Write-Host "[1/9] MongoDB (27017)..."
Start-Process -FilePath "$ROOT\tools\mongodb-extracted\mongodb-win32-x86_64-windows-8.0.12\bin\mongod.exe" `
  -ArgumentList "--dbpath","$ROOT\data\mongo","--port","27017","--wiredTigerCacheSizeGB","0.25","--bind_ip","127.0.0.1" `
  -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mongodb.log" -RedirectStandardError "$LOGS\mongodb-err.log"
Start-Sleep 6

Write-Host "[2/9] MySQL (3306)..."
Start-Process -FilePath "$ROOT\tools\mysql-extracted\mysql-8.0.42-winx64\bin\mysqld.exe" `
  -ArgumentList "--no-defaults","--datadir=D:/xm/aiyuelao/data/mysql","--port=3306","--console" `
  -WindowStyle Hidden -RedirectStandardOutput "$LOGS\mysql.log" -RedirectStandardError "$LOGS\mysql-err.log"
Start-Sleep 6

Write-Host "[3/9] ANL backend (3001, in-memory mode)..."
Start-Process -FilePath "node" -ArgumentList "server-minimal.js" -WorkingDirectory "$ROOT\projects\ANL\backend" `
  -WindowStyle Hidden -RedirectStandardOutput "$LOGS\anl-backend.log" -RedirectStandardError "$LOGS\anl-backend-err.log"

Write-Host "[4/9] ANL frontend (5173)..."
Start-Process -FilePath "cmd" -ArgumentList "/c","npm run dev > ..\..\logs\anl-frontend.log 2>&1" -WorkingDirectory "$ROOT\projects\ANL" -WindowStyle Hidden

Write-Host "[5/9] AI matching engine (8014)..."
Start-Process -FilePath "$ROOT\projects\ai-powered-matching-algorithm\.venv\Scripts\python.exe" `
  -ArgumentList "-m","uvicorn","main:app","--host","127.0.0.1","--port","8014" `
  -WorkingDirectory "$ROOT\projects\ai-powered-matching-algorithm" `
  -WindowStyle Hidden -RedirectStandardOutput "$LOGS\matching-algo.log" -RedirectStandardError "$LOGS\matching-algo-err.log"

Write-Host "[5b/9] Match center (8016, 三层漏斗打分核心)..."
Start-Process -FilePath "$ROOT\match-center\.venv\Scripts\python.exe" `
  -ArgumentList "-m","uvicorn","main:app","--host","127.0.0.1","--port","8016" `
  -WorkingDirectory "$ROOT\match-center" `
  -WindowStyle Hidden -RedirectStandardOutput "$LOGS\match-center.log" -RedirectStandardError "$LOGS\match-center-err.log"

Write-Host "[6/9] GlowMeet backend (8013, memory mode) + frontend (3000)..."
# GlowMeet 需要环境变量：用 ProcessStartInfo 注入（cmd 内联 set 的方式不可靠）
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$ROOT\projects\GlowMeet\backend\glowmeet.exe"
$psi.WorkingDirectory = "$ROOT\projects\GlowMeet\backend"
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false
$psi.EnvironmentVariables["PERSISTENCE"] = "memory"
$psi.EnvironmentVariables["PORT"] = "8013"
$psi.EnvironmentVariables["X_CLIENT_ID"] = "dev-client-id"
$psi.EnvironmentVariables["X_CLIENT_SECRET"] = "dev-client-secret"
$psi.EnvironmentVariables["X_REDIRECT_URL"] = "http://localhost:3000/auth/x/callback"
$psi.EnvironmentVariables["APP_JWT_SECRET"] = "dev-secret"
[System.Diagnostics.Process]::Start($psi) | Out-Null
Start-Process -FilePath "cmd" -ArgumentList "/c","npm run dev > ..\..\logs\glowmeet-web.log 2>&1" -WorkingDirectory "$ROOT\projects\GlowMeet\web" -WindowStyle Hidden

Write-Host "[7/9] Shidduch backend (8010) + frontend (5174)..."
Start-Process -FilePath "$ROOT\projects\shidduch-app\backend\.venv\Scripts\python.exe" `
  -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8015" `
  -WorkingDirectory "$ROOT\projects\shidduch-app\backend" `
  -WindowStyle Hidden -RedirectStandardOutput "$LOGS\shidduch-backend.log" -RedirectStandardError "$LOGS\shidduch-backend-err.log"
Start-Process -FilePath "cmd" -ArgumentList "/c","npm run dev > ..\..\logs\shidduch-frontend.log 2>&1" -WorkingDirectory "$ROOT\projects\shidduch-app\frontend" -WindowStyle Hidden

Write-Host "[8/9] wang-ai-agent backend (8123)..."
$jar = Get-ChildItem "$ROOT\projects\wang-ai-agent\target\wang-ai-agent-*.jar" -Exclude "*.original" | Select-Object -First 1
if ($jar) {
  Start-Process -FilePath "$ROOT\tools\jdk21-extracted\jdk-21.0.12.1+1\bin\java.exe" `
    -ArgumentList "-jar", $jar.FullName -WorkingDirectory "$ROOT\projects\wang-ai-agent" `
    -WindowStyle Hidden -RedirectStandardOutput "$LOGS\wang-backend.log" -RedirectStandardError "$LOGS\wang-backend-err.log"
} else {
  Write-Host "  !! jar not found, skip (run mvnw package first)"
}

# 2026-09-07 应用户要求停用 wang 前端(5175)的自动启动
# Write-Host "[9/9] wang-ai-agent frontend (5175)..."
# Start-Process -FilePath "cmd" -ArgumentList "/c","npm run dev > ..\..\logs\wang-frontend.log 2>&1" -WorkingDirectory "$ROOT\projects\wang-ai-agent\wang-ai-agent-frontend" -WindowStyle Hidden

Write-Host ""
Write-Host "All services started. Waiting 20s for self-check..."
Start-Sleep 20

# 启动看门狗（若未运行）：之后每 30 秒自动巡检救活挂掉的服务
$wd = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*watchdog.ps1*" }
if (-not $wd) {
  Start-Process -FilePath "powershell" -ArgumentList "-ExecutionPolicy","Bypass","-File","$ROOT\watchdog.ps1" -WindowStyle Hidden
  Write-Host "看门狗已启动（每30秒自动巡检，服务挂掉自动重启）"
} else {
  Write-Host "看门狗已在运行"
}
$checks = @(
  @{n="ANL backend"; u="http://localhost:3001/api/health"},
  @{n="ANL frontend"; u="http://localhost:5176/"},
  @{n="Matching engine"; u="http://127.0.0.1:8014/docs"},
  @{n="Match center"; u="http://127.0.0.1:8016/health"},
  @{n="GlowMeet backend"; u="http://localhost:8013/health"},
  @{n="GlowMeet frontend"; u="http://localhost:3000/"},
  @{n="Shidduch backend"; u="http://127.0.0.1:8015/health/ready"},
  @{n="Shidduch frontend"; u="http://localhost:5174/"},
  @{n="wang backend"; u="http://localhost:8123/api/health/ok"},
  @{n="wang frontend"; u="http://localhost:5175/"}
)
foreach ($c in $checks) {
  try {
    $r = Invoke-WebRequest -Uri $c.u -UseBasicParsing -TimeoutSec 5
    Write-Host ("  OK  " + $c.n + " -> HTTP " + $r.StatusCode)
  } catch {
    Write-Host ("  FAIL " + $c.n + " (" + $c.u + ")")
  }
}
Write-Host ""
Write-Host "Stop all: powershell -ExecutionPolicy Bypass -File D:\xm\aiyuelao\stop-all.ps1"
