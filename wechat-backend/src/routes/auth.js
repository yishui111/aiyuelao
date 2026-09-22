const express = require('express');
const crypto = require('crypto');
const { q } = require('../db');
const { signToken } = require('../auth');
const cfg = require('../config');
const { publicUser } = require('../util');

const router = express.Router();

/** 生成默认微信号 */
function genWxId(phone) {
  return 'wl_' + phone.slice(-4) + crypto.randomBytes(3).toString('hex');
}

/** 发验证码（局域网模式不接真实短信，直接返回） */
router.post('/auth/smscode', async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式不对' });
  const code = cfg.SMS_DEV_CODE || crypto.randomInt(100000, 999999).toString();
  await q(
    'INSERT INTO sms_codes (phone, code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
    [phone, code]
  );
  res.json({ ok: true, dev_code: code }); // 开发模式回显验证码
});

/** 登录（手机号+验证码；新手机号自动注册，同微信"首次登录即注册"） */
router.post('/auth/login', async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  const code = String(req.body.code || '').trim();
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式不对' });

  const rows = await q(
    'SELECT * FROM sms_codes WHERE phone = ? AND used = 0 AND expires_at > NOW() ORDER BY id DESC LIMIT 5',
    [phone]
  );
  const ok = rows.some((r) => r.code === code);
  if (!ok) return res.status(401).json({ error: '验证码错误或已过期' });
  await q('UPDATE sms_codes SET used = 1 WHERE phone = ? AND code = ?', [phone, code]);

  let users = await q('SELECT * FROM users WHERE phone = ?', [phone]);
  let user = users[0];
  if (!user) {
    const r = await q(
      'INSERT INTO users (phone, wx_id, nickname) VALUES (?, ?, ?)',
      [phone, genWxId(phone), '微友' + phone.slice(-4)]
    );
    user = (await q('SELECT * FROM users WHERE id = ?', [r.insertId]))[0];
  }
  await q('UPDATE users SET last_active_at = NOW() WHERE id = ?', [user.id]);
  res.json({ token: signToken(user.id), user: { ...publicUser(user), phone_full: user.phone } });
});

module.exports = router;
