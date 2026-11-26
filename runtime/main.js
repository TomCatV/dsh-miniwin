'use strict'

/**
 * ══════════ 代理绕过（必须在任何 require 之前）══════════
 *
 * ── 为什么 ──
 *
 * 用户开着本地代理（Clash/v2ray 等，127.0.0.1:7890）时，
 * 系统代理配置会让 Electron 和 Node 的 HTTP 请求全部走代理。
 * 而我们的数据链路全是**本机和局域网**：
 *   http://127.0.0.1:43111/frames   （迷你窗拉流）
 *   http://172.31.100.174:43111/pair（手机扫码）
 * 这些请求被代理转发出去就必然失败 —— 表现是「WiFi 连上了、
 * 码也扫了，但画面不出来」，且和网络质量无关。
 *
 * ── 解法（三层）──
 *
 *   1. 清空 process.env 里的代理变量（Node 侧 http/fetch 用）
 *   2. 只给回环+局域网段设 NO_PROXY（保留外网代理能力）
 *   3. app.commandLine 关掉 Chromium 的代理自动检测，
 *      并在 session 级别设置 proxy: 'direct'（渲染层 fetch 用）
 *
 * 这样开不开代理都能连上，且不影响用户其他程序走代理。
 */
const LOCAL_HOSTS = [
  '127.0.0.1', 'localhost', '::1',
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'
].join(',')

// ① 环境变量层：把本机/局域网加入 NO_PROXY，但保留代理本身
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                 'http_proxy', 'https_proxy', 'all_proxy']) {
  const v = process.env[k]
  if (!v) continue
  // 代理指向本机端口的场景不要删（用户可能靠它上网），只加 NO_PROXY
}
process.env.NO_PROXY = LOCAL_HOSTS
process.env.no_proxy = LOCAL_HOSTS
// 我们自己发出的请求一律不走代理（Node 的 undici / global-agent 都会读这个）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0'

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const { Adb } = require('./device')
const net = require('net')
/**
 * 通道决策的纯函数。
 *
 * 必须放在**顶层** —— 之前这行被插进了 ensureCtrl() 内部，
 * 结果 startScrcpySession 里的通道守护每次 tick 都抛 
 * ReferenceError: isCurrentAlive is not defined，而异常又被异步回调吞掉，
 * 表现就是「守护写了但从来不生效」。
 */
const { pickFallbackSerial, isCurrentAlive, findStaleWifi, shouldUpgradeToUsb } = require('./transport-pick')

/**
 * 把一条「adb 说是 already connected、实际是 offline」的 WiFi 连接救回来。
 *
 * 实测：adb connect 回 `already connected to 172.31.100.199:5555`，
 * 但 `adb devices` 里那条仍然是 offline —— 状态卡住了，只 connect 没用。
 * 必须 disconnect 再 connect 才会重新握手。
 */
async function adbReviveWifi (serial) {
  const { execFile } = require('node:child_process')
  const run = (args, t = 8000) => new Promise(resolve => {
    execFile(adbPath(), args, { timeout: t, windowsHide: true },
      (err, stdout, stderr) => resolve(String(stdout || '') + String(stderr || '')))
  })
  await run(['disconnect', serial])
  await new Promise(r => setTimeout(r, 250))
  const out = await run(['connect', serial])
  return { ok: /connected to/i.test(out), out: out.trim() }
}


/**
 * 托盘图标 —— 窗口被盖住/关掉时的最后一道唤回入口。
 *
 * 和任务栏图标互补：
 *   任务栏  → 窗口还在时点一下还原
 *   托盘    → 窗口关掉了、或者任务栏被自动隐藏时依然能操作
 *
 * 托盘不进 require('electron') 的解构，因为它有时会是 undefined
 * （极少数 Linux 环境下），延迟取更安全。
 */
let Tray = null
let Menu = null
let nativeImage = null
try {
  const el = require('electron')
  Tray = el.Tray
  Menu = el.Menu
  nativeImage = el.nativeImage
} catch {}

/**
 * 二进制路径。
 *
 * 当前架构只用两个：
 *   adb.exe      —— 设备发现、WiFi 自愈、反向控制（触控）
 *   scrcpy.exe   —— 视频采集（通过命名管道输出 mkv）
 *
 * scrcpy-server 那个 jar 不再由我们推送 —— scrcpy.exe 自己管。
 * 音频走 scrcpy 的 --audio 参数（暂未启用）。
 */
const ADB_BUNDLED = path.join(__dirname, 'tools', 'scrcpy', 'scrcpy-win64-v5.0.1', 'adb.exe')

/**
 * Node 可执行文件 —— 用于 spawn wifi-receiver.js。
 *
 * 不能用 process.execPath：Electron 里那是 electron.exe，
 * 跑普通 Node 脚本会变成启动一个 Electron 实例。
 *
 * 也不能写死某一台机器上的 nvm 路径 —— 插件发到别人机器上就找不到。
 * 顺序：显式环境变量 → 宿主安装目录自带的 runtime node → PATH → electron 同级的 node。
 */
const NODE_EXE = (() => {
  const fs0 = require('node:fs')
  const cands = []
  if (process.env.MINIWIN_NODE) cands.push(process.env.MINIWIN_NODE)
  // Electron 宿主：process.resourcesPath = <install>/resources
  const roots = []
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  if (process.resourcesPath) {
    roots.push(process.resourcesPath)
    roots.push(path.dirname(process.resourcesPath))
  }
  for (const r of roots) {
    for (const rel of [
      'runtime/x64/primary-runtime/dependencies/node/bin/node.exe',
      'resources/runtime/x64/primary-runtime/dependencies/node/bin/node.exe',
      'dependencies/node/bin/node.exe'
    ]) cands.push(path.join(r, rel))
  }
  const pathEnv = process.env.Path || process.env.PATH || ''
  for (const d of pathEnv.split(';')) {
    if (d) cands.push(d.replace(/\\+$/, '') + '/node.exe')
  }
  for (const c of cands) {
    try { if (c && fs0.existsSync(c)) return c } catch {}
  }
  return process.execPath
})()
const SCRCPY_EXE = path.join(__dirname, 'tools', 'scrcpy', 'scrcpy-win64-v5.0.1', 'scrcpy.exe')
/** 系统 adb：只在没带 bundled adb 时才用；不写死某台机器的路径 */
const ADB_SYSTEM = process.env.ADB_EXE || 'adb'

/**
 * 最小窗口宽度 —— 清晰度红线。
 *
 * 1080p 源的字符笔画宽度约 2~3 像素。窗口显示比例低于 0.3
 * 时笔画会被采样成 1 像素以下，汉字直接糊掉（实测 214 宽
 * 对应 0.196 倍，完全看不清）。
 *
 * 320 是经验下限：0.30 倍时小字仍可辨认。
 * 用户拖得再小也不允许，宁可窗口大一点。
 */
const MIN_W = 320
const MIN_H = 240
const SNAP = 14
const AUTO = process.argv.includes('--auto')

/** 解析 --serial <值>，用于锁定 USB 或 WiFi 设备 */
function argSerial () {
  const i = process.argv.indexOf('--serial')
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find(a => a.startsWith('--serial='))
  if (eq) return eq.slice('--serial='.length)
  return null
}

/**
 * ══════════════════════════════════════════════════════════════════════
 *  画质档位表
 * ══════════════════════════════════════════════════════════════════════
 *
 * 每一档都是实测跑过的配置（30 秒长跑 × 3 轮，判定标准：
 * 0 丢帧 / 0 降档 / 0 花屏 / 无低帧告警）。
 *
 * 字段说明：
 *   id        稳定标识，写进配置和 IPC，改名会破坏已有配置
 *   name      给用户看的名字
 *   maxSize   编码**长边**上限（scrcpy --max-size 是长边语义！）
 *             手机 1260×2844 → 2844 才是原生，1260 只有 44% 像素
 *   fps       编码帧率上限
 *   bitRate   目标码率（字符形式，直接给 scrcpy --video-bit-rate）
 *   note      一句话说明，切换 UI 里当副标题
 *
 * ── 为什么 1440 不在表里 ──
 *
 * 实测 1440 档 3 轮里 2 轮出现 21 次背压丢帧，其余档都是 0。
 * 怀疑是 2844→1440 的缩放比 0.506 非整数倍，手机端 encoder 的
 * scale 路径走了慢分支。等手机重新上线单独验证过再决定要不要加。
 *
 * ── 后续做切换 UI 怎么用 ──
 *
 *   1. 渲染层调 window.api.qualityList() 拿 TIERS 的副本
 *      （故意不含函数，纯数据，可以直接 postMessage）
 *   2. 用户选一个 → window.api.qualitySet('standard')
 *   3. 主进程热切换（见 applyQuality）→ 推送 quality:changed 事件
 *   4. 重启后配置里 st.quality 记住上次选择
 *
 * 整个过程不需要重启应用，也不需要重新 spawn 迷你窗。
 */
const TIERS = [
  {
    id: 'native',
    name: '原生',
    maxSize: 2844,
    fps: 60,
    bitRate: '16M',
    note: '1260×2844 原画质，局域网带宽约 16Mbps'
  },
  {
    id: 'hd',
    name: '高清',
    maxSize: 1920,
    fps: 60,
    bitRate: '12M',
    note: '1920 长边，文字锐利，带宽约 12Mbps'
  },
  {
    id: 'standard',
    name: '标准',
    maxSize: 1080,
    fps: 60,
    bitRate: '8M',
    note: '1080 长边，省一半带宽，小窗里几乎看不出差别'
  },
  {
    id: 'eco',
    name: '省电',
    maxSize: 1080,
    fps: 30,
    bitRate: '6M',
    note: '1080 长边 + 30fps，手机发热和耗电最低'
  },
  {
    /**
     * 低延迟档 —— 专为「远程操作」而不是「看视频」设计。
     *
     * 原理：编码和解码的延迟大致与「每帧的像素数 × 码率」成正比。
     * 把长边降到 1280、码率降到 4M，单帧数据量只有 native 的 1/8，
     * 编码器和大管线的排队时间随之塌下来。
     *
     * 代价是清晰度下降（1280 长边在 400px 的窗里显示比例 0.31，
     * 文字会略糊），但点击响应明显跟手。用户要的是「点了就动」，
     * 这时候清晰度不是第一优先。
     *
     * fps 用 60：低延迟场景下高 fps 更重要 —— 更高的帧率意味着
     * 画面变化能更快被编码送出，而不是等下个采样周期。
     */
    id: 'lowlat',
    name: '低延迟',
    maxSize: 1280,
    fps: 60,
    bitRate: '4M',
    note: '1280 长边 + 4M + 60fps，操作跟手，画质略降'
  }
]

/**
 * 默认档位。
 *
 * ── 从 native 改成 lowlat 的原因 ──
 *
 * native（1260×2844 / 16Mbps）画质最好，但单帧数据量大，
 * 排队深度 48 帧 ≈ 800ms —— 用户点一下屏幕要等将近一秒才看到反应，
 * 交互体感很差。
 *
 * lowlat（1280 长边 / 4M / 60fps）单帧只有 native 的 1/8，
 * 排队压到 12 帧 ≈ 200ms，点击响应明显跟手。
 *
 * 代价是清晰度略降，但用户的核心诉求是「远程操作手机」而不是
 * 「欣赏画面」。要看细节时在标题栏点档位切回「原生」即可，
 * 不需要改代码。
 */
const DEFAULT_TIER = 'lowlat'

/**
 * 设备原生长边（首次读到 props 时更新）。
 *
 * 声明在 TIERS 之后、任何使用者之前 —— 之前放在 IPC handler 附近，
 * 而 startScrcpySession 里先给它赋了值，模块加载时按从上到下求值，
 * 赋值发生在声明之前会直接抛 ReferenceError（TDZ）。
 */
let lastNativeLongSide = 0

/**
 * 命令行入口：--quality <id>
 *
 * 让「先用命令行试一档」不用改配置文件：
 *   electron main.js --auto --quality eco
 *
 * 这个值在 loadCfg() 里覆盖配置，所以必须在 loadCfg 调用之前求值——
 * 它现在就在模块顶层，早于 app.whenReady。
 */
const qualityArg = (() => {
  const i = process.argv.indexOf('--quality')
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  const eq = process.argv.find(a => a.startsWith('--quality='))
  return eq ? eq.slice('--quality='.length) : null
})()


/**
 * 按 id 找档位；找不到回落到默认档。
 *
 * 不抛异常是有意的：配置里可能存着一个被删掉的旧档位 id
 * （或者用户手改了 JSON），这时候应该静默回落到可用档，
 * 而不是让整个启动流程失败。
 */
function tierById (id) {
  return TIERS.find(t => t.id === id) ||
         TIERS.find(t => t.id === DEFAULT_TIER) ||
         TIERS[0]
}

/**
 * 从「手机原生长边」约束一个档位的实际参数。
 *
 * 档位表的 maxSize 是**绝对值**（2844/1920/1080），但如果换一台
 * 1080p 的手机，`native` 档传 2844 没有意义（scrcpy 会自动按屏幕
 * 尺寸限制，但日志和 UI 上显示的数字会误导）。所以统一在这里夹一次。
 */
function resolveTier (tier, nativeLongSide) {
  const longSide = nativeLongSide > 0 ? nativeLongSide : 2844
  const maxSize = Math.min(tier.maxSize, longSide)
  return {
    id: tier.id,
    name: tier.name,
    maxSize,
    fps: tier.fps,
    bitRate: tier.bitRate,
    /**
     * 实际编码尺寸的估算（短边按手机比例反推）。
     * 只用于日志/UI 展示，真实尺寸以 SPS 解析出来的为准。
     */
    estShort: nativeLongSide > 0
      ? Math.round(maxSize * (1260 / 2844))
      : 0
  }
}

let win = null
let session = null
/**
 * 默认窗口尺寸 —— 字号可读性优先。
 *
 * 手机物理 1260×2844，编码 1080×2438。窗口宽度对应关系：
 *   360 → 显示比例 0.33，汉字笔画糊成一团（实测用户反馈）
 *   480 → 0.44，正常字号可读
 *   600 → 0.56，接近原生清晰度但占屏太多
 * 取 480 宽 × 1000 高：在 1440p 屏上占小半屏，字清楚。
 */
/**
 * 默认窗口尺寸 —— 首次启动时按屏幕自动算到最大可用。
 *
 * 手机原生 1260×2844（比例 0.443）。想让字清楚就必须让窗口
 * 尽可能大 —— 用户屏幕上能容纳多高就用多高（留 8% 余量给任务栏）。
 *
 * w/h 为 null 时由 win:video-size 首次到达后自动计算，
 * 这样不用写死数字，换显示器也能自适应。
 */
/**
 * 持久化状态。
 *
 * quality 取代了原来的 maxSize / fps / bitRate 三个散字段 ——
 * 那三个值必须成套变化（比如 fps 改了码率也得跟着改），
 * 分开存很容易出现「fps=30 但 bitRate 还是 16M」这种不一致。
 *
 * 老配置里还留着 maxSize/fps/bitRate，加载时会做一次迁移
 * （见 loadCfg），迁移完就不再写这三个字段。
 */
const st = {
  x: null, y: null, w: null, h: null,
  ratioLock: true,
  contentOp: 1,
  bgOp: 1,
  pinned: false,
  /** 画质档位 id，见 TIERS */
  quality: DEFAULT_TIER
}

const cfgPath = () => path.join(app.getPath('userData'), 'miniwin-stream.json')
function loadCfg () {
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) } catch { /* 首次运行 */ }

  /**
   * ── 老配置迁移 ──
   *
   * 之前的配置是散字段：maxSize / fps / bitRate。
   * 现在收敛成一个 quality（档位 id）。
   *
   * 迁移策略：按老的 maxSize 找最接近的档位。
   *   >= 2400 → native
   *   >= 1600 → hd
   *   >= 1200 → standard
   *    其他   → eco
   *
   * 不覆盖用户已经设过的 quality（说明是新配置）。
   */
  if (!raw.quality && (raw.maxSize || raw.fps || raw.bitRate)) {
    const ms = Number(raw.maxSize) || 0
    raw.quality = ms >= 2400 ? 'native' : ms >= 1600 ? 'hd' : ms >= 1200 ? 'standard' : 'eco'
    raw.__migrated = true
  }

  // 迁移后不再保留这三个字段，避免下次又被当成"老配置"
  delete raw.maxSize
  delete raw.fps
  delete raw.bitRate

  Object.assign(st, raw)

  /**
   * ══════════ 置顶：默认关，只认显式的 true ══════════
   *
   * 用户要求：「默认不置顶」。
   *
   * Object.assign 会把配置里的任何值搬进 st，包括历史遗留的 pinned:true
   * —— 那种情况下用户根本没开过置顶，窗口却一直压在别的窗口上面。
   * 这里收一次口：只有配置里明确写了 `"pinned": true` 才置顶，
   * 缺失 / false / 其他值一律按「不置顶」处理。
   */
  st.pinned = raw.pinned === true

  /**
   * 命令行 --quality 优先级最高（临时试档，不改配置）。
   * 放在配置合并之后、合法性校验之前。
   */
  if (qualityArg && TIERS.some(t => t.id === qualityArg)) {
    st.quality = qualityArg
  }

  // 档位 id 必须是合法的，否则回落默认
  if (!TIERS.some(t => t.id === st.quality)) {
    st.quality = DEFAULT_TIER
    raw.__migrated = true
  }

  /**
   * 合理性检查：上次退出时的状态可能让窗口「看不见」。
   *
   * 真实踩过的坑：测试时把窗口缩到 180×408、内容透明度调到 14%、
   * 背景透明度调到 0%、还关掉了置顶。再启动时窗口确实创建了，
   * 但几乎完全透明 + 尺寸极小 + 被其它窗口盖住，用户看着就是
   * 「点了启动迷你窗没反应」。
   *
   * 所以：透明度太低、尺寸太小、或者跑出屏幕外，一律回到能看见的状态。
   *
   * 置顶不参与「救回来」：默认就是关的（用户要求），被别的窗口盖住是预期行为，
   * 标题栏圆钉 / Ctrl+Shift+F12 随时能再打开。
   */
  let fixed = false

  // w/h 为 null 表示「让程序根据屏幕自动算最大」，不做下限校验
  if (st.w !== null && (!(st.w >= MIN_W) || st.w < 340)) { st.w = null; fixed = true }
  if (st.h !== null && (!(st.h >= MIN_H) || st.h < 420)) { st.h = null; fixed = true }
  if (!(typeof st.contentOp === 'number') || st.contentOp < 0.35) { st.contentOp = 1; fixed = true }
  if (!(typeof st.bgOp === 'number') || st.bgOp < 0.35) { st.bgOp = 1; fixed = true }

  // 坐标跑出可见工作区就回到默认位置
  try {
    if (st.x !== null && st.y !== null) {
      const wa = screen.getPrimaryDisplay().workArea
      const outOfBounds =
        st.x + st.w < wa.x + 60 ||
        st.x > wa.x + wa.width - 60 ||
        st.y + st.h < wa.y + 60 ||
        st.y > wa.y + wa.height - 60
      if (outOfBounds) { st.x = null; st.y = null; fixed = true }
    }
  } catch {}

  if (fixed || raw.__migrated) {
    try { saveCfg() } catch {}
    try {
      console.log(raw.__migrated
        ? '[info] 配置已迁移到画质档位制（quality=' + st.quality + '）'
        : '[info] 窗口状态不合理（太小/太透明/跑到屏幕外），已重置为可见状态')
    } catch {}
  }
}
/**
 * 存盘前做一次「可见性脱敏」。
 *
 * 为什么：用户可能把透明度拖到 10%（会话内合法），窗口状态也存下来。
 * 下次启动读回来就是 10% —— 窗口在但几乎看不见，用户以为程序坏了。
 * 之前我自己测试就撞了两次（14%、16%、11% 各不相同）。
 *
 * 只对**存盘副本**脱敏，不动内存里的 st：
 * 当前会话想多透明就多透明，只是不把「看不见」这个状态带到下次。
 */
