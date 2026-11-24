/**
 * dsh-miniwin — Host 半侧
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 设备发现（adb devices）
 *   2. 无线调试配对：开始配对（生成配对码？不行，配对码是手机生成的）
 *      —— 所以这里做的是「接收手机扫过来的配对信息」+「配对 + 连接」
 *   3. 起投屏会话（复用 miniwin-stream 的 scrcpy 链路，画面进桌面迷你窗）
 *   4. 通过 HTTP 路由给浏览器半侧提供状态
 *
 * 关于「扫码」：
 *   配对码是**手机生成的**，PC 无法预先生成，所以必须手机→PC 传配对信息。
 *   二维码的方向是：PC 显示二维码 → 手机扫 → 手机打开一个网页 → 在网页上
 *   输入/确认配对码 → 回传给 PC。
 *
 *   但这个方案有个绕不过的硬限制：配对码是手机自己弹出来的，用户还是得看手机。
 *   所以更实用的做法是：PC 上显示二维码 = 当前 PC 的 IP + 端口，
 *   手机扫码后打开一个**极简配对页**，用户在手机上把「配对码」输进去，
 *   配对页调用 PC 的 API 完成 adb pair + connect。
 *   这样省掉的是「让用户去设置里翻 IP 和端口」，配对码该看还得看。
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

/* ==========================================================================
   运行时目录解析
   --------------------------------------------------------------------------
   这个插件依赖一整套「投屏运行时」：迷你窗主进程（Electron）、scrcpy 二进制、
   手机端 APK、音频接收端脚本。发布到插件市场之后，它们随包分发在 runtime/。

   优先级：
     1. MINIWIN_HOME 环境变量 —— 开发时常年用着，保留，不破坏已有用法
     2. 随包的 runtime/       —— 市场安装 / npm 安装走这条
     3. 都没有就报错，并把「该设置什么」写清楚

   旧的写法是把作者本机的绝对路径写死在源码里 ——
   只有作者那台机器能跑，别人装上之后扫码出码、投屏起不来。
   ========================================================================== */
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))   // <pkg>/lib

function runtimeRoot() {
  if (process.env.MINIWIN_HOME) return process.env.MINIWIN_HOME
  const bundled = path.join(PKG_DIR, '..', 'runtime')
  if (fs.existsSync(path.join(bundled, 'main.js'))) return bundled
  throw new Error(
    'dsh-miniwin: 找不到投屏运行时目录：' + bundled +
    '。请重新安装插件；如果是从源码目录挂载，设置环境变量 MINIWIN_HOME 指向 miniwin-stream 目录。'
  )
}

/**
 * 迷你窗用哪个 Electron。
 *
 * DSH 宿主自己就跑在 Electron 里，`process.execPath` 就是 electron.exe ——
 * 直接复用宿主，不用在 25MB 运行时之外再塞一份 200MB 的 Electron。
 * 宿主不是 Electron 的场合（纯 node 跑），用环境变量指一个。
 */
function resolveElectron() {
  if (process.env.MINIWIN_ELECTRON) return process.env.MINIWIN_ELECTRON
  const exe = process.execPath || ''
  if (/^electron(\.exe)?$/i.test(path.basename(exe))) return exe
  const sibling = path.join(path.dirname(exe), 'electron.exe')
  if (fs.existsSync(sibling)) return sibling
  throw new Error(
    'dsh-miniwin: 找不到 Electron 宿主可执行文件（process.execPath=' + exe +
    '）。如果宿主不是 Electron，设置环境变量 MINIWIN_ELECTRON 指向 electron.exe。'
  )
}

const ROUTE_BASE = '/dsh-miniwin'

/* ==========================================================================
   固定端口 —— 二维码不再「重启就失效」的关键
   --------------------------------------------------------------------------
   原来的写法是 recvPort = lanPort + 1、httpPort = lanPort + 2，
   而 lanPort 来自 lanServer.listen(0)，由系统随机分配。
   后果是每重启一次 DSH，深链就换一个端口：

     重启前  miniwin://stream?host=172.31.100.174&port=49597
     重启后  miniwin://stream?host=172.31.100.174&port=25521

   于是「上次扫过的码，这次必然连不上」——用户每次都得重新扫，
   断线也没法用旧码接回来。这是「扫码没反应」最主要的一个来源：
   码还是那个码，端口早换了。

   改成固定端口后，只要 PC 的局域网 IP 不变，深链就恒定：
     miniwin://stream?host=<PC_IP>&port=43110
   手机可以记地址、断线重连不用再扫，二维码也可以长期有效。

   端口选 43110/43111：高位、避开常见服务、相邻好记。
   被占用时依次往后找（见 bindFirstFree），并在 /wifi-state 里报告实际值。
   ========================================================================== */
const PREF_RECV_PORT = Number(process.env.MINIWIN_RECV_PORT || 43110)
const PREF_RECV_HTTP_PORT = Number(process.env.MINIWIN_RECV_HTTP_PORT || 43111)
const PREF_LAN_PORT = Number(process.env.MINIWIN_LAN_PORT || 43100)

/**
 * 深链里带上的编码长边上限。
 *
 * 手机 App 用 MediaProjection 抓屏，这台华为在原生像素
 * （1260×2844）下只有 4fps，长边限到 1080 能到 30fps 以上。
 * 把它放进深链意味着**改这一行就能试不同分辨率**，不用重新打包 APK。
 *
 * 可用环境变量覆盖：MINIWIN_MAX_SIZE=720 / 1440 / 2844
 */
const ENCODE_MAX_SIZE = (() => {
  const v = parseInt(process.env.MINIWIN_MAX_SIZE || '', 10)
  if (v >= 480 && v <= 2844) return v
  return 1080
})()

/**
 * 依赖注入声明。
 *
 * 只声明 webServer —— 之前多写了 'connection' 想让 requestRejection 生效，
 * 结果那条路在 desktop profile 下会把路由全打成 401。信任检查改成自己实现
 * （见 allowRequest），不再依赖 connection 服务。
 */
const inject = ['webServer']

/** 运行中的投屏会话（同一时刻只允许一个） */
let state = {
  phase: 'idle',        // idle | pairing | connecting | streaming | error
  device: null,
  code: null,
  message: '',
  /** 失败原因原文，与 message 分开存：面板要能区分「提示」和「报错」 */
  error: '',
  logs: [],
  videoSize: null,
  stats: null,
  since: 0
}

let session = null
let miniwin = null

/** LAN 配对服务器信息（端口 + token），由 apply() 填充 */
const lanInfo = { port: 0, token: '' }

/** 手机能力探测结果（由 /probe POST 写入） */
let probeResult = null

/** DSH 自己的地址（127.0.0.1:端口），从请求的 Host 头学到 */
let dshHost = ''

function pushLog(level, msg) {
  const line = { t: Date.now(), level, msg }
  state.logs.push(line)
  if (state.logs.length > 200) state.logs.shift()
  try { console.log('[dsh-miniwin] ' + msg) } catch {}
}

/** 懒加载 miniwin-stream 的实现（位于用户机器上） */
async function loadMiniwin() {
  if (miniwin) return miniwin
  const base = runtimeRoot()
  const { pathToFileURL } = await import('node:url')
  const device = await import(pathToFileURL(base + '/device.js').href)
  const streamer = await import(pathToFileURL(base + '/streamer.js').href)
  const avcc = await import(pathToFileURL(base + '/avcc.js').href)
  miniwin = { base, device, streamer, avcc }
  return miniwin
}

/**
 * 找一个真 node 来跑接收端。
 *
 * `process.execPath` 在这个插件里是 **electron.exe**（DSH 宿主跑在 Electron 里）。
 * 直接 spawn 它会被当成完整 Electron 应用启动，我的脚本不会执行 ——
 * 表现为 stderr 里一堆 network_change_notifier / gpu_disk_cache 报错，
 * 端口永远不监听。
 *
 * 查找顺序：
 *   1. MINIWIN_NODE 环境变量（显式指定）
 *   2. DSH runtime 自带的 node
 *   3. PATH 里的 node
 *   4. process.execPath 兜底（万一是普通 node 宿主）
 */
async function resolveNodeBin() {
  const fs = await import('node:fs')
  const candidates = []
  if (process.env.MINIWIN_NODE) candidates.push(process.env.MINIWIN_NODE)

  /**
   * DSH 安装目录下自带的 node。
   *
   * 不能写死路径 —— 每个人把 DSH 装在哪都不一样。
   * Electron 宿主里 `process.resourcesPath` 就是 `<安装目录>/resources`，
   * 官方 runtime 的 node 在它下面。几个已知形态都试一遍，找不到就走 PATH。
   */
  const roots = []
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  if (process.resourcesPath) {
    roots.push(process.resourcesPath)                     // <install>/resources
    roots.push(path.dirname(process.resourcesPath))       // <install>
  }
  const rels = [
    'runtime/x64/primary-runtime/dependencies/node/bin/node.exe',
    'resources/runtime/x64/primary-runtime/dependencies/node/bin/node.exe',
    'dependencies/node/bin/node.exe',
    'node/bin/node.exe'
  ]
  for (const r of roots) {
    for (const rel of rels) candidates.push(path.join(r, rel))
  }

  // PATH 里的 node
  const pathEnv = process.env.Path || process.env.PATH || ''
  for (const dir of pathEnv.split(';')) {
    if (!dir) continue
    const p = dir.replace(/\\+$/, '') + '/node.exe'
    if (candidates.indexOf(p) < 0) candidates.push(p)
  }

  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch {}
  }
  return process.execPath
}

/**
 * 浏览器信任栅栏。
 *
 * 不用 ctx.get('connection').requestRejection —— 实测在 desktop profile 下
 * 那条路会把已注册的路由全打成 401。改成和 dsh-purge-community 同样的做法：
 * 自己检查 sec-fetch-site / origin / host，只拦跨站请求。
 *
 *   - sec-fetch-site === 'cross-site'  → 拒绝
 *   - origin === 'null'                → 拒绝（沙箱 iframe / file://）
 *   - 无 origin（同源导航、curl、手机扫码直接打开）→ 放行
 *   - 有 origin 但 host 不匹配         → 拒绝
 */
