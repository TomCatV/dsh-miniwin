/**
 * 自动发现手机 —— 让用户不用输入任何地址
 * ---------------------------------------------------------------------------
 * 难点：Android 的「无线调试」端口是**随机的**（不是 5555），
 *      配对端口和连接端口还不一样。用户根本不知道填什么。
 *
 * 解法分两层：
 *
 * 1) mDNS 发现（最可靠）
 *    Android 11+ 的无线调试会通过 mDNS 广播两类服务：
 *      _adb-tls-pairing._tcp   配对端口
 *      _adb-tls-connect._tcp   连接端口
 *    用 `adb mdns services` 就能列出来 —— 不用用户做任何事。
 *
 * 2) 端口扫描兜底（mDNS 不通时）
 *    如果手机之前用 `adb tcpip 5555` 开过，那 5555 会一直开着（直到重启）。
 *    扫一遍网段的 5555 就能找到。
 *
 * 都找不到时，才需要用户插手（比如手机没开无线调试）。
 */

import net from 'node:net'
import os from 'node:os'
import { execFile } from 'node:child_process'

/** 跑 adb 命令，返回 stdout+stderr */
function adbRun(adbPath, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(adbPath, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err })
    })
  })
}

/**
 * 用 adb mdns services 列出无线调试服务
 * 输出形如：
 *   adb-XXXXXX-YYYYYY._adb-tls-connect._tcp.   192.168.1.5:37000
 *   adb-XXXXXX-YYYYYY._adb-tls-pairing._tcp.   192.168.1.5:41234
 * @returns {Promise<{connect: string|null, pairing: string|null, raw: string}>}
 */
export async function discoverByMdns(adbPath) {
  const r = await adbRun(adbPath, ['mdns', 'services'], 6000)
  const raw = (r.stdout + r.stderr).trim()
  let connect = null
  let pairing = null

  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/)
    if (!m) continue
    const addr = m[1] + ':' + m[2]
    if (/_adb-tls-connect\._tcp/i.test(line)) connect = addr
    else if (/_adb-tls-pairing\._tcp/i.test(line)) pairing = addr
  }

  return { connect, pairing, raw }
}

/** 探测单个 host:port 是否有 adb 服务在听（TCP 能连上就够了） */
function probe(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    try { sock.connect(port, host) } catch { finish(false) }
  })
}

/** 取本机所有 /24 网段（只取有网关前缀的真实网卡） */
export function localSubnets() {
  const out = []
  const nets = os.networkInterfaces()
  for (const [name, list] of Object.entries(nets)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('127.') || a.address.startsWith('169.254.')) continue
      if (/flclash|vEthernet|WSL|Hyper-V|Npcap|Loopback|TAP|TUN|VMware|VirtualBox|docker/i.test(name)) continue
      const parts = a.address.split('.').map(Number)
      if (parts.length !== 4) continue
      out.push({
        iface: name,
        self: a.address,
        prefix: parts.slice(0, 3).join('.'),
        score: /^WLAN|Wi-?Fi|Wireless/i.test(name) ? 100 : 50
      })
    }
  }
  out.sort((x, y) => y.score - x.score)
  return out
}

/**
 * 扫网段的指定端口，返回所有有响应的 IP
 * 并发 64，单个超时 400ms —— 一个 /24 扫 5555 大约 1.5 秒
 */
export async function scanPort(prefix, port, { concurrency = 64, timeout = 400 } = {}) {
  const found = []
  let next = 1
  const total = 254

  async function worker() {
    for (;;) {
      const i = next++
      if (i > total) return
      const host = prefix + '.' + i
      if (await probe(host, port, timeout)) found.push(host)
    }
  }

  const workers = []
  for (let i = 0; i < concurrency; i++) workers.push(worker())
  await Promise.all(workers)
  return found
}

/**
 * 主入口：尽最大努力找到手机，全程不需要用户输入
 *
 * 顺序（实测 HarmonyOS / EMUI 14.2 后调整）：
 *   1. USB 设备 → 用它开 tcpip 5555（一次性），**不作为最终结果**
 *   2. mDNS 连接端口（原生 Android 11+ 才有；华为没有）
 *   3. 以前连过的地址
 *   4. 扫网段 5555
 *
 * 之所以 USB 不直接返回：USB 传输慢、要一直插线。
 * 正确体验是「插一次线 → 自动切到无线 → 拔线 → 一直无线」。
 *
 * @returns {Promise<{found:boolean, via:string, serial:string|null, candidates:Array, mdns:object, subnets:Array}>}
 */