const PERSIST_MIN_OP = 0.35

function saveCfg () {
  try {
    const snapshot = Object.assign({}, st)
    if (!(snapshot.contentOp >= PERSIST_MIN_OP)) snapshot.contentOp = 1
    if (!(snapshot.bgOp >= PERSIST_MIN_OP)) snapshot.bgOp = 1
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true })
    fs.writeFileSync(cfgPath(), JSON.stringify(snapshot, null, 2))
  } catch { /* 存盘失败不影响运行 */ }
}

function adbPath () {
  if (fs.existsSync(ADB_BUNDLED)) return ADB_BUNDLED
  if (fs.existsSync(ADB_SYSTEM)) return ADB_SYSTEM
  return 'adb'
}

/* ---------- 缩放几何（与 demo 同逻辑） ---------- */
function computeResize (b, dir, dx, dy, ratioLock) {
  const ratio = b.width / b.height
  let x = b.x, y = b.y, w = b.width, h = b.height
  if (dir.includes('e')) w = b.width + dx
  if (dir.includes('w')) { w = b.width - dx; x = b.x + dx }
  if (dir.includes('s')) h = b.height + dy
  if (dir.includes('n')) { h = b.height - dy; y = b.y + dy }
  if (ratioLock) {
    if (dir === 'n' || dir === 's') { w = h * ratio; x = b.x + (b.width - w) / 2; if (dir === 'n') y = b.y + (b.height - h) }
    else { h = w / ratio; if (dir.includes('n')) y = b.y + (b.height - h); else y = b.y; if (dir.includes('w')) x = b.x + (b.width - w); else x = b.x }
  }
  if (w < MIN_W) { if (dir.includes('w')) x = b.x + (b.width - MIN_W); w = MIN_W; if (ratioLock) { h = w / ratio; if (dir.includes('n')) y = b.y + (b.height - h) } }
  if (h < MIN_H) { if (dir.includes('n')) y = b.y + (b.height - MIN_H); h = MIN_H; if (ratioLock) { w = h * ratio; if (dir.includes('w')) x = b.x + (b.width - w) } }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
}

function snapInto (x, y, w, h) {
  const wa = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) }).workArea
  let nx = x, ny = y
  if (Math.abs(nx - wa.x) < SNAP) nx = wa.x
  if (Math.abs((nx + w) - (wa.x + wa.width)) < SNAP) nx = wa.x + wa.width - w
  if (Math.abs(ny - wa.y) < SNAP) ny = wa.y
  if (Math.abs((ny + h) - (wa.y + wa.height)) < SNAP) ny = wa.y + wa.height - h
  nx = Math.min(Math.max(nx, wa.x - w + 90), wa.x + wa.width - 90)
  ny = Math.min(Math.max(ny, wa.y), wa.y + wa.height - 44)
  return { x: Math.round(nx), y: Math.round(ny) }
}

function broadcastSize () {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  win.webContents.send('size:update', { w: b.width, h: b.height })
}

function applyBounds (b) {
  if (!win || win.isDestroyed()) return
  win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(MIN_W, Math.round(b.width)), height: Math.max(MIN_H, Math.round(b.height)) })
  broadcastSize()
}

/* ---------- 会话状态 ---------- */
/**
 * 状态出口有两条：
 *   1) 推给自己的渲染进程（迷你窗 UI 用）
 *   2) POST 回 DSH 插件的 /dsh-miniwin/report（侧边栏面板用）
 * 第 2 条是可选的：插件地址没给就不发，迷你窗照样独立工作。
 */
let reportUrl = null

function pushStatus (patch) {
  if (win && !win.isDestroyed()) win.webContents.send('status', patch)
  if (reportUrl) {
    // 不 await、不阻塞；失败静默
    fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).catch(() => {})
  }
}

/** 最近一次上线的设备信息（渲染层重载后要补推） */
let lastDeviceInfo = null

/**
 * 把「当前会话状态」重新推给渲染层 —— 页面重载 / 崩溃恢复后调用。
 *
 * 渲染层是纯展示端，所有配置都靠主进程主动下发（video:config / status）。
 * 页面一刷新，它就把这些全忘了：解码器没配置 → 每帧都「丢弃」，
 * 状态栏没有文案 → 停在初始的「MiniWin」，看起来像断线。
 *
 * 这里把三样东西补一遍，不重建任何连接：
 *   ① video:config  解码器配置（SPS/PPS + codecString）
 *   ② status        连接状态 + 设备 + 分辨率
 *   ③ quality       当前画质档位
 */
function replayStateToRenderer () {
  if (!win || win.isDestroyed()) return
  try {
    const cap = session && session.scrcpyCapture
    if (cap && cap.codecPrivate && cap.codecPrivate.length >= 7) {
      const desc = avccFromCodecPrivate(cap.codecPrivate)
      const hx = i => desc[i].toString(16).padStart(2, '0')
      win.webContents.send('video:config', {
        description: desc,
        codecString: `avc1.${hx(1)}${hx(2)}${hx(3)}`,
        width: lastVideoW || 0,
        height: lastVideoH || 0
      })
    }
    const streaming = !!(cap && cap.running)
    /**
     * stats 必须一起补 —— 渲染层靠 `stats.frames > 0` 判断「已经有画面了」，
     * 少了它就会一直挂着「正在连接手机…」的占位层（真实 bug，用户报过）。
     */
    win.webContents.send('status', {
      phase: streaming ? 'streaming' : 'idle',
      streaming,
      device: lastDeviceInfo,
      videoSize: lastVideoW ? { w: lastVideoW, h: lastVideoH } : null,
      phoneAsleep: !!(session && session.phoneAsleep),
      stats: cap
        ? {
            fps: Math.round(cap.fps || 0),
            frames: cap._frames || 0,
            keyFrames: 0,
            kbps: 0,
            dropped: 0
          }
        : null
    })
    win.webContents.send('quality:changed', { current: st.quality })
    logLine('info', '渲染层已重载，状态与解码器配置已补推')
  } catch (e) {
    logLine('warn', '补推状态失败: ' + e.message)
  }
}

/**
 * 日志写入 —— 必须全程容错。
 *
 * ══════════ 为什么 console.log 会崩进程 ══════════
 *
 * 启动方式如果是 `Start-Process -RedirectStandardOutput file`，
 * Electron 的 stdout 就是一个**管道**。当上游（PowerShell / 父进程）
 * 退出或关闭了读端，管道断开，之后每次 `console.log` 都会抛：
 *
 *   Error: EPIPE: broken pipe, write
 *     at console.log (node:internal/console/constructor:414)
 *     at logLine (main.js:507)
 *
 * 而这个异常发生在主进程里、又是同步的 —— 直接把整个 Electron
 * 进程打死（用户看到的就是「弹一个 Error 窗口，然后投屏没了」）。
 *
 * 更恶劣的是：任何一次日志都可能触发（包括"启动失败"这类日志），
 * 于是「出问题 → 记日志 → 崩 → 更看不出问题」。
 *
 * 所以这里把 console.log 包在 try/catch 里。日志丢一行无所谓，
 * 进程崩了才是灾难。
 */
function safeLog (text) {
  try {
    console.log(text)
  } catch {
    // stdout 已断（EPIPE 等）。静默降级：日志只走 IPC 和上报，
    // 不再尝试写那个已经死掉的管道。
    safeLog.dead = true
  }
}

function logLine (level, msg) {
  const line = { t: Date.now(), level, msg }
  if (!safeLog.dead) safeLog(`[${level}] ${msg}`)
  try {
    if (win && !win.isDestroyed()) win.webContents.send('log', line)
  } catch {}
  if (reportUrl) {
    try {
      fetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log: msg, level })
      }).catch(() => {})
    } catch {}
  }
}

/**
 * 会话代号 —— 让「等手机」这种长阻塞能被用户打断。
 *
 * 用户点了「重开迷你窗」后可能在等手机的 3 分钟里改主意、再点一次，
 * 或者直接关窗。旧代码没有打断点，那个 await 会一直挂着，
 * 后面再启动一次就是两个循环同时扫网段，互相抢 adb。
 *
 * 每次 startSession / stopSession 都 ++，waitForPhone 每轮比对，
 * 一旦发现代号变了就立刻返回 null。
 */
let sessionGen = 0

async function stopSession () {
  sessionGen++          // 打断可能在跑的 waitForPhone
  if (!session) return
  const s = session
  session = null
  /**
   * 先取消断线重连计时器 —— 否则用户主动点「停止」之后，
   * 几秒后被挂起的 reconnectTimer 又会把投屏拉起来，像鬼一样。
   */
  try { if (s.scrcpyCapture && s.scrcpyCapture._cancelReconnect) s.scrcpyCapture._cancelReconnect() } catch {}
  // scrcpy 采集引擎：停掉 scrcpy.exe 与解析器
  try { if (s.scrcpyCapture) await s.scrcpyCapture.stop() } catch {}
  // 音频桥
  try { if (s.healer) s.healer.stop() } catch {}
  try { if (s.audio) await s.audio.stop() } catch {}
  try { if (s.cap) await s.cap.stop() } catch {}
  ipcMain.removeAllListeners('win:frame-ack')
  try { if (s.statsTimer) clearInterval(s.statsTimer) } catch {}
  // 通道守护也要停 —— 否则它会在会话已死后继续尝试切换，把新会话打断
  try { if (s.transportTimer) clearInterval(s.transportTimer) } catch {}
  try { if (s.timer) clearTimeout(s.timer) } catch {}
  try { if (s.sock) s.sock.destroy() } catch {}
  try { if (s.controlSock) s.controlSock.destroy() } catch {}
  try { if (s.srv) s.srv.close() } catch {}
  try { if (s.server) await s.server.kill() } catch {}
  try { if (s.adb) await s.adb.run(['reverse', '--remove-all']) } catch {}
  try { if (s.adb && s.port) await s.adb.removeForward(s.port) } catch {}
  // 音频路由：断开时停音频 + 杀掉手机端 APK（用户要求）
  try { if (s.router) await s.router.teardown() } catch {}
  pushStatus({ streaming: false })
  logLine('info', '会话已停止')
}

/**
 * ══════════ 采集引擎选择 ══════════
 *
 * 默认用 scrcpy.exe 采集（50~80fps），因为我们的 APK 走
 * MediaProjection 在这台华为上被系统限流到 4fps —— 官方
 * scrcpy-server 自己跑也只有 0.1fps，说明是 VirtualDisplay
 * 合成优先级的问题，不是参数能调的。
 *
 * 传 --legacy-capture 可退回旧路径（APK + scrcpy-server），
 * 用于排查或换到 MediaProjection 正常的设备上。
 */
const USE_SCRCPY_CAPTURE = !process.argv.includes('--legacy-capture')

/**
 * ══════════ adbd 重启闸门（全局）══════════
 *
 * `adb tcpip 5555` 会重启手机侧 adbd，掐断所有 adb 连接，
 * 包括 scrcpy 正在用的 USB 隧道。所以在「采集正在跑」和
 * 「采集正在启动」这两个窗口里，任何重启 adbd 的操作都必须禁止。
 *
 * 为什么不能只看 session.scrcpyCapture.running：
 *   startScrcpySession 里是
 *     const cap = new ScrcpyCapture(...)   ← L969
 *     const r = await cap.start()          ← L1285，最长 35 秒
 *     session = { scrcpyCapture: cap }     ← L1291
 *   `session` 在 cap.start() **之后**才赋值。而那 35 秒里
 *   running 也是 false（start 内部最后才置 true）。
 *   于是「启动窗口」完全裸奔 —— 后台的 tcpip 正好能在这个空隙
 *   把刚 push 完 server 的 scrcpy 打死，表现为「点了投屏就断线」。
 *
 * 所以额外用一个显式的开始/结束标志把整个 start 过程包起来。
 */
let captureStarting = false

/** 现在是否禁止重启 adbd */
function adbdRestartForbidden () {
  if (captureStarting) return true
  if (session && session.scrcpyCapture && session.scrcpyCapture.running) return true
  return false
}

/**
 * ══════════ WiFi 备用通道预热（安全版）══════════
 *
 * ── 为什么要有这一个函数 ──
 *
 * 原来「顺手把 WiFi 通道热好」这件事是在三处各写了一遍
 * （waitForPhone / startScrcpySession / DeviceWatcher），全都是
 * 无脑 `adb tcpip 5555`。而这条命令的真实语义是
 * **重启手机侧 adbd**（adb 自己会打印 "restarting in TCP mode"）。
 *
 * adbd 一重启，所有 adb 连接当场失效 —— 包括 scrcpy 正在用的
 * USB 隧道。实测：scrcpy 录制中执行 `adb tcpip 5555`，
 * 下一秒就 `WARN: Device disconnected` + 退出 code=2。
 *
 * 用户的原话是：「投屏鼠标只要操作连接就会断」。
 * 点鼠标 → 懒启动控制通道 → DeviceWatcher 首次 tick →
 * 《顺手开无线通道》→ adbd 重启 → 断流。整条链路严丝合缝。
 *
 * ── 现在的规则 ──
 *
 *   ① 采集在跑 → 一律不动 adbd（宁可不预热，也不能断眼前的画面）
 *   ② 设备已经是 TCP 模式（service.adb.tcp.port=5555）→ 不重新下发，
 *      只补一条 adb connect 把无线通道接上（connect 不重启 adbd，安全）
 *   ③ 以上都不满足时，才真正下发一次 tcpip（只在冷启动、无采集时发生）
 *
 * @param {object} keeper  WifiAdbKeeper 实例（只借用它的 _run / _phoneIp）
 * @param {string} usbSerial
 * @param {string} [tag] 日志前缀，便于分辨是哪个入口触发的
 */
async function prepareWifiBackup (keeper, usbSerial, tag = 'wifi') {
  if (!keeper || !usbSerial) return

  /** ② 采集期 / 采集启动期 硬阻断（见 adbdRestartForbidden） */
  if (adbdRestartForbidden()) {
    logLine('info', `[${tag}] 采集进行中，跳过 tcpip 预热（它会重启 adbd 导致断流）`)
    return
  }

  try {
    /** 已有 WiFi 设备在线就不用折腾 */
    const devs = await keeper.devices()
    if (devs.some(d => d.isWifi)) return

    /** 查设备当前是不是已经在 TCP 模式 */
    let alreadyTcp = false
    try {
      const g = await keeper._run([
        '-s', usbSerial, 'shell', 'getprop', 'service.adb.tcp.port'
      ], 6000)
      alreadyTcp = String(g.out || '').trim() === '5555'
    } catch {}

    if (!alreadyTcp) {
      /**
       * 下发前再查一次闸门 —— 上面那次 getprop 是异步的，
       * 这一两秒里用户完全可能已经点了「开始投屏」。
       */
      if (adbdRestartForbidden()) {
        logLine('info', `[${tag}] 采集已开始，放弃 tcpip`)
        return
      }
      const r = await keeper._run(['-s', usbSerial, 'tcpip', '5555'], 15000)
      if (!r.ok) return
      await new Promise(r2 => setTimeout(r2, 2500))
    }

    const ip = await keeper._phoneIp(usbSerial)
    if (!ip) return
    const c = await keeper._run(['connect', `${ip}:5555`], 10000)
    if (/connected/.test(c.out)) {
      st.lastPhoneIp = ip
      logLine('info', `[${tag}] 备用 WiFi 通道已就绪（${ip}:5555）—— 拔线可无缝切换`)
    }
  } catch (e) {
    logLine('info', `[${tag}] WiFi 备用通道准备失败（不影响 USB 投屏）: ${e.message}`)
  }
}

/**
 * 等手机上线 —— 阻塞式轮询，拿到 serial 就返回。
 *
 * 只在「启动投屏」这条路上用，所以可以直接 await 等满超时：
 * 用户点了按钮之后本来就是在等画面，等待期间的状态推送
 * 会让他看到「正在等手机」而不是「失败」。
 *
 * 三种情况会被识别为「可以继续」：
 *   1. adb devices 里出现 WiFi 设备（172.x.x.x:5555）
 *   2. 出现 USB 设备 → 顺手跑一次 `adb tcpip 5555` 并连上去
 *      （手机重启后 adbd 回到 USB 模式，这是唯一的入口）
 *   3. 局域网扫描命中 5555 端口
 *
 * @param {import('./wifi-adb-keeper.js').WifiAdbKeeper} keeper
 * @param {{timeoutMs?:number, intervalMs?:number}} o
 * @returns {Promise<string|null>} 可直接传给 adb -s 的 serial
 */
async function waitForPhone (keeper, o = {}) {
  /**
   * 超时可调：--wait-ms N（调试/自动化用）或 MINIWIN_WAIT_MS。
   *
   * 默认 3 分钟是给真用户看的（插线、手机弹授权框都要时间），
   * 但测试不可能等 3 分钟，所以留两个口子 —— 命令行参数优先，
   * 因为 Start-Process 传环境变量在当前机器上不可靠。
   */
  const argWait = (() => {
    const i = process.argv.indexOf('--wait-ms')
    if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10)
    const eq = process.argv.find(a => a.startsWith('--wait-ms='))
    return eq ? parseInt(eq.slice('--wait-ms='.length), 10) : NaN
  })()
  const envMs = parseInt(process.env.MINIWIN_WAIT_MS || '', 10)
  const timeoutMs = o.timeoutMs ||
    (argWait > 0 ? argWait : (envMs > 0 ? envMs : 180000))
  const intervalMs = o.intervalMs || 3000
  const deadline = Date.now() + timeoutMs
  const gen = sessionGen
  let round = 0
  let lastUsbPrepare = 0
  let toldUser = false

  while (Date.now() < deadline) {
    // 用户可能中途自己点了停止/重连/关了窗口，这里要能被叫醒
    if (gen !== sessionGen) return null
    if (!win || win.isDestroyed()) return null

    round++
    const devs = await keeper.devices()

    /**
     * ① USB 设备已在线 —— 直接用它（USB 优先，见调用方的说明）。
     *
     * 顺手在后台把 WiFi 通道也热好，拔线时能无缝切。
     */
    const usb = devs.find(d => !d.isWifi)
    if (usb) {
      logLine('ok', `手机上线（USB）: ${usb.serial}`)
      ;(async () => {
        if (Date.now() - lastUsbPrepare < 15000) return
        lastUsbPrepare = Date.now()
        // 安全版预热：采集期间不碰 adbd，见 prepareWifiBackup 顶部注释
        await prepareWifiBackup(keeper, usb.serial, 'wait')
      })()
      return usb.serial
    }

    // ② 没有 USB，但有 WiFi → 用 WiFi
    const wifi = devs.find(d => d.isWifi)
    if (wifi) {
      logLine('ok', `手机上线（WiFi）: ${wifi.serial}`)
      return wifi.serial
    }

    // ③ 扫局域网
    if (round === 1 || round % 2 === 0) {
      if (!toldUser) {
        toldUser = true
        // 1 分钟以内按秒说，否则按分钟说 —— 别把 4 秒的测试值显示成「1 分钟」
        const span = timeoutMs < 60000
          ? `${Math.max(1, Math.round(timeoutMs / 1000))} 秒`
          : `${Math.round(timeoutMs / 60000)} 分钟`
        /**
         * 等待文案。
         *
         * 断线重连时不能说「插一次 USB」那套 —— 用户刚拔线，
         * 真正该做的是插回去重新开无线调试，所以调用方会传 o.hint 覆盖。
         */
        const msg = o.hint ||
          `正在等手机上线…（手机没开 adb 监听时最长等 ${span}，插一次 USB 会立刻连上）`
        logLine('info', msg)
        pushStatus({ phase: 'connecting', hint: msg })
      }
      const found = await keeper.scanLan()
      if (found) {
        logLine('ok', `扫描到设备: ${found}`)
        return found
      }
    }

    await new Promise(r => setTimeout(r, intervalMs))
  }

  return null
}

