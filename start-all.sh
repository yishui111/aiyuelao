#!/bin/bash
# ============================================================
# AI月老 — 一键启动全部服务（原生进程，无 Docker）
# 用法: bash start-all.sh
# ============================================================
ROOT="D:/xm/aiyuelao"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

echo "[1/8] 启动 MongoDB（Shidduch 依赖, 端口 27017）..."
MONGOD=$(find "$ROOT/tools/mongodb-extracted" -name "mongod.exe" | head -1)
("$MONGOD" --dbpath "$ROOT/data/mongo" --port 27017 --wiredTigerCacheSizeGB 0.25 --bind_ip 127.0.0.1 > "$LOGS/mongodb.log" 2>&1 &)

echo "[2/8] 启动 MySQL（wang-ai-agent 依赖, 端口 3306）..."
MYSQLD="$ROOT/tools/mysql-extracted/mysql-8.0.42-winx64/bin/mysqld.exe"
("$MYSQLD" --no-defaults --datadir="D:/xm/aiyuelao/data/mysql" --port=3306 --console > "$LOGS/mysql.log" 2>&1 &)
sleep 6

echo "[3/8] 启动 ANL 后端（内存数据库模式, 端口 3001）..."
(cd "$ROOT/projects/ANL/backend" && node server-minimal.js > "$LOGS/anl-backend.log" 2>&1 &)

echo "[4/8] 启动 ANL 前端（端口 5173）..."
(cd "$ROOT/projects/ANL" && npm run dev > "$LOGS/anl-frontend.log" 2>&1 &)

echo "[5/8] 启动 AI 匹配引擎 ai-powered-matching-algorithm（端口 8001）..."
(cd "$ROOT/projects/ai-powered-matching-algorithm" && ./.venv/Scripts/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8001 > "$LOGS/matching-algo.log" 2>&1 &)

echo "[6/8] 启动 GlowMeet 后端（内存持久化, 端口 8000）+ 前端（端口 3000）..."
(cd "$ROOT/projects/GlowMeet/backend" && PERSISTENCE=memory PORT=8000 X_CLIENT_ID=dev-client-id X_CLIENT_SECRET=dev-client-secret X_REDIRECT_URL=http://localhost:3000/auth/x/callback APP_JWT_SECRET=dev-secret ./glowmeet.exe > "$LOGS/glowmeet-backend.log" 2>&1 &)
(cd "$ROOT/projects/GlowMeet/web" && npm run dev > "$LOGS/glowmeet-web.log" 2>&1 &)

echo "[7/8] 启动 Shidduch 后端（端口 8010）+ 前端（端口 5174）..."
(cd "$ROOT/projects/shidduch-app/backend" && ./.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8010 > "$LOGS/shidduch-backend.log" 2>&1 &)
(cd "$ROOT/projects/shidduch-app/frontend" && npm run dev > "$LOGS/shidduch-frontend.log" 2>&1 &)

echo "[8/8] 启动 wang-ai-agent 后端（端口 8123）+ 前端（端口 5175）..."
WANG_JAR=$(ls "$ROOT/projects/wang-ai-agent/target/"*.jar 2>/dev/null | head -1)
if [ -n "$WANG_JAR" ]; then
  (cd "$ROOT/projects/wang-ai-agent" && JAVA_HOME="$ROOT/tools/jdk21-extracted/jdk-21.0.12.1+1" "$ROOT/tools/jdk21-extracted/jdk-21.0.12.1+1/bin/java.exe" -jar "$WANG_JAR" > "$LOGS/wang-backend.log" 2>&1 &)
else
  echo "  !! 未找到 wang-ai-agent jar，跳过（先执行 mvnw package）"
fi
(cd "$ROOT/projects/wang-ai-agent/wang-ai-agent-frontend" && npm run dev > "$LOGS/wang-frontend.log" 2>&1 &)

echo ""
echo "全部服务已拉起，等待 15 秒后自检..."
sleep 15
check() { code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$1" 2>/dev/null); if [ "$code" != "000" ] && [ -n "$code" ]; then echo "  ✓ $2  ($1 → HTTP $code)"; else echo "  ✗ $2  ($1 无响应，查 $3)"; fi; }
check "http://localhost:3001/api/health"  "ANL 后端        " "$LOGS/anl-backend.log"
check "http://localhost:5173/"            "ANL 前端        " "$LOGS/anl-frontend.log"
check "http://127.0.0.1:8001/docs"        "AI匹配引擎      " "$LOGS/matching-algo.log"
check "http://localhost:8000/"            "GlowMeet 后端   " "$LOGS/glowmeet-backend.log"
check "http://localhost:3000/"            "GlowMeet 前端   " "$LOGS/glowmeet-web.log"
check "http://127.0.0.1:8010/health/ready""Shidduch 后端   " "$LOGS/shidduch-backend.log"
check "http://localhost:5174/"            "Shidduch 前端   " "$LOGS/shidduch-frontend.log"
check "http://localhost:8123/api/health/ok" "wang 后端" "$LOGS/wang-backend.log"
check "http://localhost:5175/"            "wang 前端       " "$LOGS/wang-frontend.log"
echo ""
echo "停止全部服务: bash stop-all.sh"