export async function autoDiscover(adbPath, { saved = [], onProgress = () => {} } = {}) {
  const result = { found: false, via: '', serial: null, candidates: [], mdns: null, subnets: localSubnets() }

  // 1) 已有 adb 设备
  onProgress('检查已连接的设备…')
  const dev = await adbRun(adbPath, ['devices'])
  const usbSerials = []
  for (const line of (dev.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+device$/)
    if (m) usbSerials.push(m[1])
  }

  /**
   * USB 设备不能直接当结果。
   *
   * 原因（实测 HarmonyOS / EMUI 14.2）：
   *   - 这台机器的开发者选项里**没有「无线调试」**（华为官方文档确认：
   *     「华为手机/平板系统开发者选项中没有无线调试开关」）
   *   - `adb mdns services` 永远返回空 —— adbd 不广播 _adb-tls-* 服务
   *   - 唯一可行的无线通道是 `adb tcpip 5555`（service.adb.tcp.port=5555）
   *
   * 所以 USB 在场时的正确动作是：
   *   ① 用 USB 给设备开 tcpip 5555（一次性，永久有效直到重启）
   *   ② 扫网段找到手机的 WiFi 地址
   *   ③ adb connect 走 WiFi，然后就可以拔线了
   * 这样用户后续就是纯无线使用，不用一直插线。
   */
  if (usbSerials.length) {
    const usb = usbSerials[0]
    result.usbSerial = usb
    onProgress('检测到 USB 设备，正在为它开启无线通道…')
    try {
      const t = await adbRun(adbPath, ['-s', usb, 'tcpip', '5555'], 12000)
      const tm = (t.stdout + t.stderr).trim()
      if (/restarting in TCP mode|port:\s*5555/i.test(tm)) {
        result.tcpipEnabled = true
        onProgress('无线通道已开启，正在定位手机地址…')
      } else {
        result.tcpipEnabled = false
        result.tcpipMessage = tm
      }
    } catch (e) {
      result.tcpipEnabled = false
      result.tcpipMessage = String((e && e.message) || e)
    }
  }

  // 2) mDNS
  onProgress('检查无线调试广播…')
  const mdns = await discoverByMdns(adbPath)
  result.mdns = mdns
  if (mdns.connect) {
    onProgress('发现无线调试：' + mdns.connect)
    const c = await adbRun(adbPath, ['connect', mdns.connect], 10000)
    const msg = (c.stdout + c.stderr).trim()
    if (/connected to/i.test(msg)) {
      result.found = true
      result.via = 'mdns'
      result.serial = mdns.connect
      result.candidates.push({ serial: mdns.connect, source: 'mdns-connect' })
      return result
    }
    result.candidates.push({ serial: mdns.connect, source: 'mdns-connect-failed', error: msg })
  }
  if (mdns.pairing) {
    // 有配对端口说明手机开了无线调试但还没配对
    result.candidates.push({ serial: mdns.pairing, source: 'mdns-pairing', needPair: true })
  }

  // 3) 以前连过的
  for (const s of saved) {
    if (!s.includes(':') || s === mdns.connect) continue
    onProgress('尝试上次的地址 ' + s)
    const c = await adbRun(adbPath, ['connect', s], 8000)
    if (/connected to/i.test((c.stdout + c.stderr))) {
      result.found = true
      result.via = 'saved'
      result.serial = s
      result.candidates.push({ serial: s, source: 'saved' })
      return result
    }
    result.candidates.push({ serial: s, source: 'saved-failed' })
  }

  // 4) 扫网段 5555（tcpip 模式会一直开着）
  for (const sn of result.subnets) {
    onProgress('扫描 ' + sn.prefix + '.0/24 的 5555 端口…')
    const hosts = await scanPort(sn.prefix, 5555, { concurrency: 128, timeout: 400 })
    for (const h of hosts) {
      const addr = h + ':5555'
      onProgress('尝试连接 ' + addr + '…')
      const c = await adbRun(adbPath, ['connect', addr], 8000)
      const msg = (c.stdout + c.stderr).trim()
      if (/connected to/i.test(msg)) {
        result.found = true
        result.via = 'scan'
        result.serial = addr
        result.candidates.push({ serial: addr, source: 'scan-5555' })
        return result
      }
      result.candidates.push({ serial: addr, source: 'scan-5555-failed', error: msg })
    }
  }

  return result
}
