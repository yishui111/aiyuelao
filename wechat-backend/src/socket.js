const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cfg = require('./config');

let io = null;

function init(server) {
  io = new Server(server, { cors: { origin: true }, maxHttpBufferSize: 1e6 });

  // 握手时校验 token：io(url, { auth: { token } })
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      const payload = jwt.verify(token || '', cfg.JWT_SECRET);
      socket.uid = payload.uid;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // 每个用户一个固定房间，所有推送按用户扇出（多端同登也各自收到）
    socket.join('u:' + socket.uid);
  });

  return io;
}

/** 向多个用户推送 */
function emitToUsers(uids, event, payload) {
  if (!io) return;
  for (const uid of new Set(uids)) {
    io.to('u:' + uid).emit(event, payload);
  }
}

module.exports = { init, emitToUsers };
