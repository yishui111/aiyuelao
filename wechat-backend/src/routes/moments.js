const express = require('express');
const { q } = require('../db');
const { publicUser } = require('../util');
const { emitToUsers } = require('../socket');

const router = express.Router();

function parseImgs(m) {
  if (!m.images) return [];
  try {
    const v = typeof m.images === 'string' ? JSON.parse(m.images) : m.images;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function decorate(rows, meId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const likes = await q(
    `SELECT k.moment_id, k.user_id, u.nickname FROM moment_likes k
     JOIN users u ON u.id = k.user_id WHERE k.moment_id IN (${ids.map(() => '?').join(',')})
     ORDER BY k.id`,
    ids
  );
  const comments = await q(
    `SELECT c.*, u.nickname AS user_nickname, r.nickname AS reply_to_nickname
     FROM moment_comments c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN users r ON r.id = c.reply_to_uid
     WHERE c.moment_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.id`,
    ids
  );
  return rows.map((m) => {
    const mlikes = likes.filter((l) => l.moment_id === m.id);
    const mcomments = comments.filter((c) => c.moment_id === m.id);
    return {
      id: m.id,
      user: { id: m.user_id, nickname: m.nickname, avatar: m.avatar },
      content: m.content || '',
      images: parseImgs(m),
      location: m.location || '',
      created_at: m.created_at,
      likes: mlikes.map((l) => ({ user_id: l.user_id, nickname: l.nickname })),
      liked_by_me: mlikes.some((l) => l.user_id === meId),
      comments: mcomments.map((c) => ({
        id: c.id, user_id: c.user_id, nickname: c.user_nickname,
        reply_to_uid: c.reply_to_uid || 0, reply_to_nickname: c.reply_to_nickname || '',
        content: c.content, created_at: c.created_at,
      })),
    };
  });
}

/** 发朋友圈（文字+图片+位置） */
router.post('/moments', async (req, res) => {
  const me = req.user;
  const content = String(req.body.content || '').trim().slice(0, 2000);
  const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 9).map(String).slice(0, 500) : [];
  if (!content && !images.length) return res.status(400).json({ error: '写点什么或选张图片吧' });
  const r = await q('INSERT INTO moments (user_id, content, images, location) VALUES (?, ?, ?, ?)', [
    me.id, content, JSON.stringify(images), String(req.body.location || '').slice(0, 200),
  ]);
  const row = (await q(
    'SELECT m.*, u.nickname, u.avatar FROM moments m JOIN users u ON u.id = m.user_id WHERE m.id = ?',
    [r.insertId]
  ))[0];
  res.json({ moment: (await decorate([row], me.id))[0] });
});

/** 朋友圈信息流（我的+好友的，倒序翻页） */
router.get('/moments', async (req, res) => {
  const me = req.user;
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
  const beforeId = parseInt(req.query.before_id, 10) || 0;
  const params = [me.id];
  let where = '(m.user_id = ? OR m.user_id IN (SELECT friend_id FROM friendships WHERE user_id = ?';
  params.push(me.id);
  where += ' AND blacklisted = 0))';
  if (beforeId > 0) { where += ' AND m.id < ?'; params.push(beforeId); }
  const rows = await q(
    `SELECT m.*, u.nickname, u.avatar FROM moments m JOIN users u ON u.id = m.user_id
     WHERE ${where} ORDER BY m.id DESC LIMIT ${limit}`,
    params
  );
  res.json({ moments: await decorate(rows, me.id), has_more: rows.length === limit });
});

/** 某人的朋友圈主页（本人或好友） */
router.get('/moments/user/:uid', async (req, res) => {
  const me = req.user;
  const uid = parseInt(req.params.uid, 10);
  if (uid !== me.id) {
    const fr = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ? AND blacklisted = 0', [me.id, uid]);
    if (!fr.length) return res.status(403).json({ error: '仅好友可查看朋友圈' });
  }
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
  const beforeId = parseInt(req.query.before_id, 10) || 0;
  const params = [uid];
  let where = 'm.user_id = ?';
  if (beforeId > 0) { where += ' AND m.id < ?'; params.push(beforeId); }
  const rows = await q(
    `SELECT m.*, u.nickname, u.avatar FROM moments m JOIN users u ON u.id = m.user_id
     WHERE ${where} ORDER BY m.id DESC LIMIT ${limit}`,
    params
  );
  res.json({ moments: await decorate(rows, me.id), has_more: rows.length === limit });
});

/** 点赞/取消点赞（幂等切换） */
router.post('/moments/:id/like', async (req, res) => {
  const me = req.user;
  const mid = parseInt(req.params.id, 10);
  const moment = (await q('SELECT * FROM moments WHERE id = ?', [mid]))[0];
  if (!moment) return res.status(404).json({ error: '该条不存在' });
  const has = await q('SELECT id FROM moment_likes WHERE moment_id = ? AND user_id = ?', [mid, me.id]);
  let liked;
  if (has.length) {
    await q('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?', [mid, me.id]);
    liked = false;
  } else {
    await q('INSERT INTO moment_likes (moment_id, user_id) VALUES (?, ?)', [mid, me.id]);
    liked = true;
    if (moment.user_id !== me.id)
      emitToUsers([moment.user_id], 'moment_notify', { action: 'like', moment_id: mid, by_user: publicUser(me) });
  }
  res.json({ ok: true, liked });
});

/** 评论（可回复某人；仅好友） */
router.post('/moments/:id/comments', async (req, res) => {
  const me = req.user;
  const mid = parseInt(req.params.id, 10);
  const moment = (await q('SELECT * FROM moments WHERE id = ?', [mid]))[0];
  if (!moment) return res.status(404).json({ error: '该条不存在' });
  if (moment.user_id !== me.id) {
    const fr = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ? AND blacklisted = 0', [me.id, moment.user_id]);
    if (!fr.length) return res.status(403).json({ error: '仅好友可评论' });
  }
  const content = String(req.body.content || '').trim().slice(0, 500);
  if (!content) return res.status(400).json({ error: '评论不能为空' });
  let replyTo = parseInt(req.body.reply_to_uid, 10) || 0;
  if (replyTo) {
    const valid = await q(
      'SELECT id FROM moment_comments WHERE moment_id = ? AND user_id = ?',
      [mid, replyTo]
    );
    if (!valid.length && replyTo !== moment.user_id) replyTo = 0;
  }
  const r = await q('INSERT INTO moment_comments (moment_id, user_id, reply_to_uid, content) VALUES (?, ?, ?, ?)', [
    mid, me.id, replyTo, content,
  ]);
  if (moment.user_id !== me.id)
    emitToUsers([moment.user_id], 'moment_notify', { action: 'comment', moment_id: mid, by_user: publicUser(me) });
  res.json({
    comment: {
      id: r.insertId, user_id: me.id, nickname: me.nickname,
      reply_to_uid: replyTo, reply_to_nickname: '', content, created_at: new Date(),
    },
  });
});

/** 删除自己的朋友圈 */
router.delete('/moments/:id', async (req, res) => {
  const me = req.user;
  const mid = parseInt(req.params.id, 10);
  const moment = (await q('SELECT * FROM moments WHERE id = ?', [mid]))[0];
  if (!moment || moment.user_id !== me.id) return res.status(404).json({ error: '该条不存在' });
  await q('DELETE FROM moments WHERE id = ?', [mid]);
  await q('DELETE FROM moment_likes WHERE moment_id = ?', [mid]);
  await q('DELETE FROM moment_comments WHERE moment_id = ?', [mid]);
  res.json({ ok: true });
});

/** 删除评论（评论者本人或朋友圈主人） */
router.delete('/moments/:id/comments/:cid', async (req, res) => {
  const me = req.user;
  const mid = parseInt(req.params.id, 10);
  const cid = parseInt(req.params.cid, 10);
  const moment = (await q('SELECT * FROM moments WHERE id = ?', [mid]))[0];
  const comment = (await q('SELECT * FROM moment_comments WHERE id = ? AND moment_id = ?', [cid, mid]))[0];
  if (!moment || !comment) return res.status(404).json({ error: '评论不存在' });
  if (me.id !== moment.user_id && me.id !== comment.user_id)
    return res.status(403).json({ error: '无权删除该评论' });
  await q('DELETE FROM moment_comments WHERE id = ?', [cid]);
  res.json({ ok: true });
});

module.exports = router;
