const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('./config');

let pool = null;

async function init() {
  // 1) 连 MySQL（不带库），建库 + 执行 schema（幂等）
  const conn = await mysql.createConnection({
    host: cfg.DB.host,
    port: cfg.DB.port,
    user: cfg.DB.user,
    password: cfg.DB.password,
    multipleStatements: true,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${cfg.DB.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.changeUser({ database: cfg.DB.database });
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await conn.query(schema);
  await conn.end();

  // 2) 常规连接池
  pool = mysql.createPool({
    host: cfg.DB.host,
    port: cfg.DB.port,
    user: cfg.DB.user,
    password: cfg.DB.password,
    database: cfg.DB.database,
    connectionLimit: 10,
  });

  await seed();
}

/** SELECT 返回行数组；INSERT/UPDATE 返回 ResultSetHeader */
async function q(sql, params) {
  if (!pool) throw new Error('db not ready');
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** 首次启动写入内置账号：文件传输助手 + 两个测试号（互为好友） */
async function seed() {
  const rows = await q('SELECT COUNT(*) n FROM users');
  if (rows[0].n > 0) return;
  await q(
    `INSERT INTO users (id, phone, wx_id, nickname, signature, region) VALUES
     (1, '10000000000', 'filehelper', '文件传输助手', '和生活备份每个瞬间', ''),
     (2, '13800000001', 'weiliao_001', '测试小微', '这是 1 号测试账号，验证码 123456', '北京 朝阳'),
     (3, '13800000002', 'weiliao_002', '测试小信', '这是 2 号测试账号，验证码 123456', '北京 海淀')`
  );
  await q(
    `INSERT INTO friendships (user_id, friend_id) VALUES (2,3),(3,2)`
  );
}

module.exports = { init, q };
