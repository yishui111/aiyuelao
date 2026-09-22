const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT || '3002', 10),
  DB: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '123456',
    database: process.env.DB_NAME || 'wechat',
  },
  JWT_SECRET: process.env.JWT_SECRET || 'weiliao-local-lan-secret',
  TOKEN_TTL: '30d',
  SMS_DEV_CODE: process.env.SMS_DEV_CODE || '123456', // 局域网开发模式固定验证码
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
  MAX_UPLOAD_MB: 20,
  SHARE_MAX_HOURS: 1, // 实时位置共享最长 1 小时自动结束
};
