# dsh-miniwin — DSH 侧边栏手机投屏

**用户只需要做一件事：扫码。**

扫完码，PC 自动找手机、自动连、自动弹出桌面迷你窗。不需要填 IP，不需要填端口。

画面走 scrcpy 链路（H.264 硬编 → adb reverse → WebCodecs 硬解 → 桌面窗口），
**不进浏览器**。迷你窗支持内容透明度 / 背景透明度独立调节、八向缩放、置顶。

---

## 什么是「投屏」

就是**把手机屏幕的画面显示到电脑上**。这套东西有三个界面，别混了：

```
┌─ 电脑 ──────────────────────────────────────┐
│                                              │
│  ① DSH 侧边栏「手机投屏」面板                 │
│     → 出二维码、配对、启动（不显示画面）        │
│                                              │
│  ② 桌面上的迷你窗                             │
│     → 真正显示手机画面的窗口                   │
│       可调透明度 / 拖动 / 缩放 / 置顶          │
│                                              │
└──────────────────────────────────────────────┘

┌─ 手机 ─┐
│ ③ 扫码后打开的配对页                          │
│    → 自动连接，不用填东西                      │
└────────┘
```

---

## 使用

```
① 侧边栏点「手机投屏」    ② 手机相机扫码    ③ 桌面弹出迷你窗
   ┌──────────────┐      ┌──────────┐      ┌────────────┐
   │  ▓▓▓▓▓▓▓▓    │      │          │      │            │
   │  ▓ 二维码 ▓   │ ───► │  扫码    │ ───► │  手机画面   │
   │  ▓▓▓▓▓▓▓▓    │      │          │      │  透明窗口   │
   └──────────────┘      └──────────┘      └────────────┘
```

**第一次要多插一次 USB 线**（原因见下）。之后永久无线，除非手机重启。

---

## 迷你窗 UI

四档自适应，宽度变了布局跟着变，**文字可以藏，图标永远在**：

| 宽度 | 滑杆标签 | 按钮 |
|---|---|---|
| ≥ 300px | 内容透明度 / 背景透明度 | 图标 + 文字 |
| 220–299px | 内容 / 背景 | 图标 + 短词 |
| 150–219px | 纯图标（◐ / ▣） | 纯图标 |
| < 150px | 纯图标，隐藏百分比 | 纯图标 |

按钮：`比例` `重连` `−` `＋` `重置`

- **重连** —— 断开旧会话重新连（之前叫「开始投屏」，会让人以为还得再点一次，很误导）
- **重置** —— 窗口太小或太透明看不见时，一键恢复 360×640 / 100% / 置顶

---

## 性能

实测（真机 476×1080 @ 60fps）：

```
帧率          100 fps（rAF 满速）
平均帧间隔    10.0 ms
p95           10.3 ms
最大          10.6 ms
卡顿(>33ms)   0 次
```

**关键优化**：去掉了 `#shell` 上的 `backdrop-filter: blur(16px)`。

它会实时模糊「窗口背后的桌面」，而窗口里每帧都在播视频 → 每帧触发一次全窗口模糊
→ GPU 顶满 → 画面卡顿。现在默认不模糊，只保留半透明底色（背景透明度滑杆照样有效）；
需要毛玻璃感时加 `.blur` 类，模糊半径也降到 10px。

`box-shadow` 从 `0 24px 60px` 收到 `0 10px 28px`（大范围阴影每次重绘都要算）。

---

## 自动发现

用户不输入任何地址，四层兜底：

| 顺序 | 方法 | 说明 |
|---|---|---|
| 1 | USB 设备 → 开 tcpip | 插线时自动 `adb tcpip 5555`，**不把 USB 当结果** |
| 2 | mDNS 广播 | 原生 Android 11+ 才有；华为没有 |
| 3 | 上次连过的地址 | 记忆 `ip:port` |
| 4 | 扫网段 5555 | 并发 128，一个 /24 约 1.5 秒 |

**为什么 USB 不直接返回**：USB 传输慢、要一直插线。正确体验是
「插一次线 → 自动切无线 → 拔线 → 一直无线」。

---

## 为什么这台华为必须插一次线

`adbd` 默认只监听 USB。要让它监听 TCP，必须执行 `adb tcpip 5555`，
而这条命令本身需要一条已有的 adb 连接 —— 循环依赖。