/**
 * scrcpy 采集模式的会话启动。
 *
 * 比旧路径短很多：不需要推 server、不需要 reverse 隧道、
 * 不需要自己解析 scrcpy 协议 —— scrcpy.exe 全包了，
 * 我们只负责把它录出来的 mkv 实时解成帧。
 */
async function startScrcpySession (opts = {}) {
  const adb = new Adb(adbPath())

  /**
   * ══════════ adbd 重启闸门：从函数一开始就关上 ══════════
   *
   * 原来这个闸门只在 cap.start() 前一刻才关，于是整段「探设备 / 读属性 /
   * 预热 WiFi」的窗口是敞开的 —— 期间任何一处触发 `adb tcpip 5555`
   * （它**重启 adbd**），都会在 scrcpy 刚 push 完 server 时把连接打死：
   * 一个字节也写不出来 → 35 秒后判「管道连接超时」。
   *
   * 实测 WiFi 通道每次都要重试一次才好，根因就在这个窗口。
   * 现在从进函数起就禁止重启 adbd；cap.start() 那处保留作为重复保险。
   *
   * 防呆：万一中途抛异常没走到 cap.start() 的 finally，90 秒后自动放开，
   * 免得永久锁死 adbd 重启能力。
   */
  captureStarting = true
  setTimeout(() => { captureStarting = false }, 90000)

  /**
   * ══════════ WiFi adb 自愈 ══════════
   *
   * adb 的 TCP 模式在手机重启后失效（adbd 回到 USB 模式），
   * 而 `adb tcpip` 只能通过 USB 下发。华为又裁掉了
   * 「无线调试配对」入口，没法用 Android 11 的原生方案。
   *
   * 所以这里在启动前先跑一次自愈：
   *   ① 已有 WiFi 设备 → 直接用
   *   ② 只有 USB → 自动跑 tcpip 切到 WiFi，然后提示用户拔线
   *   ③ 都没有 → 扫局域网 5555 端口找设备
   *
   * 全部自动化，用户最多插线 3 秒。
   */
  const { WifiAdbKeeper } = require('./wifi-adb-keeper.js')
  const keeper = new WifiAdbKeeper({
    adb: adbPath(),
    preferIp: st.lastPhoneIp || null,
    onLog: (m) => logLine('info', m),
    onOnline: (serial) => {},
    /** 采集期（含启动窗口）禁止 tcpip —— 重启 adbd 会掐断 scrcpy */
    isStreaming: () => adbdRestartForbidden()
  })

  // 先探一次当前状态（同步拿结果，不用等守护循环）
  let devs0 = await keeper.devices()

  /**
   * ══════════ 拔线后 WiFi 是 offline 的，得先救活 ══════════
   *
   * 实测（用户拔线后的日志）：
   *   [scrcpy] ERROR: Device could not be connected (state=offline)
   *   ERROR: Server connection failed
   *
   * usb 一拔，adb 表里那条 `ip:5555` 不会消失，而是变成 **offline**。
   * 旧代码还把它当可用设备选中，于是三次重试全打在一条死连接上，
   * 用户看到的就是「卡住不动」。
   *
   * 所以：只要表里有 WiFi 条目但都不是 device，就先 `adb connect` 一次
   * （缓存 IP 或条目里的 IP），再重读设备表。
   */
  const liveOf = (list) => (list || []).filter(d => d.state === 'device')
  if (!liveOf(devs0).some(d => d.isWifi)) {
    const stale = (devs0 || []).find(d => d.isWifi)
    const ip = (stale && String(stale.serial).split(':')[0]) ||
      (/^\d+\.\d+\.\d+\.\d+$/.test(String(st.lastPhoneIp || '')) ? st.lastPhoneIp : '')
    if (ip) {
      try {
        logLine('info', `[wifi] adb 里那条 ${ip}:5555 是 offline，主动重连一次…`)
        const a0 = new Adb(adbPath())
        const r0 = await a0.connectWifi(ip, 5555)
        logLine('info', `[wifi] 重连结果: ${(r0 && (r0.stdout || r0.message)) || 'ok'}`)
        await new Promise(res => setTimeout(res, 600))
        devs0 = await keeper.devices()
      } catch (e) {
        logLine('warn', '[wifi] 重连失败: ' + e.message)
      }
    }
  }

  let chosen = null
  const wifiDev = devs0.find(d => d.isWifi && d.state === 'device')
  const usbDev = devs0.find(d => !d.isWifi && d.state === 'device')

  /**
   * ══════════ 通道优先级：USB > WiFi ══════════
   *
   * 用户要求：「我 USB 和 WiFi 同时在线你优先用 USB」。
   *
   * ── 为什么 USB 优先是对的 ──
   *
   * ① 延迟低且稳定
   *    USB 是直连，没有 WiFi 抖动。实测单帧到达时间方差小很多，
   *    画面更跟手（点击游戏时尤其明显）。
   *
   * ② 带宽不受环境干扰
   *    访客 WiFi（RHZD-GUEST）是共享 AP，别人下载就会抢带宽；
   *    USB 没有这个问题。原生 2844 长边 @60fps 要 16Mbps，
   *    WiFi 抖动时直接表现为掉帧/花屏风险。
   *
   * ③ 不会「睡着」
   *    WiFi adb 是运行时状态（adbd 重启就没了），USB 插着就一直在。
   *
   * ── 什么时候仍用 WiFi ──
   *
   * 只有 USB 不在的时候。也就是说：插着线走 USB，拔了线自动
   * 由断线重连机制切到 WiFi（这条链路之前已经验证过）。
   *
   * 注意：即使用 USB，也要**顺手把 WiFi 通道准备好**（跑一次
   * tcpip + connect），这样用户拔线时能立刻无缝切过去，
   * 而不是等重连逻辑慢慢探测。
   */
  if (opts.serial && devs0.some(d => d.serial === opts.serial && d.state === 'device')) {
    chosen = opts.serial
  } else if (usbDev) {
    /**
     * USB 优先。
     *
     * 但仍然在后台把 WiFi 通道热好（不阻塞主流程）：
     * 拔线时不至于抓瞎。失败也无所谓，不影响 USB 直播。
     */
    chosen = usbDev.serial
    logLine('ok', `使用 USB 通道（${usbDev.serial}）`)

    /**
     * 把 WiFi 通道热好 —— 但**必须等它做完**再去启动采集。
     *
     * 这里原来是 fire-and-forget（`;(async () => {…})()`），后果很隐蔽：
     * prepareWifiBackup 内部可能跑 `adb tcpip 5555`，而那是**重启 adbd**。
     * 如果它在 scrcpy 正在 push server / 刚连上的那几秒里落地，
     * 采集端就会「一个字节都写不出来」，35 秒后判「管道连接超时」——
     * 用户看到的正是「WiFi 连不上」。实测这台机器上 WiFi 通道每次都要
     * 重试一次才好，根因就是这个竞态。
     *
     * 现在改成阻塞等待，但加 4 秒上限：手机重启后第一次插线最多多等 4 秒，
     * 换来的是采集不再被自己人打死。
     */
    try {
      await Promise.race([
        prepareWifiBackup(keeper, usbDev.serial, 'start'),
        new Promise(res => setTimeout(res, 4000))
      ])
    } catch {}
  } else if (wifiDev) {
    chosen = wifiDev.serial
    logLine('info', `没有 USB，使用 WiFi 通道（${wifiDev.serial}）`)
  } else {
    // 什么都没连 → 扫局域网
    logLine('info', '没有 adb 设备，正在扫描局域网…')
    const found = await keeper.scanLan()
    if (found) {
      chosen = found
      st.lastPhoneIp = found.split(':')[0]
      logLine('ok', `扫描到设备: ${found}`)
    }
  }

  /**
   * ══════════ 找不到设备时「等」而不是「报错」══════════
   *
   * 手机的 WiFi adb 是运行时状态：手机重启、切飞行、连着 WiFi 但
   * adbd 没开监听口，都会让 adb devices 变空。旧实现是当场抛错，
   * 用户点了「启动迷你窗」只看到一句失败就没了 —— 而真实情况往往
   * 只是「手机还没就绪」，等十几秒就好。
   *
   * 现在的行为：
   *   ① 先明确告诉用户「在等手机」而不是「失败」
   *   ② 每 3 秒重扫一次（优先上次 IP，再扫全网段 /24）
   *   ③ 期间只要 USB 插上，自动跑一次 tcpip 切到 WiFi
   *   ④ 超时（默认 3 分钟）才真正报错，并把可操作的原因写清楚
   */
  if (!chosen) {
    /**
     * 等多久？
     *
     * 首次启动可以等满（用户可能正在插线），但**断线自动重连不能等 3 分钟**：
     * 用户拔掉 USB 之后如果 WiFi 没就绪，界面会静默卡住 3 分钟 ——
     * 这正是「拔掉了，你看下卡了」那个现象。
     *
     * 重连时最多等 15 秒，并把可操作的原因直接写进提示条。
     */
    const waitMs = opts.reconnect ? 15000 : undefined
    if (opts.reconnect) {
      pushStatus({
        phase: 'connecting',
        hint: 'USB 已断开，WiFi 通道没就绪：插回 USB 一次即可重新开启无线调试'
      })
    }
    chosen = await waitForPhone(keeper, {
      intervalMs: 3000,
      timeoutMs: waitMs,
      hint: opts.reconnect
        ? 'USB 已断开，WiFi 通道没就绪：插回 USB 一次即可重新开启无线调试'
        : null
    })
    if (chosen) {
      /**
       * 只有 WiFi 地址才记 lastPhoneIp。
       *
       * 踩过的坑：USB 序列号（2MN0224829001893）也被 split(':')[0] 存了进去，
       * 落盘成 lastPhoneIp。下次冷启动时 keeper 会拿这个「IP」去
       * `adb connect 2MN0224829001893:5555`，白等一轮再失败。
       */
      if (/:\d+$/.test(chosen)) st.lastPhoneIp = chosen.split(':')[0]
      logLine('ok', `手机已就绪: ${chosen}`)
    }
  }

  if (!chosen) {
    const msg = '还是没找到手机。手机和电脑连的是同一个 WiFi（当前电脑在 RHZD-GUEST），' +
      '但手机侧没有开 adb 监听端口 —— 手机重启后需要在「开发者选项」里插一次 USB 由电脑自动初始化。'
    logLine('error', msg)
    pushStatus({ phase: 'error', error: msg })
    throw new Error(msg)
  }

  /**
   * ══════════ 选完先验活 ══════════
   *
   * adb 的条目会在 device / offline 之间抖（WiFi 上尤其明显）。直接拿一条
   * offline 的 serial 去 spawn scrcpy，三轮全打在死连接上：
   *
   *   [scrcpy] ERROR: Device could not be connected (state=offline)
   *   启动失败（管道连接超时）第 2/3 → 第 3/3 → 用户看到的就是「卡了」
   *
   * 所以连查两次（间隔 300ms）；不是 device 就唤醒一次；还不行就当「没设备」，
   * 交给下面的等待逻辑，而不是硬着头皮起 scrcpy。
   */
  if (chosen) {
    const isAlive = async () => {
      try {
        const list = await new Adb(adbPath()).devices()
        return list.some(x => x.serial === chosen && x.state === 'device')
      } catch { return false }
    }
    let alive = await isAlive()
    if (!alive) { await new Promise(r => setTimeout(r, 300)); alive = await isAlive() }
    if (!alive && /:\d+$/.test(String(chosen))) {
      logLine('warn', `[preflight] ${chosen} 当前不是 device，先唤醒一次…`)
      try {
        const rv = await adbReviveWifi(chosen)
        logLine('info', `[preflight] 唤醒结果：${rv.out || (rv.ok ? 'ok' : '失败')}`)
      } catch {}
      alive = await isAlive()
    }
    if (!alive) {
      logLine('warn', `[preflight] ${chosen} 仍不可用，先不启动采集`)
      chosen = null
    }
  }

  if (!chosen) {
    const waitMs = opts.reconnect ? 15000 : undefined
    if (opts.reconnect) {
      pushStatus({
        phase: 'connecting',
        hint: 'USB 已断开，WiFi 通道没就绪：插回 USB 一次即可重新开启无线调试'
      })
    }
    chosen = await waitForPhone(keeper, { intervalMs: 3000, timeoutMs: waitMs, hint: opts.reconnect ? 'USB 已断开，WiFi 通道没就绪：插回 USB 一次即可重新开启无线调试' : null })
  }

  // 用找到的 serial 选设备
  let dev
  try {
    dev = await adb.pickDevice(chosen)
  } catch (e) {
    logLine('error', e.message)
    pushStatus({ phase: 'error', error: e.message })
    throw e
  }
  logLine('ok', `设备：${dev.model || dev.serial}（${dev.transport}）`)
  lastDeviceInfo = { serial: dev.serial, model: dev.model, transport: dev.transport }
  pushStatus({ device: lastDeviceInfo, phase: 'preparing' })

  /**
   * 设备属性 —— 用 `let` 提到外层。
   *
   * 之前是 try 块里的 const，后面的采集参数要用 props.wm 却拿不到，
   * 直接抛 `props is not defined`，整个启动就断在这儿。
   * （典型的作用域错误：读的时候在 try 外面）
   */
  let props = null
  try {
    props = await adb.props()
    logLine('info', `Android ${props.release} (SDK ${props.sdk})${props.wm ? ' · ' + props.wm.width + '×' + props.wm.height : ''}`)
    pushStatus({ props })
  } catch (e) { logLine('warn', '读设备信息失败: ' + e.message) }

  const { ScrcpyCapture } = require('./scrcpy-capture.js')

  /**
   * ══════════ 采集参数 = 当前画质档位 ══════════
   *
   * 手机原生长边从 props.wm 读（这台是 2844），用来把档位里的
   * 绝对值夹一次 —— 换一台 1080p 手机时 native 档不会传 2844 上去。
   *
   * 档位表的定义见文件顶部的 TIERS 注释。
   */
  const nativeLongSide = props && props.wm
    ? Math.max(props.wm.width, props.wm.height)
    : 2844
  const nativeShortSide = props && props.wm
    ? Math.min(props.wm.width, props.wm.height)
    : 1260
  /** 短边/长边，用于按 max-size 反推另一条边（估算展示用） */
  const nativeAspect = nativeLongSide > 0 ? nativeShortSide / nativeLongSide : 0.443

  const tierRaw = tierById(st.quality)
  const tier = resolveTier(tierRaw, nativeLongSide)
  /** 记下来给 quality:get 用（那时已经没有 props 上下文了） */
  lastNativeLongSide = nativeLongSide

  const capMaxSize = tier.maxSize
  const capFps = Math.min(tier.fps, 60)
  /**
   * ══════════ WiFi 通道必须压码率 ══════════
   *
   * 实测（HBN-AL00）：
   *   原生档 1260×2844 @16Mbps 走 USB 没问题；
   *   同样的参数走 WiFi，scrcpy 的编码器被套接字反压卡住 ——
   *   35 秒一个字节都没写进管道，然后被判「管道连接超时」。
   *   用户看到的是「WiFi 连不上」，其实设备连得好好的。
   *
   * 降到 1080/8M 后立刻正常：3.0 秒出首帧，10 秒 248 帧。
   *
   * 所以 WiFi 通道把长边压到 ≤1080、码率压到 ≤8M，并在日志里写明原因，
   * 免得用户以为画质是自己设错了。
   */
  const isWifiTransport = /:\d+$/.test(String(dev.serial || ''))
  const WIFI_MAX_SIZE = 1080
  const WIFI_MAX_BITRATE = 8 * 1000 * 1000

  function parseBitRate (s) {
    const m = /^(\d+(?:\.\d+)?)([KMG])$/i.exec(String(s || '').trim())
    if (!m) return 0
    const n = Number(m[1])
    const unit = m[2].toUpperCase()
    return Math.round(n * (unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : 1e9))
  }
  function formatBitRate (bps) {
    if (bps >= 1e6) return Math.round(bps / 1e6) + 'M'
    return Math.round(bps / 1e3) + 'K'
  }

  const wifiCapped = isWifiTransport &&
    (capMaxSize > WIFI_MAX_SIZE || parseBitRate(tier.bitRate) > WIFI_MAX_BITRATE)
  const capBitRate = isWifiTransport
    ? formatBitRate(Math.min(parseBitRate(tier.bitRate) || WIFI_MAX_BITRATE, WIFI_MAX_BITRATE))
    : tier.bitRate
  const finalMaxSize = isWifiTransport ? Math.min(capMaxSize, WIFI_MAX_SIZE) : capMaxSize

  const estShort = Math.max(1, Math.round(finalMaxSize * nativeAspect))
  logLine('info',
    `画质档位：${tier.name}（${tier.id}）` +
    ` → 约 ${estShort}×${finalMaxSize} · ${capBitRate} · ${capFps}fps` +
    (nativeLongSide !== tierRaw.maxSize ? `（已按手机原生长边 ${nativeLongSide} 收敛）` : '') +
    (wifiCapped ? '｜WiFi 通道自动压到 1080/8M（原档位会卡死编码器）' : ''))

  const cap = new ScrcpyCapture({
    scrcpy: SCRCPY_EXE,
    adb: adbPath(),
    serial: dev.serial,
    maxSize: finalMaxSize,
    bitRate: capBitRate,
    maxFps: capFps
  })
  cap.onLog = (m) => logLine('info', '[cap] ' + m)

  /**
   * ══════════ 断线自愈（拔 USB / WiFi 掉线 / 手机休眠）══════════
   *
   * ── 用户原话 ──
   * 「我拔掉 usb 画面直接断开了 你这不行啊」
   *
   * 确实不行。原来的 scrcpy 进程退出后只置了个 running=false，
   * 没有任何恢复动作 —— 画面停在最后一帧，用户只能手动点重连。
   *
   * ── 这里的策略 ──
   *
   * 退避重连，最多 8 次，间隔从 1.5s 递增到 15s：
   *   1.5s → 3s → 4.5s → 6s → 7.5s → 9s → 12s → 15s
   *
   * 如果是「拔了 USB 但 WiFi adb 还在」：几秒内就重连上。
   * 如果是「手机休眠/换网」：等到 8 次放弃，并给用户一句明确提示，
   * 而不是默默停在那儿。
   *
   * 关键：每次重连前重新走一遍设备发现（WiFi 优先），
   * 因为断线后 serial 可能变了（USB 序列号 → WiFi IP:port）。
   */
  let reconnectAttempts = 0
  let reconnectTimer = null
  /**
   * ══════════ 两个容易混淆的标志，必须分开 ══════════
   *
   * userStopped —— 用户主动点了「停止投屏」。
   *   一旦为 true，本次会话内**不再自动重连**（用户要的就是停）。
   *
   * _cancelReconnect 之前错误地把它设成了 true，后果：
   *   重连流程 startSession() → stopSession() → _cancelReconnect()
   *   → userStopped = true → 之后所有 scheduleReconnect 全部 return。
   *   表现就是「拔了再插，日志刷 0 秒后第 1 次重连，但画面永远不回来」。
   *
   * 现在改成：_cancelReconnect 只清计时器，不碰 userStopped。
   * userStopped 只在真正的「停止」入口被设置。
   */
  let userStopped = false
  /** 重连过程中临时屏蔽重入，与 userStopped 无关 */
  let suppressReconnect = false

  /**
   * 重连互斥锁。
   *
   * 踩过的坑（实测日志）：拔掉 USB 后日志刷出几十条
   * 「0 秒后第 1 次重连」，永远停在「第 1 次」，画面一直黑着。
   *
   * 原因有两个：
   *   ① hotplug 和 scheduleReconnect 两套机制同时在跑，互相打断
   *   ② 每次 startSession 都会把 reconnectAttempts 清零，
   *      于是退避永远停留在第一档（150ms），变成了快速的失败-重试风暴
   */
  let reconnecting = false

  const scheduleReconnect = (reason) => {
    if (userStopped || !session) return
    if (reconnecting) return          // 已有一次重连在进行，不叠加
    if (reconnectAttempts >= 8) {
      logLine('error', `已重试 ${reconnectAttempts} 次仍连不上（${reason}）。` +
        '请确认手机在线；若刚重启过手机，插一次 USB 让程序重新开无线通道。')
      pushStatus({ phase: 'error', error: '连接已断开，重试多次失败' })
      return
    }
    reconnectAttempts++
    /**
     * 退避序列 —— 面向 USB 热插拔优化过。
     *
     * 原来从 1.5 秒起步，但 USB 拔插时 adb 重新枚举设备只要 300~800ms，
     * 等 1.5 秒纯属浪费。现在前两次几乎立即（150/400ms），
     * 让「拔了再插」的画面恢复接近瞬时；后续才逐步退避，
     * 避免手机真离线时疯狂重试。
     */
    const delay = [150, 400, 800, 1500, 2500, 4000, 6000, 10000][reconnectAttempts - 1]
    logLine('warn', `连接断开（${reason}），${Math.round(delay / 1000)} 秒后第 ${reconnectAttempts} 次重连…`)
    pushStatus({ phase: 'connecting', hint: `连接断开，正在重连（第 ${reconnectAttempts} 次）` })

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null
      if (userStopped || !session) return
      if (reconnecting) return
      reconnecting = true
      try {
        // 重新走一遍完整启动（含设备发现 + 手机端清理）
        suppressReconnect = false
        await startSession({ reconnect: true })
        logLine('ok', `重连成功（第 ${reconnectAttempts} 次）`)
        reconnectAttempts = 0
      } catch (e) {
        logLine('warn', `第 ${reconnectAttempts} 次重连失败: ${e.message}`)
        reconnecting = false
        scheduleReconnect('重连失败')
        return
      } finally {
        reconnecting = false
      }
    }, delay)
  }

  cap.onExit = (code) => {
    // code=0 是我们自己调的 stop()，不重连
    if (code === 0) return
    // 正在重连流程里主动停旧会话，不触发新一轮
    if (suppressReconnect) return
    scheduleReconnect(`scrcpy 退出 code=${code}`)
  }

  // 暴露给 stopSession 用来取消重连
  cap._cancelReconnect = () => {
    /**
     * 只清计时器，**不设 userStopped**。
     *
     * 这个方法被 stopSession 调用，而 stopSession 在每次
     * startSession 开头都会执行 —— 如果这里设了 userStopped，
     * 重连一次之后就永久禁止重连了。
     */
    suppressReconnect = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }

  let frames = 0
  let keyFrames = 0
  let bytes = 0
  let sentCodec = false

  /**
   * 背压 —— 商业级设计：以「解码器队列深度」为准，不是固定帧数。
   *
   * 踩过的坑：把上限设成 48 帧，结果采集 79fps、渲染只吃掉 6fps，
   * 90% 的帧被丢弃（1251 收到 / 1126 丢弃）。而解码器队列 q=0
   * 说明它其实吃得下 —— 纯粹是限流把帧拦掉了。
   *
   * 现在改成：按帧率动态定上限，正常情况下一帧不丢。
   */
  /**
   * 在途帧上限 —— 按帧率算，不写死 24。
   *
   * 24 帧在 30fps 下是 0.8 秒的缓冲，够用；
   * 但在 60fps 下只有 0.4 秒 —— 手机端编码器偶尔抖一下、
   * 或者渲染层 GC 停顿 200ms，立刻撞上限开始丢帧。
   *
   * 一旦丢帧就要等下一个 IDR（最多 2 秒）才能恢复参考链，
   * 表现就是「时不时定格一下」。实测原生/高清两档 25 秒内
   * 各撞 3~5 次，正是这个原因。
   *
   * 现在按 fps × 0.8 秒给缓冲，下限 24 上限 90：
   *   30fps → 24
   *   60fps → 48
   * 缓冲越深越不容易丢帧，代价只是峰值时延迟多一点
   * （对「看手机画面」这种场景完全可接受，屏幕又不是鼠标）。
   */
  /**
   * 在途帧上限 —— 按「延迟预算」算，不按「帧率比例」算。
   *
   * 旧算法 capFps * 0.8：60fps → 48 帧在途。
   * 48 帧 @60fps = 800ms 的排队深度 —— 用户点了屏幕，
   * 要等前面 48 帧送完才能看到反应。这就是「点击迟钝」的元凶。
   *
   * 新算法：固定 200ms 的延迟预算。
   *   60fps → 12 帧
   *   30fps → 6 帧
   *
   * 帧少意味着缓冲区浅，画面更新的「最后一帧」能更快到达渲染层。
   * 代价是网络抖动时更容易丢帧（表现为偶发跳帧），
   * 但交互场景下「跟手」远比「绝对不丢帧」重要。
   */
  const LATENCY_BUDGET_MS = 200
  const MAX_IN_FLIGHT = Math.max(4, Math.min(24,
    Math.round((LATENCY_BUDGET_MS / 1000) * (capFps || 60))))
  let inFlight = 0
  /** 上次收到渲染层回执的时间；0 = 还没开始发帧，不做超时判断 */
  let lastAckAt = 0
  let dropped = 0

  cap.onReady = (info) => {
    if (!win || win.isDestroyed()) return
    try {
      const desc = avccFromCodecPrivate(info.codecPrivate)
      /**
       * 从 AVCDecoderConfigurationRecord 里读出 profile / level，
       * 拼成 WebCodecs 要的 codecString（形如 avc1.42c020）。
       *
       * AVCC 结构：
       *   [0]    configurationVersion (1)
       *   [1]    AVCProfileIndication        ← profile_idc
       *   [2]    profile_compatibility
       *   [3]    AVCLevelIndication          ← level_idc
       * codecString = 'avc1.' + hex(profile) + hex(compat) + hex(level)
       *
       * 渲染层用这个字符串判断是否要重建解码器，
       * 不传的话 state.codecString 一直是空，解不出画面。
       */
      const profile = desc[1].toString(16).padStart(2, '0')
      const compat = desc[2].toString(16).padStart(2, '0')
      const level = desc[3].toString(16).padStart(2, '0')
      const codecString = `avc1.${profile}${compat}${level}`

      win.webContents.send('video:config', {
        description: desc,
        codecString,
        width: info.width || 0,
        height: info.height || 0
      })
      sentCodec = true
      /**
       * 把真实分辨率同步回 DSH 侧边栏面板。
       *
       * 插件那边的 state.videoSize 一直没有被填过：迷你窗只在
       * stats 里推 fps/丢帧，从来不推尺寸，于是面板那句
       * 「投屏中 · 720×1600」永远显示不出来，只剩一个「投屏中」。
       */
      if (info.width > 0 && info.height > 0) {
        pushStatus({ videoSize: { w: info.width, h: info.height } })
      }
      logLine('ok', `解码器配置已下发（${codecString}，SPS/PPS ${desc.length}B）`)
    } catch (e) {
      logLine('error', '配置解码器失败: ' + e.message)
    }
  }

  /**
   * 丢帧后的恢复标记。
   *
   * ── 花屏的真凶 ──
   *
   * H.264 的 P 帧是**差分**编码：每一帧都引用前面若干帧。
   * 如果因为背压把中间一帧丢掉，后面的帧解出来就是「引用了不存在的
   * 参考」—— 现象是画面从某个位置开始腐烂，并且**越滚越大**，
   * 直到下一个 IDR（关键帧）才自愈。
   *
   * 实测截图非常典型：屏幕上半部分还是清楚的，下半部分全是色块，
   * 而且持续几十帧不恢复。原因就是 scrcpy 的 I 帧间隔是 2 秒
   * （--i-frame-interval 默认），中间丢一帧就要糊两秒。
   *
   * 修法：一旦丢帧，立刻进入「等关键帧」状态，期间所有非关键帧
   * 全部丢弃（反正解出来也是坏的），直到拿到 key frame 才恢复。
   * 这样宁可停顿 1~2 秒，也不要持续花屏。
   */
  let waitingKeyframe = false

  /* ==========================================================================
     息屏 / 亮屏跟随 —— 状态变量
     --------------------------------------------------------------------------
     必须声明在 cap.onFrame 之前：onFrame 是个闭包，而 cap.start() 里
     随时可能来第一帧。若把 `let lastFrameAt` 写在下面（start 之后），
     第一帧就会撞上 TDZ 直接抛 ReferenceError。
     ========================================================================== */
  /** 最近一次真的有帧的时刻 */
  let lastFrameAt = Date.now()
  /** 手机当前是否息屏（由 adb 探测，不是猜的） */
  let phoneAsleep = false
  /** 亮屏后的宽限截止时间：这段时间内即使没帧也不许重启采集 */
  let wakeGraceUntil = 0
  let lastScreenProbeAt = 0
  let screenProbeBusy = false

  cap.onFrame = (buf, ptsMs, isKey) => {
    frames++
    if (isKey) keyFrames++
    bytes += buf.length
    /** 最近一次真的有帧的时刻 —— 息屏判定、断流判定都以它为准 */
    lastFrameAt = Date.now()
    if (!win || win.isDestroyed()) return
    if (!sentCodec) return          // 还没 configure，丢弃

    // 丢过帧 → 只等关键帧，其余全丢（避免参考链断裂导致花屏）
    if (waitingKeyframe) {
      if (!isKey) { dropped++; return }
      waitingKeyframe = false
      logLine('info', '已等到关键帧，画面恢复')
    }

    /**
     * ══════════ 背压死锁修复 ══════════
     *
     * 踩过的坑（实测）：画面突然冻在某一帧，日志刷
     *   「背压丢帧（在途 12），等下一个关键帧重置参考链」
     * 而 decodeQueueSize=0、解码器完全空闲 —— 说明不是解码跟不上，
     * 而是 inFlight 计数永远减不回去。
     *
     * 根因：inFlight 靠渲染层每帧回一次 ack 来递减。一旦某次 ack
     * 丢了（窗口失焦、渲染层 GC、IPC 通道抖动），计数就永久偏高；
     * 达到上限后所有帧被丢，而丢帧又不减少计数 —— 死锁。
     *
     * 修法：给「最早那次未确认的发送」记时间戳。如果超过
     * ACK_TIMEOUT 还没收到 ack，就把计数强制清零并请求关键帧。
     * 丢一两帧远好过整个画面冻死。
     */
    const ACK_TIMEOUT = 800
    if (inFlight > 0 && lastAckAt > 0 && Date.now() - lastAckAt > ACK_TIMEOUT) {
      /**
       * 双重保险：既清零计数，也清掉 waitingKeyframe。
       *
       * 只清零计数是不够的 —— waitingKeyframe 若仍为 true，
       * 后续每一帧都会走「等关键帧」分支被丢掉，画面依然不动。
       */
      logLine('warn', `渲染层 ${Math.round(Date.now() - lastAckAt)}ms 未回执，重置背压（${inFlight} → 0）`)
      inFlight = 0
      waitingKeyframe = false
      lastAckAt = Date.now()
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      dropped++
      /*
       * 关键：不能只丢这一帧就完事。
       * 一丢就必须把后续所有 P 帧一起丢掉，直到下一个 IDR ——
       * 否则解码器会拿缺失参考的帧去解，画面直接腐烂。
       */
      if (!waitingKeyframe) {
        waitingKeyframe = true
        logLine('warn', `背压丢帧（在途 ${inFlight}），等下一个关键帧重置参考链`)
      }
      return
    }

    inFlight++
    lastAckAt = lastAckAt || Date.now()
    win.webContents.send('video:frame', {
      data: buf,
      pts: ptsMs,
      key: isKey
    })
  }

  /**
   * 采集启动窗口 → 关上 adbd 重启闸门。
   * cap.start() 最长 35 秒，这段时间 session 还没赋值、running 也是
   * false，光靠那两处判断挡不住后台的 tcpip。用显式标志包起来。
   */
  captureStarting = true
  let r
  try {
    r = await cap.start()
  } finally {
    captureStarting = false
  }
  if (!r.ok) {
    pushStatus({ phase: 'error', error: r.error })
    throw new Error(r.error || '采集启动失败')
  }

  /**
   * session.serial 必须写上。
   *
   * 通道守护靠它判断「当前用的是哪条通道」，而这里原来只有
   * { scrcpyCapture: cap } —— session.serial 永远是 undefined，
   * 守护于是把每条通道都判成「已死」，日志里出现
   *   [switch] 通道切换：undefined → 172.31.100.199:5555
   */
  session = { scrcpyCapture: cap, serial: dev.serial }
  pushStatus({ phase: 'streaming', streaming: true })
  logLine('ok', '投屏已启动（scrcpy 采集）')

  /**
   * ── 音频路由（按用户规则）──────────────────────────────
   *   · 手机插耳机（有线/蓝牙）→ 声音留在手机，绝不投到电脑
   *   · 手机外放 → 连接即双端静音（手机媒体音量降到 0、投屏音量 0）
   *   · 手动把投屏音量调上去 → 才开始转发手机声音
   *   · 投屏音量不影响手机；手机音量变化 → 投屏音量同步成手机音量
   *   · 断开连接 → 停音频 + 杀掉手机端 APK
   */
  /** 耳机态：APK 已被停掉（声音留在手机端）。放在 try 外面，后面的自愈要用 */
  let apkSuppressed = false
  try {
    const { AudioRouter } = require('./audio-router.js')

    /**
     * 耳机态：APK 必须停掉。
     *
     * 不只是「把投屏音量压到 0」—— 那个 APK 一旦跑起来就会把手机
     * STREAM_MUSIC 锁在 0，耳机里也会跟着没声。所以耳机在场时
     * 直接 force-stop 它，让手机按自己的方式出声；
     * 耳机拔掉再把自愈拉起来，重新接管。
     */
    const applyAudioRoute = (st) => {
      if (!session || !st) return
      if (st.headset && !apkSuppressed) {
        apkSuppressed = true
        try { if (session.healer) session.healer.stop() } catch {}
        router.killApk()
          .then(() => logLine('ok', '[audio] 耳机已连接：已停掉手机端采集，声音留在手机'))
          .catch(() => {})
      } else if (!st.headset && apkSuppressed) {
        apkSuppressed = false
        logLine('info', '[audio] 耳机已拔出：恢复手机端声音采集')
        try { if (session.healer) session.healer.start() } catch {}
      }
    }

    const router = new AudioRouter({
      adb: adbPath(),
      serial: dev.serial,
      apkPackage: 'com.miniwin.stream',
      httpPort: 27191,
      onLog: (m) => logLine('info', m),
      onState: (st) => {
        try { win && win.webContents.send('audio:state', st) } catch {}
        applyAudioRoute(st)
      }
    })
    session.router = router

    await router.poll()
    if (router.last.headset) {
      logLine('info', `[audio] 耳机已连接（${router.last.devices.join('+')}）：声音留在手机端`)
      apkSuppressed = true
      await router.killApk()
    } else {
      // 外放：投屏音量默认 0。手机那头由 APK 自己静音，不用在这里灌音量键。
      router.setPcVolume(0)
      logLine('info', '[audio] 外放：投屏音量默认 0，调高才开始把手机声音投到电脑')
    }
    router.start()
  } catch (e) {
    logLine('warn', '[audio] 路由初始化失败: ' + e.message)
  }

  /**
   * ══════════ 音频：走 APK，不走 scrcpy ══════════
   *
   * 这台机器是 Android 12，scrcpy 的音频捕获要 Android 13+
   * （实测：audio playback capture source not supported before
   *  Android 13）。画面用 scrcpy（50~80fps，比 APK 的
   *  MediaProjection 4fps 好得多），声音用 APK —— 两者并存。
   *
   * APK 侧在开始捕获时会把手机 STREAM_MUSIC 调到 0，
   * 所以手机不出声，声音只在电脑播放。
   */
  if (process.argv.includes('--with-audio')) {
    try {
      const { AudioBridge } = require('./audio-bridge.js')
      const audio = new AudioBridge({
        /**
         * 必须用真正的 node.exe，不能用 process.execPath。
         *
         * Electron 里 process.execPath 指向 electron.exe，
         * 拿它去跑一个普通 Node 脚本会启动一个 Electron 实例
         * （表现为日志里刷 disk_cache 报错、脚本行为异常）。
         */
        node: NODE_EXE,
        receiverJs: path.join(__dirname, 'wifi-receiver.js'),
        adb: adbPath(),
        lanPort: 27190,
        onLog: (m) => logLine('info', m),
        onConfig: (cfg) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('audio:config', { description: cfg.description })
          }
        },
        onFrame: (buf, pts) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('audio:frame', { data: buf, pts })
          }
        },
        onState: (st) => {
          if (st.waiting) logLine('info', '[audio] 等待 APK 推流…')
        }
      })
      const ar = await audio.startReceiver()
      if (ar.ok) {
        await audio.startPulling()
        session.audio = audio
        logLine('ok', '音频接收端已启动（需在手机上打开 MiniWin 投屏）')

        /**
         * 音频自愈。
         *
         * 华为会周期性杀掉占用 MediaProjection 的第三方 App
         * （白名单也拦不住）。没有自愈的话表现是「有画面没声音」，
         * 用户必须手动重推深链才能恢复。
         */
        const { AudioHealer } = require('./audio-healer.js')
        const healer = new AudioHealer({
          adb: adbPath(),
          serial: dev.serial,
          port: 27190,
          httpPort: 27191,
          onLog: (m) => logLine('info', m),
          onRecovered: () => logLine('ok', '音频已自动恢复')
        })
        healer.start()
        session.healer = healer
        /**
         * 耳机在场时不要把自愈拉起来 —— 它会立刻把 APK 重新推上去，
         * 而那个 APK 一跑就把手机音量锁 0，耳机里照样没声。
         */
        if (apkSuppressed) {
          try { healer.stop() } catch {}
          logLine('info', '[audio] 耳机仍连接中：暂不拉起手机端采集')
        }
      } else {
        logLine('warn', '音频接收端启动失败: ' + (ar.error || ''))
      }
    } catch (e) {
      logLine('warn', '音频启动异常: ' + e.message)
    }
  }

  /**
   * 自适应降档 —— 只治「在跑但不流畅」，不治「根本没帧」。
   *
   * ── 血泪教训 ──
   *
   * 旧逻辑：`if (fps > 0 && fps < 22) lowStreak++`，连 5 秒就降档重启。
   *
   * 手机断连时 fps 会掉到 2、kbps 掉到 7（实测日志），
   * 那根本不是「帧率偏低」而是「没有画面」，可旧逻辑照样判定偏低 →
   * stop() → start() → 管道名相同 → EADDRINUSE → 再 stop → 再 start…
   * 几十条错误刷屏，最后必须手动杀进程。
   *
   * 现在分三种情况处理：
   *   ① 完全没帧（kbps ≈ 0 或 fps < 3）→ 这是断流，交给下面的断流检测重连
   *   ② 有帧但不满 22 → 真的不流畅，降档
   *   ③ 刚启动 15 秒内不判断 → 累计均值天然偏低，别误伤
   */
  const BITRATE_STEPS = ['8M', '5M', '3M']
  let bitrateIdx = 0
  let lowStreak = 0
  let deadStreak = 0
  let lastRebootAt = 0
  /** 本次采集启动的时刻，用于宽限期判断 */
  let capStartedAt = cap._startedAt || Date.now()

  /**
   * ══════════ 问手机：你现在是亮屏还是息屏？══════════
   *
   * 用户的原话：「手机从息屏到亮屏 要能快速反应并跟随」。
   *
   * ── 为什么必须问，而不能靠「没帧」猜 ──
   *
   * 息屏和断流在数据面上长得一模一样：都是 fps=0、kbps≈0。
   * 旧逻辑一律当成「断流」，6 秒后就把 scrcpy stop() + start() 重来一遍。
   * 而重启一次要 push server + 等首个 IDR，实测 10~35 秒 ——
   * 用户在这期间点亮手机，看到的是一块黑屏，而不是「立刻跟上」。
   *
   * 现在：没帧超过 1.2 秒就去问一次电源状态。
   *   mWakefulness=Awake           → 亮着，没帧就是真断流
   *   mWakefulness=Asleep/Dozing   → 息屏，正常现象，什么都不做
   *
   * dumpsys power 是一次 adb shell 调用，实测 40~80ms，仅在没帧时才发，
   * 正常播放时零开销。
   */
  const probeScreenAwake = () => new Promise((resolve) => {
    try {
      require('node:child_process').execFile(
        adbPath(),
        ['-s', dev.serial, 'shell', 'dumpsys power | grep -m1 mWakefulness='],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          const s = String(stdout || '')
          if (/mWakefulness=Awake/.test(s)) return resolve(true)
          if (/mWakefulness=(Asleep|Dozing)/.test(s)) return resolve(false)
          resolve(null)          // 查不到就别乱判，维持现状
        }
      )
    } catch { resolve(null) }
  })

  /** 把探测结果落到状态上（只在真正变化时打日志 / 推 UI） */
  const applyScreenState = (awake) => {
    if (awake === null || awake === undefined) return
    const wasAsleep = phoneAsleep
    phoneAsleep = (awake === false)
    if (phoneAsleep === wasAsleep) return
    if (phoneAsleep) {
      logLine('info', '手机已息屏 —— 暂停断流检测，画面停在最后一帧')
      pushStatus({ phoneAsleep: true })
    } else {
      logLine('ok', '手机已亮屏 —— 等待画面恢复')
      pushStatus({ phoneAsleep: false })
      /**
       * 亮屏后的宽限：
       *   · 计数器清零，别把息屏那段时间算成「连续没画面」
       *   · capStartedAt 重置，跳过「前 15 秒不降档」之外的误判
       *   · 再给 4 秒硬宽限：编码器恢复出首个 IDR 需要时间（实测 0.5~2 秒），
       *     这期间哪怕还没帧也绝不重启采集
       */
      deadStreak = 0
      lowStreak = 0
      capStartedAt = Date.now()
      wakeGraceUntil = Date.now() + 4000
    }
  }

  const statsTimer = setInterval(async () => {
    const now = Date.now()
    const idleMs = now - lastFrameAt

    /**
     * ══════════ 什么时候去问电源状态 ══════════
     *
     * 两种时机，缺一不可：
     *
     * ① 已经判成息屏 → 每 1.2 秒问一次
     *    这一条是「亮屏后要快速跟上」的关键。注意此时画面可能**还在出帧**
     *    （息屏瞬间 / AOD / 锁屏动画都会继续产生几帧），所以不能靠
     *    「有帧了」来推断亮屏 —— 必须真的问一次。
     *
     * ② 亮屏但没帧 → 每 900ms 问一次
     *    用来区分「手机睡了」和「真的断流」。
     *
     * 亮屏且有帧时一次都不问，正常播放零开销。
     */
    const wantProbe = phoneAsleep
      ? (now - lastScreenProbeAt >= 1200)
      : (idleMs > 1200 && now - lastScreenProbeAt >= 900)
    if (wantProbe && !screenProbeBusy) {
      lastScreenProbeAt = now
      screenProbeBusy = true
      try { applyScreenState(await probeScreenAwake()) } finally { screenProbeBusy = false }
    }

    const fps = cap.fps
    const kbps = Math.round(bytes / 1024 / ((now - (cap._startedAt || now)) / 1000 || 1))

    pushStatus({
      stats: {
        fps: Math.round(fps),
        keyFrames,
        kbps,
        dropped,
        /**
         * frames 必须带上 —— 渲染层有两处逻辑依赖它：
         *   · 判断「已经有画面了」，据此撤掉「正在连接手机…」占位层
         *   · 判断「亮屏后画面有没有回来」，据此把标题从「手机息屏」改回「投屏中」
         * 之前漏了这个字段，于是 `s.stats.frames > 0` 永远是 false，
         * 占位层和息屏标题都会卡住不动（真实 bug，用户报过两次）。
         */
        frames
      },
      /**
       * phoneAsleep 跟着每秒的 stats 一起推，而不是「只在变化时推一次」。
       *
       * ── 为什么必须这样 ──
       *
       * 只推边沿（变化时才推）意味着：任何一次推送丢失、或者渲染层
       * 自己把状态搞乱（页面重载、手滑、脚本注入），遮罩就会**永久**挂着
       * —— 用户明明已经开屏了，画面中央还写着「手机已息屏」。
       *
       * 现在每秒都带一份权威状态，渲染层每次都覆盖，最多误差 1 秒，
       * 而且是自愈的。
       */
      phoneAsleep,
      /**
       * 音频状态也跟着每秒推。
       *
       * 以前「画面在跑但电脑没声音」只能去翻日志，用户根本分不清是
       * 没连上、还是自己电脑静音了。现在界面能直接看到。
       * 数据来自 AudioHealer 每 3 秒对接收端 /meta 的探测。
       */
      audioConnected: session && session.healer ? !!session.healer.connected : false,
      audioFrames: session && session.healer ? (session.healer.frames || 0) : 0
    })
    if (session) session.phoneAsleep = phoneAsleep
    if (win && !win.isDestroyed()) {
      win.webContents.send('stats', { fps: Math.round(fps), dropped, keyFrames })
    }

    /**
     * 息屏期：不做任何「补救」动作。
     * 这时候重启采集不但没用，还会让用户亮屏后多等十几秒 —— 正好和他要的相反。
     */
    if (phoneAsleep) {
      deadStreak = 0
      lowStreak = 0
      return
    }

    const age = now - capStartedAt

    // ① 完全没帧 —— 断流，不做降档，交给重连
    if (kbps < 5 || fps < 3) {
      // 刚亮屏的宽限期内不判死：编码器正在恢复
      if (now < wakeGraceUntil) return
      deadStreak++
      lowStreak = 0
      if (deadStreak >= 5) {
        deadStreak = 0
        if (now - lastRebootAt > 20000) {
          lastRebootAt = now
          logLine('warn', '长时间没有画面（已确认手机是亮屏状态），正在重新连接…')
          try {
            await cap.stop()
            const rr = await cap.start()
            if (rr.ok) { capStartedAt = Date.now() }
            else logLine('error', '重连失败: ' + (rr.error || ''))
          } catch (e) {
            logLine('error', '重连异常: ' + e.message)
          }
        }
      }
      return
    }
    deadStreak = 0

    // ③ 启动宽限期：前 15 秒不判断（累计均值天然偏低）
    if (age < 15000) { lowStreak = 0; return }

    // ② 有帧但不流畅 → 降档
    if (fps < 22) lowStreak++
    else lowStreak = 0

    if (lowStreak >= 5 && bitrateIdx < BITRATE_STEPS.length - 1 && now - lastRebootAt > 15000) {
      const prevIdx = bitrateIdx
      bitrateIdx++
      lowStreak = 0
      lastRebootAt = now
      const newRate = BITRATE_STEPS[bitrateIdx]
      logLine('warn', `帧率持续偏低（${Math.round(fps)}fps），码率降到 ${newRate} 重试`)
      try {
        await cap.stop()
        cap.bitRate = newRate
        const rr = await cap.start()
        if (rr.ok) {
          capStartedAt = Date.now()
        } else {
          // 降档失败 → 回退档位，否则下次会跳档
          bitrateIdx = prevIdx
          logLine('error', '降档重启失败: ' + (rr.error || ''))
        }
      } catch (e) {
        bitrateIdx = prevIdx
        logLine('error', '降档异常: ' + e.message)
      }
    }
  }, 1000)
  session.statsTimer = statsTimer
  session.cap = cap

  /**
   * ══════════ 通道守护：USB ⇄ WiFi 自动切换 ══════════
   *
   * 用户的原话：「对于用户来说不就是 USB 和 WiFi 两种连接方式吗？
   * 那 USB 拔掉切 WiFi、WiFi 断开切 USB 你总得做吧」。
   *
   * 之前的实际情况：
   *   · 拔 USB → scrcpy 退出 → scheduleReconnect → startSession 重新选通道。
   *     这条**能**切到 WiFi，但前提是 adb 设备表里恰好还有那条 ip:5555
   *     （adbd 重启过、手机换过 IP 就没了）；
   *   · WiFi 掉线 → 同样只能靠重连；重连里扫不到 WiFi 就会掉进
   *     waitForPhone 的 3 分钟扫描，用户看到的是「一直没画面」。
   *
   * 现在加一个主动守护：每 1.5 秒确认当前通道还在不在，不在就**立刻**
   * 切到另一条；USB 拔掉且 WiFi 不在表里时，用缓存的手机 IP 主动
   * `adb connect` 一次再切。
   *
   * 与 scheduleReconnect 的关系：切换走 stopSession + startSession，
   * stopSession 会调 cap._cancelReconnect()，所以不会和退避重连打架。
   */
  const mySerial = session.serial
  const myIsWifi = /:\d+$/.test(mySerial)
  let switchingTransport = false
  /** 连续多少次看到在线的 USB（防抖，1.5 秒/次） */
  let usbSeenFor = 0
  /** 上次尝试唤醒 WiFi 的时间（节流，避免每 1.5 秒刷一次） */
  let lastWakeAt = 0

  const transportTimer = setInterval(async () => {
    if (!session || session.serial !== mySerial) return
    if (switchingTransport) return
    // 守护里的异常必须留痕：上一版抛了 ReferenceError 被吞掉，谁都看不见
    try {
      let devs = []
      try {
        devs = await keeper.devices()
        /**
         * WifiAdbKeeper.devices() 只返回**在线**设备，而且条目只有
         * { serial, isWifi } —— 没有 state 字段。
         *
         * 守护里所有判断都写的是 state === 'device'，于是永远为假：
         * 「当前通道还活着」判成已死、「切到 USB」找不到目标，
         * 表现为一直卡在唤醒 WiFi 那一支。
         * 这里统一补上 state，后面就能用同一套语义。
         */
        devs = (devs || []).map(d => ({
          serial: d.serial,
          isWifi: !!d.isWifi,
          state: d.state || 'device'
        }))
      } catch (e) {
        logLine('warn', '[switch] 读设备表失败: ' + e.message)
        return
      }
      const live = d => d && d.state === 'device'

      /* ── 当前通道还活着：只在「WiFi 跑着、USB 插回来了」时升级 ── */
      if (isCurrentAlive(mySerial, devs)) {
        usbSeenFor = (myIsWifi && devs.some(d => !d.isWifi && live(d))) ? usbSeenFor + 1 : 0
        const up = shouldUpgradeToUsb(mySerial, devs, usbSeenFor, 3)
        if (up.upgrade) {
          switchingTransport = true
          try {
            logLine('ok', `[switch] USB 回来了 → 切回 USB（${up.serial}），比 WiFi 稳`)
            pushStatus({ phase: 'connecting', hint: 'USB 已插入，正在切回 USB…' })
            await stopSession()
            await startSession({ serial: up.serial })
          } catch (e) {
            logLine('warn', '[switch] 切回 USB 失败: ' + e.message)
          } finally { switchingTransport = false; usbSeenFor = 0 }
        }
        return
      }
      usbSeenFor = 0

      /* ── 当前通道没了：先按规则挑 ── */
      let target = pickFallbackSerial(mySerial, devs).target

      /**
       * 没得挑就尝试唤醒 WiFi。
       *
       * 两个坑：
       *   ① adb 会回 `already connected`，但 devices 里那条仍是 offline
       *      —— 只 connect 没用，必须 disconnect 再 connect（adbReviveWifi）。
       *   ② 不节流的话每 1.5 秒刷一次日志，实测刷了几十条还在原地打转。
       */
      if (!target && Date.now() - lastWakeAt > 8000) {
        lastWakeAt = Date.now()
        const stale = devs.find(d => d.isWifi) || null
        const ip = (stale && String(stale.serial).split(':')[0]) ||
          (/^\d+\.\d+\.\d+\.\d+$/.test(String(st.lastPhoneIp || '')) ? st.lastPhoneIp : '')
        if (ip) {
          try {
            const r = await adbReviveWifi(ip + ':5555')
            logLine('info', `[switch] 唤醒 WiFi ${ip}:5555 → ${r.out || (r.ok ? 'ok' : '失败')}`)
            try { devs = await keeper.devices() } catch {}
            const w = devs.find(d => d.isWifi && live(d))
            if (w) target = w.serial
          } catch (e) { logLine('warn', '[switch] 唤醒失败: ' + e.message) }
        }
      }

      if (!target) return

      switchingTransport = true
      try {
        const label = myIsWifi ? 'WiFi → USB' : 'USB → WiFi'
        logLine('ok', `[switch] 通道切换：${mySerial} → ${target}（${label}）`)
        pushStatus({ phase: 'connecting', hint: `已自动切换通道：${label}` })
        await stopSession()
        await startSession({ serial: target })
      } catch (e) {
        logLine('warn', '[switch] 切换失败: ' + e.message)
      } finally { switchingTransport = false }
    } catch (e) {
      logLine('warn', '[switch] 守护异常: ' + e.message)
    }
  }, 1500)
  session.transportTimer = transportTimer

  /**
   * 帧回执 —— 背压计数的唯一出口。
   *
   * lastAckAt 用于检测「ack 长时间不来」的死锁（见上面的 ACK_TIMEOUT）。
   * 每次收到 ack 都刷新时间戳，这样超时判断的是「距离上次成功回执多久」，
   * 而不是「第一帧发出多久」—— 后者在正常高速流里会误判。
   */
  ipcMain.removeAllListeners('win:frame-ack')
  ipcMain.on('win:frame-ack', () => {
    if (inFlight > 0) inFlight--
    lastAckAt = Date.now()
  })

  return { ok: true }
}