/**
 * 请求准入检查。
 *
 * 历史：这里原本很严 —— `Origin: null` 直接拒、`sec-fetch-site: cross-site` 直接拒。
 * 目的是防 CSRF：别让随便一个网页就能调起投屏。
 *
 * 但 DSH 侧边栏的 iframe 恰好落在这两个条件里：
 *   - 沙箱 iframe 的 Origin 头就是字符串 "null"
 *   - 从宿主页面发起的子请求常被标成 cross-site
 * 结果 PC 端扫码页的「刷新二维码」按钮点了毫无反应 ——
 * 请求被 403 挡掉，前端只看到 fetch 失败，界面上什么都不会变。
 *
 * 现在的判断改成看**实际来源**而不是浏览器给的这些可能失真的标签：
 *   1. 明确拒绝真正的外部站点（有 Origin 且 host 对不上）
 *   2. 放行 Origin 为 null / 缺失的情况 —— 这只可能是本地文件或沙箱 iframe，
 *      远程站点伪造不出 "null" 这个受浏览器管控的头值
 *
 * 强约束仍在：本服务只绑 127.0.0.1，外网根本连不上。
 */
function allowRequest(req) {
  const h = (name) => String((req.headers && req.headers[name]) || '')

  /**
   * 明确的外部来源才拒绝。
   *
   * 注意不能只凭 sec-fetch-site 判断：DSH 侧边栏 iframe 会带
   * cross-site，但它确实是本地页面。这里改为「有 Origin 且 host 不匹配才拒」。
   */
  const origin = h('origin').trim()
  if (origin && origin !== 'null') {
    let originHost = ''
    try { originHost = new URL(origin).host } catch { return false }
    const host = h('host').trim()
    // 有 host 就要求同 host；没有 host（极少见）就放行
    if (host && originHost.toLowerCase() !== host.toLowerCase()) return false
  }

  // Origin 为 null 或缺失：本地文件 / 沙箱 iframe / 同源导航，放行
  return true
}

function resolveWebServer(ctx) {
  const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (viaGet) return viaGet
  return ctx.webServer
}

function hasRoutes(server) {
  return !!server && typeof server.register === 'function'
}

/**
 * 统一的 JSON 响应。
 *
 * CORS 必须带上，原因：
 * 扫码页会被 DSH 侧边栏以 iframe 形式加载。iframe 的 origin 有两种可能 ——
 * 要么跟宿主同源（此时 CORS 无所谓），要么被沙箱化成 null / 别的端口。
 * 后者的情况下 fetch('/dsh-miniwin/wifi-state') 会因为缺
 * Access-Control-Allow-Origin 被浏览器直接掐掉，表现就是
 * 「点刷新按钮完全没反应，控制台也不弹错」—— 排查起来极其费劲。
 *
 * 这服务只监听 127.0.0.1，且全部是投屏状态/二维码这类非敏感数据，
 * 放开 * 是合适的。顺便允许 OPTIONS 预检。
 */
function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Content-Length': String(body.length)
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve(null)
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 取本机所有非回环 IPv4，并按「手机能不能连上」排好序。
 *
 * 实测这台机器上有 7 个网卡，其中：
 *   - FlClash (198.18.0.1)        → TUN 虚拟网卡，手机绝对连不上
 *   - 10.8.0.75 本地连接           → VPN 虚拟网卡
 *   - 172.21.64.1 / 172.25.16.1   → Hyper-V / WSL 虚拟交换机
 *   - 169.254.x                    → APIPA（没拿到 DHCP）
 *   - 以太网 2 (192.168.172.122)   → 虚拟网卡（MACVTAP），不一定通
 *   - WLAN (172.31.100.174)       → 真网卡，手机就在这个网段 ← 要选这个
 *
 * 所以不能只排除 127.x，必须按网卡名 + 网段双重过滤。
 */
const VIRTUAL_IFACE = /flclash|vEthernet|WSL|Hyper-V|Npcap|Loopback|TAP|TUN|VMware|VirtualBox|docker|br-|veth/i
const VIRTUAL_NET = [
  /^198\.18\./,      // FlClash fake-ip
  /^169\.254\./,     // APIPA
  /^10\.8\./,        // 常见 VPN
  /^100\.64\./       // CGNAT（Tailscale 等）
]

function scoreAddr(name, address) {
  let s = 0
  // 真无线 / 真有线优先
  if (/^WLAN|^Wi-?Fi|Wireless/i.test(name)) s += 100
  else if (/^以太网|^Ethernet|^本地连接(?!\*)/i.test(name)) s += 60
  // 虚拟网卡降权
  if (VIRTUAL_IFACE.test(name)) s -= 100
  for (const re of VIRTUAL_NET) if (re.test(address)) s -= 80
  // 家用/办公常见私网段加分
  if (/^192\.168\./.test(address)) s += 30
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 25
  if (/^10\./.test(address)) s += 10
  return s
}

async function localAddrs() {
  const os = await import('node:os')
  const out = []
  const nets = os.networkInterfaces()
  for (const [name, list] of Object.entries(nets)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('127.')) continue
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        score: scoreAddr(name, a.address)
      })
    }
  }
  // 分高的排前面；同分保持系统顺序
  out.sort((x, y) => y.score - x.score)
  return out
}

/* ==========================================================================
   LAN 配对服务器
   --------------------------------------------------------------------------
   DSH 自己的 webServer 绑死在 127.0.0.1（见 host.cordis.patch.yml 的
   `host: 127.0.0.1`），手机永远连不上。所以扫码配对页必须自己起一个
   监听 0.0.0.0 的独立 HTTP 服务。

   这个服务只做两件事：
     GET  /            → 手机配对页
     POST /pair        → 收配对码，转给 host 侧逻辑
     POST /connect     → 直连
     POST /launch      → 起迷你窗
     GET  /state       → 手机看进度

   安全：只允许局域网访问，且绑定随机高端口 + 一次性 token 前缀。
   ========================================================================== */
let lanServer = null
let lanPort = 0
let lanToken = ''

