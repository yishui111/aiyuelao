const express = require('express');
const { q } = require('../db');
const { publicUser, msgPreview } = require('../util');
const { emitToUsers } = require('../socket');

const router = express.Router();

const MSG_TYPES = ['text', 'image', 'voice', 'video', 'location', 'file', 'share'];

// ---------------- 内部辅助 ----------------

async function isMember(convId, uid) {
  const r = await q('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [convId, uid]);
  return r[0] || null;
}

async function convMembers(convId) {
  return q('SELECT * FROM conversation_members WHERE conversation_id = ?', [convId]);
}

async function getOrCreateSingle(meId, peerId) {
  const exist = await q(
    `SELECT c.id FROM conversations c
     JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
     JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
     WHERE c.type = 'single' LIMIT 1`,
    [meId, peerId]
  );
  if (exist.length) return { convId: exist[0].id, created: false };
  const r = await q("INSERT INTO conversations (type) VALUES ('single')");
  await q('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)', [
    r.insertId, meId, r.insertId, peerId,
  ]);
  return { convId: r.insertId, created: true };
}

async function insertMessage(convId, senderId, type, content) {
  const r = await q('INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, ?, ?)', [
    convId, senderId, type, JSON.stringify(content),
  ]);
  return (await q('SELECT * FROM messages WHERE id = ?', [r.insertId]))[0];
}

/** 会话完整载荷（列表项/新建会话推送共用） */
async function convPayload(convId, meId) {
  const conv = (await q('SELECT * FROM conversations WHERE id = ?', [convId]))[0];
  if (!conv) return null;
  const members = await convMembers(convId);
  const memberIds = members.map((m) => m.user_id);
  const mine = members.find((m) => m.user_id === meId) || {};

  let peer = null;
  if (conv.type === 'single') {
    const peerId = memberIds.find((id) => id !== meId);
    if (peerId != null) {
      const u = (await q('SELECT * FROM users WHERE id = ?', [peerId]))[0];
      const fr = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?', [meId, peerId]);
      peer = { ...publicUser(u), remark: fr.length ? fr[0].remark : '' };
    }
  }
  const lastRows = await q(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
    [convId]
  );
  const last = lastRows[0] || null;
  let unread = 0;
  if (last) {
    const ur = await q(
      'SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND id > ? AND sender_id != ? AND revoked = 0',
      [convId, mine.last_read_msg_id || 0, meId]
    );
    unread = ur[0].n;
  }
  const sender = last && last.sender_id !== meId
    ? (await q('SELECT nickname FROM users WHERE id = ?', [last.sender_id]))[0]
    : { nickname: '' };
  return {
    conversation_id: convId,
    type: conv.type,
    name: conv.type === 'group' ? conv.name : '',
    avatar: conv.type === 'group' ? conv.avatar : '',
    notice: conv.notice || '',
    owner_id: conv.owner_id,
    member_count: memberIds.length,
    peer,
    stick_top: !!mine.stick_top,
    muted: !!mine.muted,
    role: mine.role || 'member',
    unread,
    last_message: last
      ? {
          id: last.id, sender_id: last.sender_id, sender_nickname: sender ? sender.nickname : '',
          type: last.type, preview: msgPreview(last, sender ? sender.nickname : ''),
          revoked: !!last.revoked, created_at: last.created_at,
        }
      : null,
    updated_at: last ? last.created_at : conv.created_at,
  };
}

/** 校验并规范化消息内容 */
function validateContent(type, content) {
  if (typeof content !== 'object' || content === null) return null;
  switch (type) {
    case 'text': {
      const t = String(content.text || '').trim();
      return t ? { text: t.slice(0, 5000) } : null;
    }
    case 'image':
      return content.url ? { url: String(content.url), w: content.w || 0, h: content.h || 0 } : null;
    case 'voice':
      return content.url ? { url: String(content.url), duration: Math.min(60, content.duration || 0) } : null;
    case 'video':
      return content.url ? { url: String(content.url), poster: content.poster || '', duration: content.duration || 0 } : null;
    case 'location':
      if (typeof content.lat !== 'number' || typeof content.lng !== 'number') return null;
      return { lat: content.lat, lng: content.lng, label: String(content.label || '我的位置').slice(0, 100) };
    case 'file':
      return content.url ? { url: String(content.url), name: String(content.name || '文件').slice(0, 200), size: content.size || 0 } : null;
    case 'share':
      return content.share_id ? { share_id: content.share_id } : null;
    default:
      return null;
  }
}

// ---------------- 会话 ----------------

/** 会话列表（置顶在前，其余按最新消息时间倒序） */
router.get('/conversations', async (req, res) => {
  const me = req.user;
  const rows = await q(
    `SELECT cm.conversation_id FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     WHERE cm.user_id = ?`,
    [me.id]
  );
  const list = [];
  for (const r of rows) {
    const p = await convPayload(r.conversation_id, me.id);
    if (p) list.push(p);
  }
  list.sort((a, b) => (b.stick_top - a.stick_top) || (new Date(b.updated_at) - new Date(a.updated_at)));
  res.json({ conversations: list });
});

/** 单聊会话：不存在则创建（必须互为好友） */
router.post('/conversations/single', async (req, res) => {
  const me = req.user;
  const peerId = parseInt(req.body.peer_id, 10);
  if (!peerId || peerId === me.id) return res.status(400).json({ error: '参数错误' });
  const peer = (await q('SELECT * FROM users WHERE id = ?', [peerId]))[0];
  if (!peer) return res.status(404).json({ error: '用户不存在' });
  // 文件传输助手是内置服务账号，无需加好友
  if (peer.wx_id !== 'filehelper') {
    const fr = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?', [me.id, peerId]);
    if (!fr.length) return res.status(403).json({ error: '只能和好友聊天，请先添加好友' });
  }
  const { convId, created } = await getOrCreateSingle(me.id, peerId);
  const payload = await convPayload(convId, me.id);
  if (created) emitToUsers([peerId], 'conv_new', { conversation: await convPayload(convId, peerId) });
  res.json({ conversation: payload });
});

/** 建群（至少再拉 1 人，成员必须是我的好友） */
router.post('/conversations/group', async (req, res) => {
  const me = req.user;
  const name = String(req.body.name || '').trim().slice(0, 64);
  const memberIds = [...new Set((req.body.member_ids || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  if (!memberIds.length) return res.status(400).json({ error: '请选择群成员' });
  const friends = await q('SELECT friend_id FROM friendships WHERE user_id = ?', [me.id]);
  const friendSet = new Set(friends.map((f) => f.friend_id));
  const valid = memberIds.filter((id) => friendSet.has(id));
  if (!valid.length) return res.status(400).json({ error: '群成员必须是你的好友' });

  const r = await q("INSERT INTO conversations (type, name, owner_id) VALUES ('group', ?, ?)", [
    name || '群聊', me.id,
  ]);
  const convId = r.insertId;
  const all = [me.id, ...valid];
  for (const uid of all) {
    await q("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)", [
      convId, uid, uid === me.id ? 'owner' : 'member',
    ]);
  }
  const names = [];
  for (const uid of valid) {
    const u = (await q('SELECT nickname FROM users WHERE id = ?', [uid]))[0];
    names.push(u ? u.nickname : uid);
  }
  const sys = await insertMessage(convId, me.id, 'system', { text: `${me.nickname}邀请${names.join('、')}加入了群聊` });
  emitToUsers(all, 'conv_new', { conversation: await convPayload(convId, me.id) });
  emitToUsers(all, 'msg', { message: sys, conversation_id: convId });
  res.json({ conversation: await convPayload(convId, me.id) });
});

/** 会话详情（成员列表） */
router.get('/conversations/:id', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  if (!(await isMember(convId, me.id))) return res.status(403).json({ error: '不在该会话中' });
  const conv = (await q('SELECT * FROM conversations WHERE id = ?', [convId]))[0];
  const members = await q(
    `SELECT m.user_id, m.role, m.joined_at, u.nickname, u.avatar, u.wx_id, u.gender
     FROM conversation_members m JOIN users u ON u.id = m.user_id
     WHERE m.conversation_id = ? ORDER BY m.role = 'owner' DESC, m.id`,
    [convId]
  );
  res.json({ conversation: { ...conv, notice: conv.notice || '' }, members });
});

/** 拉人入群（群成员均可拉自己的好友） */
router.post('/conversations/:id/members', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  const conv = (await q('SELECT * FROM conversations WHERE id = ?', [convId]))[0];
  if (!conv || conv.type !== 'group') return res.status(404).json({ error: '群不存在' });
  if (!(await isMember(convId, me.id))) return res.status(403).json({ error: '不在该群中' });
  const ids = [...new Set((req.body.user_ids || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  const friends = await q('SELECT friend_id FROM friendships WHERE user_id = ?', [me.id]);
  const friendSet = new Set(friends.map((f) => f.friend_id));
  const added = [], names = [];
  for (const uid of ids) {
    if (!friendSet.has(uid) || (await isMember(convId, uid))) continue;
    await q('INSERT IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [convId, uid]);
    const u = (await q('SELECT nickname FROM users WHERE id = ?', [uid]))[0];
    added.push(uid); names.push(u ? u.nickname : uid);
  }
  if (added.length) {
    const sys = await insertMessage(convId, me.id, 'system', { text: `${me.nickname}邀请${names.join('、')}加入了群聊` });
    emitToUsers([...added, me.id], 'conv_new', { conversation: await convPayload(convId, me.id) });
    emitToUsers(await convMembers(convId).then((ms) => ms.map((m) => m.user_id)), 'msg', { message: sys, conversation_id: convId });
  }
  res.json({ ok: true, added });
});

/** 踢人（仅群主） */
router.delete('/conversations/:id/members/:uid', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const conv = (await q('SELECT * FROM conversations WHERE id = ?', [convId]))[0];
  if (!conv || conv.type !== 'group') return res.status(404).json({ error: '群不存在' });
  if (conv.owner_id !== me.id) return res.status(403).json({ error: '仅群主可以移除成员' });
  const target = await isMember(convId, uid);
  if (!target || uid === me.id) return res.status(400).json({ error: '该成员不存在' });
  await q('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [convId, uid]);
  const u = (await q('SELECT nickname FROM users WHERE id = ?', [uid]))[0];
  const sys = await insertMessage(convId, me.id, 'system', { text: `${me.nickname}将${u ? u.nickname : uid}移出了群聊` });
  emitToUsers([uid], 'conv_removed', { conversation_id: convId });
  emitToUsers((await convMembers(convId)).map((m) => m.user_id), 'msg', { message: sys, conversation_id: convId });
  res.json({ ok: true });
});

/** 退群 */
router.post('/conversations/:id/quit', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  const conv = (await q('SELECT * FROM conversations WHERE id = ?', [convId]))[0];
  if (!conv || conv.type !== 'group') return res.status(400).json({ error: '仅群聊可退出' });
  if (!(await isMember(convId, me.id))) return res.json({ ok: true });
  await q('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [convId, me.id]);
  const rest = await convMembers(convId);
  if (!rest.length) {
    await q('DELETE FROM conversations WHERE id = ?', [convId]);
  } else {
    const sys = await insertMessage(convId, me.id, 'system', { text: `${me.nickname}退出了群聊` });
    emitToUsers(rest.map((m) => m.user_id), 'msg', { message: sys, conversation_id: convId });
    if (conv.owner_id === me.id) {
      await q("UPDATE conversations SET owner_id = ? WHERE id = ?", [rest[0].user_id, convId]);
      await q("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", [convId, rest[0].user_id]);
    }
  }
  res.json({ ok: true });
});

/** 群设置（群名/公告/头像，群主或管理员） */
router.put('/conversations/:id/group', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  const mine = await isMember(convId, me.id);
  const conv = (await q('SELECT * FROM conversations WHERE id = ?', [convId]))[0];
  if (!conv || conv.type !== 'group') return res.status(404).json({ error: '群不存在' });
  if (!mine || (mine.role !== 'owner' && mine.role !== 'admin'))
    return res.status(403).json({ error: '仅群主/管理员可修改' });
  const patch = {};
  if (typeof req.body.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 64);
  if (typeof req.body.notice === 'string') patch.notice = req.body.notice.slice(0, 500);
  if (typeof req.body.avatar === 'string') patch.avatar = req.body.avatar.slice(0, 500);
  const keys = Object.keys(patch);
  if (keys.length) {
    await q('UPDATE conversations SET ' + keys.map((k) => `${k} = ?`).join(', ') + ' WHERE id = ?', [
      ...keys.map((k) => patch[k]), convId,
    ]);
    emitToUsers((await convMembers(convId)).map((m) => m.user_id), 'conv_update', { conversation_id: convId });
  }
  res.json({ ok: true });
});

/** 我的会话设置（置顶/免打扰） */
router.put('/conversations/:id/myflags', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  const mine = await isMember(convId, me.id);
  if (!mine) return res.status(403).json({ error: '不在该会话中' });
  const patch = {};
  if (typeof req.body.stick_top === 'boolean') patch.stick_top = req.body.stick_top ? 1 : 0;
  if (typeof req.body.muted === 'boolean') patch.muted = req.body.muted ? 1 : 0;
  const keys = Object.keys(patch);
  if (keys.length) {
    await q('UPDATE conversation_members SET ' + keys.map((k) => `${k} = ?`).join(', ') + ' WHERE id = ?', [
      ...keys.map((k) => patch[k]), mine.id,
    ]);
  }
  res.json({ ok: true });
});

// ---------------- 消息 ----------------

/** 历史消息（倒序翻页：before_id 之前的一页，返回升序） */
router.get('/conversations/:id/messages', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  if (!(await isMember(convId, me.id))) return res.status(403).json({ error: '不在该会话中' });
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 30);
  const beforeId = parseInt(req.query.before_id, 10) || 0;
  const params = [convId];
  let where = 'conversation_id = ?';
  if (beforeId > 0) { where += ' AND id < ?'; params.push(beforeId); }
  const rows = await q(`SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ${limit}`, params);
  const hasMore = rows.length === limit;
  const messages = rows.reverse().map((m) => ({
    id: m.id, conversation_id: m.conversation_id, sender_id: m.sender_id,
    type: m.type, content: JSON.parse(m.content), revoked: !!m.revoked, created_at: m.created_at,
  }));
  res.json({ messages, has_more: hasMore });
});

/** 发消息（REST 发送；服务端通过 Socket.io 实时推给会话所有成员） */
router.post('/conversations/:id/messages', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  const mine = await isMember(convId, me.id);
  if (!mine) return res.status(403).json({ error: '不在该会话中' });
  const type = req.body.type;
  if (!MSG_TYPES.includes(type)) return res.status(400).json({ error: '不支持的消息类型' });
  const content = validateContent(type, req.body.content);
  if (!content) return res.status(400).json({ error: '消息内容不合法' });

  // 单聊黑名单拦截：对方拉黑了我
  const conv = (await q('SELECT * FROM conversations WHERE id = ?', [convId]))[0];
  if (conv && conv.type === 'single') {
    const members = await convMembers(convId);
    const peerId = members.map((m) => m.user_id).find((id) => id !== me.id);
    if (peerId) {
      const theirs = await q('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?', [peerId, me.id]);
      if (theirs.length && theirs[0].blacklisted)
        return res.status(403).json({ error: '消息已发出，但被对方拒收了' });
    }
  }

  const m = await insertMessage(convId, me.id, type, content);
  const memberIds = (await convMembers(convId)).map((x) => x.user_id);
  emitToUsers(memberIds, 'msg', {
    message: { id: m.id, conversation_id: convId, sender_id: me.id, type, content, revoked: false, created_at: m.created_at },
    conversation_id: convId,
  });
  res.json({ message: { id: m.id, conversation_id: convId, sender_id: me.id, type, content, revoked: false, created_at: m.created_at } });
});

/** 上报已读位置（消未读数） */
router.post('/conversations/:id/read', async (req, res) => {
  const me = req.user;
  const convId = parseInt(req.params.id, 10);
  const mine = await isMember(convId, me.id);
  if (!mine) return res.status(403).json({ error: '不在该会话中' });
  const lastMsgId = parseInt(req.body.last_msg_id, 10) || 0;
  await q('UPDATE conversation_members SET last_read_msg_id = GREATEST(last_read_msg_id, ?) WHERE id = ?', [
    lastMsgId, mine.id,
  ]);
  res.json({ ok: true });
});

/** 撤回消息（发送者 2 分钟内，仿微信） */
router.post('/messages/:id/revoke', async (req, res) => {
  const me = req.user;
  const m = (await q('SELECT * FROM messages WHERE id = ?', [req.params.id]))[0];
  if (!m || m.sender_id !== me.id) return res.status(404).json({ error: '消息不存在' });
  if (m.revoked) return res.json({ ok: true });
  const ageMin = (Date.now() - new Date(m.created_at).getTime()) / 60000;
  if (ageMin > 2) return res.status(403).json({ error: '超过 2 分钟，无法撤回' });
  await q('UPDATE messages SET revoked = 1 WHERE id = ?', [m.id]);
  const sys = await insertMessage(m.conversation_id, me.id, 'system', { text: `${me.nickname}撤回了一条消息` });
  const memberIds = (await convMembers(m.conversation_id)).map((x) => x.user_id);
  emitToUsers(memberIds, 'msg_revoke', { conversation_id: m.conversation_id, message_id: m.id });
  emitToUsers(memberIds, 'msg', { message: { ...sys, content: JSON.parse(sys.content) }, conversation_id: m.conversation_id });
  res.json({ ok: true });
});

module.exports = router;