正常机型用「无线调试」（Android 11+）绕过：手机自己弹配对码。
但**华为/鸿蒙的开发者选项里没有这个开关**（截图 4 段确认 +
[华为官方文档](https://consumer.huawei.com/cn/support/content/zh-cn15997564/)）。

实测 `adb mdns services` 永远返回空，adbd 不广播 `_adb-tls-*`。

唯一可行的无线通道就是 `adb tcpip`，代价是一次 USB。

---

## 关于 DRM 黑屏

部分视频 App（番茄小说等）会设 `FLAG_SECURE`，任何屏幕录制 API 都抓不到，
表现为投出来是黑的。这是 Android 的反盗录机制，**不是 bug**。

判断方法：手机自己 `adb exec-out screencap` 能拍到、但投屏黑屏 → 就是 DRM。
系统设置、小红书、开发者选项这些都能正常投。

---

## 架构

```
手机                                      PC
┌────────────────────┐                  ┌──────────────────────────────────┐
│ 浏览器（扫码打开）   │                  │ DSH 插件 Host 半侧                │
│  GET  /            │ ◄─────────────── │  ├ LAN 服务器 0.0.0.0:随机端口     │
│  GET  /auto        │ ────────────────►│  │   └ /t/<token>/ 零输入配对页     │
│  POST /pair-auto   │                  │  ├ 自动发现 (discover.js)          │
│  POST /launch      │                  │  └ Host 路由 127.0.0.1:DSH端口     │
└────────────────────┘                  │                                  │
                                         │  拉起 miniwin-stream/main.js      │
┌────────────────────┐                  │   └ WebCodecs 硬解 → 桌面迷你窗   │
│ scrcpy-server       │  adb reverse     │       └ --report 状态回传         │
│ (app_process)       │ ───────────────► │                                  │
└────────────────────┘                  └──────────────────────────────────┘
```

### 为什么需要独立 LAN 服务器

DSH 的 webServer 绑死在 `127.0.0.1`（`host.cordis.patch.yml` 里写死的），
手机永远连不上。所以配对页必须自己起一个监听 `0.0.0.0` 的服务，
端口随机、路径带一次性 token。

---

## 踩过的坑

### 1. 路由全 401 —— 两个独立原因

**A. `ctx.get('connection').requestRejection` 在 desktop profile 下不可用**
用它做信任栅栏会把路由全打 401。改成自己查 `sec-fetch-site` / `origin` / `host`。

**B. `webServer.register` 不认 `method` 字段**
只认 `{kind:'exact', path, handler}`。带 method 的对象注册后不可达。
一个 path 一条 route，内部按 `req.method` 分流。

### 2. LAN 服务器起不来 —— ESM 里用了 require

`package.json` 是 `"type":"module"`，`require('node:http')` 抛
`require is not defined`，在 async IIFE 里被静默吞掉，`lanPort` 永远是 0。

### 3. 二维码指向 FlClash 假 IP

7 个网卡，`os.networkInterfaces()` 第一个是 `198.18.0.1`（FlClash TUN）。
按网卡名 + 网段打分排序：WLAN +100，虚拟网卡 −100，FlClash 网段 −80。

### 4. QR 编码器 format info 位序写反

结构检查（finder / timing / dark module）全过，但 OpenCV 一帧都解不出来。
逐位对比发现 16 个差异全在 format info。

> **教训：结构检查通过 ≠ 码能扫。必须真解码。**

### 5. 迷你窗启动即崩：`ipcMain.handle is not a function`

```js
// 错：空字符串仍是存在的 key
env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
// 对：整个删掉
delete e.ELECTRON_RUN_AS_NODE
```

Electron 判断的是「变量**是否存在**」，不是值。存在就以纯 Node 模式启动，
`require('electron')` 返回 npm 包的路径字符串。

### 6. 「点了启动迷你窗没反应」

配置被污染：窗口 180×408、内容透明度 14%、未置顶。窗口确实创建了，但肉眼看不见。

三层防护：
| 层 | 做法 |
|---|---|
| UI 初始化 | `paintOpacity(false)` —— 初始化时不回写主进程 |
| 主进程读配置 | 尺寸 < 280×420、透明度 < 35%、未置顶 → 自动重置 |
| 主进程存配置 | 存盘副本脱敏，透明度 < 35% 一律存成 100% |

第三层是关键：**当前会话想多透明都行，只是不把「看不见」带到下次**。

### 7. 滑杆被意外触发

`pointerdown` 时立刻 `set(e)`，窗口出现在鼠标下方就会被设成该位置的值（实测 9%）。
改成只有真拖动过、或确认是单击，才改动。

### 8. 帧率统计在骗人

拿「数据到达」当采样点，窗口长度随网络抖动漂移，fps 在 5~128 之间乱跳。
改成固定 1 秒定时器 + 每拍重置窗口。

---

## HTTP 路由

### DSH Host 路由（`127.0.0.1:<DSH端口>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-miniwin/state` | 会话状态 + 日志 |
| GET | `/dsh-miniwin/addrs` | 本机 IPv4（已排序）+ lanPort + lanToken |
| GET | `/dsh-miniwin/qr?text=` | 生成二维码 SVG |
| GET | `/dsh-miniwin/devices` | adb 设备列表 |
| GET | `/dsh-miniwin/m` | 配对页（本地预览） |
| GET | `/dsh-miniwin/auto` | **自动发现（零输入核心）** |
| POST | `/dsh-miniwin/pair-auto` | 只填配对码 |
| POST | `/dsh-miniwin/pair` | 底层配对 |
| POST | `/dsh-miniwin/connect` | `{addr}` |
| POST | `/dsh-miniwin/launch` | `{serial}` 起迷你窗 |
| POST | `/dsh-miniwin/report` | 迷你窗状态回写 |

### LAN 服务器（`0.0.0.0:<lanPort>`，手机访问）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/t/<token>/` | 手机配对页 |
| GET | `/t/<token>/auto` | 自动发现 |
| POST | `/t/<token>/pair-auto` | `{code}` |
| POST | `/t/<token>/launch` | `{serial}` |

token 不对返回 403。

---

## 依赖

| 路径 | 用途 | 环境变量 |
|---|---|---|
| `C:/Users/Vincent/dsh/miniwin-stream/` | 迷你窗实现 | `MINIWIN_HOME` |
| `.../tools/scrcpy/.../adb.exe` | adb | `MINIWIN_ADB` |
| `...research/_probe/node_modules/electron/dist/electron.exe` | 跑迷你窗 | `MINIWIN_ELECTRON` |

---

## 测试

```powershell
cd C:\Users\Vincent\.dsh\plugins\dsh-miniwin
node --test --test-timeout=45000 test/host.test.mjs      # 20 项
node --test --test-timeout=45000 test/qr.test.mjs        #  8 项
node --test --test-timeout=45000 test/addrs.test.mjs     #  5 项
node --test --test-timeout=45000 test/discover.test.mjs  #  7 项
node --test --test-timeout=45000 test/state.test.mjs     #  9 项
```

合计 **49 项全通过**。

QR 编码器自己实现（byte mode, 版本 1–10, EC L/M/Q/H, mask 0），
已用 OpenCV 解码验证，并与 python `qrcode` 参考实现逐位一致。

---

## 已知限制

- **第一次必须插一次 USB**（Android adbd 的循环依赖 + 华为无无线调试）
- **重启手机后需再插一次**（`adb tcpip` 不持久化）
- **DRM 内容投不出来**（`FLAG_SECURE`，系统级保护）
- 拿不到音频（`AudioPlaybackCapture` 的 API 限制）
- LAN 端口每次启动随机变化（重新出码即可）
- **不支持在手机浏览器里投屏**：`getDisplayMedia` 在
  [Chrome for Android 不支持](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia)

---

## 声音规则

| 场景 | 行为 |
|---|---|
| 手机插着耳机（有线/蓝牙） | **声音留在手机**，不投到电脑；插件会停掉手机端采集，避免它把音量锁在 0 |
| 手机外放，刚连上投屏 | **双端静音**：手机静音，投屏音量默认 0 |
| 手动把投屏音量调高 | 才开始把手机声音投到电脑 |
| 拖投屏音量 | 只改电脑这一端，不动手机音量 |
| 按手机音量键 | 投屏音量被**重置**成手机当前音量 |
| 断开连接 | 停音频 + 杀掉手机端 App |

耳机插着时投屏音量恒为 0，拔掉也不会自动出声 —— 必须手动调高。