/**
 * 把 CodecPrivate（AVCDecoderConfigurationRecord，mkv 里的格式）
 * 直接当 AVCC description 用。
 *
 * scrcpy 写入 mkv 的 CodecPrivate 就是标准的
 * AVCDecoderConfigurationRecord（ISO/IEC 14496-15），
 * WebCodecs 的 VideoDecoder.configure() 的 description
 * 要的正是同一份结构 —— 直接透传即可，不用重新组装。
 */
function avccFromCodecPrivate (cp) {
  if (!cp || cp.length < 7) throw new Error('CodecPrivate 过短')
  return cp
}

/**
 * 会话启动入口 —— 当前只有一种采集引擎：scrcpy.exe + 命名管道。
 *
 * ══════════ 互斥 + 去抖 ══════════
 *
 * 用户点「重开迷你窗」时，插件层会 spawn 一个新进程；新进程拿不到
 * 单实例锁 → 把 second-instance 事件交给已经在跑的那个 → 那边调
 * startSession()。同时用户自己也可能连点几次。
 *
 * 实测日志里 `已有迷你窗在跑` 一次刷了十几条 —— 十几条 startSession
 * 并发跑，每条都 stopSession() 掐断别人正在建的管道，
 * 最后全是 EADDRINUSE / 管道连接超时。
 *
 * 现在用一把 Promise 锁串行化：同一时刻只有一个启动流程在跑，
 * 后续请求直接复用它的结果（250ms 内的重复请求当作同一次）。
 */
