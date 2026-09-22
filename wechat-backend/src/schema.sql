-- ============================================================
-- 微聊（仿微信）数据库设计  库名: wechat
-- 对标微信核心数据模型：
--   用户个人资料 / 好友关系 / 单聊群聊消息 / 最新位置与实时位置共享 / 朋友圈
-- 全部 InnoDB + utf8mb4，建表均为 IF NOT EXISTS，服务每次启动自动执行（幂等）
-- ============================================================

-- 1. 用户表（个人数据核心表）
CREATE TABLE IF NOT EXISTS users (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone       VARCHAR(20)  NOT NULL COMMENT '手机号，登录账号',
  wx_id       VARCHAR(32)  NOT NULL COMMENT '微信号，唯一，可自定义一次',
  nickname    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '昵称',
  avatar      VARCHAR(500) NOT NULL DEFAULT '' COMMENT '头像 URL，空则前端用首字占位',
  gender      TINYINT      NOT NULL DEFAULT 0 COMMENT '0未知 1男 2女',
  region      VARCHAR(100) NOT NULL DEFAULT '' COMMENT '地区，如 广东 深圳',
  signature   VARCHAR(200) NOT NULL DEFAULT '' COMMENT '个性签名',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_active_at DATETIME NULL COMMENT '最近活跃时间（登录/上报时刷新）',
  UNIQUE KEY uk_phone (phone),
  UNIQUE KEY uk_wxid (wx_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户';

-- 2. 短信验证码（局域网开发模式固定 123456，表结构保留以对接真实短信）
CREATE TABLE IF NOT EXISTS sms_codes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone      VARCHAR(20) NOT NULL,
  code       VARCHAR(10) NOT NULL,
  used       TINYINT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_phone (phone, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='登录验证码';

-- 3. 好友申请（"新的朋友"）
CREATE TABLE IF NOT EXISTS friend_requests (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_uid    BIGINT UNSIGNED NOT NULL,
  to_uid      BIGINT UNSIGNED NOT NULL,
  message     VARCHAR(200) NOT NULL DEFAULT '' COMMENT '验证消息',
  status      ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at  DATETIME NULL,
  KEY idx_to (to_uid, status),
  KEY idx_from (from_uid, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='好友申请';

-- 4. 好友关系（双向两行，仿微信通讯录：备注/拉黑）
CREATE TABLE IF NOT EXISTS friendships (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL COMMENT '本人',
  friend_id   BIGINT UNSIGNED NOT NULL COMMENT '对方',
  remark      VARCHAR(64) NOT NULL DEFAULT '' COMMENT '备注名',
  blacklisted TINYINT NOT NULL DEFAULT 0 COMMENT '1=已被本人拉黑',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_pair (user_id, friend_id),
  KEY idx_friend (friend_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='好友关系';

-- 5. 会话（单聊/群聊）
CREATE TABLE IF NOT EXISTS conversations (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type        ENUM('single','group') NOT NULL,
  name        VARCHAR(64) NOT NULL DEFAULT '' COMMENT '群名（单聊为空，展示取对方昵称/备注）',
  avatar      VARCHAR(500) NOT NULL DEFAULT '' COMMENT '群头像',
  owner_id    BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '群主',
  notice      VARCHAR(500) NOT NULL DEFAULT '' COMMENT '群公告',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话';

-- 6. 会话成员（含个人维度设置：置顶/免打扰/已读位置）
CREATE TABLE IF NOT EXISTS conversation_members (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversation_id  BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  role             ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
  stick_top        TINYINT NOT NULL DEFAULT 0 COMMENT '置顶聊天',
  muted            TINYINT NOT NULL DEFAULT 0 COMMENT '消息免打扰',
  last_read_msg_id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已读到的消息id（算未读数）',
  joined_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_conv_user (conversation_id, user_id),
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话成员';

-- 7. 消息（单聊群聊共用一张表，content 按类型存 JSON）
CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id       BIGINT UNSIGNED NOT NULL,
  type            ENUM('text','image','voice','video','location','file','share','system') NOT NULL,
  content         MEDIUMTEXT NOT NULL COMMENT 'JSON：text{text} image{url,w,h} voice{url,duration} location{lat,lng,label} share{share_id} …',
  revoked         TINYINT NOT NULL DEFAULT 0 COMMENT '1=已撤回（展示为"撤回了一条消息"）',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_conv (conversation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天消息';

-- 8. 用户最新位置（每人一行，APP 周期性上报覆盖）
CREATE TABLE IF NOT EXISTS user_locations (
  user_id    BIGINT UNSIGNED PRIMARY KEY,
  lat        DOUBLE NOT NULL,
  lng        DOUBLE NOT NULL,
  accuracy   FLOAT  NOT NULL DEFAULT 0 COMMENT '定位精度（米）',
  speed      FLOAT  NOT NULL DEFAULT 0,
  bearing    FLOAT  NOT NULL DEFAULT 0 COMMENT '朝向（度）',
  source     VARCHAR(20) NOT NULL DEFAULT 'gps' COMMENT 'gps/network',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_time (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户最新位置';

-- 9. 实时位置共享会话（聊天里的"共享实时位置"）
CREATE TABLE IF NOT EXISTS location_shares (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  initiated_by  BIGINT UNSIGNED NOT NULL,
  status        ENUM('active','ended') NOT NULL DEFAULT 'active',
  started_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at      DATETIME NULL,
  KEY idx_conv (conversation_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实时位置共享';

-- 10. 共享参与者
CREATE TABLE IF NOT EXISTS location_share_members (
  id       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  share_id BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_share_user (share_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='共享参与者';

-- 11. 朋友圈
CREATE TABLE IF NOT EXISTS moments (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  content    TEXT COMMENT '文字',
  images     JSON NULL COMMENT '图片URL数组',
  location   VARCHAR(200) NOT NULL DEFAULT '' COMMENT '所在位置',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='朋友圈';

-- 12. 朋友圈点赞
CREATE TABLE IF NOT EXISTS moment_likes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  moment_id  BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_moment_user (moment_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='朋友圈点赞';

-- 13. 朋友圈评论（reply_to_uid 支持回复某人）
CREATE TABLE IF NOT EXISTS moment_comments (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  moment_id    BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL COMMENT '评论人',
  reply_to_uid BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '回复谁，0=直接评论',
  content      VARCHAR(500) NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_moment (moment_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='朋友圈评论';
