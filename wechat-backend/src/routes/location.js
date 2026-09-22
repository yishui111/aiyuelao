const express = require('express');
const { q } = require('../db');
const { haversine, bearing, fmtDistance, publicUser } = require('../util');
const { emitToUsers } = require('../socket');
const cfg = require('../config');

const router = express.Router();

/** 是否互为好友且互相未拉黑 */
async function friendOk(meId, otherId) {
  const rows = await q(
    'SELECT * FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [meId, otherId, otherId, meId]
  );
  return rows.length === 2 && !rows.some((r) => r.blacklisted);
}

/** 上报位置（APP 周期调用；若正在实时共享中，立即把全员最新坐标推给共享房间） */
router.post('/location/report', async (req, res) => {
  const me = req.user;
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return res.status(400).json({ error: '经纬度不合法' });
  await q(
    `INSERT INTO user_locations (user_id, lat, lng, accuracy, speed, bearing, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lat = VALUES(lat), lng = VALUES(lng), accuracy = VALUES(accuracy),
       speed = VALUES(speed), bearing = VALUES(bearing), source = VALUES(source), updated_at = NOW()`,
    [me.id, lat, lng, req.body.accuracy || 0, req.body.speed || 0, req.body.bearing || 0,
     req.body.source === 'network' ? 'network' : 'gps']
  );
  await q('UPDATE users SET last_active_at = NOW() WHERE id = ?', [me.id]);

  // 正在参与的活跃共享 → 推送最新参与者坐标
  const shares = await q(
    `SELECT s.id FROM location_shares s
     JOIN location_share_members m ON m.share_id = s.id
     WHERE m.user_id = ? AND s.status = 'active'`,
    [me.id]
  );
  for (const s of shares) await pushShareUpdate(s.id);
  res.json({ ok: true });
});

/** 查看某人最新位置（限好友且互未拉黑） */
router.get('/location/:uid', async (req, res) => {
  const me = req.user;
  const uid = parseInt(req.params.uid, 10);
  if (uid !== me.id && !(await friendOk(me.id, uid)))
    return res.status(403).json({ error: '仅好友之间可查看位置' });
  const rows = await q('SELECT * FROM user_locations WHERE user_id = ?', [uid]);
  if (!rows.length) return res.status(404).json({ error: '对方还没有上报过位置' });
  const loc = rows[0];
  let mine = null;
  if (uid !== me.id) {
    const my = await q('SELECT * FROM user_locations WHERE user_id = ?', [me.id]);
    if (my.length) {
      const dist = haversine(my[0].lat, my[0].lng, loc.lat, loc.lng);
      mine = { distance_m: Math.round(dist), distance_text: fmtDistance(dist), bearing: Math.round(bearing(my[0].lat, my[0].lng, loc.lat, loc.lng)) };
    }
  }
  res.json({
    user_id: uid,
    lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, source: loc.source,
    updated_at: loc.updated_at,
    age_seconds: Math.round((Date.now() - new Date(loc.updated_at).getTime()) / 1000),
    relative_to_me: mine,
  });
});

/** 实时位置共享参与者推送 */
async function pushShareUpdate(shareId) {
  const share = (await q('SELECT * FROM location_shares WHERE id = ?', [shareId]))[0];
  if (!share) return;
  const parts = await q(
    `SELECT u.id, u.nickname, u.avatar, l.lat, l.lng, l.accuracy, l.updated_at
     FROM location_share_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN user_locations l ON l.user_id = m.user_id
     WHERE m.share_id = ? ORDER BY m.id`,
    [shareId]
  );
  emitToUsers(parts.map((p) => p.id), 'share_update', {
    share_id: shareId,
    conversation_id: share.conversation_id,
    status: share.status,
    participants: parts,
  });
}