let startLock = null
let startPromise = null
let lastStartAt = 0

async function startSession (opts = {}) {
  /**
   * 250ms 内的重复调用视为「同一次点击」——
   * 直接返回上一次的结果，不再重启一遍。
   */
  if (startPromise && Date.now() - lastStartAt < 250) {
    logLine('info', '忽略重复的启动请求（刚启动过）')
    return startPromise
  }

  // 已经有启动流程在跑 → 排队等它结束
  if (startLock) {
    logLine('info', '另一个启动流程正在进行，等待它结束…')
    try { await startLock } catch {}
  }

  lastStartAt = Date.now()
  startLock = (async () => {
    try {
      await stopSession()
      return await startScrcpySession(opts)
    } finally {
      startLock = null
    }
  })()
  startPromise = startLock
  return startLock
}

/**
 * 单实例锁 —— 从根上解决「点一次多一个窗」。
 *
 * 侧边栏那个按钮在投屏中显示的是「重开迷你窗」，而 DSH 插件侧
 * /launch 实际做的是 spawn 一个新进程。以前没有锁，插件一重启
 * （或用户连点两次）就丢了上一个 pid，旧窗口变成孤儿留在屏幕上：
 * 现象是同时有几个空窗口，而且帧率越开越低（多个进程抢手机编码器）。
 *
 * 有了锁之后：第二个实例拿不到锁就把事件交给已有的那个，然后自己
 * 退出。已有实例收到 second-instance → 把窗口亮出来并重连一次 ——
 * 正好就是「重开迷你窗」想表达的意思。
 */
