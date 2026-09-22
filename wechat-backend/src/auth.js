const jwt = require('jsonwebtoken');
const cfg = require('./config');
const { q } = require('./db');

function signToken(uid) {
  return jwt.sign({ uid }, cfg.JWT_SECRET, { expiresIn: cfg.TOKEN_TTL });
}

/** Express 中间件：校验 Bearer token，注入 req.user（完整用户行） */
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录' });
  let payload;
  try {
    payload = jwt.verify(token, cfg.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  const rows = await q('SELECT * FROM users WHERE id = ?', [payload.uid]);
  if (!rows.length) return res.status(401).json({ error: '账号不存在' });
  req.user = rows[0];
  next();
}

module.exports = { signToken, requireAuth };
