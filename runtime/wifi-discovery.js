'use strict'
/**
 * 纯 WiFi 快速连接：局域网自动发现手机。
 *
 * 三条线索，按可靠性排序：
 *   1. 上次连成功的地址（缓存，毫秒级）
 *   2. adb mDNS（`adb mdns services`，Android 11+ 无线调试会广播）
 *   3. 端口扫描：对本机每个网卡的 /24 扫 5555（经典 `adb tcpip 5555`）
 *
 * 只做 TCP connect 探测，不发送任何应用层数据；扫描并发 96、超时 260ms，
 * 一个 /24 约 1 秒扫完，不会把路由器的 ARP 表打爆。
 */
const net = require('net')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const CACHE_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'miniwin-stream')
const CACHE_FILE = path.join(CACHE_DIR, 'wifi-cache.json')

function run (file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') })
    })
  })
}

/**
 * 本机所有可用于局域网通信的 IPv4 /24 网段。
 *
 * ── 必须只留私有网段 ──
 *
 * 实测这台机器上有个虚拟网卡拿到了 28.0.0.x 这种**公网地址**，
 * 旧代码把它也当 /24 扫了 —— adb 里于是多出
 * `28.0.0.254:5555 offline` 这种垃圾条目，把「有没有设备」的判断
 * 搅乱，还白扫 256 个陌生地址。
 *
 * 现在只认 RFC1918（10/8、172.16/12、192.168/16），虚拟网卡一律跳过，
 * WLAN 排在最前。
 */
const VIRTUAL_IF = /vEthernet|VMware|VirtualBox|WSL|Hyper-V|Loopback|Npcap|TAP|TUN|Clash|代理|虚拟/i
const WIFI_IF = /WLAN|Wi-Fi|无线/i
const ETH_IF = /^(以太网|Ethernet|Local Area)/i

function isPrivateIPv4 (ip) {
  return /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
}

function localSubnets () {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_IF.test(name)) continue
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (/^169\.254\./.test(a.address)) continue
      if (!isPrivateIPv4(a.address)) continue
      const base = a.address.split('.').slice(0, 3).join('.')
      const score = WIFI_IF.test(name) ? 100 : (ETH_IF.test(name) ? 50 : 10)
      out.push({ iface: name, address: a.address, base, score })
    }
  }
  out.sort((x, y) => y.score - x.score)
  return out
}

function probe (host, port, timeout = 260) {
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve(ok ? { host, port, ms: Date.now() - started } : null)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    try { sock.connect(port, host) } catch { finish(false) }
  })
}

/** 并发扫描一个网段的指定端口，返回命中列表 */
async function scanSubnet (base, port = 5555, { concurrency = 96, timeout = 260 } = {}) {
  const hosts = []
  for (let i = 1; i <= 254; i++) hosts.push(`${base}.${i}`)
  const hits = []
  let idx = 0
  const worker = async () => {
    while (idx < hosts.length) {
      const host = hosts[idx++]
      const r = await probe(host, port, timeout)
      if (r) hits.push(r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker))
  return hits.sort((a, b) => a.ms - b.ms)
}

/** `adb mdns services` 里能直接拿到 IP:端口（Android 11+ 无线调试） */
async function mdnsDevices (adbPath) {
  if (!adbPath) return []
  const { out } = await run(adbPath, ['mdns', 'services'], 6000)
  const found = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/)
    if (m) found.push({ host: m[1], port: Number(m[2]), from: 'mdns' })
  }
  return found
}

function readCache () {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (j && typeof j.host === 'string' && j.port) return j
  } catch {}
  return null
}

function writeCache (host, port) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ host, port, at: Date.now() }, null, 2))
  } catch {}
}

/** 发现候选设备 */
async function discover ({ adbPath, port = 5555, timeout = 260 } = {}) {
  const t0 = Date.now()
  const subnets = localSubnets()
  const seen = new Set()
  const candidates = []
  const add = (host, p, from, extra = {}) => {
    const key = `${host}:${p}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ host, port: p, from, ...extra })
  }

  const cached = readCache()
  if (cached) add(cached.host, cached.port, 'cache')

  // mDNS 和端口扫描并行跑：adb mdns 首次调用要 ~1s，串行会把冷启动拖长
  const mdnsPromise = mdnsDevices(adbPath)

  /**
   * 网段按优先级逐个扫，命中即停。
   * 之前是所有网段并行扫完再合并（约 3.3s），而实际手机在 WLAN 段，
   * 第一个网段就开始命中，后面那些（以太网/虚拟网卡）纯属浪费时间。
   */
  for (const s of subnets) {
    const hits = await scanSubnet(s.base, port, { timeout })
    if (!hits.length) continue
    hits.forEach(h => add(h.host, h.port, 'scan', { ms: h.ms }))
    break
  }

  ;(await mdnsPromise).forEach(d => add(d.host, d.port, 'mdns'))

  return { candidates, took: Date.now() - t0, subnets, scannedPorts: [port] }
}

/**
 * 连上之后记住它，下次毫秒级复用。
 *
 * 注意：`adb connect` 对「端口开着但不是 adb」的服务有时也回 connected，
 * 随后 devices 里是 offline。所以连完必须用 get-state 复核，
 * 只有 state=device 才算成功，否则会把无效地址写进缓存。
 */
async function connect (adbPath, host, port = 5555, timeout = 12000) {
  const target = `${host}:${port}`
  const { out, err } = await run(adbPath, ['connect', target], timeout)
  const msg = (out + err).trim()
  if (!/connected to/i.test(msg) || /failed|cannot|refused/i.test(msg)) {
    return { ok: false, target, message: msg || '连接失败' }
  }
  const st = await run(adbPath, ['-s', target, 'get-state'], 6000)
  const state = (st.out + st.err).trim()
  if (!/^device$/m.test(state)) {
    await run(adbPath, ['disconnect', target], 5000)
    return { ok: false, target, message: `端口可达但不是可用 adb 设备（state=${state || 'unknown'}）` }
  }
  writeCache(host, port)
  return { ok: true, target, message: msg, state }
}

/** 一键快速连接：缓存直连 → 失败才做 mDNS+扫描 */
async function quickConnect ({ adbPath, port = 5555 } = {}) {
  const t0 = Date.now()

  // 快速路径：上次连成功的地址，直接连，省掉整个网段扫描
  const cached = readCache()
  if (cached) {
    const r = await connect(adbPath, cached.host, cached.port)
    if (r.ok) {
      return {
        ok: true,
        target: r.target,
        via: 'cache',
        fast: true,
        took: Date.now() - t0,
        tried: [{ host: cached.host, port: cached.port, from: 'cache', ok: true, message: r.message }],
        candidates: [{ host: cached.host, port: cached.port, from: 'cache' }]
      }
    }
  }

  const found = await discover({ adbPath, port })
  const tried = []
  for (const c of found.candidates) {
    const r = await connect(adbPath, c.host, c.port)
    tried.push({ ...c, ok: r.ok, message: r.message })
    if (r.ok) {
      return { ok: true, target: r.target, via: c.from, fast: false, took: Date.now() - t0, tried, candidates: found.candidates }
    }
  }
  return { ok: false, error: '同网段没有找到可连接的手机', took: Date.now() - t0, tried, candidates: found.candidates }
}

module.exports = { discover, connect, quickConnect, localSubnets, probe, scanSubnet, readCache, writeCache, CACHE_FILE }

if (require.main === module) {
  const adbPath = process.argv[2]
  ;(async () => {
    const r = await quickConnect({ adbPath })
    console.log(JSON.stringify(r, null, 2))
  })()
}