const SINGLE_INSTANCE = !process.argv.includes('--no-single-instance')
const gotTheLock = SINGLE_INSTANCE ? app.requestSingleInstanceLock() : true
if (!gotTheLock) {
  app.quit()
} else if (SINGLE_INSTANCE) {
  app.on('second-instance', () => {
    /**
     * 窗口可能已经被关掉了（window-all-closed 不退出进程，
     * 所以 win 会变成 destroyed）。这种情况必须**重新创建**窗口，
     * 只 show() 一个 destroyed 的 BrowserWindow 会抛异常。
     */
    if (!win || win.isDestroyed()) {
      logLine('info', '收到重开请求，正在重建迷你窗…')
      /**
       * 必须调 bootWindow —— 它才是真正的建窗函数（whenReady 与托盘用的都是它）。
       *
       * 原来写的是 createWindow，而这个函数**在文件里根本不存在**。
       * 后果：窗口被关掉之后，用户从侧边栏再点一次「启动迷你窗」，
       * 已有实例收到 second-instance 立刻抛
       *   ReferenceError: createWindow is not defined
       * 主进程弹出「A JavaScript error occurred in the main process」，
       * 窗口也再也回不来。
       */
      bootWindow().catch(e => logLine('error', '重建窗口失败: ' + e.message))
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.moveTop()

    /**
     * ══════════ 关键修复：已在投屏就不要重启 ══════════
     *
     * 用户的原话：「投屏鼠标只要操作连接就会断」。
     *
     * 复现链路（实测确认）：
     *   ① 迷你窗正在投屏（scrcpy 活得好好的）
     *   ② 用户点侧边栏的「启动迷你窗 / 重开迷你窗」
     *   ③ 插件 spawn 一个新的 electron 进程
     *   ④ 新进程抢不到单实例锁 → 自己退出
     *   ⑤ 已存在的实例收到 second-instance → 这里无条件 startSession()
     *   ⑥ startSession 第一件事是 stopSession() → **掐掉正在跑的 scrcpy**
     *   ⑦ 然后重建，中间黑屏 5~10 秒
     *
     * 用户看到的就是「鼠标一点，投屏就断」。
     *
     * 正确行为：健康状态下点按钮 = 把窗口提到前台，什么都不重启。
     * 只有真的没在投屏（或采集已经死了）才需要重建。
     */
    const captureAlive = !!(
      session &&
      session.scrcpyCapture &&
      session.scrcpyCapture.running &&
      !suppressReconnect
    )

    if (captureAlive) {
      logLine('info', '已在投屏中 —— 仅把窗口提到前台，不重启采集')
      pushStatus({ phase: 'streaming', streaming: true })
      return
    }

    logLine('info', '当前没有在投屏，开始建立连接…')
    setTimeout(() => {
      startSession({}).catch(e => logLine('error', '重连失败: ' + e.message))
    }, 200)
  })
}

/* ---------- IPC ---------- */
ipcMain.handle('dev:list', async () => {
  const adb = new Adb(adbPath())
  try { return { ok: true, devices: await adb.devices(), adb: adbPath() } }
  catch (e) { return { ok: false, error: e.message, adb: adbPath() } }
})

ipcMain.handle('dev:connect-wifi', async (_e, { host, port }) => {
  const adb = new Adb(adbPath())
  try {
    const r = await adb.connectWifi(host, port)
    return { ok: true, ...r, devices: await adb.devices() }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('audio:set-volume', async (_e, v) => {
  if (!session || !session.router) return { ok: false, error: '没有活动会话' }
  try {
    const r = session.router.setPcVolume(Number(v) || 0)
    logLine('info', `[audio] 投屏音量=${r.pcVolume}，${r.forwarding ? '转发中' : '不转发'}`)
    return { ok: true, ...r }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('audio:state', async () => {
  if (!session || !session.router) return { ok: false, error: '没有活动会话' }
  return { ok: true, ...session.router.last, forwarding: session.router.shouldForward() }
})

ipcMain.handle('dev:tcpip', async () => {  const adb = new Adb(adbPath())
  try {
    await adb.pickDevice()
    const r = await adb.enableTcpip(5555)
    return { ok: true, ...r }
  } catch (e) { return { ok: false, error: e.message } }
})

/**
 * 纯 WiFi 一键连接：不用手输 IP、不用扫码。
 *
 * 顺序：落盘缓存（~200ms）→ adb mDNS → 多网段端口扫描。
 * 命中后用 get-state 复核，确认是真 adb 设备才写缓存。
 */
ipcMain.handle('dev:wifi-quick', async () => {
  const disc = require('./wifi-discovery.js')
  try {
    const r = await disc.quickConnect({ adbPath: adbPath() })
    let devices = []
    if (r.ok) { try { devices = await new Adb(adbPath()).devices() } catch {} }
    return { ...r, devices }
  } catch (e) { return { ok: false, error: e.message } }
})

/** 只发现不连接（给设置面板列出候选） */
ipcMain.handle('dev:wifi-discover', async () => {
  const disc = require('./wifi-discovery.js')
  try {
    return { ok: true, ...(await disc.discover({ adbPath: adbPath() })) }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('stream:start', async (_e, opts) => {
  try {
    const r = await startSession(opts || {})
    return { ok: true, ...r }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('stream:stop', async () => { await stopSession(); return { ok: true } })

/* ══════════════════════════════════════════════════════════════════════
   画质档位接口（为切换 UI 预留）
   ──────────────────────────────────────────────────────────────────────
   渲染层 / 插件面板 / 命令行 都可以调这三个：

     quality:list   → { ok, current, tiers:[{id,name,maxSize,fps,bitRate,note}] }
     quality:get    → { ok, current, tier }
     quality:set    → { ok, current, tier }        参数：档位 id

   切换策略：
     · 只改配置、不重启 → 下次启动生效
     · 正在投屏时立刻热切换（stop → 换参数 → start），
       中间会黑 1~2 秒，这是 scrcpy 的固有成本（要重建编码器）
     · 切换前会清掉手机侧 server，否则新档抢不到 MediaCodec

   为什么用 invoke 而不是 send：切换需要知道成败和最终生效值，
   渲染层要据此更新按钮状态。
   ══════════════════════════════════════════════════════════════════════ */

/** 给外部看的档位副本（纯数据，能直接过 structuredClone） */
function tierListForUi () {
  return TIERS.map(t => ({
    id: t.id,
    name: t.name,
    maxSize: t.maxSize,
    fps: t.fps,
    bitRate: t.bitRate,
    note: t.note
  }))
}

ipcMain.handle('quality:list', async () => {
  return { ok: true, current: st.quality, tiers: tierListForUi() }
})

ipcMain.handle('quality:get', async () => {
  const raw = tierById(st.quality)
  return { ok: true, current: st.quality, tier: resolveTier(raw, lastNativeLongSide) }
})

ipcMain.handle('quality:set', async (_e, id) => {  const target = TIERS.find(t => t.id === id)
  if (!target) {
    return { ok: false, error: `未知档位: ${id}`, current: st.quality }
  }

  const prev = st.quality
  st.quality = target.id
  saveCfg()
  logLine('info', `画质档位切换：${prev} → ${target.id}（${target.name}）`)

  // 通知渲染层（UI 上的按钮要跟着变）
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('quality:changed', { current: target.id, tier: target }) } catch {}
  }
  if (reportUrl) {
    fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quality: target.id })
    }).catch(() => {})
  }

  /**
   * 正在投屏 → 立刻热切换。
   *
   * 没在投屏就只改配置，什么都不用做 —— 下次点「启动」自然用新档。
   * 这个判断很重要：不做的话每次改档都会白起一次采集，
   * 用户只是想在没连手机时预选一下档位，却被迫等 10 秒。
   */
  if (session && session.scrcpyCapture && session.scrcpyCapture.running) {
    logLine('info', '正在投屏，立即应用新档位…')
    /**
     * 切档位 = 重建编码器，实测 3~6 秒。
     * 这段时间画面停在最后一帧不动，用户很容易以为卡死了 ——
     * 推一条 switching 让 UI 给出明确的「正在切换」提示。
     * 放在 finally 里清除，异常也不会留下一个永远转圈的遮罩。
     */
    pushStatus({ switching: { name: target.name } })
    try {
      await startSession({})
      logLine('ok', `已切换到 ${target.name}`)
    } catch (e) {
      logLine('error', '切换失败，回滚到 ' + prev + ': ' + e.message)
      st.quality = prev
      saveCfg()
      return { ok: false, error: e.message, current: st.quality }
    } finally {
      pushStatus({ switching: null })
    }
  }

  return { ok: true, current: st.quality, tier: target }
})

/**
 * 透明度写入。
 *
 * 阈值保护：低于 35% 一律不落盘。
 * 用户手动调到 10% 是合法的，但那种状态存下来，下次启动
 * 窗口会「看起来根本没显示」—— 这是最容易让人以为程序坏掉的坑。
 * 会话内想多透明都行，只是不记住。
 */
const VISIBLE_MIN = 0.35

ipcMain.on('win:opacity', (_e, v) => {
  if (typeof v.content === 'number') st.contentOp = v.content
  if (typeof v.bg === 'number') st.bgOp = v.bg
  saveCfg()
})
ipcMain.on('win:pin', (_e, on) => { st.pinned = !!on; if (win) win.setAlwaysOnTop(st.pinned, 'screen-saver'); saveCfg() })
ipcMain.on('win:ratio', (_e, on) => { st.ratioLock = !!on; saveCfg() })
ipcMain.on('win:close', () => { saveCfg(); app.quit() })

/**
 * 帧回执不再在这里注册 —— startScrcpySession 内部用自己的闭包
 * 维护 inFlight（见该函数里的 ipcMain.on('win:frame-ack')）。
 * 这里再注册一个会导致 ack 被提前消费，背压计数错乱。
 */

/**
 * 视频分辨率到手 —— 把窗口调到「视频区正好是该比例」。
 *
 * chromeH（标题栏 + 控制面板）由渲染层实测传入。
 * 之前写死 134 是错的：实测 223px 宽时是 42 + 98 = 140，
 * 差 6px 就把底部裁掉了。
 */
let videoAspect = 0
/** 上次用过的 chrome 高度（标题栏 + 底部面板）。面板折叠时它也会变。 */
let lastChromeH = -1
/**
 * 最新的视频像素尺寸。
 *
 * 反向控制要用它把鼠标坐标换算成手机坐标，所以必须早点声明 ——
 * 下面 win:video-size 里会赋值，而控制模块的 ensureCtrl() 也会读它。
 * 用 let 声明在读取之前，避免 TDZ 报错。
 */
let lastVideoW = 0

/** 程序内部调整窗口尺寸期间置 true，避免 resize 事件把尺寸写回 st */
let _programmaticResize = false
let lastVideoH = 0
ipcMain.on('win:video-size', (_e, d) => {
  if (!win || win.isDestroyed()) return
  if (!d || !d.w || !d.h) return

  // 控制事件要把鼠标坐标换算到手机像素，得知道视频的真实分辨率。
  // 这里是最早能拿到该值的地方，顺手同步给控制器。
  const sizeChanged = (lastVideoW !== d.w || lastVideoH !== d.h)
  lastVideoW = d.w
  lastVideoH = d.h
  /**
   * 顺手把真实分辨率报给 DSH 侧边栏。
   *
   * 面板上的 state.videoSize 一直是 null：唯一来源是解码器配置时的
   * info.width/info.height，而它们取自 MKV 头部 —— 这台手机上头部不带
   * 像素尺寸（实测 0x0），于是 info.width > 0 永远不成立，一次都没推过。
   *
   * 渲染层画第一帧时能拿到 VideoFrame.displayWidth/Height，那才是真值。
   */
  if (sizeChanged) {
    try { pushStatus({ videoSize: { w: d.w, h: d.h } }) } catch {}
  }
  if (ctrl && ctrl.ready) ctrl.setScreen(d.w, d.h)

  const ratio = d.w / d.h                 // 竖屏约 0.44
  /**
   * chrome 高度（标题栏 + 底部面板）。
   *
   * 下限从 60 降到 0：面板现在默认收起，chrome 只剩标题栏 42px。
   * 之前 Math.max(60, ...) 会把它硬抬到 60，导致每算一次视频区都少 18px，
   * 窗口宽度偏窄，画面右侧被裁掉一条。
   */
  const chromeH = Math.max(0, Math.round(d.chromeH || 42))

  /**
   * 比例和 chrome 高度都没变才算「没变化」。
   *
   * 原来只比 ratio —— 面板展开/收起时视频比例不变、chrome 变了，
   * 但这里会直接 return，窗口尺寸就永远停在展开时的样子，
   * 收起面板后下方留一条空白、宽度也不对。这是折叠功能失效的根因。
   */
  if (Math.abs(ratio - videoAspect) < 0.001 && chromeH === lastChromeH) return
  videoAspect = ratio
  lastChromeH = chromeH

  const b = win.getBounds()

  /**
   * 窗口尺寸算法：以**宽度**为准反推高度。
   *
   * 之前的写法是「保持当前窗口高度，用高度反推宽度」：
   *
   *   stageH = b.height - chromeH
   *   stageW = stageH * ratio        ← 宽度是被算出来的
   *   newW   = stageW; newH = stageH + chromeH
   *
   * 问题是 stageW 后面会被 MIN_W 夹一下。一旦夹住，宽度改小了，
   * 但 stageH 没跟着变 —— 视频按较小宽度等比缩放后只用到一部分高度，
   * 上下就多出两条黑边。看起来就是「窗口被拉长、画面上下留空」。
   *
   * 现在改成：
   *   1. 宽度取当前窗口宽度（不低于 MIN_W）
   *   2. 用宽度反推高度，保证视频区严丝合缝
   *   3. 只有在算出来的高度超过屏幕可用高度时，才反过来按高度缩宽度
   *
   * 这样窗口永远等于「视频 + chrome」，不会有多余空白。
   */
  const wa = screen.getDisplayNearestPoint({
    x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2)
  }).workArea

  /**
   * 尺寸贴合：以**屏幕可用空间**为上限，而不是以「当前窗口宽度」为准。
   *
   * 之前的 bug：窗口初始 400 宽 → 按比例算出高度 902 →
   * 超过屏幕可用高度 → 反过来压宽度到 206。
   * 结果用户设的 400×900 被程序改回 206×487，
   * 1080p 源缩到 0.19 倍，汉字全糊 —— 这正是「越用越小越糊」的原因。
   *
   * 现在：先按屏幕可用高度算出**最大可用宽度**，
   * 再取「用户当前宽度」和「最大宽度」中的较大者（不低于 MIN_W），
   * 保证既放得下、又尽可能大。
   */
  const maxStageH = Math.max(120, wa.height - chromeH - 20)
  const maxStageW = Math.round(maxStageH * ratio)

  /**
   * 目标宽度必须**从配置读**，不能从「当前窗口宽度」读。
   *
   * 踩过的坑：写成 Math.min(maxStageW, b.width) 后，
   * 每次 win:video-size 都拿上一轮的宽度当输入 ——
   * 窗口一路 400 → 300 → 200 → 34 无限缩下去，
   * 因为每轮都被 maxStageW 或 MIN_W 夹一次，越夹越小。
   *
   * 现在：优先用 st.w（用户设定的目标宽度，拖动时更新），
   * 只有 st.w 缺失时才退回当前窗口宽度。
   * 这样无论 win:video-size 触发多少次，结果都收敛到同一个值。
   */
  const targetW = (st.w && st.w >= MIN_W) ? st.w : Math.max(MIN_W, Math.round(b.width))
  let stageW = Math.max(MIN_W, Math.min(maxStageW, Math.round(targetW)))
  let stageH = Math.round(stageW / ratio)
  // 万一算出来仍然超高（极小屏幕），以高度为准收一次
  if (stageH > maxStageH) {
    stageH = maxStageH
    stageW = Math.max(MIN_W, Math.round(stageH * ratio))
  }

  const newW = stageW
  const newH = stageH + chromeH

  if (Math.abs(newW - b.width) > 1 || Math.abs(newH - b.height) > 1) {
    /**
     * 窗口贴合视频时，**保持左边缘和底部不动**。
     *
     * 原来用的是 `x: b.x + (b.width - newW)`，即以右边缘为基准。
     * 窗口默认在左下角，视频比例到达后宽度从 360 收到 220 ——
     * 右边缘不动意味着左边缘要往右挪 140px，于是窗口看起来
     * 从角落里「飘」到了屏幕中间。用户会觉得「默认位置又不对了」。
     *
     * 现在 x 保持不动（贴左边），y 用「底边不动」重算，
     * 这样窗口在左下角收缩，角落始终贴着不变。
     */
    const keepBottom = b.y + b.height
    const newY = keepBottom - newH
    applyBounds({ x: b.x, y: newY, width: newW, height: newH })
    const nb = win.getBounds()
    st.w = nb.width; st.h = nb.height; st.x = nb.x; st.y = nb.y
    saveCfg()
    logLine('info', `窗口贴合视频：${newW}×${newH}（视频区 ${stageW}×${stageH} + chrome ${chromeH}）`)
  }

  /**
   * 拿到真实视频比例后，用它锁住窗口拖拽比例。
   *
   * 这是「缩放等比例」的唯一正确时机 —— 此时才知道手机画面到底多宽多高。
   * 之后用户拖边缘，Electron 会在拖动过程中就按这个比例约束，
   * 不会先变形再跳回来，也不会出现视频被裁掉或留黑边。
   *
   * 注意传的是**窗口**比例而不是视频比例：窗口里除了视频还有标题栏和
   * 底部工具栏（chromeH），所以要用 (视频宽) / (视频高 + 固定高度)、
   * 这个换算无法用一个常数精确表达。这里退一步，用当前窗口比值 ——
   * 上面的 applyBounds 已经把窗口调成了「视频比例 + 固定 chrome」，
   * 所以此刻窗口比值就是正确的拖拽基准。
   */
  /**
   * 比例锁 —— 这里有个隐蔽的坑，导致窗口被越锁越小。
   *
   * setAspectRatio 会**约束窗口的宽高比**。如果传入的比值和
   * applyBounds 设的尺寸不一致，Electron 会按锁定的比例反过来
   * 调整窗口尺寸 —— 我们算出的 400×945 被强行拉回 219×517。
   *
   * 更糟的是每次 win:video-size 都重新锁一次，锁的是「上一轮的
   * 窗口比值」，误差累积，窗口一路缩小到 34×80。
   *
   * 正确做法：用**视频区**的比例（stageH 加上 chrome 后的窗口比例），
   * 并且只在比例真正变化时才重设，避免反复累积误差。
   */
  try {
    const cur = win.getBounds()
    const targetRatio = chromeH > 0 ? (cur.width / cur.height) : (cur.width / cur.height)
    if (!win.__aspectLocked || Math.abs((win.__aspectLocked || 0) - targetRatio) > 0.01) {
      win.setAspectRatio(targetRatio)
      win.__aspectLocked = targetRatio
    }
  } catch {}
})

ipcMain.handle('win:state', () => {
  const b = win.getBounds()
  return { ...st, x: b.x, y: b.y, w: b.width, h: b.height, minW: MIN_W, minH: MIN_H }
})

/* ==========================================================================
   反向控制：持久 adb shell
   --------------------------------------------------------------------------
   尝试过 scrcpy 控制协议（更理想：1~3ms 且支持 UTF-8），
   但这台华为上 server 收到首个控制消息就 SIGABRT，客户端绕不过去。
   完整排查过程见 adb-control.js 顶部注释。

   现在用持久 adb shell + stdin 喂 input 命令，实测延迟：
     每次 fork adb      243 ms/次   ← 拖动完全不可用
     持久 shell + stdin  13 ms/次   ← 可用
   ========================================================================== */
let ctrl = null
let ctrlStarting = null
/** 设备看门狗：负责 USB ↔ WiFi 无感切换 */
let devWatcher = null

/** 当前用于控制的设备序列号。WiFi 序列号形如 172.31.100.199:5555。 */
function ctrlSerial () {
  if (st.ctrlSerial) return st.ctrlSerial
  try {
    const cp = require('node:child_process')
    const out = cp.execFileSync(adbPath(), ['devices'], { encoding: 'utf8', timeout: 4000 })
    // 优先挑 WiFi 设备（含冒号），USB 的纯数字序列号排后面
    const wifi = out.match(/^(\d+\.\d+\.\d+\.\d+:\d+)\s+device$/m)
    if (wifi) return wifi[1]
    const any = out.match(/^(\S+)\s+device$/m)
    if (any) return any[1]
  } catch {}
  return null
}

/** 懒启动控制通道；并发调用共用同一个启动 Promise */
async function ensureCtrl () {
  if (ctrl && ctrl.ready) return ctrl
  if (ctrlStarting) return ctrlStarting

  const serial = ctrlSerial()
  if (!serial) return null

  ctrlStarting = (async () => {
    try {
      const { AdbShellControl, DeviceWatcher } = require('./adb-control.js')
      const c = new AdbShellControl({ adb: adbPath(), serial })
      c.onLog(m => logLine('info', '[ctl] ' + m))
      c.setScreen(lastVideoW || 720, lastVideoH || 1600)
      const r = await c.start()
      if (!r.ok) { ctrl = null; return null }
      ctrl = c

      /**
       * 启动设备看门狗：USB ↔ WiFi 无感切换。
       *
       * 候选地址从「当前用的 WiFi serial」和「最近记录的地址」里取，
       * 这样手机掉线后能自动重连回同一个 IP。
       */
      if (!devWatcher) {
        const known = []
        if (st.ctrlSerial && /:\d+$/.test(st.ctrlSerial)) known.push(st.ctrlSerial)
        if (!known.length && /:\d+$/.test(serial)) known.push(serial)
        /**
         * USB 热插拔快速重连。
         *
         * 用 adb track-devices 的事件流（不是轮询）：设备一插上
         * 几乎立刻收到通知，然后立即重启采集 —— 用户「拔了再插」
         * 的画面恢复时间从 10 秒级降到 1 秒级。
         *
         * 和 DeviceWatcher 的分工：
         *   DeviceWatcher   管「控制通道」切到哪个 serial（4 秒轮询，够用）
         *   UsbHotplugWatcher 管「采集链路」的即时恢复（事件驱动，要快）
         */
        if (!global.__usbHotplug) {
          const { UsbHotplugWatcher } = require('./usb-hotplug.js')
          global.__usbHotplug = new UsbHotplugWatcher({
            adb: adbPath(),
            onLog: (m) => logLine('info', m),
            onDeviceLost: (ser) => {
              logLine('warn', `USB/WiFi 设备断开：${ser}`)
            },
            /**
             * ══════════ 插上 USB = 全自动接管 ══════════
             *
             * 用户的原话：「插上 usb 就自动把声音带过来啊，
             *              注意先把手机上的声音静音了」。
             *
             * 所以这里不能再有「session 存在才恢复」这种前置条件 ——
             * 冷启动时 session 本来就是 null，按旧逻辑插上 USB
             * 什么都不会发生，用户看到的就是「插了没反应」。
             *
             * 现在的行为：
             *   ① 无条件重建投屏会话（画面 + 音频接收端 + 自愈）
             *   ② 音频自愈会自动拉起 APK 并授权，手机随即静音
             *   ③ 声音从电脑出来，手机不响
             *
             * 唯一尊重用户意愿的例外：用户明确点过「停止」时不动。
             */
            onDeviceBack: async (ser) => {
              logLine('ok', `USB 已连接：${ser}`)

              // 用户主动停止过 → 不自动拉起（这是他的明确意愿）
              if (userStopped) {
                logLine('info', '用户已手动停止，跳过自动启动')
                return
              }
              if (reconnecting) return

              reconnecting = true
              try {
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

                logLine('info', '正在自动建立投屏 + 声音链路…')
                await startSession({})
                reconnectAttempts = 0
                logLine('ok', '✓ 投屏与声音已自动接管（手机静音，声音在电脑）')
                pushStatus({ phase: 'streaming', streaming: true })
              } catch (e) {
                logLine('warn', '自动启动失败: ' + e.message)
                reconnecting = false
                scheduleReconnect('USB 接入后自动启动失败')
                return
              } finally {
                reconnecting = false
              }
            }
          })
          /**
           * ══════════ 暂时禁用（重要）══════════
           *
           * 实测这个 hotplug 会造成灾难性后果：
           *
           *   [usb] 设备在线 → 触发重连 → 启动 scrcpy
           *   [usb] 设备转为 offline            ← adb 自己抖一下
           *   [usb] 设备在线 → 又触发重连 → 又启动 scrcpy
           *
           * 每启动一次 scrcpy，adbd 就会重新协商一次传输层；
           * 频繁重启把 USB 链路彻底搞断（用户表现：一投屏就断线）。
           *
           * 而且 track-devices 在设备刚接入时会连续推
           * online/offline 好几次，我的边沿检测没滤掉这种抖动。
           *
           * 现在改为：靠 scrcpy 自身的 onExit 回调 + scheduleReconnect
           * 来做恢复（这条路径成熟可靠），hotplug 只保留代码不启用。
           * 需要时传 --usb-hotplug 参数才开。
           */
          if (process.argv.includes('--usb-hotplug')) {
            global.__usbHotplug.start()
            logLine('info', 'USB 热插拔加速已启用（实验性）')
          }
        }

        devWatcher = new DeviceWatcher({
          adb: adbPath(),
          wifiCandidates: known,
          /**
           * ══════════ 采集期禁止重启 adbd ══════════
           *
           * 传这个回调进去，DeviceWatcher 就不会在投屏时
           * 去跑 `adb tcpip 5555`（那会重启 adbd → scrcpy 断流）。
           *
           * 判断依据是「有没有活着的 scrcpy 进程」，而不是
           * session 是否存在 —— 因为 session 在崩溃后可能还挂着。
           */
          isStreaming: () => adbdRestartForbidden()
        })
        devWatcher.onLog(m => logLine('info', '[dev] ' + m))
        devWatcher.onChange(({ serial: s2, kind }) => {
          // 切换时不重建控制会话，只改目标 —— 用户无感
          if (ctrl) ctrl.switchTo(s2)
          st.ctrlSerial = s2
          saveCfg()
          logLine('ok', `[dev] 已切到 ${kind === 'wifi' ? '无线' : 'USB'}: ` + s2)
        })
        devWatcher.start(4000)
      }

      return c
    } catch (e) {
      logLine('error', '[ctl] 启动异常: ' + String(e.message || e))
      ctrl = null
      return null
    } finally {
      ctrlStarting = null
    }
  })()
  return ctrlStarting
}

ipcMain.on('ctl:tap', async (_e, d) => {
  if (!d || typeof d.x !== 'number') {
    logLine('warn', '[ctl] tap 参数无效: ' + JSON.stringify(d))
    return
  }
  const c = await ensureCtrl()
  if (!c) { logLine('warn', '[ctl] tap 失败：控制通道未就绪'); return }
  const p = c.toPhysical(d.x, d.y)
  logLine('info', `[ctl] tap 视频(${Math.round(d.x)},${Math.round(d.y)}) → 物理(${p.x},${p.y})`)
  c.tap(d.x, d.y)
})

ipcMain.on('ctl:swipe', async (_e, d) => {
  if (!d) return
  const c = await ensureCtrl()
  if (!c) return
  c.swipe(d.x1, d.y1, d.x2, d.y2, d.ms)
})

ipcMain.on('ctl:longpress', async (_e, d) => {
  if (!d) return
  const c = await ensureCtrl()
  if (!c) return
  c.longPress(d.x, d.y, d.ms)
})

ipcMain.on('ctl:key', async (_e, code) => {
  if (!code) return
  const c = await ensureCtrl()
  if (!c) return
  if (typeof code === 'number') { c.key(code); return }
  const m = String(code).match(/^KEYCODE_(\w+)$/)
  if (m) {
    const numeric = KEYCODE_MAP[m[1]]
    if (numeric) c.key(numeric)
    return
  }
  const n = Number(code)
  if (Number.isFinite(n)) c.key(n)
})

ipcMain.on('ctl:text', async (_e, text) => {
  if (typeof text !== 'string' || !text) return
  const c = await ensureCtrl()
  if (!c) return
  c.text(text)
})

ipcMain.on('ctl:scroll', async (_e, d) => {
  if (!d) return
  const c = await ensureCtrl()
  if (!c) return
  c.scroll(d.x, d.y, d.hx || 0, d.vy || 0)
})

/** 查询控制通道状态（设置面板里显示用） */
ipcMain.handle('ctl:info', async () => {
  const serial = ctrlSerial()
  if (!serial) return { ok: false, error: '没有可用设备（需要先 adb connect）' }
  const ready = !!(ctrl && ctrl.ready)
  if (!ready) ensureCtrl().catch(() => {})
  return {
    ok: true,
    serial,
    wifi: /:\d+$/.test(serial),
    ready,
    transport: ready ? 'adb-shell' : 'pending'
  }
})

/** 手动指定控制目标（多设备时用） */
ipcMain.on('ctl:setSerial', async (_e, s) => {
  st.ctrlSerial = s || null
  saveCfg()
  if (ctrl) { try { await ctrl.stop() } catch {} ctrl = null }
  logLine('info', '控制目标: ' + (s || '自动'))
})

/** Android keycode 名字 → 数值 */
const KEYCODE_MAP = {
  BACK: 4,
  HOME: 3,
  MENU: 82,
  APP_SWITCH: 187,
  ENTER: 66,
  DEL: 67,
  TAB: 61,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  ESCAPE: 111,
  SPACE: 62
}

let drag = null
ipcMain.on('drag:start', () => { if (win) drag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() } })
ipcMain.on('drag:move', () => {
  if (!win || !drag) return
  const c = screen.getCursorScreenPoint()
  applyBounds({ x: drag.bounds.x + (c.x - drag.cursor.x), y: drag.bounds.y + (c.y - drag.cursor.y), width: drag.bounds.width, height: drag.bounds.height })
})
ipcMain.on('drag:end', () => {
  if (!win || !drag) { drag = null; return }
  const b = win.getBounds()
  const s = snapInto(b.x, b.y, b.width, b.height)
  applyBounds({ ...b, x: s.x, y: s.y })
  const nb = win.getBounds()
  st.x = nb.x; st.y = nb.y; st.w = nb.width; st.h = nb.height
  saveCfg(); drag = null
})

let rs = null
ipcMain.on('resize:start', (_e, dir) => { if (win) rs = { dir, cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() } })
ipcMain.on('resize:move', () => {
  if (!win || !rs) return
  const c = screen.getCursorScreenPoint()
  applyBounds(computeResize(rs.bounds, rs.dir, c.x - rs.cursor.x, c.y - rs.cursor.y, st.ratioLock))
})
ipcMain.on('resize:end', () => {
  if (!win) { rs = null; return }
  const b = win.getBounds()
  st.x = b.x; st.y = b.y; st.w = b.width; st.h = b.height
  saveCfg(); broadcastSize(); rs = null
})

ipcMain.on('win:scale', (_e, f) => {
  if (!win) return
  const b = win.getBounds()
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2
  const w = Math.max(MIN_W, Math.min(1600, b.width * f))
  const h = st.ratioLock ? w * (b.height / b.width) : Math.max(MIN_H, b.height * f)
  applyBounds({ x: cx - w / 2, y: cy - h / 2, width: w, height: h })
  const nb = win.getBounds()
  st.w = nb.width; st.h = nb.height; st.x = nb.x; st.y = nb.y
  saveCfg()
})

/**
 * 重置视图：尺寸 + 透明度回到「看得见」。
 * 这是用户把滑杆拉到 0 / 窗口缩没时的救命入口，所以尺寸和透明度必须一起做。
 *
 * 置顶不参与重置：默认就是关的（用户要求），重置顺手把它打开等于偷偷改设置。
 * 需要置顶时标题栏圆钉 / Ctrl+Shift+F12 一键就能开。
 *
 * 位置也要回到默认的左下角 —— 之前这里写的是右上角，
 * 和启动时的默认位置不一致，点一次「重置」窗口就跑到右上角挡住面板，
 * 用户会以为重置把窗口弄丢了。
 */
ipcMain.on('win:reset', () => {
  if (!win) return
  const wa = screen.getPrimaryDisplay().workArea
  st.contentOp = 1
  st.bgOp = 1
  win.setAlwaysOnTop(st.pinned, 'screen-saver')

  const RW = 360, RH = 640
  applyBounds({
    x: wa.x + 24,
    y: wa.y + wa.height - RH - 24,
    width: RW, height: RH
  })
  const nb = win.getBounds()
  st.w = nb.width; st.h = nb.height; st.x = nb.x; st.y = nb.y
  saveCfg()
  logLine('ok', `视图已重置：360×640 / 透明度 100% / 置顶${st.pinned ? '开' : '关'} / 左下角`)
})

/* ---------- 启动 ---------- */
/**
 * ② Chromium 层：关掉一切代理自动检测。
 *
 * --no-proxy-server 让 Chromium 完全不使用代理（包括系统代理、
 * PAC 脚本、自动检测）。我们的所有网络请求都是本机或局域网，
 * 不需要代理；而外网请求（比如检查更新）对我们并不关键。
 *
 * --proxy-bypass-list 作为补充：即使别处开了代理，
 * 这些地址也强制直连。两个参数同时给，覆盖各种启动路径。
 */
app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost;::1;10.*;172.*;192.168.*')
app.commandLine.appendSwitch('proxy-auto-detect', 'false')
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox')

app.whenReady().then(async () => {
  await bootWindow()
})

/**
 * 托盘图标 —— 窗口被盖住 / 关掉时的最后一道唤回入口。
 *
 * 为什么必须有：
 *   任务栏图标只在窗口**存在**时有用。窗口被关掉（window-all-closed
 *   不退出进程）之后，任务栏那一项也没了，用户手上只剩快捷键。
 *   托盘常驻，关多少次窗口它都在。
 *
 * 菜单项直接对着真实操作，不做花活：
 *   显示 / 隐藏      切换窗口可见性（没有窗口就新建一个）
 *   置顶             切换 alwaysOnTop
 *   重新连接         重跑一次 startSession
 *   停止投屏         只停会话，窗口留着
 *   退出             保存配置后退出
 */
let tray = null
function setupTray () {
  if (!Tray || !Menu || !nativeImage) {
    logLine('warn', '当前环境不支持托盘图标，跳过')
    return
  }
  if (tray) return

  const iconPath = path.join(__dirname, 'assets', 'tray-32.png')
  let img = null
  try {
    img = nativeImage.createFromPath(iconPath)
    if (img.isEmpty()) {
      logLine('warn', '托盘图标加载为空: ' + iconPath)
      img = null
    }
  } catch (e) {
    logLine('warn', '托盘图标加载失败: ' + e.message)
  }
  if (!img) return

  try {
    tray = new Tray(img)
  } catch (e) {
    logLine('warn', '托盘创建失败: ' + e.message)
    tray = null
    return
  }

  const rebuild = () => {
    const visible = !!(win && !win.isDestroyed() && win.isVisible())
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? '隐藏迷你窗' : '显示迷你窗',
        click: async () => {
          try {
            if (!win || win.isDestroyed()) {
              await bootWindow()
              return
            }
            if (visible) win.hide()
            else { win.show(); win.focus(); win.moveTop() }
          } catch (e) { logLine('error', '托盘切换失败: ' + e.message) }
          // 菜单文字要跟着状态变，重建一次
          setTimeout(rebuild, 120)
        }
      },
      {
        label: (st.pinned ? '✓ ' : '') + '置顶',
        click: () => {
          st.pinned = !st.pinned
          if (win && !win.isDestroyed()) {
            win.setAlwaysOnTop(st.pinned, 'screen-saver')
            if (st.pinned) win.moveTop()
            if (win.webContents) win.webContents.send('pinned', st.pinned)
          }
          saveCfg()
          setTimeout(rebuild, 120)
        }
      },
      { type: 'separator' },
      {
        label: '重新连接',
        click: () => {
          logLine('info', '托盘：重新连接')
          startSession({}).catch(e => logLine('error', '重连失败: ' + e.message))
        }
      },
      {
        label: '停止投屏',
        click: () => {
          logLine('info', '托盘：停止投屏')
          stopSession().catch(() => {})
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => { saveCfg(); app.quit() }
      }
    ])
    try { tray.setContextMenu(menu) } catch {}
  }

  rebuild()
  try {
    tray.setToolTip('MiniWin 手机投屏')
    // 单击托盘 = 显示（比右键菜单再点一次快）
    tray.on('click', async () => {
      try {
        if (!win || win.isDestroyed()) { await bootWindow(); return }
        if (win.isVisible()) { win.focus(); win.moveTop() }
        else { win.show(); win.focus(); win.moveTop() }
      } catch (e) { logLine('error', '托盘单击失败: ' + e.message) }
    })
  } catch {}

  logLine('info', '托盘图标已就绪')
}

/**
 * 本地控制 HTTP 服务 —— 见 app.whenReady 里的调用点注释。
 *
 * 极简实现：不引框架，只处理 4 个路由，全部同步返回 JSON。
 */
function startControlServer (port) {
  const http = require('node:http')
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(b.length),
        'Access-Control-Allow-Origin': '*'
      })
      res.end(b)
    }

    const u = new URL(req.url, 'http://127.0.0.1')
    const p = u.pathname

    if (req.method === 'GET' && p === '/state') {
      return send(200, {
        ok: true,
        streaming: !!(session && session.scrcpyCapture && session.scrcpyCapture.running),
        quality: st.quality,
        tier: resolveTier(tierById(st.quality), lastNativeLongSide),
        pinned: st.pinned,
        videoSize: lastVideoW && lastVideoH ? { w: lastVideoW, h: lastVideoH } : null
      })
    }

    if (req.method === 'GET' && p === '/quality') {
      return send(200, {
        ok: true,
        current: st.quality,
        tiers: tierListForUi()
      })
    }

    if (req.method === 'POST' && p === '/quality') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', async () => {
        let body = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
        const id = body && body.id
        const target = TIERS.find(t => t.id === id)
        if (!target) return send(400, { ok: false, error: 'unknown tier: ' + id })

        const prev = st.quality
        st.quality = target.id
        saveCfg()
        logLine('info', `[ctl] 档位切换：${prev} → ${target.id}`)
        if (win && !win.isDestroyed()) {
          try { win.webContents.send('quality:changed', { current: target.id, tier: target }) } catch {}
        }
        if (session && session.scrcpyCapture && session.scrcpyCapture.running) {
          try {
            await startSession({})
            return send(200, { ok: true, current: st.quality, tier: target, hot: true })
          } catch (e) {
            st.quality = prev
            saveCfg()
            return send(500, { ok: false, error: e.message, current: st.quality })
          }
        }
        return send(200, { ok: true, current: st.quality, tier: target, hot: false })
      })
      return
    }

    if (req.method === 'POST' && p === '/reconnect') {
      startSession({})
        .then(() => send(200, { ok: true }))
        .catch(e => send(500, { ok: false, error: e.message }))
      return
    }

    if (req.method === 'POST' && p === '/quit') {
      send(200, { ok: true })
      setTimeout(() => { saveCfg(); app.quit() }, 100)
      return
    }

    send(404, { ok: false, error: 'not found' })
  })

  srv.on('error', e => logLine('warn', '控制端口启动失败: ' + e.message))
  srv.listen(port, '127.0.0.1', () => {
    logLine('info', `控制端口已监听 127.0.0.1:${port}`)
  })
  return srv
}