/** 发起实时位置共享（会话内），并往会话里发一张"共享卡片"消息 */
router.post('/location/shares', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.body.conversation_id, 10);
  const mine = await q('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [convId, me.id]);
  if (!mine.length) return res.status(403).json({ error: '不在该会话中' });
  const r = await q(
    "INSERT INTO location_shares (conversation_id, initiated_by) VALUES (?, ?)",
    [convId, me.id]
  );
  await q('INSERT IGNORE INTO location_share_members (share_id, user_id) VALUES (?, ?)', [r.insertId, me.id]);
  const msg = await q(
    "INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, 'share', ?)",
    [convId, me.id, JSON.stringify({ share_id: r.insertId })]
  );
  const memberIds = (await q('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [convId])).map((x) => x.user_id);
  emitToUsers(memberIds, 'msg', {
    message: { id: msg.insertId, conversation_id: convId, sender_id: me.id, type: 'share', content: { share_id: r.insertId }, revoked: false, created_at: new Date() },
    conversation_id: convId,
  });
  await pushShareUpdate(r.insertId);
  res.json({ share_id: r.insertId });
});

/** 加入实时位置共享 */
router.post('/location/shares/:id/join', async (req, res) => {
  const me = req.user;
  const share = (await q('SELECT * FROM location_shares WHERE id = ?', [req.params.id]))[0];
  if (!share) return res.status(404).json({ error: '共享不存在' });
  if (share.status !== 'active') return res.status(409).json({ error: '共享已结束' });
  const mine = await q('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [share.conversation_id, me.id]);
  if (!mine.length) return res.status(403).json({ error: '不在该会话中' });
  await q('INSERT IGNORE INTO location_share_members (share_id, user_id) VALUES (?, ?)', [share.id, me.id]);
  await pushShareUpdate(share.id);
  res.json({ ok: true });
});

/** 退出共享（全员退出后自动结束） */
router.post('/location/shares/:id/leave', async (req, res) => {
  const me = req.user;
  const share = (await q('SELECT * FROM location_shares WHERE id = ?', [req.params.id]))[0];
  if (!share) return res.status(404).json({ error: '共享不存在' });
  await q('DELETE FROM location_share_members WHERE share_id = ? AND user_id = ?', [share.id, me.id]);
  const rest = await q('SELECT user_id FROM location_share_members WHERE share_id = ?', [share.id]);
  if (!rest.length) {
    await q("UPDATE location_shares SET status = 'ended', ended_at = NOW() WHERE id = ?", [share.id]);
    emitToUsers([me.id], 'share_update', { share_id: share.id, conversation_id: share.conversation_id, status: 'ended', participants: [] });
  } else {
    await pushShareUpdate(share.id);
  }
  res.json({ ok: true });
});

/** 查询共享（参与者+各自最新坐标） */
router.get('/location/shares/:id', async (req, res) => {
  const share = (await q('SELECT * FROM location_shares WHERE id = ?', [req.params.id]))[0];
  if (!share) return res.status(404).json({ error: '共享不存在' });
  const parts = await q(
    `SELECT u.id, u.nickname, u.avatar, l.lat, l.lng, l.accuracy, l.updated_at
     FROM location_share_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN user_locations l ON l.user_id = m.user_id
     WHERE m.share_id = ? ORDER BY m.id`,
    [share.id]
  );
  res.json({ share, participants: parts });
});

/** 附近的人（1 小时内上报过位置的用户，按距离升序） */
router.get('/location/nearby/list', async (req, res) => {
  const me = req.user;
  const radius = Math.min(50, parseFloat(req.query.radius_km) || 5) * 1000;
  const my = await q('SELECT * FROM user_locations WHERE user_id = ?', [me.id]);
  if (!my.length) return res.status(400).json({ error: '请先开启定位' });
  const rows = await q(
    `SELECT u.id, u.nickname, u.avatar, u.gender, u.signature, u.wx_id, l.lat, l.lng, l.updated_at
     FROM user_locations l JOIN users u ON u.id = l.user_id
     WHERE l.user_id != ? AND l.updated_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    [me.id]
  );
  const black = await q(
    `SELECT friend_id FROM friendships WHERE user_id = ? AND blacklisted = 1
     UNION SELECT user_id FROM friendships WHERE friend_id = ? AND blacklisted = 1`,
    [me.id, me.id]
  );
  const blocked = new Set(black.map((r) => r.friend_id || r.user_id));
  const myFriends = new Set(
    (await q('SELECT friend_id FROM friendships WHERE user_id = ? AND blacklisted = 0', [me.id])).map((r) => r.friend_id)
  );
  const out = rows
    .filter((r) => !blocked.has(r.id))
    .map((r) => ({ ...publicUser(r), lat: r.lat, lng: r.lng, is_friend: myFriends.has(r.id), distance_m: Math.round(haversine(my[0].lat, my[0].lng, r.lat, r.lng)) }))
    .filter((r) => r.distance_m <= radius)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, 50)
    .map((r) => ({ ...r, distance_text: fmtDistance(r.distance_m) }));
  res.json({ users: out });
});

/** 兜底清理：超过时限的共享自动结束（入口路由挂载后每分钟跑一次） */
setInterval(() => {
  q(
    `SELECT id FROM location_shares WHERE status = 'active' AND started_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [cfg.SHARE_MAX_HOURS]
  )
    .then(async (rows) => {
      for (const r of rows) {
        await q("UPDATE location_shares SET status = 'ended', ended_at = NOW() WHERE id = ?", [r.id]);
        await pushShareUpdate(r.id).catch(() => {});
      }
    })
    .catch(() => {});
}, 60 * 1000).unref();

module.exports = router;
