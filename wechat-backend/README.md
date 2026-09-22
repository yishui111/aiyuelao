# 微聊后端（仿微信）

> 端口 `3002` · Node.js(Express + Socket.io) + MySQL 8 持久化 · 无 Docker 原生进程
> 对接客户端：`wechat-app`（手机端）/ `watch-app`（手表端），同一个库、同一套接口。

## 启动

```powershell
# 依赖：MySQL 3306（root/123456，由 tools\mysql-extracted 提供，可用 start-all.ps1 拉起）
cd D:\xm\aiyuelao\wechat-backend
npm install          # 首次
npm start            # 自动建库建表（库名 wechat，幂等）并监听 3002
npm test             # 端到端自测（需服务已启动），应输出 49 通过 0 失败
```

环境变量（均有默认值）：`PORT`(3002) `DB_HOST` `DB_PORT`(3306) `DB_USER`(root) `DB_PASS`(123456) `DB_NAME`(wechat) `SMS_DEV_CODE`(123456) `JWT_SECRET` `UPLOAD_DIR`。

## 一、数据库设计（仿微信模型）

库 `wechat`，13 张表（`src/schema.sql`，启动自动执行，可重跑）：

| 表 | 对应微信概念 | 要点 |
|---|---|---|
| `users` | 个人资料 | 手机号+验证码登录；`wx_id` 微信号唯一可改；昵称/头像/性别/地区/签名 |
| `sms_codes` | 短信验证码 | 局域网开发模式固定 123456，表结构预留接真实短信 |
| `friend_requests` | 新的朋友 | 验证消息，accept 后双向写 `friendships` |
| `friendships` | 通讯录 | 双向两行；备注 `remark`、拉黑 `blacklisted` |
| `conversations` | 会话 | `single` 单聊 / `group` 群聊（群名/群主/公告） |
| `conversation_members` | 会话成员 | 角色、置顶、免打扰、`last_read_msg_id`（算未读数） |
| `messages` | 聊天消息 | 单聊群聊同表；类型 text/image/voice/video/location/file/share/system；`revoked` 撤回标记；content 按 JSON 存 |
| `user_locations` | 位置数据 | **每人一行最新位置**（lat/lng/精度/速度/朝向/来源），上报即覆盖 |
| `location_shares` | 共享实时位置 | 会话内发起，1 小时自动结束 |
| `location_share_members` | 共享参与者 | 参与者坐标实时读 `user_locations` |
| `moments` / `moment_likes` / `moment_comments` | 朋友圈 | 图文+位置、点赞（幂等切换）、评论支持回复某人 |

内置账号（首次启动自动 seed）：`文件传输助手`（无需加好友可直接聊）、`测试小微 13800000001`、`测试小信 13800000002`（互为好友，验证码 123456）。

## 二、对外接口一览（全部 REST，前缀 `/api`，除登录外均需 `Authorization: Bearer <token>`）

### 认证与资料
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/smscode` | 发验证码 `{phone}`，返回 `dev_code`（开发模式回显） |
| POST | `/auth/login` | `{phone, code}` → `{token, user}`；新手机号自动注册 |
| PUT | `/users/me` | 改昵称/头像/性别/地区/签名/微信号（微信号全唯一校验） |
| GET | `/users/search?keyword=` | 手机号/微信号精确 + 昵称模糊，带 `is_friend` |
| GET | `/users/:id` | 公开资料 + 关系（是否好友/拉黑/备注） |

### 通讯录
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/friends/requests` | 发好友申请 `{target: 手机号或微信号}` 或 `{target_uid}` |
| GET | `/friends/requests` | 收到+发出的申请列表 |
| POST | `/friends/requests/:id/accept` / `.../reject` | 通过/拒绝（通过后实时推送对方） |
| GET | `/friends` | 通讯录（备注/拉黑标记） |
| PUT | `/friends/:uid` | 设备注 `{remark}` / 拉黑 `{blacklisted: bool}` |
| DELETE | `/friends/:uid` | 删除好友（双向解除，记录保留） |

