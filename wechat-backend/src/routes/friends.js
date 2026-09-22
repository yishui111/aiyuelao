const express = require('express');
const { q } = require('../db');
const { publicUser } = require('../util');
const { emitToUsers } = require('../socket');

const router = express.Router();

/** 好友关系辅助：返回 [是否好友, 好友行(我的视角), 好友行(对方视角)] */
async function relation(meId, otherId) {
  const mine = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?', [meId, otherId]);
  const theirs = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?', [otherId, meId]);
  return [mine.length > 0 && theirs.length > 0, mine[0] || null, theirs[0] || null];
}

/** 发好友申请：target 可以是 user_id / 手机号 / 微信号 */
router.post('/friends/requests', async (req, res) => {
  const me = req.user;
  const b = req.body || {};
  let target = null;
  if (b.target_uid) {
    target = (await q('SELECT * FROM users WHERE id = ?', [b.target_uid]))[0];
  } else if (typeof b.target === 'string') {
    if (/^1\d{10}$/.test(b.target)) target = (await q('SELECT * FROM users WHERE phone = ?', [b.target]))[0];
    else target = (await q('SELECT * FROM users WHERE wx_id = ?', [b.target]))[0];
  }
  if (!target) return res.status(404).json({ error: '找不到该用户' });
  if (target.id === me.id) return res.status(400).json({ error: '不能添加自己' });

  const [isFriend, , theirs] = await relation(me.id, target.id);
  if (isFriend) return res.status(409).json({ error: '你们已经是好友了' });
  if (theirs && theirs.blacklisted) return res.status(403).json({ error: '对方已将你加入黑名单' });

  const dup = await q(
    "SELECT * FROM friend_requests WHERE from_uid = ? AND to_uid = ? AND status = 'pending'",
    [me.id, target.id]
  );
  if (dup.length) return res.status(409).json({ error: '已发送过申请，等待对方验证' });

  const r = await q(
    "INSERT INTO friend_requests (from_uid, to_uid, message) VALUES (?, ?, ?)",
    [me.id, target.id, String(b.message || '我是' + me.nickname).slice(0, 200)]
  );
  const request = (await q('SELECT * FROM friend_requests WHERE id = ?', [r.insertId]))[0];
  emitToUsers([target.id], 'friend_request', { request, from_user: publicUser(me) });
  res.json({ ok: true, request });
});

/** 收到的/发出的好友申请列表 */
router.get('/friends/requests', async (req, res) => {
  const me = req.user;
  const received = await q(
    `SELECT r.*, u.nickname, u.avatar, u.wx_id FROM friend_requests r
     JOIN users u ON u.id = r.from_uid WHERE r.to_uid = ? ORDER BY r.id DESC LIMIT 100`,
    [me.id]
  );
  const sent = await q(
    `SELECT r.*, u.nickname, u.avatar, u.wx_id FROM friend_requests r
     JOIN users u ON u.id = r.to_uid WHERE r.from_uid = ? ORDER BY r.id DESC LIMIT 100`,
    [me.id]
  );
  res.json({ received, sent });
});

/** 同意好友申请 → 双向写好友关系（仿微信） */
router.post('/friends/requests/:id/accept', async (req, res) => {
  const me = req.user;
  const rows = await q('SELECT * FROM friend_requests WHERE id = ?', [req.params.id]);
  const reqRow = rows[0];
  if (!reqRow || reqRow.to_uid !== me.id) return res.status(404).json({ error: '申请不存在' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: '该申请已处理' });

  await q("UPDATE friend_requests SET status = 'accepted', handled_at = NOW() WHERE id = ?", [reqRow.id]);
  await q('INSERT IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?), (?, ?)', [
    me.id, reqRow.from_uid, reqRow.from_uid, me.id,
  ]);
  const fromUser = (await q('SELECT * FROM users WHERE id = ?', [reqRow.from_uid]))[0];
  emitToUsers([reqRow.from_uid], 'friend_handled', {
    request_id: reqRow.id, status: 'accepted', by_user: publicUser(me),
  });
  res.json({ ok: true, friend: publicUser(fromUser) });
});

/** 拒绝好友申请 */
router.post('/friends/requests/:id/reject', async (req, res) => {
  const me = req.user;
  const rows = await q('SELECT * FROM friend_requests WHERE id = ?', [req.params.id]);
  const reqRow = rows[0];
  if (!reqRow || reqRow.to_uid !== me.id) return res.status(404).json({ error: '申请不存在' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: '该申请已处理' });
  await q("UPDATE friend_requests SET status = 'rejected', handled_at = NOW() WHERE id = ?", [reqRow.id]);
  emitToUsers([reqRow.from_uid], 'friend_handled', {
    request_id: reqRow.id, status: 'rejected', by_user: publicUser(me),
  });
  res.json({ ok: true });
});

/** 通讯录列表（带备注/拉黑标记） */
router.get('/friends', async (req, res) => {
  const me = req.user;
  const rows = await q(
    `SELECT u.id, u.wx_id, u.nickname, u.avatar, u.gender, u.region, u.signature,
            f.remark, f.blacklisted, f.created_at AS friend_since
     FROM friendships f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? ORDER BY u.nickname`,
    [me.id]
  );
  res.json({ friends: rows });
});

/** 设置备注 / 拉黑 / 取消拉黑 */
router.put('/friends/:uid', async (req, res) => {
  const me = req.user;
  const uid = parseInt(req.params.uid, 10);
  const b = req.body || {};
  const mine = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?', [me.id, uid]);
  if (!mine.length) return res.status(404).json({ error: '不是好友' });
  const patch = {};
  if (typeof b.remark === 'string') patch.remark = b.remark.trim().slice(0, 64);
  if (typeof b.blacklisted === 'boolean') patch.blacklisted = b.blacklisted ? 1 : 0;
  const keys = Object.keys(patch);
  if (keys.length) {
    await q(
      'UPDATE friendships SET ' + keys.map((k) => `${k} = ?`).join(', ') + ' WHERE user_id = ? AND friend_id = ?',
      [...keys.map((k) => patch[k]), me.id, uid]
    );
  }
  res.json({ ok: true });
});

/** 删除好友（双向解除，聊天记录保留） */
router.delete('/friends/:uid', async (req, res) => {
  const me = req.user;
  const uid = parseInt(req.params.uid, 10);
  await q('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', [
    me.id, uid, uid, me.id,
  ]);
  emitToUsers([uid], 'friend_deleted', { by_user: publicUser(me) });
  res.json({ ok: true });
});

module.exports = router;
