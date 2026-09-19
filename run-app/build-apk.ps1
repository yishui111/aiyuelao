# ============================================================
# 约跑步 APP - 一键构建 APK
# 直接用 aapt2/javac/d8/zipalign/apksigner，无需 Gradle / Android Studio
# 用法: powershell -ExecutionPolicy Bypass -File build-apk.ps1
# 产物: run-app\yuepao-release.apk
# ============================================================
$ErrorActionPreference = "Stop"
$ROOT = "D:\xm\aiyuelao"
$APP  = "$ROOT\run-app\app"
$SDK  = "$ROOT\tools\android-sdk"
$BT   = "$SDK\build-tools\34.0.0"
$AJAR = "$SDK\platforms\android-34\android.jar"
$JDK  = "$ROOT\tools\jdk21-extracted\jdk-21.0.12.1+1"
$BUILD = "$ROOT\run-app\build"

if (-not (Test-Path "$BT\aapt2.exe")) { throw "缺 aapt2：请先解压 SDK（tools\android-sdk-zips）" }
$env:JAVA_HOME = $JDK
$env:PATH = "$JDK\bin;$env:PATH"

New-Item -ItemType Directory -Force -Path "$BUILD\gen","$BUILD\classes","$BUILD\dex" | Out-Null
Remove-Item "$BUILD\gen\*","$BUILD\classes\*","$BUILD\dex\*" -Recurse -Force -ErrorAction SilentlyContinue

function Step($n, $msg) { Write-Host "[$n/8] $msg" }

# ---- 1. 编译资源 ----
Step 1 "aapt2 compile 资源..."
& "$BT\aapt2.exe" compile --dir "$APP\res" -o "$BUILD\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }

# ---- 2. 链接资源 + 生成 R.java（assets 不走 -A：aapt2 在 Windows 下会打成反斜杠路径）----
Step 2 "aapt2 link 打包基础 APK..."
& "$BT\aapt2.exe" link -o "$BUILD\base.apk" -I $AJAR `
    --manifest "$APP\AndroidManifest.xml" --java "$BUILD\gen" `
    "$BUILD\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

# ---- 3. javac 编译 Java ----
Step 3 "javac 编译..."
$sources = @(Get-ChildItem "$APP\java" -Recurse -Filter *.java) + @(Get-ChildItem "$BUILD\gen" -Recurse -Filter *.java)
& "$JDK\bin\javac.exe" -source 8 -target 8 -nowarn -bootclasspath $AJAR `
    -classpath "$BUILD\gen" -d "$BUILD\classes" $sources.FullName
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

# ---- 4. d8 转 dex（先打包 jar；直接 java -cp 调 33.0.2 的 d8.jar：
#      34.0.0 的 d8 有匿名类 NPE bug，33.0.2 的 d8.bat 用了 JDK9 移除的 ext.dirs）----
Step 4 "d8 转换 dex..."
& "$JDK\bin\jar.exe" cf "$BUILD\classes.jar" -C "$BUILD\classes" .
if ($LASTEXITCODE -ne 0) { throw "jar cf 失败" }
& "$JDK\bin\java.exe" -cp "$SDK\build-tools\33.0.2\lib\d8.jar" com.android.tools.r8.D8 `
    --release --lib $AJAR --min-api 23 --output "$BUILD\dex" "$BUILD\classes.jar"
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

# ---- 5. classes.dex + 内置网页塞进 APK（jar 写入用正斜杠路径）----
Step 5 "打包 classes.dex 与 assets..."
& "$JDK\bin\jar.exe" uf "$BUILD\base.apk" -C "$BUILD\dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar dex 失败" }
New-Item -ItemType Directory -Force -Path "$BUILD\stage\assets\www" | Out-Null
Copy-Item "$APP\assets\www\index.html" "$BUILD\stage\assets\www\index.html" -Force
& "$JDK\bin\jar.exe" uf "$BUILD\base.apk" -C "$BUILD\stage" assets/www/index.html
if ($LASTEXITCODE -ne 0) { throw "jar assets 失败" }

# ---- 6. 对齐 ----
Step 6 "zipalign 对齐..."
& "$BT\zipalign.exe" -f 4 "$BUILD\base.apk" "$BUILD\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

# ---- 7. 签名（首次自动生成调试证书）----
Step 7 "签名..."
$KS = "$BUILD\debug.keystore"
if (-not (Test-Path $KS)) {
    & "$JDK\bin\keytool.exe" -genkeypair -keystore $KS -alias yuepao `
        -storepass yuepao123 -keypass yuepao123 -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=YuePao,O=Run,C=CN"
}
& "$BT\apksigner.bat" sign --ks $KS --ks-pass pass:yuepao123 --key-pass pass:yuepao123 `
    --out "$ROOT\run-app\yuepao-release.apk" "$BUILD\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }

# ---- 8. 校验 ----
Step 8 "校验签名..."
& "$BT\apksigner.bat" verify --print-certs "$ROOT\run-app\yuepao-release.apk" | Select-Object -First 2

$size = [math]::Round((Get-Item "$ROOT\run-app\yuepao-release.apk").Length / 1KB)
Write-Host ""
Write-Host "构建完成 ✓  D:\xm\aiyuelao\run-app\yuepao-release.apk ($size KB)"
Write-Host "安装：把 APK 传到手机安装；或 USB 连接后  tools\android-sdk\platform-tools\adb.exe install -r yuepao-release.apk"
