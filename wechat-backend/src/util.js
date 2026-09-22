/** 通用工具：球面距离/方位角、公开字段、消息预览 */

const EARTH_R = 6371000; // 米

/** Haversine 球面距离，单位米 */
function haversine(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/** 从 A 看向 B 的方位角（正北 0 度，顺时针） */
function bearing(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * rad) * Math.cos(lat2 * rad);
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lng2 - lng1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function fmtDistance(m) {
  if (m < 1000) return Math.round(m) + 'm';
  return (m / 1000).toFixed(1) + 'km';
}

/** 对外可见的用户字段（手机号脱敏） */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    phone: u.phone ? u.phone.slice(0, 3) + '****' + u.phone.slice(-4) : '',
    wx_id: u.wx_id,
    nickname: u.nickname,
    avatar: u.avatar,
    gender: u.gender,
    region: u.region,
    signature: u.signature,
  };
}

/** 会话列表里消息的文案预览（仿微信：[图片]/[语音]/[位置]…） */
function msgPreview(m, senderNickname) {
  if (!m) return '';
  if (m.revoked) return senderNickname + '撤回了一条消息';
  let c = {};
  try { c = JSON.parse(m.content); } catch { /* ignore */ }
  switch (m.type) {
    case 'text': return c.text || '';
    case 'image': return '[图片]';
    case 'voice': return '[语音]' + (c.duration ? c.duration + '"' : '');
    case 'video': return '[视频]';
    case 'location': return '[位置]' + (c.label ? ' ' + c.label : '');
    case 'share': return '[实时位置共享]';
    case 'file': return '[文件]' + (c.name ? ' ' + c.name : '');
    case 'system': return c.text || '';
    default: return '[消息]';
  }
}

module.exports = { haversine, bearing, fmtDistance, publicUser, msgPreview };