/**
 * 创建/重建迷你窗。
 *
 * 单独抽成函数是因为 `window-all-closed` 现在**不退出进程**了 ——
 * 窗口被关掉之后进程还活着，收到重开请求时需要能重新建一个窗口。
 * 如果首次启动和重建走两套代码，配置加载、代理设置、IPC 注册
 * 迟早会不一致，所以统一走这里。
 *
 * 幂等：已经在跑就直接返回。
 */
async function bootWindow () {
  if (win && !win.isDestroyed()) return win

  /**
   * ③ Session 层：显式声明直连。
   *
   * 渲染层的 fetch/XHR 走的是 defaultSession，它的代理策略
   * 独立于 Node 侧的环境变量。这里再钉死一次 ensureFirefoxProxy
   * 风格的行为：mode='direct' 表示完全不使用代理。
   */
  try {
    const { session } = require('electron')
    await session.defaultSession.setProxy({ mode: 'direct' })
    console.log('[proxy] defaultSession 已设为 direct（不受系统代理影响）')
  } catch (e) {
    console.log('[proxy] setProxy 失败（忽略）: ' + e.message)
  }

  // 顺便把已存在的代理配置清掉，防止 PAC 残留
  try {
    const { session } = require('electron')
    await session.defaultSession.closeAllConnections()
  } catch {}

  /**
   * 代理自检：启动后打印实际生效的代理状态。
   * 用户报「连不上」时，这行日志能立刻区分
   * 「代理问题」还是「App/网络问题」。
   */
  try {
    const { session } = require('electron')
    const px = await session.defaultSession.resolveProxy('http://127.0.0.1:43111')
    console.log('[proxy] 127.0.0.1:43111 的代理判定 = ' + px +
      (px.startsWith('DIRECT') ? ' ✓ 直连（正确）' : ' ✗ 走了代理（异常！）'))
    const px2 = await session.defaultSession.resolveProxy('http://172.31.100.199:43110')
    console.log('[proxy] 局域网 172.31.*: ' + px2 +
      (px2.startsWith('DIRECT') ? ' ✓ 直连（正确）' : ' ✗ 走了代理（异常！）'))
  } catch (e) { console.log('[proxy] 自检失败: ' + e.message) }
  loadCfg()

  // 可选：把状态回传给 DSH 插件（--report <url>）
  const ri = process.argv.indexOf('--report')
  if (ri >= 0 && process.argv[ri + 1]) reportUrl = process.argv[ri + 1]

  /**
   * ── 本地控制端口 ──
   *
   * 给「DSH 插件面板」和「自动化测试」一个不依赖窗口焦点的入口。
   *
   * 为什么需要它：档位切换这类操作只有 IPC（ipcMain.handle）一条路，
   * 而 IPC 只能从渲染层发起。插件面板在外面的浏览器里拿不到
   * preload 的 window.api，测试脚本也没法模拟按键（Chromium 拒绝
   * 后台进程抢焦点，实测 FOCUS_FAILED）。
   *
   * 所以开一个只绑 127.0.0.1 的极小 HTTP 服务：
   *   GET  /state              当前档位 + 会话状态
   *   GET  /quality            档位表 + 当前档
   *   POST /quality  {"id":x}  切换档位（含热切换）
   *   POST /reconnect          重连
   *   POST /quit               退出
   *
   * 安全边界：只 bind 127.0.0.1，且要求 --control-port 显式传入
   * （默认不开）。同机的其他程序能调，但那本来就等价于同一个用户
   * 的权限，不构成额外暴露面。
   */
  const ci = process.argv.indexOf('--control-port')
  const controlPort = ci >= 0 ? Number(process.argv[ci + 1]) : 0
  if (controlPort > 0) startControlServer(controlPort)

  // 自检用：--shot <png路径> [--shot-delay <ms>] 启动后截自己的图
  const si = process.argv.indexOf('--shot')
  const shotPath = si >= 0 ? process.argv[si + 1] : null
  const sdi = process.argv.indexOf('--shot-delay')
  const shotDelay = sdi >= 0 ? Number(process.argv[sdi + 1]) : 8000

  /**
   * WiFi 模式：--wifi <http源>
   * 不走 adb/scrcpy，从本地 HTTP（wifi-receiver.js 的 27191）拉帧。
   * 手机 App → TCP 27190 → receiver → HTTP 27191 → 这里 → 渲染。
   */
  const wi = process.argv.indexOf('--wifi')
  const wifiSource = wi >= 0 ? process.argv[wi + 1] : null

  const wa = screen.getPrimaryDisplay().workArea

  /**
   * 窗口初始尺寸 —— st.w/h 为 null 时按屏幕自动算到最大。
   *
   * 手机原生 1260×2844（比例 0.443）。要让小字可读，窗口必须
   * 尽可能大：屏幕高度用到 92%（留余量给任务栏），按手机比例
   * 反推宽度；如果宽度超出屏幕再反过来收。这样不管什么显示器
   * 都自动开到最大可见尺寸。
   */
  const PHONE_RATIO = 1260 / 2844
  const chromeGuess = 42
  let w, h
  if (st.w && st.h) {
    w = Math.max(MIN_W, Math.round(st.w))
    h = Math.max(MIN_H, Math.round(st.h))
  } else {
    const maxH = Math.round((wa.height - chromeGuess) * 0.92)
    const maxW = Math.round((wa.width - 40) * 0.92)
    let stageH = maxH
    let stageW = Math.round(stageH * PHONE_RATIO)
    if (stageW > maxW) {
      stageW = maxW
      stageH = Math.round(stageW / PHONE_RATIO)
    }
    w = Math.max(MIN_W, stageW)
    h = Math.max(MIN_H, stageH + chromeGuess)
  }

  /**
   * 默认位置：左下角。
   *
   * 之前是右上角（wa.width - w - 48, wa.y + 72），会直接盖住 DSH 右侧的
   * 投屏面板和对话框，每次都得先把它拖走才能看面板。
   * 左下角是屏幕上最不碍事的位置：任务栏之上、聊天区左侧空白处，
   * 拖过来之后也符合「小窗挂在角落不挡事」的直觉。
   *
   * 留 24px 边距，不贴死屏幕边缘，避免和任务栏/圆角视觉上黏在一起。
   */
  const DEF_X = wa.x + 24
  const DEF_Y = wa.y + wa.height - h - 24

  win = new BrowserWindow({
    x: st.x ?? DEF_X,
    y: st.y ?? DEF_Y,
    width: w, height: h,
    frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, resizable: true, maximizable: false, minimizable: false,
    fullscreenable: false,
    /**
     * ══════════ skipTaskbar 必须是 false ══════════
     *
     * 原来是 true —— 窗口不出现在任务栏。后果是：取消置顶后它被
     * 别的程序盖住，而任务栏上没有图标、又没有托盘，
     * 用户除了去 DSH 面板点「重开迷你窗」之外**没有任何入口**。
     * 这是用户报「点别处就看不见了」的根因之一。
     *
     * 现在 false：任务栏有图标，点一下就能还原/前置。
     * 另外还加了托盘图标（见 setupTray），双保险。
     */
    skipTaskbar: false,
    alwaysOnTop: st.pinned,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  })

  /**
   * 缩放等比：交给「视频比例」去锁，不在这里用占位尺寸锁。
   *
   * 一开始想直接 setAspectRatio(w / h) 锁住窗口比例，但那样是错的：
   * 启动时 360×640 只是「还没收到视频」的占位比例，真实手机画面是
   * 720×1600 之类的值。用占位比例锁死之后，等 win:video-size 到达、
   * 窗口按视频比例重算时两者会互相打架，拖动边缘也会感觉「拽不动」。
   *
   * 正确的锁在下面 win:video-size 处理里：拿到 videoAspect 之后锁那个值。
   */
  win.setAlwaysOnTop(st.pinned, 'screen-saver')
  await win.loadFile(path.join(__dirname, 'ui.html'))
  broadcastSize()

  /**
   * ══════════ 渲染层重载后补推状态 ══════════
   *
   * 页面刷新（DevTools reload、崩溃恢复、或者我们改 UI 后手动 reload）
   * 之后渲染层手里是空的：没有 `video:config`（解码器配置），
   * 也没有 `status`（状态栏文案与设备信息）。
   *
   * 表现：画面一直黑着、标题栏停在「MiniWin」、工具栏没有帧率 ——
   * 看起来像「连接断了」，其实采集还好好的，只是没人把配置再告诉它一次。
   *
   * 这里在每次加载完成后补一遍：不重建会话，只补数据。
   */
  win.webContents.on('did-finish-load', () => { replayStateToRenderer() })

  /**
   * ══════════ WiFi 模式：把流地址交给渲染层 ══════════
   *
   * 这里曾经是个致命缺口：`--wifi <url>` 解析出来了，却**从来没有人把它
   * 发给渲染层** —— ui.html 里的 `onWifiStart` 监听器永远等不到事件，
   * 于是 WiFi 模式下窗口就是一块占位图，用户看到的是「连不上」。
   *
   * 现在每次加载完成都发一次（页面重载后也能自己恢复），
   * 渲染层收到就开始长轮询 /frames 拉画面 + 起 WifiAudio 播放声音。
   */
  if (wifiSource) {
    const sendWifiStart = () => {
      if (!win || win.isDestroyed()) return
      try {
        win.webContents.send('wifi:start', { source: wifiSource })
        logLine('info', '[wifi] 已通知渲染层拉流: ' + wifiSource)
      } catch (e) { logLine('warn', '[wifi] 通知渲染层失败: ' + e.message) }
    }
    win.webContents.on('did-finish-load', sendWifiStart)
    sendWifiStart()
    /**
     * 首帧加载时的竞态：bootWindow() 是 await loadFile 回来的，此时
     * did-finish-load 已经过去，而渲染层的监听器可能刚注册完 —— 一条事件
     * 丢了就是「窗口一直空白」。补两次延迟发送，渲染层用 wifiRunning 去重，
     * 多发无害。
     */
    setTimeout(sendWifiStart, 700)
    setTimeout(sendWifiStart, 2200)

    /**
     * WiFi 模式下的音频策略。
     *
     * 复用同一套 AudioRouter：
     *   · 有 adb 通道 → 能识别耳机，完整规则生效
     *   · 没有 adb   → 耳机不可知，按外放处理（投屏音量默认 0，
     *                   手机端由 APK 自己锁 0），手机音量键仍能遥控投屏音量
     * 投屏音量 = 渲染层本地增益，永远不会写回手机。
     */
    ;(async () => {
      try {
        const { AudioRouter } = require('./audio-router.js')
        let serial = null
        try {
          const adb = new Adb(adbPath())
          const list = await adb.devices()
          const ready = list.filter(d => d.state === 'device')
          if (ready.length) serial = ready[0].serial
        } catch {}
        const httpPort = (() => {
          try { return Number(new URL(wifiSource).port) || 0 } catch { return 0 }
        })()
        const router = new AudioRouter({
          adb: adbPath(),
          serial,
          httpPort,
          apkPackage: 'com.miniwin.stream',
          onLog: (m) => logLine('info', m),
          onState: (st) => { try { win && win.webContents.send('audio:state', st) } catch {} }
        })
        await router.poll()
        router.setPcVolume(0)
        router.start()
        app.on('will-quit', () => { try { router.stop() } catch {} })
        logLine(serial ? 'info' : 'warn',
          serial
            ? '[audio] WiFi 模式：音频策略已接管，能识别耳机（' + serial + '）'
            : '[audio] WiFi 模式：没有 adb 通道，耳机状态无法探测，按外放处理（投屏音量默认 0）')
      } catch (e) {
        logLine('warn', '[audio] WiFi 模式音频策略初始化失败: ' + e.message)
      }
    })()
  }

  /**
   * ══════════ Esc 只在窗口有焦点时才退出 ══════════
   *
   * 踩过的坑：原来是 globalShortcut.register('Escape', ...)。
   * globalShortcut 是**系统级**的 —— 无论焦点在浏览器、微信还是
   * 任何程序，按 Esc 都会把迷你窗关掉。用户在别处按 Esc 关个弹窗，
   * 投屏就没了，还以为程序坏了。
   *
   * 现在改成窗口内按键：只有鼠标点过迷你窗、它拿到焦点时，
   * Esc 才生效。想全局关就用下面注册的快捷键（Ctrl+Alt+Q）。
   */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape' && !input.control && !input.alt) {
      e.preventDefault()
      saveCfg()
      app.quit()
    }
  })

  /**
   * ══════════ 唤回 / 置顶 / 退出的快捷键 ══════════
   *
   * 需求：取消置顶后，窗口会被别的程序盖住；而 skipTaskbar 让它
   * 不在任务栏，用户没有任何入口把它叫回来（只能去面板点「重开」）。
   *
   * ── 为什么不用 Ctrl+Alt+X ──
   *
   * 最初写的是 Ctrl+Alt+M / T / Q。实测 register() 全部返回 false ——
   * 这台机器上有程序（输入法/驱动）占用了整个 Ctrl+Alt 前缀，
   * 于是三个快捷键一个都不生效，比不注册还糟（用户以为能用）。
   *
   * 逐个试出来的可用组合：
   *   Ctrl+Alt+M  ✗    Ctrl+Alt+T  ✗    Ctrl+Alt+Q  ✗
   *   F9 ✓   Ctrl+Shift+F12 ✓   Alt+Shift+J ✓
   *
   * 选了下面三个，注册失败会打日志（而不是静默失效）：
   *   F9             唤回 / 重建迷你窗
   *   Ctrl+Shift+F12 切换置顶
   *   Alt+Shift+J    退出
   */
  const SHORTCUTS = [
    ['F9', async () => {
      try {
        if (!win || win.isDestroyed()) {
          logLine('info', '迷你窗不存在，正在重建…')
          await bootWindow()
          return
        }
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        win.moveTop()
        logLine('info', '已唤回迷你窗')
      } catch (e) {
        logLine('error', '唤回失败: ' + e.message)
      }
    }],
    ['Control+Shift+F12', () => {
      if (!win || win.isDestroyed()) return
      st.pinned = !st.pinned
      win.setAlwaysOnTop(st.pinned, 'screen-saver')
      if (st.pinned) win.moveTop()
      saveCfg()
      logLine('info', st.pinned ? '已置顶' : '已取消置顶（F9 可唤回）')
      if (win.webContents) win.webContents.send('pinned', st.pinned)
    }],
    ['Alt+Shift+J', () => {
      logLine('info', '收到退出快捷键')
      saveCfg()
      app.quit()
    }]
  ]

  for (const [accel, fn] of SHORTCUTS) {
    let ok = false
    try { ok = globalShortcut.register(accel, fn) } catch {}
    if (ok) logLine('info', `快捷键已注册: ${accel}`)
    else logLine('warn', `快捷键被占用，注册失败: ${accel}`)
  }

  setupTray()

  logLine('info', 'adb: ' + adbPath())

  /**
   * 启动采集。
   *
   * 只有一条路径了：scrcpy.exe + 命名管道。
   * --auto 或 --connect 都走这里；不传参数时窗口只显示占位。
   */
  if (AUTO || process.argv.includes('--connect')) {
    const ser = argSerial()
    setTimeout(() => {
      startSession({ serial: ser || undefined })
        .catch(e => logLine('error', '启动失败: ' + e.message))
    }, 800)
  }

  // 自检截图：等画面出来再截，然后退出
  if (shotPath) {
    setTimeout(async () => {
      try {
        const fs2 = await import('node:fs')
        const img = await win.webContents.capturePage()
        fs2.writeFileSync(shotPath, img.toPNG())
        logLine('ok', '已截图: ' + shotPath)
      } catch (e) {
        logLine('error', '截图失败: ' + e.message)
      }
      setTimeout(() => { saveCfg(); app.quit() }, 400)
    }, shotDelay)
  }

  return win
}

