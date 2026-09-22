const express = require('express');
const { q } = require('../db');
const { publicUser } = require('../util');

const router = express.Router();

/** 修改我的资料（昵称/头像/性别/地区/签名/微信号） */
router.put('/users/me', async (req, res) => {
  const me = req.user;
  const b = req.body || {};
  const patch = {};
  if (typeof b.nickname === 'string' && b.nickname.trim()) patch.nickname = b.nickname.trim().slice(0, 64);
  if (typeof b.avatar === 'string') patch.avatar = b.avatar.slice(0, 500);
  if ([0, 1, 2].includes(b.gender)) patch.gender = b.gender;
  if (typeof b.region === 'string') patch.region = b.region.slice(0, 100);
  if (typeof b.signature === 'string') patch.signature = b.signature.slice(0, 200);
  if (typeof b.wx_id === 'string' && b.wx_id && b.wx_id !== me.wx_id) {
    const wxid = b.wx_id.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{5,19}$/.test(wxid))
      return res.status(400).json({ error: '微信号需 6-20 位，字母开头，可含数字、下划线、减号' });
    const dup = await q('SELECT id FROM users WHERE wx_id = ? AND id != ?', [wxid, me.id]);
    if (dup.length) return res.status(409).json({ error: '该微信号已被占用' });
    patch.wx_id = wxid;
  }
  const keys = Object.keys(patch);
  if (!keys.length) return res.json({ ok: true, user: { ...publicUser(me), phone_full: me.phone } });
  await q(
    'UPDATE users SET ' + keys.map((k) => `${k} = ?`).join(', ') + ' WHERE id = ?',
    [...keys.map((k) => patch[k]), me.id]
  );
  const u = (await q('SELECT * FROM users WHERE id = ?', [me.id]))[0];
  res.json({ ok: true, user: { ...publicUser(u), phone_full: u.phone } });
});

/** 搜索用户：手机号 / 微信号 精确，昵称模糊（带是否好友标记） */
router.get('/users/search', async (req, res) => {
  const me = req.user;
  const kw = String(req.query.keyword || '').trim();
  if (!kw) return res.json({ users: [] });
  let rows;
  if (/^1\d{10}$/.test(kw)) {
    rows = await q('SELECT * FROM users WHERE phone = ? AND id != ?', [kw, me.id]);
  } else if (/^[a-zA-Z][a-zA-Z0-9_-]{5,19}$/.test(kw)) {
    rows = await q('SELECT * FROM users WHERE wx_id = ? AND id != ?', [kw, me.id]);
    if (!rows.length) rows = await q('SELECT * FROM users WHERE nickname LIKE ? AND id != ? LIMIT 20', ['%' + kw + '%', me.id]);
  } else {
    rows = await q('SELECT * FROM users WHERE nickname LIKE ? AND id != ? LIMIT 20', ['%' + kw + '%', me.id]);
  }
  const friendRows = await q('SELECT friend_id FROM friendships WHERE user_id = ?', [me.id]);
  const friendSet = new Set(friendRows.map((r) => r.friend_id));
  res.json({ users: rows.map((u) => ({ ...publicUser(u), is_friend: friendSet.has(u.id) })) });
});

/** 查某人公开资料（含与我的关系：是否好友/是否拉黑） */
router.get('/users/:id', async (req, res) => {
  const me = req.user;
  const uid = parseInt(req.params.id, 10);
  const rows = await q('SELECT * FROM users WHERE id = ?', [uid]);
  if (!rows.length) return res.status(404).json({ error: '用户不存在' });
  const fr = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?', [me.id, uid]);
  res.json({
    user: publicUser(rows[0]),
    is_friend: fr.length > 0,
    blacklisted: fr.length ? !!fr[0].blacklisted : false,
    remark: fr.length ? fr[0].remark : '',
  });
});

module.exports = router;
