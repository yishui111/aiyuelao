# 约跑步 APP · 部署与双机测试指南

> 服务器复用「AI月老」现有服务（ANL 后端 3001 + 匹配中心 8016），本目录只包含终端 APP。
> 产物：`run-app\yuepao-release.apk`（约 21KB，Android 6.0+ 可装，手机 / Wear OS 手表通用）。

---

## 一、功能对照（对应《约跑步部署文档》）

| 文档需求 | 实现位置 |
|---|---|
| 服务器判断两个人距离 | 匹配中心 8016（Haversine 球面距离，`/discover` 新增 `mode=run`：距离优先 75% + 活跃度 25%，跳过性别硬筛，不调 LLM） |
| APP 发送位置 | ANL 后端 3001 新增 `POST /api/location/report`，APP 每 8 秒上报一次 GPS |
| 距离近得到回应 | 3001 新增 `GET /api/run/nearby`（50 公里半径内跑者，按距离排序），点「约TA跑」立即配对 |
| 约个时间去跑步 | 配对后进入聊天（支持"明早7点约吗"等快捷话术），配对过的跑者按钮变「去聊天」，可反复约 |
| 手表兼容 | APK 无手机专属依赖，Wear OS 可侧载（见下文第五节）；第一版以手机为主，手表先靠手机通知镜像 |

## 二、一次性准备（只做一次）

**1. 防火墙放行 3001 端口**（管理员 PowerShell 或 CMD 执行；不做这步手机一定连不上）：

```bat
netsh advfirewall firewall add rule name="AI月老-约跑步APP(3001)" dir=in action=allow protocol=TCP localport=3001
```

**2. 查电脑的局域网 IP**：`ipconfig` 看「无线局域网适配器 WLAN」的 IPv4，形如 `192.168.x.x`。

**3. 确认服务在线**：双击根目录「启动AI月老.bat」（只需 ANL 后端 3001 + 匹配中心 8016，其余服务可开可不开），或单独验证：

```
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:8016/health
```

## 三、安装 APP 到手机

- **方式 A（推荐）**：把 `yuepao-release.apk` 通过微信文件传输助手/QQ/数据线拷到手机，点击安装（需允许"安装未知应用"）。
- **方式 B（USB 调试）**：

```
tools\android-sdk\platform-tools\adb.exe install -r run-app\yuepao-release.apk
```

## 四、两人约跑步测试流程

1. **两台手机连同一个 Wi-Fi**（能互相访问电脑所在局域网）。
2. 各自打开 APP，第一栏填 `http://<电脑IP>:3001` → 点「测试」提示 ✓；填不同手机号 → 「获取验证码」→ 填 `123456` → 登录。
3. 登录后 APP 自动开始 GPS 上报（顶部绿点 `定位中 ±XXm`）。首帧定位建议在窗边或户外，室内 GPS 弱时自动走 Wi-Fi 网络定位。
4. 「附近跑者」页 8 秒自动刷新，50 公里内按距离排序；点「约TA跑」→ 配对成功自动进入聊天，约时间地点即可。
5. 对方聊天页 2.5 秒轮询收消息（也支持实时推送通道，MVP 用轮询更省电稳定）。

> 演示数据说明：后端自带 16 个外地演示用户（北京/上海等），50 公里半径内互不干扰；真实两人只要相距 50 公里内就会互相看到。

## 五、装到手表（Wear OS）

APK 未加手机专属限制，Wear OS 2+（API 23+）可侧载：

```
tools\android-sdk\platform-tools\adb.exe connect <手表IP>:5555
tools\android-sdk\platform-tools\adb.exe install -r run-app\yuepao-release.apk
```

注意：Wear OS 3+ 的系统桌面可能不显示侧载的手机应用，可用 adb 拉起：

```
tools\android-sdk\platform-tools\adb.exe shell am start -n com.yuepao.run/.MainActivity
```

第一版界面按手机尺寸设计，手表上可用但未做圆屏优化；按部署文档"先做手机端"的约定，手表独立 UI 属下一阶段（原生定位桥 LocationManager 在 Wear OS 上可直接复用）。

## 六、改了代码怎么重新打包

```
powershell -ExecutionPolicy Bypass -File D:\xm\aiyuelao\run-app\build-apk.ps1
```

全自动 8 步（aapt2 → javac → d8 → 打包 → 对齐 → 签名），无需 Gradle/Android Studio。
工具链已就位于 `tools\android-sdk\`（build-tools 34.0.0/33.0.2、platform 34、platform-tools）。

**两个已知坑（脚本已内置规避，改动时留意）：**
- JDK21 javac 编译的非静态内部类/匿名类会让 d8（8.2/3.3 实测）NPE，嵌套类必须全部 `static`；
- aapt2 在 Windows 打 assets 会用反斜杠路径，assets 由脚本经 jar 以正斜杠补装。

## 七、常见问题

| 现象 | 原因与处理 |
|---|---|
| 测试连接 ✗ | 手机和电脑不在同一 Wi-Fi；防火墙没放行 3001；IP 填错（要电脑局域网 IP，不是 127.0.0.1） |
| 一直"定位中…" | 手机定位服务（GPS）没开；APP 定位权限被拒（设置→应用→约跑步→权限）；室内信号弱，靠窗或出门 |
| 附近列表为空 | 对方没登录/没开定位；或你们相距超 50 公里（半径在 APP `index.html` 的 `radius_km=50` 可调） |
| 验证码不对 | 开发模式固定 `123456` |
| 服务莫名重启 | 看 `logs\watchdog.log`；看门狗每 30 秒巡检（已修复 node 绝对路径解析问题） |

## 八、本目录结构

```
run-app/
├── app/
│   ├── AndroidManifest.xml        # 权限：INTERNET + 定位；允许 http 明文；watch 兼容声明
│   ├── java/com/yuepao/run/MainActivity.java   # WebView 壳 + 原生 GPS 定位桥（LocationManager）
│   ├── res/mipmap-xxhdpi/ic_launcher.png       # 启动图标
│   └── assets/www/index.html      # 全部界面（登录/附近跑者/约跑消息/聊天/我的）
├── build-apk.ps1                  # 一键构建脚本
├── build/                         # 构建中间产物 + 调试证书
└── yuepao-release.apk             # 构建产物
```
