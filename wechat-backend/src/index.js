const express = require('express');
const path = require('path');
const http = require('http');
const cfg = require('./config');
const db = require('./db');
const socket = require('./socket');
const { requireAuth } = require('./auth');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '15mb' })); // 头像等 base64 走 JSON 时放行
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/uploads', express.static(cfg.UPLOAD_DIR, { maxAge: '30d' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'weiliao-backend', db: cfg.DB.database, time: new Date().toISOString() });
});

app.use('/api', require('./routes/auth'));
app.use('/api', requireAuth); // 以下全部接口需要登录
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/friends'));
app.use('/api', require('./routes/conversations'));
app.use('/api', require('./routes/location'));
app.use('/api', require('./routes/moments'));
app.use('/api', require('./routes/upload'));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在: ' + req.method + ' ' + req.path }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: '服务器开小差了，请稍后再试' });
});

async function start(attempt = 1) {
  try {
    await db.init();
  } catch (e) {
    console.error(`[db] MySQL 连接失败（第 ${attempt} 次）: ${e.message}`);
    if (attempt >= 20) {
      console.error('[db] 放弃启动，等待看门狗拉起重试');
      process.exit(1);
    }
    return setTimeout(() => start(attempt + 1), 3000);
  }
  socket.init(server);
  server.listen(cfg.PORT, () => {
    console.log(`[weiliao] 微聊后端已启动 → http://127.0.0.1:${cfg.PORT}  (REST /api/* + WebSocket)`);
  });
}

process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
start();
