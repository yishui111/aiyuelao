/**
 * 微聊后端 · 端到端自测：模拟 A、B 两个用户走完核心链路
 * 覆盖：登录注册 / 资料修改 / 好友申请与通过 / 单聊(发消息/未读/已读/撤回)
 *       位置上报与查看 / 实时位置共享(Socket推送) / 建群与群聊 / 朋友圈 / 附近的人 / 上传
 * 运行：先启动服务(node src/index.js)，再 node test-e2e.mjs
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://127.0.0.1:3002';
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

// 两个 Socket 客户端，用于验证实时推送
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    const events = [];
    s.on('connect', () => resolve({ s, events }));
    s.on('connect_error', reject);
    s.onAny((event, ...args) => events.push([event, args[0]]));
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function find(events, name) {
  const hits = events.filter((e) => e[0] === name);
  return hits.length ? hits[hits.length - 1][1] : null;
}

async function main() {
  const phoneA = '139' + String(Date.now()).slice(-8);
  const phoneB = '138' + String(Date.now()).slice(-8);

  console.log('\n== 1. 登录/注册 ==');
  await api('POST', '/api/auth/smscode', null, { phone: phoneA });
  const loginA = await api('POST', '/api/auth/login', null, { phone: phoneA, code: '123456' });
  ok('A 登录成功', loginA.status === 200 && loginA.data.token);
  const tA = loginA.data.token, uidA = loginA.data.user.id;

  await api('POST', '/api/auth/smscode', null, { phone: phoneB });
  const loginB = await api('POST', '/api/auth/login', null, { phone: phoneB, code: '123456' });
  ok('B 登录成功', loginB.status === 200 && loginB.data.token);
  const tB = loginB.data.token, uidB = loginB.data.user.id;

  const bad = await api('POST', '/api/auth/login', null, { phone: phoneA, code: '000000' });
  ok('错误验证码被拒', bad.status === 401);

  console.log('\n== 2. 资料 ==');
  const upA = await api('PUT', '/api/users/me', tA, { nickname: '阿聊', gender: 1, signature: '你好微聊', region: '北京 朝阳' });
  ok('A 改资料', upA.status === 200 && upA.data.user.nickname === '阿聊');
  const wx = await api('PUT', '/api/users/me', tB, { wx_id: 'b_test_' + String(Date.now()).slice(-5) });
  ok('B 设微信号', wx.status === 200);

  console.log('\n== 3. 好友 ==');
  const sA = await connect(tA), sB = await connect(tB);
  const req = await api('POST', '/api/friends/requests', tA, { target: wx.data.user.wx_id, message: '交个朋友' });
  ok('A 发申请(按微信号)', req.status === 200);
  await sleep(300);
  const pushed = find(sB.events, 'friend_request');
  ok('B 实时收到申请推送', pushed && pushed.from_user.nickname === '阿聊');
  const listB = await api('GET', '/api/friends/requests', tB);
  ok('B 申请列表可见', listB.data.received.length > 0);
  const acc = await api('POST', `/api/friends/requests/${listB.data.received[0].id}/accept`, tB);
  ok('B 通过申请', acc.status === 200);
  await sleep(300);
  ok('A 收到通过推送', !!find(sA.events, 'friend_handled'));
  const friendsA = await api('GET', '/api/friends', tA);
  ok('A 通讯录有 B', friendsA.data.friends.some((f) => f.id === uidB));

  console.log('\n== 4. 单聊 ==');
  const conv = await api('POST', '/api/conversations/single', tA, { peer_id: uidB });
  ok('A 创建/获取单聊', conv.status === 200 && conv.data.conversation.conversation_id);
  const convId = conv.data.conversation.conversation_id;
  await sleep(300);
  ok('B 实时收到新会话推送', !!find(sB.events, 'conv_new'));

  const m1 = await api('POST', `/api/conversations/${convId}/messages`, tA, { type: 'text', content: { text: '在吗？' } });
  ok('A 发文本', m1.status === 200 && m1.data.message.id);
  await sleep(300);
  const gotMsg = find(sB.events, 'msg');
  ok('B 实时收到消息', gotMsg && gotMsg.message.content.text === '在吗？');

  const m2 = await api('POST', `/api/conversations/${convId}/messages`, tB, { type: 'text', content: { text: '在的，怎么了' } });
  ok('B 回消息', m2.status === 200);
  const convsA = await api('GET', '/api/conversations', tA);
  const convA = convsA.data.conversations.find((c) => c.conversation_id === convId);
  ok('A 列表未读=1', convA && convA.unread === 1, `实际=${convA && convA.unread}`);
  ok('A 列表预览正确', convA && convA.last_message.preview === '在的，怎么了');
  const rd = await api('POST', `/api/conversations/${convId}/read`, tA, { last_msg_id: m2.data.message.id });
  ok('A 上报已读', rd.status === 200);
  const convsA2 = await api('GET', '/api/conversations', tA);
  ok('A 未读清零', convsA2.data.conversations.find((c) => c.conversation_id === convId).unread === 0);

  const hist = await api('GET', `/api/conversations/${convId}/messages?limit=10`, tB);
  ok('B 拉历史消息', hist.data.messages.length === 2);

  const rv = await api('POST', `/api/messages/${m1.data.message.id}/revoke`, tA);
  ok('A 撤回消息', rv.status === 200);
  await sleep(300);
  ok('B 收到撤回推送', !!find(sB.events, 'msg_revoke'));
  const hist2 = await api('GET', `/api/conversations/${convId}/messages?limit=10`, tB);
  ok('历史里消息标记已撤回', hist2.data.messages.some((m) => m.id === m1.data.message.id && m.revoked));
  const foreign = await api('POST', `/api/messages/${m2.data.message.id}/revoke`, tA);
  ok('不能撤回别人的消息', foreign.status === 404);

  console.log('\n== 5. 位置 ==');
  const rA = await api('POST', '/api/location/report', tA, { lat: 39.9042, lng: 116.4074, accuracy: 20 });
  ok('A 上报位置(天安门)', rA.status === 200);
  const rB = await api('POST', '/api/location/report', tB, { lat: 39.9100, lng: 116.4130, accuracy: 25 });
  ok('B 上报位置(约1km外)', rB.status === 200);
  const locB = await api('GET', `/api/location/${uidB}`, tA);
  ok('A 查 B 位置', locB.status === 200 && locB.data.relative_to_me && locB.data.relative_to_me.distance_m > 500,
    JSON.stringify(locB.data.relative_to_me));
  const near = await api('GET', '/api/location/nearby/list?radius_km=5', tA);
  ok('A 的"附近的人"含 B', near.data.users.some((u) => u.id === uidB));

  console.log('\n== 6. 实时位置共享 ==');
  const sh = await api('POST', '/api/location/shares', tA, { conversation_id: convId });
  ok('A 发起共享', sh.status === 200 && sh.data.share_id);
  await sleep(300);
  const shareMsg = find(sB.events, 'msg');
  ok('B 收到共享卡片消息', shareMsg && shareMsg.message.type === 'share');
  const join = await api('POST', `/api/location/shares/${sh.data.share_id}/join`, tB);
  ok('B 加入共享', join.status === 200);
  await sleep(400);
  const upd = find(sB.events, 'share_update');
  ok('B 收到共享参与者的实时坐标', upd && upd.participants && upd.participants.length === 2 &&
    upd.participants.every((p) => p.lat != null));
  // A 移动位置 → 服务端把新坐标推给 B
  await api('POST', '/api/location/report', tA, { lat: 39.9500, lng: 116.4500, accuracy: 15 });
  await sleep(400);
  const upd2 = find(sB.events, 'share_update');
  ok('A 移动后 B 收到更新', upd2 && upd2.participants.find((p) => p.id === uidA).lat === 39.95);
  const leave = await api('POST', `/api/location/shares/${sh.data.share_id}/leave`, tB);
  ok('B 退出共享', leave.status === 200);

  console.log('\n== 7. 群聊 ==');
  const g = await api('POST', '/api/conversations/group', tA, { name: '测试群', member_ids: [uidB] });
  ok('A 建群', g.status === 200 && g.data.conversation.type === 'group');
  const gid = g.data.conversation.conversation_id;
  const gm = await api('POST', `/api/conversations/${gid}/messages`, tB, { type: 'text', content: { text: '群里大家好' } });
  ok('B 群里发言', gm.status === 200);
  const gset = await api('PUT', `/api/conversations/${gid}/group`, tA, { notice: '本群只聊正事' });
  ok('A 改群公告', gset.status === 200);

  console.log('\n== 8. 朋友圈 ==');
  const mo = await api('POST', '/api/moments', tB, { content: '第一条朋友圈！', images: [], location: '北京' });
  ok('B 发朋友圈', mo.status === 200 && mo.data.moment.id);
  await sleep(200);
  const feedA = await api('GET', '/api/moments', tA);
  ok('A 刷到 B 的朋友圈', feedA.data.moments.some((m) => m.id === mo.data.moment.id));
  const like = await api('POST', `/api/moments/${mo.data.moment.id}/like`, tA);
  ok('A 点赞', like.status === 200 && like.data.liked);
  await sleep(200);
  ok('B 收到点赞推送', !!find(sB.events, 'moment_notify'));
  const cmt = await api('POST', `/api/moments/${mo.data.moment.id}/comments`, tA, { content: '太赞了' });
  ok('A 评论', cmt.status === 200);
  const likeAgain = await api('POST', `/api/moments/${mo.data.moment.id}/like`, tA);
  ok('A 再点=取消赞', likeAgain.status === 200 && !likeAgain.data.liked);

  console.log('\n== 9. 边界与安全 ==');
  const notFriendConv = await api('POST', '/api/conversations/single', tA, { peer_id: 1 });
  ok('非好友不能开聊(filehelper 例外放行)', notFriendConv.status === 200); // filehelper 内置账号直接可聊
  const noAuth = await fetch(BASE + '/api/conversations');
  ok('无 token 被拒', noAuth.status === 401);
  const blackTest = await api('PUT', `/api/friends/${uidB}`, tA, { blacklisted: true });
  ok('A 拉黑 B', blackTest.status === 200);
  const blockedMsg = await api('POST', `/api/conversations/${convId}/messages`, tB, { type: 'text', content: { text: '还能发吗' } });
  ok('B 被拉黑后发消息被拒收', blockedMsg.status === 403);
  const locBlocked = await api('GET', `/api/location/${uidA}`, tB);
  ok('B 拉黑后查不到 A 位置', locBlocked.status === 403);
  await api('PUT', `/api/friends/${uidB}`, tA, { blacklisted: false });

  console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
  sA.s.disconnect(); sB.s.disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试中断:', e.message); process.exit(1); });