/**
 * 窗口关闭时**不要**直接退出整个 app。
 *
 * 迷你窗只有一个窗口，`window-all-closed → app.quit()` 意味着
 * 任何一次误关（Alt+F4、任务管理器、点错）都会让整个投屏进程消失，
 * 用户只能重新点「重开迷你窗」。
 *
 * 现在：关窗口 = 停止投屏但**保留进程**，靠 Ctrl+Alt+M 或者
 * 插件再发一次 /launch 就能把窗口重新创建出来。
 * 真正退出走 Esc（窗口内）或 Ctrl+Alt+Q。
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 不 quit，只是把会话停掉；进程留着等下一句「重开」
    logLine('info', '迷你窗已关闭（进程保留，Ctrl+Alt+M 或面板重开可唤回）')
    stopSession().catch(() => {})
  }
})

app.on('will-quit', async () => {
  globalShortcut.unregisterAll()
  await stopSession()
  /**
   * 退出时必须显式关掉控制通道。
   *
   * 设备侧的 server 是 app_process 起的独立进程，不会随客户端退出而消失。
   * 不清理的话它继续占着 abstract socket "scrcpy"，
   * 下次启动新 server 就 bind 失败 —— 现象是「控制突然不能用了，
   * 重启小窗也没用」，实际要手动 pkill 才能恢复。
   */
  if (ctrl) {
    try { await ctrl.stop() } catch {}
    ctrl = null
  }
  if (devWatcher) {
    try { devWatcher.stop() } catch {}
    devWatcher = null
  }
})