async function startLanServer(onPair, onConnect, onLaunch, getState) {
  if (lanServer) return { port: lanPort, token: lanToken, existing: true }

  // 这是 ESM 模块（package.json 里 "type":"module"），不能用 require，必须动态 import。
  // 之前写 require 导致 apply 里 Promise 静默 reject，lanPort 一直是 0。
  const http = await import('node:http')
  const crypto = await import('node:crypto')
  lanToken = crypto.randomBytes(6).toString('hex')

  lanServer = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://x')
    const path = u.pathname

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    const json = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(b.length) }, cors))
      res.end(b)
    }

    // 只接受带 token 的 /t/<token>/... 路径，防止同网段别人乱调
    let routePath = path
    const m = path.match(/^\/t\/([a-f0-9]+)(\/.*)$/)
    if (m) {
      if (m[1] !== lanToken) { json(403, { ok: false, error: 'bad token' }); return }
      routePath = m[2]
    } else if (path !== '/' && path !== '/pair' && path !== '/connect' && path !== '/launch' && path !== '/state') {
      json(404, { ok: false, error: 'not found' })
      return
    }

    const readJson = () => new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => { size += c.length; if (size > 65536) { req.destroy(); return } chunks.push(c) })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })

    try {
      if (req.method === 'GET' && (routePath === '/' || routePath === '/m')) {
        const b = Buffer.from(MOBILE_PAGE, 'utf8')
        res.writeHead(200, Object.assign({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(b.length)
        }, cors))
        res.end(b)
        return
      }

      /**
       * 能力探测页。
       * 用途：确认这台手机的浏览器到底能不能自己抓屏推流。
       * 如果能 → 完全不需要 adb，不用插线，不用 adb tcpip。
       */
      if (req.method === 'GET' && routePath === '/probe') {
        const b = Buffer.from(PROBE_PAGE, 'utf8')
        res.writeHead(200, Object.assign({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(b.length)
        }, cors))
        res.end(b)
        return
      }

      if (req.method === 'POST' && routePath === '/probe') {
        const body = await readJson()
        probeResult = body
        pushLog('info', '手机探测结果: ' + JSON.stringify(body).slice(0, 300))
        json(200, { ok: true })
        return
      }

      if (req.method === 'GET' && routePath === '/probe-result') {
        json(200, { ok: true, result: probeResult })
        return
      }

      /**
       * APK 下载。手机浏览器直接下载安装（需要允许未知来源）。
       * App 是唯一能拿到 MediaProjection 权限的途径 ——
       * 华为浏览器不支持 getDisplayMedia，这条路是纯 WiFi 的唯一解。
       *
       * ── 为什么同时支持 HEAD ──
       *
       * 之前只认 GET。华为浏览器、夸克、系统下载器在真正下载前
       * 大多会先发一个 HEAD 探大小 —— 那个请求回了 404，下载器就直接
       * 判定「文件不存在」，用户看到的是「下载失败」，连进度条都没有。
       * 而 curl / 浏览器地址栏直接访问又是好的，所以这个坑很容易漏。
       *
       * HEAD 只回头不回体（Content-Length 照给），语义上完全够用。
       */
      if ((req.method === 'GET' || req.method === 'HEAD') && routePath === '/app.apk') {
        try {
          const fs = await import('node:fs')
          const apkPath = path.join(runtimeRoot(), 'apk', 'miniwin.apk')
          const stat = fs.statSync(apkPath)
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Length': String(stat.size),
            'Content-Disposition': 'attachment; filename="miniwin.apk"',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          })
          if (req.method === 'HEAD') { res.end(); return }
          const stream = fs.createReadStream(apkPath)
          stream.on('error', () => { try { res.destroy() } catch {} })
          stream.pipe(res)
        } catch (e) {
          json(500, { ok: false, error: String((e && e.message) || e) })
        }
        return
      }

      /**
       * 生成 miniwin://stream?host=x&port=y 深链。
       * 手机装好 App 后扫这个码 → 直接拉起 App 并填好地址。
       */
      if (req.method === 'GET' && routePath === '/deep-link') {
        const addrs = await localAddrs()
        const pick = addrs[0]
        if (!pick || !lanInfo.port) {
          json(503, { ok: false, error: 'LAN 服务未就绪' })
          return
        }
        // 接收端端口：LAN 端口 + 1，固定约定，App 直接推流到这里
        const recvPort = lanInfo.port + 1
        const link = 'miniwin://stream?host=' + pick.address + '&port=' + recvPort + '&maxSize=' + ENCODE_MAX_SIZE
        json(200, { ok: true, link, host: pick.address, port: recvPort })
        return
      }

      if (req.method === 'GET' && routePath === '/state') {
        json(200, { ok: true, state: getState() })
        return
      }
      if (req.method === 'POST' && routePath === '/pair') {
        const body = await readJson()
        json(200, await onPair(body))
        return
      }
      if (req.method === 'POST' && routePath === '/connect') {
        const body = await readJson()
        json(200, await onConnect(body))
        return
      }
      if (req.method === 'POST' && routePath === '/launch') {
        const body = await readJson()
        json(200, await onLaunch(body))
        return
      }
      json(404, { ok: false, error: 'not found' })
    } catch (e) {
      json(500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  return new Promise((resolve, reject) => {
    /**
     * 优先绑固定端口（43100 起），被占用时往后挪，全占满才交回系统随机。
     *
     * 绑 0.0.0.0 才能让手机访问。固定端口的意义：
     * 手机上保存的地址、已经印出来的二维码不会因为重启 PC 就作废。
     *
     * 注意：这里不能用「全局 once('error') 直接 reject」的写法。
     * EADDRINUSE 是预期内的情况（要重试下一个端口），
     * 一旦外层 reject 掉，lanServer 被置 null，重试就没意义了。
     * 所以错误处理必须放在 tryListen 内部，按端口逐个吃掉。
     */
    let attempt = 0
    const tryListen = () => {
      const port = attempt === 0 ? PREF_LAN_PORT
        : (attempt <= 10 ? PREF_LAN_PORT + attempt : 0)
      attempt++

      const onErr = (e) => {
        lanServer.removeListener('listening', onOk)
        if (e && e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
          lanServer = null
          reject(e)
          return
        }
        if (attempt > 12) { lanServer = null; reject(new Error('LAN 端口全部占用')); return }
        // EADDRINUSE：直接对同一个 server 再 listen 下一个端口即可
        setTimeout(tryListen, 30)
      }
      const onOk = () => {
        lanServer.removeListener('error', onErr)
        lanPort = lanServer.address().port
        resolve({ port: lanPort, token: lanToken })
      }
      lanServer.once('error', onErr)
      lanServer.once('listening', onOk)
      try { lanServer.listen(port, '0.0.0.0') } catch (e) { onErr(e) }
    }
    tryListen()
  })
}

function stopLanServer() {
  if (!lanServer) return
  try { lanServer.close() } catch {}
  lanServer = null
  lanPort = 0
}

/* ==========================================================================
   扫码页 HTML
   --------------------------------------------------------------------------
   这页是用户真正盯着看的东西，所以单独做了一版，不再用「白卡片 + 一行字」。

   几个刻意的设计决定：
   - 深色底 + 两团柔和径向光晕：屏幕在暗环境下不刺眼，二维码对比度反而更高。
   - 二维码放大到 clamp(220px, 44vh, 320px)：手机隔着 50cm 也能一次对上，
     之前 212px 在高分屏上偏小。
   - 状态是**实时**的：每 1.2 秒轮询 /wifi-state，连上了立刻变绿并显示分辨率。
     用户不用猜「到底扫没扫上」，这是「扫码没反应」体验的一半。
   - 刷新按钮不是装饰：DSH 重启、换网卡、IP 变了，点一下就能拿到新码，
     不用去侧边栏重新点一遍 WiFi 投屏。
   ========================================================================== */
function scanPageHtml(link, svg, host) {
  const safeLink = String(link || '').replace(/[<>&"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
  ))
  const safeHost = String(host || '').replace(/[<>&"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
  ))
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫码投屏 · MiniWin</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    background:#07080b;color:#e8eaf1;
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;
    padding:32px 20px;overflow-y:auto;
    -webkit-font-smoothing:antialiased;
  }
  /* 两团柔光，给纯黑底一点空间感 */
  body::before,body::after{
    content:"";position:fixed;pointer-events:none;border-radius:50%;
    filter:blur(90px);opacity:.5;z-index:0;
  }
  body::before{width:520px;height:520px;top:-220px;left:50%;transform:translateX(-50%);
    background:radial-gradient(circle,rgba(74,144,248,.42),transparent 70%)}
  body::after{width:420px;height:420px;bottom:-200px;right:-120px;
    background:radial-gradient(circle,rgba(124,92,255,.28),transparent 70%)}

  .wrap{position:relative;z-index:1;width:100%;max-width:480px;
    display:flex;flex-direction:column;align-items:center;gap:22px}

  .eyebrow{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
    color:#5d6780;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

  h1{font-size:24px;font-weight:700;letter-spacing:-.02em;text-align:center;line-height:1.3}
  h1 em{font-style:normal;
    background:linear-gradient(100deg,#7db4ff,#b39bff);
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{font-size:13px;color:#79839b;text-align:center;margin-top:-12px}

  /* 二维码 */
  .qrCard{background:#fff;border-radius:26px;padding:20px;
    box-shadow:0 32px 80px rgba(0,0,0,.62),0 0 0 1px rgba(255,255,255,.06);
    transition:transform .18s ease,box-shadow .18s ease}
  .qrCard:hover{transform:translateY(-2px);
    box-shadow:0 38px 90px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.09)}
  .qrCard svg{display:block;width:clamp(220px,44vh,320px);height:auto;
    image-rendering:pixelated;border-radius:6px}

  /* 实时状态 */
  .status{display:inline-flex;align-items:center;gap:8px;
    padding:7px 15px 7px 12px;border-radius:999px;font-size:13px;
    background:#11141c;border:1px solid #1d2230;color:#8b94aa;
    transition:background .25s,border-color .25s,color .25s}
  .status .dot{width:8px;height:8px;border-radius:50%;background:#4a5368;
    transition:background .25s,box-shadow .25s}
  .status.wait .dot{background:#e0a33a;box-shadow:0 0 0 0 rgba(224,163,58,.55);
    animation:pulse 1.8s infinite}
  .status.on{background:rgba(38,201,122,.1);border-color:rgba(38,201,122,.34);color:#5fd99b}
  .status.on .dot{background:#26c97a;box-shadow:0 0 10px rgba(38,201,122,.85)}
  .status.off{background:rgba(224,90,90,.09);border-color:rgba(224,90,90,.3);color:#e88a8a}
  .status.off .dot{background:#e05a5a}
  @keyframes pulse{
    0%{box-shadow:0 0 0 0 rgba(224,163,58,.5)}
    70%{box-shadow:0 0 0 8px rgba(224,163,58,0)}
    100%{box-shadow:0 0 0 0 rgba(224,163,58,0)}
  }

  /* 深链 */
  .linkChip{width:100%;display:flex;align-items:center;gap:8px;
    background:#0e1119;border:1px solid #191e2b;border-radius:13px;
    padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:11px;color:#6c7793}
  .linkChip code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    user-select:all;color:#8a94ad}
  .linkChip button{flex:0 0 auto;background:#1a2030;color:#9aa6c4;border:0;
    border-radius:8px;padding:5px 10px;font-size:11px;cursor:pointer;
    font-family:inherit;transition:background .15s,color .15s}
  .linkChip button:hover{background:#232b3f;color:#cfd8ee}

  /* 按钮 */
  .btns{display:flex;gap:10px;width:100%}
  .btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;
    height:42px;border:0;border-radius:12px;font-size:13.5px;font-weight:600;
    font-family:inherit;cursor:pointer;transition:transform .12s,background .15s,box-shadow .15s}
  .btn:active{transform:scale(.98)}
  .btn.pri{background:linear-gradient(180deg,#4f8ff5,#3a72e0);color:#fff;
    box-shadow:0 6px 18px rgba(58,114,224,.35)}
  .btn.pri:hover{background:linear-gradient(180deg,#5c99f8,#4479e6)}
  .btn.ghost{flex:0 0 auto;padding:0 16px;background:#12161f;color:#94a0bb;
    border:1px solid #1e2431}
  .btn.ghost:hover{background:#181e2a;color:#c3cde4}

  /* 步骤 */
  .steps{width:100%;display:flex;flex-direction:column;gap:9px;margin-top:2px}
  .step{display:flex;align-items:center;gap:10px;font-size:13px;color:#8791a8}
  .step b{color:#dfe5f3;font-weight:600}
  .n{flex:0 0 auto;width:21px;height:21px;border-radius:7px;display:grid;place-items:center;
    font-size:11px;font-weight:700;background:rgba(74,144,248,.15);color:#8fbaff;
    box-shadow:inset 0 0 0 1px rgba(74,144,248,.26)}

  .foot{font-size:11.5px;color:#4e5668;text-align:center;line-height:1.9}
  .foot b{color:#6c7793;font-weight:500}

  .toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,20px);
    background:#1b2233;color:#dfe6f6;font-size:12.5px;padding:9px 16px;border-radius:10px;
    border:1px solid #283046;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:9}
  .toast.show{opacity:1;transform:translate(-50%,0)}
</style>
</head><body>
<div class="wrap">
  <div class="eyebrow">MiniWin 投屏</div>
  <h1>手机扫这个<em>码</em></h1>
  <div class="sub">画面直接投到桌面透明小窗，不进浏览器</div>

  <div class="qrCard" id="qrCard">${svg || '<div style="width:clamp(220px,44vh,320px);height:clamp(220px,44vh,320px);display:grid;place-items:center;color:#999;font-size:13px">暂无地址</div>'}</div>

  <div class="status wait" id="st"><span class="dot"></span><span id="stText">等待手机连接…</span></div>

  <div class="linkChip">
    <code id="linkText">${safeLink}</code>
    <button id="copyBtn" type="button">复制</button>
  </div>

  <div class="btns">
    <button class="btn pri" id="refreshBtn" type="button">刷新二维码</button>
    <button class="btn ghost" id="reopenBtn" type="button">重开窗口</button>
  </div>

  <div class="steps">
    <div class="step"><span class="n">1</span><span>手机打开 <b>MiniWin 投屏</b> App</span></div>
    <div class="step"><span class="n">2</span><span>点 <b>扫码连接</b>，对准上面的码</span></div>
    <div class="step"><span class="n">3</span><span>弹窗点 <b>立即开始</b>，小窗就出来了</span></div>
  </div>

  <div class="foot">
    当前电脑地址 <b>${safeHost || '未获取'}</b><br>
    扫不出来就把手机靠近屏幕、调亮显示器，或点「刷新二维码」
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
(function () {
  var st = document.getElementById('st')
  var stText = document.getElementById('stText')
  var qrCard = document.getElementById('qrCard')
  var linkText = document.getElementById('linkText')
  var toastEl = document.getElementById('toast')
  var lastLink = linkText.textContent.trim()
  var timer = null

  function toast(msg) {
    toastEl.textContent = msg
    toastEl.classList.add('show')
    clearTimeout(toastEl._t)
    toastEl._t = setTimeout(function () { toastEl.classList.remove('show') }, 2200)
  }

  function setStatus(kind, text) {
    st.className = 'status ' + kind
    stText.textContent = text
  }

  /**
   * 统一的请求封装。
   *
   * 关键点：失败必须 throw，让调用方能显示原因。
   * 之前直接链 .then(r => r.json())，403 / 网络错误都会被吞成
   * 「点了没反应」—— 用户完全无从判断发生了什么。
   *
   * base 固定取 location.origin：页面由本服务自己提供，
   * 用绝对地址可以避开 iframe 里相对路径解析到别的 origin 的坑。
   */
  var BASE = location.origin
  function api(path, opts) {
    return fetch(BASE + path, Object.assign({ cache: 'no-store' }, opts || {}))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
  }

  function poll() {
    api('/dsh-miniwin/wifi-state')
      .then(function (j) {
        if (!j || !j.ok) { setStatus('off', '状态读取失败'); return }

        // 地址变了（换网卡 / 重启后 IP 变了）→ 自动换码，不用用户手动点
        if (j.link && j.link !== lastLink) {
          lastLink = j.link
          linkText.textContent = j.link
          refreshQr(j.link, true)
        }

        if (j.connected) {
          var size = j.videoSize ? (j.videoSize.w + '×' + j.videoSize.h) : ''
          setStatus('on', '已连接' + (size ? ' · ' + size : '') + ' · ' + j.frames + ' 帧')
        } else if (j.recvAlive) {
          setStatus('wait', '等待手机连接…')
        } else {
          setStatus('off', '接收端未运行，点「重开窗口」')
        }
      })
      .catch(function (e) { setStatus('off', '无法连接本地服务 (' + e.message + ')') })
  }

  function refreshQr(link, silent) {
    if (!link) { if (!silent) toast('还没有可用地址'); return }
    api('/dsh-miniwin/qr?text=' + encodeURIComponent(link))
      .then(function (j) {
        if (j && j.svg) {
          qrCard.innerHTML = j.svg
          linkText.textContent = link
          lastLink = link
          if (!silent) toast('二维码已刷新')
        } else if (!silent) toast('二维码生成失败：' + ((j && j.error) || '未知'))
      })
      .catch(function (e) { if (!silent) toast('二维码生成失败 (' + e.message + ')') })
  }

  document.getElementById('refreshBtn').addEventListener('click', function () {
    var btn = this
    btn.disabled = true
    btn.textContent = '刷新中…'
    api('/dsh-miniwin/wifi-state')
      .then(function (j) {
        if (j && j.link) { refreshQr(j.link, false); poll() }
        else toast('拿不到地址：' + ((j && j.error) || '接收端未运行'))
      })
      .catch(function (e) { toast('刷新失败 (' + e.message + ')') })
      .then(function () { btn.disabled = false; btn.textContent = '刷新二维码' })
  })

  document.getElementById('reopenBtn').addEventListener('click', function () {
    var btn = this
    btn.disabled = true
    btn.textContent = '启动中…'
    api('/dsh-miniwin/wifi-start', { method: 'POST' })
      .then(function (j) {
        if (j && j.ok) { toast('窗口已重新打开'); refreshQr(j.link, true); poll() }
        else toast('启动失败：' + ((j && j.error) || '未知'))
      })
      .catch(function (e) { toast('启动失败 (' + e.message + ')') })
      .then(function () { btn.disabled = false; btn.textContent = '重开窗口' })
  })

  document.getElementById('copyBtn').addEventListener('click', function () {
    var t = linkText.textContent.trim()
    if (!t) return
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast('已复制') },
        function () { toast('复制失败，请手动选中') })
    } else {
      toast('请手动选中复制')
    }
  })

  poll()
  timer = setInterval(poll, 1200)
  window.addEventListener('beforeunload', function () { clearInterval(timer) })
})()
</script>
</body></html>`
}


let routeInvoker = null   // 由 apply() 赋值：(method, path, body) => Promise<object>

function invokeRoute(method, path, body) {
  if (!routeInvoker) return Promise.resolve({ ok: false, error: 'invoker 未就绪' })
  return routeInvoker(method, path, body)
}

function apply(ctx) {
  const webServer = resolveWebServer(ctx)
  if (!hasRoutes(webServer)) {
    try {
      ctx.logger?.warn?.('[dsh-miniwin] 当前 profile 没有 webServer，跳过路由注册')
    } catch {}
    return
  }

  const disposers = []
  /**
   * 注册一条路由。
   *
   * 实测：DSH webServer 的 register 只认 `{ kind:'exact', path, handler }`，
   * **没有 `method` 字段**。带 method 的对象注册后路由不可达（实测 401）。
   * 正确做法和 dsh-purge-community 一致：一个 path 一个 handler，
   * 内部自己按 request.method 分流。
   */
  const routeMap = new Map()

  function route(method, path, handler) {
    let entry = routeMap.get(path)
    if (!entry) {
      entry = { handlers: {} }
      routeMap.set(path, entry)

      const wrapped = {
        kind: 'exact',
        path,
        handler: async (req, res) => {
          const m = String(req.method || 'GET').toUpperCase()

          // 预检：必须在准入检查之前答掉。
          // 浏览器发 OPTIONS 时不会带 Cookie，也可能带 Origin: null，
          // 如果先做 allowRequest 就会 403，连预检都过不去。
          if (m === 'OPTIONS') {
            try {
              res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Private-Network': 'true',
                'Access-Control-Max-Age': '600'
              })
              res.end()
            } catch {}
            return
          }

          if (!allowRequest(req)) {
            // 被拒时也要给 CORS 头，否则前端只会看到「网络错误」，
            // 完全不知道是权限问题 —— 这是「点按钮没反应」的另一半原因。
            try { sendJson(res, 403, { ok: false, error: 'forbidden' }) } catch {}
            return
          }

          const h = entry.handlers[m] || entry.handlers['*']
          if (!h) {
            try { sendJson(res, 405, { ok: false, error: 'method not allowed' }) } catch {}
            return
          }
          try {
            return await h(req, res)
          } catch (e) {
            try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch {}
          }
        }
      }
      disposers.push(webServer.register(wrapped))
    }
    entry.handlers[method.toUpperCase()] = handler
  }

  /**
   * 内部 invoke：给 LAN 服务器用。
   * 造一对假的 req/res，跑同一份 handler，把 JSON 结果拿回来。
   * 不经过 HTTP，所以没有 origin/host 检查（LAN 服务器自己做 token 校验）。
   */
  routeInvoker = async (method, path, body) => {
    const entry = routeMap.get(path)
    if (!entry) return { ok: false, error: 'no route ' + path }
    const h = entry.handlers[String(method).toUpperCase()]
    if (!h) return { ok: false, error: 'no method ' + method }

    const req = {
      method,
      url: path,
      headers: { host: '127.0.0.1' },
      on(ev, cb) {
        if (ev === 'data' && body) setTimeout(() => cb(Buffer.from(JSON.stringify(body), 'utf8')), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
        return req
      },
      destroy() {}
    }

    let payload = ''
    let code = 200
    const res = {
      statusCode: 200,
      writeHead(c) { code = c; this.statusCode = c; return this },
      end(b) { if (b) payload += b.toString('utf8'); return this },
      setHeader() {}
    }

    await h(req, res)
    try { return JSON.parse(payload) } catch { return { ok: false, error: 'bad response', raw: payload.slice(0, 200), code } }
  }

  /* ---------- 状态 ---------- */
  route('GET', ROUTE_BASE + '/state', async (req, res) => {
      // 记下 DSH 自己的 Host，后面迷你窗要往这回报状态。
      // DSH 端口是随机的，不能用环境变量（可能是旧值）。
      try {
        const host = String(req.headers.host || '')
        if (host) dshHost = 'http://' + host
      } catch {}
      sendJson(res, 200, { ok: true, state })
  })

  /**
   * 探测入口：给出一条手机能打开的 URL，让手机自报「能不能自己抓屏」。
   * 结论决定走哪条路线：
   *   getDisplayMedia 可用 → 纯浏览器推流，零 adb、零插线
   *   不可用 → 仍需 adb（tcpip 或侧载 APK）
   */
  route('GET', ROUTE_BASE + '/probe-url', async (req, res) => {
    const addrs = await localAddrs()
    const pick = addrs[0]
    if (!pick || !lanInfo.port) {
      return sendJson(res, 503, { ok: false, error: 'LAN 服务未就绪' })
    }
    const url = 'http://' + pick.address + ':' + lanInfo.port + '/t/' + lanInfo.token + '/probe'
    sendJson(res, 200, {
      ok: true,
      url,
      address: pick.address,
      port: lanInfo.port,
      token: lanInfo.token
    })
  })

  route('GET', ROUTE_BASE + '/probe-result', async (req, res) => {
    sendJson(res, 200, { ok: true, result: probeResult })
  })

  /**
   * WiFi 模式一键启动：
   *   1. 起接收端（node wifi-receiver.js --lan <lanPort>）
   *   2. 起 WiFi 版迷你窗（--wifi http://127.0.0.1:<recvHttp>）
   *   3. 返回手机要扫的深链
   * 手机装过 APK 后扫这个码 → App 自动填地址 → 点允许 → 画面出现。
   */
  route('POST', ROUTE_BASE + '/wifi-start', async (req, res) => {
    try {
      const { spawn } = await import('node:child_process')
      const m = await loadMiniwin()
      const addrs = await localAddrs()
      const pick = addrs[0]
      if (!pick || !lanInfo.port) {
        return sendJson(res, 503, { ok: false, error: 'LAN 服务未就绪' })
      }
      const recvPort = PREF_RECV_PORT
      const httpPort = PREF_RECV_HTTP_PORT

      // 1. 接收端（已在跑就复用）
      let recvAlive = false
      try {
        const r = await fetch('http://127.0.0.1:' + PREF_RECV_HTTP_PORT + '/meta', { signal: AbortSignal.timeout(1500) })
        if (r.ok) recvAlive = true
      } catch {}
      if (!recvAlive) {
        /**
         * 启动接收端时踩过的两个坑：
         *
         * 1) process.execPath 是 electron.exe，不是 node。
         *    DSH 插件宿主本身跑在 Electron 里，spawn(process.execPath) 会把
         *    它当成一个完整 Electron 应用启动（stderr 里全是
         *    network_change_notifier / gpu_disk_cache 报错），我的脚本根本
         *    不执行 → 端口永远不监听。
         *    必须显式用 DSH runtime 的 node.exe。
         *
         * 2) 必须清掉 ELECTRON_RUN_AS_NODE，否则子进程行为异常。
         */
        const recvEnv = Object.assign({}, process.env)
        delete recvEnv.ELECTRON_RUN_AS_NODE
        const errFile = m.base + '/receiver-stderr.log'
        const outF = await import('node:fs')
        try { outF.writeFileSync(errFile, '') } catch {}
        const errStream = outF.createWriteStream(errFile)
        const nodeBin = await resolveNodeBin()
        pushLog('info', '接收端 node: ' + nodeBin)
        /**
         * 2.0：接收端额外接收 adb 路径与 scrcpy-server jar，
         * 供零 APK 配对页（/pair、/start-zero）使用。
         */
        const adbExe = m.base + '/tools/scrcpy/scrcpy-win64-v5.0.1/adb.exe'
        const srvJar = m.base + '/tools/scrcpy/scrcpy-win64-v5.0.1/scrcpy-server'
        const child = spawn(nodeBin, [
          m.base + '/wifi-receiver.js', String(recvPort), String(httpPort),
          adbExe, srvJar
        ], { cwd: m.base, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: recvEnv })
        child.stderr.pipe(errStream)
        child.unref()
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 300))
          try {
            const r2 = await fetch('http://127.0.0.1:' + httpPort + '/meta', { signal: AbortSignal.timeout(1000) })
            if (r2.ok) { recvAlive = true; break }
          } catch {}
        }
        if (!recvAlive) return sendJson(res, 500, { ok: false, error: '接收端启动失败' })
      }

      // 2. 迷你窗（WiFi 模式），杀旧实例保证可见
      if (session && session.pid) {
        try { process.kill(session.pid, 'SIGTERM') } catch {}
        await new Promise(r => setTimeout(r, 700))
        try { process.kill(session.pid, 0); process.kill(session.pid, 'SIGKILL') } catch {}
        session = null
      }
      const electron = resolveElectron()
      const env = Object.assign({}, process.env)
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(electron, [
        m.base + '/main.js',
        '--wifi', 'http://127.0.0.1:' + httpPort
      ], { cwd: m.base, detached: true, stdio: 'ignore', env })
      child.unref()
      session = { pid: child.pid, startedAt: Date.now() }
      pushLog('ok', 'WiFi 模式迷你窗已启动 (pid=' + child.pid + ')')

      sendJson(res, 200, {
        ok: true,
        pid: child.pid,
        link: 'miniwin://stream?host=' + pick.address + '&port=' + recvPort + '&maxSize=' + ENCODE_MAX_SIZE,
        host: pick.address,
        port: recvPort,
        /**
         * 2.0：扫码页地址。二维码现在编码这个 URL —— 手机扫码打开
         * 配对页（双端零安装），不再直接弹 App 深链。
         * 配对页由接收端 /pair 提供（同一 HTTP 服务，端口 httpPort+1
         * 的局域网转发由 LAN server 处理不了，所以配对页挂在
         * 接收端 HTTP 上，需把该端口暴露到局域网）。
         */
        pairUrl: 'http://' + pick.address + ':' + httpPort + '/pair',
        apkUrl: 'http://' + pick.address + ':' + lanInfo.port + '/t/' + lanInfo.token + '/app.apk'
      })
    } catch (e) {
      pushLog('error', 'wifi-start 异常: ' + String((e && e.stack) || e).slice(0, 400))
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  /* ---------- 本机地址（给 PC 端生成二维码用） ---------- */
  route('GET', ROUTE_BASE + '/addrs', async (req, res) => {
      const addrs = await localAddrs()
      // 端口：从当前请求的 Host 头里取，最准
      let port = 0
      try {
        const host = String(req.headers.host || '')
        const m = host.match(/:(\d+)$/)
        if (m) port = Number(m[1])
      } catch {}
      if (!port) {
        const env = process.env.DSH_WEB_URL || process.env.DSH_WEB_PORT
        if (env) {
          const m2 = String(env).match(/:(\d+)/)
          if (m2) port = Number(m2[1])
        }
      }
      // lanPort 是手机真正能连的端口（0.0.0.0 监听）；
      // port 是 DSH webServer 的端口，只给 127.0.0.1 用，手机连不上。
      sendJson(res, 200, {
        ok: true,
        addrs,
        port,
        lanPort: lanInfo.port,
        lanToken: lanInfo.token
      })
  })

  /* ---------- 生成二维码 SVG（Host 侧算好，前端直接插） ---------- */
  route('GET', ROUTE_BASE + '/qr', async (req, res) => {
      let text = ''
      try {
        const u = new URL(req.url, 'http://x')
        text = u.searchParams.get('text') || ''
      } catch {}
      if (!text) return sendJson(res, 400, { ok: false, error: '缺 text' })
      if (text.length > 400) return sendJson(res, 400, { ok: false, error: '内容过长' })
      try {
        const { qrSvg } = await import('./qr.js')
        const svg = qrSvg(text, { level: 'M', scale: 6, margin: 3, dark: '#000', light: '#fff' })
        sendJson(res, 200, { ok: true, svg, text })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e.message || e) })
      }
  })

  /* ---------- WiFi 实时状态（扫码页轮询用） ---------- */
  route('GET', ROUTE_BASE + '/wifi-state', async (req, res) => {
    try {
      const addrs = await localAddrs()
      const pick = addrs[0]
      const recvPort = PREF_RECV_PORT
      const link = pick
        ? 'miniwin://stream?host=' + pick.address + '&port=' + recvPort + '&maxSize=' + ENCODE_MAX_SIZE
        : ''
      let meta = null
      try {
        const r = await fetch('http://127.0.0.1:' + PREF_RECV_HTTP_PORT + '/meta',
          { signal: AbortSignal.timeout(1200) })
        if (r.ok) meta = await r.json()
      } catch {}
      sendJson(res, 200, {
        ok: true,
        link,
        host: pick ? pick.address : '',
        recvPort,
        recvAlive: !!meta,
        connected: !!(meta && meta.connected),
        frames: (meta && meta.frames) || 0,
        videoSize: (meta && meta.videoSize) || null,
        codecString: (meta && meta.codecString) || null,
        lanPort: lanInfo.port,
        lanToken: lanInfo.token,
        apkUrl: pick ? 'http://' + pick.address + ':' + lanInfo.port + '/t/' + lanInfo.token + '/app.apk' : ''
      })
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
    }
  })

  /* ---------- 扫码页（自包含，每次请求实时生成二维码） ---------- */
  route('GET', ROUTE_BASE + '/scan-page', async (req, res) => {
    try {
      const addrs = await localAddrs()
      const pick = addrs[0]
      const link = pick
        ? 'miniwin://stream?host=' + pick.address + '&port=' + PREF_RECV_PORT + '&maxSize=' + ENCODE_MAX_SIZE
        : ''
      const { qrSvg } = await import('./qr.js')
      const svg = link ? qrSvg(link, { level: 'M', scale: 8, margin: 2, dark: '#0a0b0f', light: '#ffffff' }) : ''
      const html = scanPageHtml(link, svg, pick ? pick.address : '')
      const buf = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store'
      })
      res.end(buf)
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  /* ---------- 设备列表 ---------- */
  route('GET', ROUTE_BASE + '/devices', async (req, res) => {
      try {
        const m = await loadMiniwin()
        const adb = new m.device.Adb(adbPath())
        const devices = await adb.devices()
        sendJson(res, 200, { ok: true, devices, adb: adbPath() })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e.message || e) })
      }
  })

  /* ---------- 手机扫码后调用的配对接口 ---------- */
  route('POST', ROUTE_BASE + '/pair', async (req, res) => {
      const body = await readBody(req)
      if (!body || !body.addr) return sendJson(res, 400, { ok: false, error: '缺 addr' })
      const addr = String(body.addr).trim()
      const code = String(body.code || '').trim()

      state.phase = 'pairing'
      state.message = `配对 ${addr}`
      pushLog('info', `开始配对 ${addr}`)

      try {
        const m = await loadMiniwin()
        const adb = new m.device.Adb(adbPath())
        const { execFile } = await import('node:child_process')
        const run = (args) => new Promise((resolve, reject) => {
          execFile(adbPath(), args, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { stdout, stderr }))
            resolve({ stdout, stderr })
          })
        })

        const r1 = await run(['pair', addr, code])
        pushLog('ok', '配对返回: ' + (r1.stdout + r1.stderr).trim())

        // 配对成功后，连接端口通常和配对端口不同。
        // 从 mdns 里找，找不到就要求用户提供。
        state.phase = 'connecting'
        let connAddr = body.connAddr ? String(body.connAddr).trim() : null

        if (!connAddr) {
          try {
            const r2 = await run(['mdns', 'services'])
            const line = (r2.stdout || '').split('\n').find(l => /_adb-tls-connect/.test(l))
            if (line) {
              const m2 = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/)
              if (m2) connAddr = m2[1] + ':' + m2[2]
            }
          } catch {}
        }

        if (!connAddr) {
          state.phase = 'error'
          state.message = '配对成功，但拿不到连接端口。请在手机的「无线调试」页面看「IP 地址和端口」，填到连接地址。'
          pushLog('warn', state.message)
          return sendJson(res, 200, { ok: true, needConnAddr: true, message: state.message })
        }

        const r3 = await run(['connect', connAddr])
        const msg3 = (r3.stdout + r3.stderr).trim()
        pushLog(/connected to/i.test(msg3) ? 'ok' : 'warn', '连接: ' + msg3)

        const devices = await adb.devices()
        const hit = devices.find(d => d.state === 'device')
        if (!hit) {
          state.phase = 'error'
          state.message = '连接失败: ' + msg3
          return sendJson(res, 200, { ok: false, error: state.message, devices })
        }

        state.phase = 'idle'
        state.device = hit
        state.message = '已连接 ' + (hit.model || hit.serial)
        pushLog('ok', state.message)
        sendJson(res, 200, { ok: true, device: hit, connAddr, devices })
      } catch (e) {
        state.phase = 'error'
        state.message = String(e.message || e)
        pushLog('error', state.message)
        sendJson(res, 200, { ok: false, error: state.message, stderr: e.stderr && String(e.stderr).slice(0, 500) })
      }
  })

  /* ---------- 连接已有设备（不需配对，5555 直连） ---------- */
  route('POST', ROUTE_BASE + '/connect', async (req, res) => {
      const body = await readBody(req)
      const addr = body && body.addr ? String(body.addr).trim() : ''
      if (!addr) return sendJson(res, 400, { ok: false, error: '缺 addr' })
      try {
        const { execFile } = await import('node:child_process')
        const run = (args) => new Promise((resolve, reject) => {
          execFile(adbPath(), args, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { stdout, stderr }))
            resolve({ stdout, stderr })
          })
        })
        const r = await run(['connect', addr])
        const msg = (r.stdout + r.stderr).trim()
        pushLog(/connected to/i.test(msg) ? 'ok' : 'warn', msg)
        const m = await loadMiniwin()
        const adb = new m.device.Adb(adbPath())
        const devices = await adb.devices()
        const hit = devices.find(d => d.state === 'device')
        if (hit) { state.device = hit; state.phase = 'idle'; state.message = '已连接 ' + (hit.model || hit.serial) }
        sendJson(res, 200, { ok: !!hit, message: msg, devices, device: hit || null })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e.message || e) })
      }
  })

  /* ---------- 触发投屏（画面进桌面迷你窗，不进浏览器） ---------- */
  route('POST', ROUTE_BASE + '/launch', async (req, res) => {
      const body = await readBody(req)
      const serial = body && body.serial ? String(body.serial).trim() : ''
      try {
        const { spawn } = await import('node:child_process')
        const m = await loadMiniwin()
        const electron = resolveElectron()
        const args = [m.base + '/main.js']
        if (serial) args.push('--serial', serial)
        args.push('--auto')
        // 让迷你窗把状态回传，侧边栏面板能看到实时状态
        // DSH 端口随机，必须用实际请求到的 Host，不能用环境变量
        let reportBase = dshHost
        if (!reportBase) {
          try {
            const host = String(req.headers.host || '')
            if (host) reportBase = 'http://' + host
          } catch {}
        }
        if (!reportBase && process.env.DSH_WEB_URL) reportBase = process.env.DSH_WEB_URL
        if (reportBase) {
          args.push('--report', reportBase + '/dsh-miniwin/report')
        }

        /**
         * 复用前必须验活，而且要验「它是不是连的当前 DSH」。
         *
         * 踩过坑：DSH 重启后插件模块重新加载，session 残留了上一个 DSH 实例
         * 起的迷你窗 pid。进程本身还活着（孤儿），但它连的是旧端口，状态推不
         * 回来；更糟的是它可能被缩成 180×360 贴在屏幕角落，用户点「启动迷你窗」
         * 完全没有反应感。
         *
         * 所以：pid 活着也一律重启，保证窗口是新建的、可见的、连当前 DSH。
         *
         * ── v2：改为「不杀，交给单实例锁」──
         *
         * 迷你窗侧加了 requestSingleInstanceLock：新进程拿不到锁会立刻
         * 退出，并把 second-instance 交给已经在跑的那个 —— 那个实例
         * 自己亮窗口 + 重连一次，正好等于「重开迷你窗」的语义。
         *
         * 这里主动 kill 反而有害：杀掉旧进程等于把锁释放给新进程，
         * 结果还是两个窗口（而且中间那段黑屏更明显）。
         * 现在只探活 + 记录，不杀。
         */
        const prev = session
        if (session && session.pid) {
          let alive = true
          try { process.kill(session.pid, 0) } catch { alive = false }
          if (!alive) {
            session = null
          } else {
            session.procAlive = true
            pushLog('info', '已有迷你窗在跑：本次只让它重连，不再开新窗')
          }
        }

        const child = spawn(electron, args, {
          cwd: m.base,
          detached: true,
          stdio: 'ignore',
          env: (() => {
            // 必须把 ELECTRON_RUN_AS_NODE 这个 key 整个删掉。
            // 设为空字符串不行 —— Electron 判断的是"是否存在"，
            // 一旦存在 electron.exe 就以纯 Node 模式启动，
            // 此时 require('electron') 拿到的是 npm 包导出的路径字符串，
            // ipcMain / BrowserWindow 全是 undefined。
            const e = Object.assign({}, process.env)
            delete e.ELECTRON_RUN_AS_NODE
            return e
          })()
        })
        child.unref()
        /**
         * 复用时**不能**把 session 改写成这个新 pid。
         *
         * 新进程会立刻退出（拿不到单实例锁），如果 session 记的是它，
         * 下一个 tick 就判成「迷你窗已死」，面板跟着掉成 idle ——
         * 而用户屏幕上那个窗口其实一直在正常投屏。
         *
         * 所以：复用时保留旧 session（真实在跑的那个 pid 由 second-instance
         * 事件驱动重连），只用新进程的退出事件做一次「已转交」日志。
         */
        const reused = !!(prev && prev.procAlive)
        if (!reused) session = { pid: child.pid, startedAt: Date.now() }
        child.on('exit', () => {
          /**
           * 单实例下「新进程秒退」是正常现象，不是崩溃。
           *
           * 迷你窗已经在跑时，第二个进程拿不到锁就会立刻退出，
           * 事件转给在跑的那个去重连。这种情况不能把状态打成 idle ——
           * 否则面板会在画面正常时闪一下「未连接」。
           */
          if (reused) {
            pushLog('info', '新进程已把重连请求交给运行中的迷你窗')
            return
          }
          pushLog('warn', '迷你窗进程退出')
          session = null
          state.phase = 'idle'
        })

        state.phase = 'streaming'
        state.since = Date.now()
        state.error = ''
        pushLog('ok', reused
          ? '已通知运行中的迷你窗重连'
          : '迷你窗已启动 (pid=' + child.pid + ')')
        sendJson(res, 200, { ok: true, pid: reused ? prev.pid : child.pid, reused })
      } catch (e) {
        state.phase = 'error'
        state.message = String(e.message || e)
        pushLog('error', state.message)
        sendJson(res, 200, { ok: false, error: state.message })
      }
  })

  /* ---------- 状态回写（迷你窗进程上报） ---------- */
  route('POST', ROUTE_BASE + '/report', async (req, res) => {
      const body = await readBody(req)
      if (body) {
        if (body.phase) state.phase = body.phase
        if (body.videoSize) state.videoSize = body.videoSize
        if (body.stats) state.stats = body.stats
        /**
         * error / hint 必须单独接住。
         *
         * 以前只认 message，于是迷你窗那边推上来的
         * `{ phase:'error', error:'...' }` 到了面板就只剩一个红点 ——
         * 用户看到「连不上」，但看不到为什么。等待手机上线可能长达
         * 三分钟，这段时间的 hint 也要显示出来，否则界面是死的。
         */
        if (body.error) { state.error = body.error; state.message = body.error }
        if (body.hint) state.message = body.hint
        if (body.message && !body.error && !body.hint) { state.message = body.message; pushLog(body.level || 'info', body.message) }
        if (body.error) pushLog('error', body.error)
        if (body.hint) pushLog('info', body.hint)
        if (body.device) state.device = body.device
        if (body.log) pushLog(body.level || 'info', body.log)
      }
      sendJson(res, 200, { ok: true })
  })

  /* ---------- 手机扫码落地页（极简配对页，纯 HTML） ---------- */
  route('GET', ROUTE_BASE + '/m', async (req, res) => {
      const body = Buffer.from(MOBILE_PAGE, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length)
      })
      res.end(body)
  })

  /* ======================================================================
     零输入自动连接
     ----------------------------------------------------------------------
     用户只需要扫码打开页面，剩下的全自动：
       1. 已连着？直接用
       2. mDNS 广播里找无线调试端口
       3. 扫网段 5555（tcpip 遗留）
       4. 都没有 → 告诉用户去开无线调试（点一下重试）
       5. 开了但还是连不上 → 只差配对码，那时才让用户填 6 位数字
     ====================================================================== */

  /** 记住最近一次发现的配对地址，供 /pair-auto 用 */
  let lastPairingAddr = ''
  let lastDiscovered = null

  route('GET', ROUTE_BASE + '/auto', async (req, res) => {
    try {
      const { autoDiscover } = await import('./discover.js')
      const adb = adbPath()

      // 上次连过且还活着的地址
      const saved = state.device && state.device.serial ? [state.device.serial] : []

      const r = await autoDiscover(adb, {
        saved,
        onProgress: (msg) => pushLog('info', msg)
      })
      lastDiscovered = r

      if (r.found) {
        // 拿设备型号，给页面显示
        let model = ''
        try {
          const { Adb } = await loadMiniwin().then(m => m.device)
          const a = new Adb(adb)
          a.serial = r.serial
          const p = await a.props()
          model = p.model || ''
        } catch {}

        state.phase = 'idle'
        state.device = { serial: r.serial, model, transport: r.via }
        state.message = '已连接 ' + (model || r.serial)
        pushLog('ok', `自动发现成功（${r.via}）: ${r.serial}`)
        return sendJson(res, 200, {
          ok: true,
          serial: r.serial,
          model,
          via: r.via,
          tcpipEnabled: !!r.tcpipEnabled,
          // 走 WiFi 连上的话，USB 线可以拔了
          canUnplug: /:\d+$/.test(r.serial)
        })
      }

      // 有配对端口 = 手机开了无线调试，只差配对
      const pairingCand = (r.candidates || []).find(c => c.needPair)
      if (pairingCand) {
        lastPairingAddr = pairingCand.serial
        pushLog('info', '发现配对端口，等待配对码: ' + lastPairingAddr)
        return sendJson(res, 200, {
          ok: false,
          needPair: true,
          pairingAddr: lastPairingAddr,
          message: '手机已开启无线调试，只差配对码'
        })
      }

      pushLog('warn', '自动发现失败：没找到可连接的手机')
      sendJson(res, 200, {
        ok: false,
        needSetup: true,
        needUsb: !r.usbSerial,
        tcpipEnabled: !!r.tcpipEnabled,
        usbSeen: !!r.usbSerial,
        // 华为/鸿蒙的开发者选项里没有「无线调试」（华为官方文档确认），
        // 所以提示必须引导用户插线，而不是让他去找一个不存在的开关。
        message: r.usbSerial
          ? '已尝试开启无线通道但没找到手机。请确认手机和电脑连的是同一个 WiFi。'
          : '请用数据线连一下手机（只需一次）。',
        candidates: r.candidates,
        mdns: r.mdns && r.mdns.raw
      })
    } catch (e) {
      pushLog('error', '自动发现异常: ' + ((e && e.message) || e))
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
    }
  })

  /** 用户只填配对码，地址从 mDNS 自动取 */
  route('POST', ROUTE_BASE + '/pair-auto', async (req, res) => {
    const body = await readBody(req)
    const code = String((body && body.code) || '').trim()
    if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { ok: false, error: '配对码是 6 位数字' })

    try {
      const { discoverByMdns } = await import('./discover.js')
      const adb = adbPath()

      // 重新查一次配对地址（用户可能刚点了「使用配对码配对设备」）
      let pairingAddr = lastPairingAddr
      const mdns = await discoverByMdns(adb)
      if (mdns.pairing) pairingAddr = mdns.pairing

      if (!pairingAddr) {
        return sendJson(res, 200, {
          ok: false,
          error: '没找到配对地址。请确认手机停在「使用配对码配对设备」弹窗上，然后重试。'
        })
      }

      pushLog('info', `配对 ${pairingAddr} code=${code}`)

      // 走已有的 /pair 逻辑
      const r = await invokeRoute('POST', ROUTE_BASE + '/pair', {
        addr: pairingAddr,
        code,
        connAddr: null   // 让它自己去 mDNS 找连接端口
      })

      if (!r || !r.ok) {
        return sendJson(res, 200, {
          ok: false,
          error: (r && (r.error || r.message)) || '配对失败，配对码可能过期了'
        })
      }

      // 补设备型号
      let model = ''
      try {
        const { Adb } = await loadMiniwin().then(m => m.device)
        const a = new Adb(adb)
        a.serial = r.device.serial
        const p = await a.props()
        model = p.model || ''
      } catch {}

      sendJson(res, 200, {
        ok: true,
        serial: r.device.serial,
        model,
        via: 'pair'
      })
    } catch (e) {
      pushLog('error', '配对异常: ' + ((e && e.message) || e))
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
    }
  })

  /* ---------- 起 LAN 配对服务器（手机只能访问这个） ---------- */
  // DSH 的 webServer 绑在 127.0.0.1，手机连不上；这个监听 0.0.0.0 独立端口。
  // 逻辑不重复实现：直接把请求转成内部 invoke 打到上面已注册的 handler。
  ;(async () => {
    try {
      const r = await startLanServer(
        (body) => invokeRoute('POST', ROUTE_BASE + '/pair', body),
        (body) => invokeRoute('POST', ROUTE_BASE + '/connect', body),
        (body) => invokeRoute('POST', ROUTE_BASE + '/launch', body),
        () => state
      )
      lanInfo.port = r.port
      lanInfo.token = r.token
      pushLog('ok', `LAN 配对服务已启动，端口 ${r.port}`)
    } catch (e) {
      pushLog('warn', 'LAN 配对服务启动失败: ' + ((e && e.message) || e))
    }
  })()

  ctx.effect(() => () => {
    for (const d of disposers) { try { d() } catch {} }
    stopLanServer()
    if (session && session.pid) {
      try { process.kill(session.pid) } catch {}
    }
  })
}

function adbPath() {
  if (process.env.MINIWIN_ADB) return process.env.MINIWIN_ADB
  try {
    return path.join(runtimeRoot(), 'tools', 'scrcpy', 'scrcpy-win64-v5.0.1', 'adb.exe')
  } catch {
    // 运行时没就位时不要让设备发现直接崩，退回 PATH 里的 adb
    return 'adb'
  }
}

/** 手机能力探测页 —— 用来确认浏览器能否直接抓屏推流 */
const PROBE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0b0f">
<title>能力探测</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{
  margin:0;min-height:100dvh;padding:20px 18px calc(24px + env(safe-area-inset-bottom));
  background:#0a0b0f;color:#e9ebf2;
  font:15px/1.6 -apple-system,"PingFang SC","HarmonyOS Sans SC",system-ui,sans-serif;
}
h1{font-size:20px;margin:0 0 6px;font-weight:660;letter-spacing:-.02em}
.sub{color:#6b7288;font-size:13px;margin:0 0 20px}
.row{
  display:flex;align-items:flex-start;gap:10px;
  padding:11px 13px;margin-bottom:8px;border-radius:11px;
  background:#14161d;border:1px solid #252935;
}
.ok{border-color:rgba(61,220,132,.35);background:rgba(61,220,132,.07)}
.no{border-color:rgba(255,93,85,.3);background:rgba(255,93,85,.06)}
.dot{
  width:9px;height:9px;border-radius:50%;flex:0 0 auto;margin-top:7px;
  background:#4a5060;
}
.ok .dot{background:#3ddc84;box-shadow:0 0 8px #3ddc84}
.no .dot{background:#ff5d55}
.name{font-size:14px;font-weight:560;display:block}
.detail{font-size:12px;color:#8b91a4;font-family:ui-monospace,Consolas,monospace;
  word-break:break-all;line-height:1.55;margin-top:2px;display:block}
.try{
  width:100%;padding:15px;margin-top:16px;border:0;border-radius:13px;
  background:linear-gradient(178deg,#6aa8ff,#2b6fe0);color:#fff;
  font:inherit;font-size:15px;font-weight:620;
}
.try:active{transform:scale(.98)}
.try:disabled{opacity:.4}
#out{
  margin-top:16px;padding:14px;border-radius:11px;
  background:#14161d;border:1px solid #252935;
  font:11px/1.55 ui-monospace,Consolas,monospace;color:#9aa2b8;
  white-space:pre-wrap;word-break:break-all;max-height:40vh;overflow:auto;
}
#preview{width:100%;border-radius:11px;margin-top:14px;display:none;border:1px solid #252935}
</style>
</head>
<body>
<h1>手机能力探测</h1>
<p class="sub">看看这台手机能不能直接把屏幕推给电脑</p>

<div id="list"></div>

<button class="try" id="btn">试一下抓屏幕</button>
<video id="preview" playsinline muted></video>
<div id="out"></div>

<script>
var $ = function(id){ return document.getElementById(id) }
var out = $('out')
var log = []
function add(s){
  log.push(s)
  out.textContent = log.join('\\n')
}
function post(path, body){
  return fetch(path, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body || {})
  }).then(function(r){ return r.json() }).catch(function(e){ return {err: String(e)} })
}

/* ── 逐项探测 ── */
var checks = []
function push(name, pass, detail){
  checks.push({name:name, pass:pass, detail:detail})
}

// 1. getDisplayMedia
var hasGDM = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
push('getDisplayMedia', hasGDM,
  hasGDM ? '存在（还需实测能否真的弹出选择框）' : '不存在 —— 浏览器不支持网页抓屏')

// 2. getSupportedConstraints
var s = navigator.mediaDevices && navigator.mediaDevices.getSupportedConstraints
  ? navigator.mediaDevices.getSupportedConstraints() : {}
push('displaySurface 约束', !!s.displaySurface, s.displaySurface ? '支持' : '不支持')

// 3. MediaRecorder
push('MediaRecorder', typeof MediaRecorder !== 'undefined',
  typeof MediaRecorder !== 'undefined' ? '支持' : '不支持')

// 4. 可用的 H.264 编码
var h264 = ''
if (typeof MediaRecorder !== 'undefined'){
  ['video/mp4;codecs=avc1.42E01E','video/webm;codecs=avc1.42E01E',
   'video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'].forEach(function(t){
    if (MediaRecorder.isTypeSupported(t) && !h264) h264 = t
  })
}
push('可录制格式', !!h264, h264 || '无可用格式')

// 5. WebSocket
push('WebSocket', typeof WebSocket !== 'undefined', typeof WebSocket !== 'undefined' ? '支持' : '不支持')

// 6. WebCodecs VideoEncoder
push('WebCodecs VideoEncoder', typeof VideoEncoder !== 'undefined',
  typeof VideoEncoder !== 'undefined' ? '支持（可硬编 H.264）' : '不支持')

// 7. UA
add('UA: ' + navigator.userAgent)
add('屏幕: ' + screen.width + '×' + screen.height + ' @' + (window.devicePixelRatio||1) + 'x')
add('')

checks.forEach(function(c){
  var d = document.createElement('div')
  d.className = 'row ' + (c.pass ? 'ok' : 'no')
  d.innerHTML = '<span class="dot"></span><span style="flex:1;min-width:0">' +
    '<span class="name">' + c.name + '</span>' +
    '<span class="detail">' + c.detail + '</span></span>'
  $('list').appendChild(d)
  add((c.pass ? 'PASS ' : 'FAIL ') + c.name + ': ' + c.detail)
})

// 把探测结果回传 PC
post('probe', {
  ua: navigator.userAgent,
  checks: checks,
  screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
  formats: h264
}).then(function(r){ add('\\n回传 PC: ' + JSON.stringify(r)) })

/* ── 实测 getDisplayMedia ── */
$('btn').onclick = async function(){
  this.disabled = true
  this.textContent = '正在请求…'
  add('\\n--- 尝试 getDisplayMedia ---')
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
      add('浏览器没有 getDisplayMedia')
      post('probe', {gdmError: 'not-supported'})
      this.textContent = '不支持'
      return
    }
    var stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: false
    })
    var track = stream.getVideoTracks()[0]
    var st = track.getSettings()
    add('成功！')
    add('  分辨率: ' + st.width + '×' + st.height)
    add('  帧率: ' + st.frameRate)
    add('  displaySurface: ' + (st.displaySurface || '未知'))

    var v = $('preview')
    v.style.display = 'block'
    v.srcObject = stream
    v.play().catch(function(){})

    post('probe', {
      gdmOk: true,
      settings: { w: st.width, h: st.height, fps: st.frameRate, surface: st.displaySurface },
      format: h264
    })
    this.textContent = '抓屏成功 ✓'
  } catch (e) {
    add('失败: ' + e.name + ' — ' + e.message)
    post('probe', { gdmError: e.name + ': ' + e.message })
    this.textContent = '失败: ' + e.name
  }
}
</script>
</body>
</html>
`

/**
 * 手机扫完二维码看到的页面 —— 零输入版本
 * 设计目标：单手可操作、信息密度低、状态一眼看懂
 */
const MOBILE_PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0b0f">
<title>手机投屏</title>
<style>
:root{
  color-scheme:dark;
  --bg:#0a0b0f; --card:#14161d; --card2:#1b1e27;
  --line:#252935; --line2:#2f3444;
  --txt:#e9ebf2; --txt2:#9aa2b8; --txt3:#6b7288;
  --blue:#4a90f8; --blue2:#6aa8ff;
  --green:#3ddc84; --red:#ff5d55; --amber:#f0b429;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100dvh;
  background:radial-gradient(120% 60% at 50% 0%,#141a28 0%,var(--bg) 55%);
  color:var(--txt);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC",
    "Microsoft YaHei",system-ui,sans-serif;
  display:flex;flex-direction:column;
  padding:calc(24px + env(safe-area-inset-top)) 22px calc(28px + env(safe-area-inset-bottom));
  -webkit-font-smoothing:antialiased;
}

/* ── 顶部品牌 ── */
.brand{display:flex;align-items:center;gap:11px;margin-bottom:32px}
.brand .mark{
  width:38px;height:38px;border-radius:11px;flex:0 0 auto;
  display:grid;place-items:center;
  background:linear-gradient(158deg,var(--blue2),#2b6fe0);
  box-shadow:0 6px 18px rgba(47,111,216,.35);
}
.brand .mark svg{width:19px;height:19px;fill:none;stroke:#fff;
  stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.brand .txt b{display:block;font-size:16px;font-weight:650;letter-spacing:-.01em;line-height:1.3}
.brand .txt span{font-size:11px;color:var(--txt3);letter-spacing:.08em;text-transform:uppercase}

/* ── 舞台 ── */
.stage{display:none;flex:1;flex-direction:column}
.stage.on{display:flex}

/* ── 大标题 ── */
.hero h1{
  margin:0 0 10px;font-size:34px;line-height:1.15;
  font-weight:680;letter-spacing:-.028em;
}
.hero h1 em{font-style:normal;color:var(--blue2)}
.hero p{margin:0;color:var(--txt2);font-size:14px;line-height:1.7}

/* ── 转圈 ── */
.spinner{
  width:42px;height:42px;margin:0 0 26px;border-radius:50%;
  border:2.5px solid rgba(74,144,248,.16);border-top-color:var(--blue);
  animation:spin .85s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── 进度步骤 ── */
.steps{list-style:none;margin:32px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.steps li{
  display:flex;align-items:center;gap:13px;
  padding:11px 0;font-size:14px;color:var(--txt3);
  transition:color .28s;
}
.steps li .ico{
  width:22px;height:22px;border-radius:50%;flex:0 0 auto;
  border:1.5px solid currentColor;opacity:.4;
  display:grid;place-items:center;transition:all .28s;
}
.steps li .ico svg{width:11px;height:11px;fill:none;stroke:currentColor;
  stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;opacity:0}
.steps li.on{color:var(--txt)}
.steps li.on .ico{opacity:1;border-color:var(--blue);color:var(--blue);
  box-shadow:0 0 0 4px rgba(74,144,248,.1)}
.steps li.done{color:var(--green)}
.steps li.done .ico{opacity:1;border-color:var(--green);background:var(--green)}
.steps li.done .ico svg{stroke:#0a0b0f;opacity:1}

/* ── 结果卡 ── */
.result{text-align:center;padding-top:8px}
.result .badge{
  width:76px;height:76px;border-radius:50%;margin:0 auto 24px;
  display:grid;place-items:center;
}
.result .badge svg{width:34px;height:34px;fill:none;stroke-width:2.6;
  stroke-linecap:round;stroke-linejoin:round}
.result.ok .badge{background:rgba(61,220,132,.1);border:2px solid rgba(61,220,132,.35)}
.result.ok .badge svg{stroke:var(--green)}
.result.err .badge{background:rgba(255,93,85,.1);border:2px solid rgba(255,93,85,.35)}
.result.err .badge svg{stroke:var(--red)}
.result h2{margin:0 0 10px;font-size:23px;font-weight:660;letter-spacing:-.02em}
.result p{margin:0;color:var(--txt2);font-size:14px;line-height:1.75}
.result .device{
  display:inline-flex;align-items:center;gap:8px;margin-top:20px;
  padding:8px 16px;border-radius:99px;
  background:var(--card);border:1px solid var(--line);
  font-size:13px;color:var(--txt2);
}
.result .device i{width:7px;height:7px;border-radius:50%;background:var(--green);
  box-shadow:0 0 8px var(--green);flex:0 0 auto}

/* ── 底部操作区 ── */
.actions{margin-top:auto;padding-top:28px;display:flex;flex-direction:column;gap:10px}
button{
  width:100%;padding:16px;border-radius:14px;border:0;
  font:inherit;font-size:15.5px;font-weight:620;letter-spacing:.01em;
  cursor:pointer;transition:transform .12s,opacity .2s;
}
button:active{transform:scale(.978)}
button:disabled{opacity:.45}
button.primary{
  background:linear-gradient(178deg,var(--blue2),#2b6fe0);color:#fff;
  box-shadow:0 8px 24px rgba(47,111,216,.32);
}
button.ghost{
  background:var(--card);border:1px solid var(--line);
  color:var(--txt2);font-weight:520;font-size:14.5px;padding:14px;
}

/* ── 提示卡 ── */
.tip{
  margin-top:26px;padding:16px 18px;border-radius:14px;
  background:var(--card);border:1px solid var(--line);
  font-size:13px;line-height:1.8;color:var(--txt3);
}
.tip b{color:var(--txt);font-weight:620}
.tip ol{margin:10px 0 0;padding-left:19px}
.tip li{margin:5px 0}
.tip.warn{background:rgba(240,180,41,.07);border-color:rgba(240,180,41,.22);color:#c9a961}
.tip.warn b{color:#f0c674}

/* ── 配对码输入 ── */
.codeWrap{margin:28px 0 0}
.codeWrap input{
  width:100%;padding:18px;border-radius:14px;
  border:1.5px solid var(--line);background:var(--card);
  color:var(--txt);font:inherit;font-size:28px;font-weight:620;
  letter-spacing:.4em;text-align:center;
  font-variant-numeric:tabular-nums;outline:none;
  transition:border-color .18s;
}
.codeWrap input::placeholder{
  font-size:15px;font-weight:400;letter-spacing:.02em;color:var(--txt3);
}
.codeWrap input:focus{border-color:var(--blue)}

.hide{display:none!important}
</style></head>
<body>

<div class="brand">
  <div class="mark">
    <svg viewBox="0 0 24 24">
      <rect x="6" y="2" width="12" height="20" rx="2.5"/>
      <path d="M11 18.5h2"/>
    </svg>
  </div>
  <div class="txt"><b>手机投屏</b><span>to desktop</span></div>
</div>

<!-- ══ 1. 自动连接中 ══ -->
<div class="stage on" id="sScan">
  <div class="hero">
    <div class="spinner"></div>
    <h1>正在连你的<em>电脑</em></h1>
    <p>不用填任何东西，几秒就好</p>
  </div>
  <ul class="steps" id="stepList">
    <li data-k="lan"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg></span><span>连接局域网</span></li>
    <li data-k="find"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg></span><span>查找设备</span></li>
    <li data-k="link"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg></span><span>建立连接</span></li>
    <li data-k="open"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg></span><span>打开桌面窗口</span></li>
  </ul>
  <div id="wxTip" class="tip warn hide">
    <b>微信里可能连不上</b>
    <ol>
      <li>点右上角「···」</li>
      <li>选「<b>在浏览器打开</b>」</li>
      <li>回来点下面的重试</li>
    </ol>
  </div>
  <div class="actions">
    <button class="ghost hide" id="btnWxRetry">已在浏览器打开，重试</button>
  </div>
</div>

<!-- ══ 2. 成功 ══ -->
<div class="stage" id="sOk">
  <div class="result ok">
    <div class="badge"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg></div>
    <h2>连上了</h2>
    <p>电脑桌面上已经弹出迷你窗<br>这个页面可以关掉了</p>
    <div class="device" id="okDev" style="display:none"><i></i><span></span></div>
  </div>
  <div id="unplugTip" class="tip hide">
    <b>USB 线可以拔了</b><br>
    以后直接扫码就能连，不用再插线。
  </div>
  <div class="actions">
    <button class="ghost" id="btnAgain">再来一次</button>
  </div>
</div>

<!-- ══ 3. 需要插线 ══ -->
<div class="stage" id="sNeed">
  <div class="result err">
    <div class="badge"><svg viewBox="0 0 24 24">
      <path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/>
    </svg></div>
    <h2>还差一步</h2>
    <p>需要先用数据线连一次电脑</p>
  </div>
  <div class="tip">
    <b>插一次线就好，之后不用再插：</b>
    <ol>
      <li>数据线连电脑</li>
      <li>手机上点「<b>允许 USB 调试</b>」</li>
      <li>回来点下面的按钮</li>
    </ol>
  </div>
  <div class="actions">
    <button class="primary" id="btnRetry">插好了，重新连接</button>
  </div>
</div>

<!-- ══ 4. 需要配对码 ══ -->
<div class="stage" id="sPair">
  <div class="result">
    <div class="badge" style="background:rgba(74,144,248,.1);border:2px solid rgba(74,144,248,.35)">
      <svg viewBox="0 0 24 24" style="stroke:var(--blue)">
        <rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/>
        <path d="M7.5 10.5V7a4.5 4.5 0 019 0v3.5"/>
      </svg>
    </div>
    <h2>输入配对码</h2>
    <p>手机弹窗里那 6 位数字</p>
  </div>
  <div class="codeWrap">
    <input id="code" inputmode="numeric" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code">
  </div>
  <div class="tip">
    地址已经自动获取，<b>只要填配对码</b>。
  </div>
  <div class="actions">
    <button class="primary" id="btnPair">连接</button>
  </div>
</div>

<script>
var API = (function(){
  var m = location.pathname.match(/^(\\/t\\/[a-f0-9]+)\\//)
  return m ? m[1] : ''
})()
var $ = function(id){ return document.getElementById(id) }

function show(name){
  ['sScan','sOk','sNeed','sPair'].forEach(function(k){
    $(k).classList.toggle('on', k === name)
  })
}

function mark(k, st){
  var li = document.querySelector('#stepList li[data-k="' + k + '"]')
  if(li) li.className = st || ''
}
function allDone(){
  ;['lan','find','link','open'].forEach(function(k){ mark(k,'done') })
}

function api(path, body){
  return fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'Content-Type':'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function(r){ return r.json() })
}

var pendingPair = ''

async function boot(){
  show('sScan')
  mark('lan','done')
  mark('find','on')

  var j
  try {
    j = await api('/auto')
  } catch(e){
    mark('find','')
    return show('sNeed')
  }

  if(!j || !j.ok){
    mark('find','')
    if(j && j.needPair){
      pendingPair = j.pairingAddr || ''
      return show('sPair')
    }
    return show('sNeed')
  }

  mark('find','done')
  mark('link','done')
  mark('open','on')

  try { await api('/launch', { serial: j.serial }) } catch(e){}
  mark('open','done')
  allDone()

  var dev = $('okDev')
  if(j.model || j.serial){
    dev.style.display = 'inline-flex'
    dev.querySelector('span').textContent = (j.model || j.serial) + (j.canUnplug ? ' · 无线' : '')
  }
  if(j.canUnplug) $('unplugTip').classList.remove('hide')
  setTimeout(function(){ show('sOk') }, 380)
}

var IS_WECHAT = /MicroMessenger/i.test(navigator.userAgent)
if(IS_WECHAT){
  $('wxTip').classList.remove('hide')
  $('btnWxRetry').classList.remove('hide')
}

$('btnWxRetry').onclick = boot
$('btnRetry').onclick = boot
$('btnAgain').onclick = boot

$('btnPair').onclick = async function(){
  var code = ($('code').value || '').replace(/\\D/g,'')
  if(code.length !== 6){ $('code').focus(); return }
  this.disabled = true
  this.textContent = '连接中…'

  try {
    var j = await api('/pair-auto', { code: code })
    if(!j || !j.ok){
      this.disabled = false
      this.textContent = '重试'
      alert((j && j.error) || '配对失败，配对码可能过期了，回手机上重新要一个')
      return
    }
    allDone()
    await api('/launch', { serial: j.serial }).catch(function(){})
    var dev = $('okDev')
    if(j.model || j.serial){
      dev.style.display = 'inline-flex'
      dev.querySelector('span').textContent = j.model || j.serial
    }
    show('sOk')
  } catch(e){
    this.disabled = false
    this.textContent = '重试'
    alert('网络错误：' + e.message)
  }
}

$('code').addEventListener('input', function(){
  this.value = this.value.replace(/\\D/g,'')
})

boot()
</script>
</body></html>`

const name = 'dsh-miniwin'

export { apply, inject, name }