### 会话与消息
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/conversations` | 会话列表：最后一条+未读数+置顶/免打扰+对方资料 |
| POST | `/conversations/single` | 获取/创建单聊 `{peer_id}`（须好友；filehelper 例外） |
| POST | `/conversations/group` | 建群 `{name, member_ids}`（自动发系统消息） |
| GET | `/conversations/:id` | 会话详情+成员列表 |
| GET | `/conversations/:id/messages?before_id=&limit=` | 历史消息倒序翻页 |
| POST | `/conversations/:id/messages` | 发消息 `{type, content}`；服务端经 Socket.io 实时推送全员 |
| POST | `/conversations/:id/read` | 上报已读 `{last_msg_id}`（消未读） |
| POST | `/messages/:id/revoke` | 撤回（发送者 2 分钟内，仿微信） |
| POST | `/conversations/:id/members` | 拉人入群；`DELETE .../members/:uid` 踢人（群主） |
| POST | `/conversations/:id/quit` | 退群；群主退出自动转让 |
| PUT | `/conversations/:id/group` | 群名/公告/头像（群主/管理员） |
| PUT | `/conversations/:id/myflags` | 置顶 `{stick_top}` / 免打扰 `{muted}` |

消息 content 格式：text`{text}` · image`{url,w,h}` · voice`{url,duration}` · video`{url,poster}` · location`{lat,lng,label}` · file`{url,name,size}` · share`{share_id}` · system`{text}`

### 位置
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/location/report` | 上报 `{lat,lng,accuracy,speed,bearing,source}`，8 秒一次由 APP 调 |
| GET | `/location/:uid` | 看某人最新位置（限好友），返回与我距离/方位/更新时间 |
| POST | `/location/shares` | 发起实时位置共享 `{conversation_id}`（自动发共享卡片消息） |
| POST | `/location/shares/:id/join` / `.../leave` | 加入/退出共享（全员退出自动结束） |
| GET | `/location/shares/:id` | 参与者及各自最新坐标 |
| GET | `/location/nearby/list?radius_km=5` | 附近的人（1 小时内活跃，按距离排序，含 `is_friend`） |

### 朋友圈 / 其他
| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET/DELETE | `/moments` | 发（文字+图≤9+位置）/ 信息流（好友+自己，翻页）/ 删除 |
| GET | `/moments/user/:uid` | 某人的朋友圈主页 |
| POST | `/moments/:id/like` | 点赞/取消（幂等切换，实时通知主人） |
| POST | `/moments/:id/comments` | 评论 `{content, reply_to_uid?}` |
| DELETE | `/moments/:id/comments/:cid` | 删评论（评论者或主人） |
| POST | `/upload` | multipart `file` 字段，≤20MB → `{url}`（`/uploads/...` 静态访问） |
| GET | `/health` | 健康检查 |

### WebSocket（Socket.io，实时推送）
连接：`io(server, { auth: { token } })`；服务端按用户房间扇出（多端同登各自收到）。

| 事件 | 触发 |
|---|---|
| `msg` | 新消息（含共享卡片）；正在打开的会话由客户端直接追加 |
| `msg_revoke` | 撤回 |
| `conv_new` / `conv_update` / `conv_removed` | 新会话/会话变更/被移出群 |
| `friend_request` / `friend_handled` / `friend_deleted` | 好友动态 |
| `share_update` | 实时位置共享参与者坐标更新（上报位置即触发推送，无需轮询） |
| `moment_notify` | 朋友圈点赞/评论通知 |

## 三、目录结构

```
wechat-backend/
├── src/
│   ├── index.js            # Express 启动 + 路由挂载（auth 后全站鉴权）
│   ├── schema.sql          # 仿微信数据库建表（幂等）
│   ├── db.js               # 连接池 + 建库建表 + 内置账号 seed
│   ├── auth.js             # JWT 签发/校验中间件
│   ├── socket.js           # Socket.io（token 握手 + 按用户房间推送）
│   ├── util.js             # Haversine 距离/方位角/消息预览
│   └── routes/             # auth/users/friends/conversations/location/moments/upload
├── test-e2e.mjs            # 双用户全链路自测（49 项断言）
└── uploads/                # 图片/语音/文件存储（静态服务）
```

## 四、当前未覆盖（后续路线图）

视频通话、红包/转账（支付）、小程序、扫一扫、收藏、摇一摇、漂流瓶、真实短信通道、HTTPS/公网部署。语音消息依赖 WebView 的 MediaRecorder（Android 10+ 体验最佳，老机型自动降级提示）。
