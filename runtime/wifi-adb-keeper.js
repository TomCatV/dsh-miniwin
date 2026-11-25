/**
 * WiFi adb 自愈 —— 让投屏在「手机重启后」自动恢复，不需要插 USB。
 *
 * ══════════ 要解决什么 ══════════
 *
 * adb 的 TCP 模式（`adb tcpip 5555`）本质上是**运行时状态**：
 * adbd 进程重启就回到 USB 模式，所以手机一重启就失效。
 * 而 `adb tcpip` 本身只能通过 USB 通道下发，无法自己通过网络执行 ——
 * 鸡生蛋的问题。
 *
 * 华为把这台机器的「无线调试」设置页裁掉了（Settings 里没有
 * 对应的 Activity，adb_wifi_enabled 是只读的），所以 Android 11
 * 原生的「无线调试配对」也用不了。只能靠下面的策略绕过去。
 *
 * ══════════ 三层自愈策略 ══════════
 *
 * ① 平时：直接用 WiFi serial 连接（TTL 内一直有效）
 *
 * ② 掉线时：扫描局域网的 5555 端口，找到就重连
 *    —— 处理「手机换了 IP」「DHCP 重新分配」这类情况
 *
 * ③ 都不行时：等 USB 出现，自动跑一次 `adb tcpip` 然后切回 WiFi
 *    —— 处理「手机重启」这种情况。用户只需插线 3 秒，
 *       程序提示「可以拔线了」就拔掉，全程自动化
 *
 * ══════════ 为什么不做「无线调试配对」 ══════════
 *
 * Android 11+ 的原生无线调试需要：
 *   开发者选项 → 无线调试 → 使用配对码配对设备
 * 华为在这台机器的 ROM 上把这个入口去掉了（实测 Settings 里
 * 搜不到任何 WirelessDebuggingActivity，adb_wifi_enabled 永远返回 0
 * 且不可写）。所以只能走上面的三层策略。
 */

const net = require('node:net')
const { execFile } = require('node:child_process')

class WifiAdbKeeper {
  /**
   * @param {object} o
   * @param {string} o.adb        adb.exe 路径
   * @param {string} [o.preferIp] 优先尝试的手机 IP
   * @param {()=>void} [o.onLog]
   * @param {(serial:string)=>void} [o.onOnline]  拿到可用 serial 时回调
   * @param {(needUsb:boolean)=>void} [o.onNeedUsb] 需要用户插 USB 时回调
   */
  constructor (o) {
    this.adb = o.adb
    /**
     * 优先 IP：显式传入 > 上次成功连接落盘的缓存。
     *
     * 缓存来自 wifi-discovery.js（%APPDATA%\miniwin-stream\wifi-cache.json）。
     * 之前 preferIp 只在内存里，程序一重启就丢，每次都要重新扫整个 /24；
     * 有了落盘缓存，冷启动也能 200ms 内直连。
     */
    this.preferIp = o.preferIp || (() => {
      try { const c = require('./wifi-discovery.js').readCache(); return c ? c.host : null } catch { return null }
    })()
    this.onLog = o.onLog || (() => {})
    this.onOnline = o.onOnline || (() => {})
    this.onNeedUsb = o.onNeedUsb || (() => {})

    this.serial = null          // 当前可用的 serial（wifi 或 usb）
    this.transport = null       // 'wifi' | 'usb'
    this.timer = null
    this.scanning = false
    this._lastUsbPrepare = 0
    /**
     * 「现在是否正在投屏采集」——上层注入。
     * 采集期间禁止 `adb tcpip`（那会重启 adbd 掐断 scrcpy），
     * 详见 _check() 里的注释。
     */
    this.isStreaming = o.isStreaming || null
  }

  log (m) { this.onLog('[wifi-adb] ' + m) }

  _run (args, timeout = 8000) {
    return new Promise(resolve => {
      execFile(this.adb, args, { timeout, windowsHide: true },
        (err, stdout, stderr) => resolve({
          ok: !err,
          out: String(stdout || ''),
          err: String(stderr || (err && err.message) || '')
        }))
    })
  }

  /** 列出当前 adb 设备 */
  async devices () {
    const r = await this._run(['devices'])
    const list = []
    /**
     * 按行扫，注意 Windows 的 \r。
     *
     * ── 踩过的坑（这个 bug 藏得很深）──
     *
     * adb.exe 在 Windows 上输出的是 CRLF：
     *   "List of devices attached\r\n2MN0224829001893\tdevice\r\n\r\n"
     *
     * 原来按 \n 切之后，每行末尾还挂着 \r。而正则写成：
     *   /^(\S+)\s+(\S+)$/
     * `\S` 不匹配 \r、`$` 只匹配字符串末尾（不含 \r），于是
     * **整行匹配失败**，list 永远是空数组。
     *
     * 后果：手机明明插着 USB、adb devices 也看得到，程序却判定
     * 「没有 adb 设备」→ 直接跳去扫局域网 → 扫不到（WiFi adb 没开）
     * → 卡在「正在等手机上线」3 分钟。而 USB 那条路根本没被尝试。
     *
     * 修法：先 trim 掉行尾空白再匹配；同时按 \r?\n 切行，
     * 两种换行都能吃。
     */
    for (const raw of r.out.split(/\r?\n/)) {
      const line = raw.trim()      // ← 关键：吃掉行尾的 \r
      if (!line) continue
      const m = line.match(/^(\S+)\s+(\S+)$/)
      if (m && m[2] === 'device') {
        list.push({
          serial: m[1],
          isWifi: /:\d+$/.test(m[1]),
          /**
           * 必须带上 state。
           *
           * 这里只 push 了 state==='device' 的行，但调用方（startScrcpySession、
           * 通道守护）普遍用 `d.state === 'device'` 判断能否使用 —— 少了这个
           * 字段它们全判假：明明两条通道都在线，却选不出设备，
           * 守护还会反复"切回 USB"打成死循环。
           */
          state: 'device'
        })
      }
    }
    return list
  }

  /**
   * 启动守护循环。
   *
   * 每 5 秒检查一次：
   *   - 有 WiFi 设备 → 直接用，标记 online
   *   - 只有 USB → 跑一次 tcpip 切到 WiFi，然后提示用户拔线
   *   - 都没有 → 扫描局域网
   */
  start () {
    this.stop()
    const tick = async () => {
      try { await this._check() } catch (e) { this.log('检查失败: ' + e.message) }
      this.timer = setTimeout(tick, 5000)
    }
    tick()
  }

  stop () {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  async _check () {
    const devs = await this.devices()
    const wifi = devs.find(d => d.isWifi)
    const usb = devs.find(d => !d.isWifi)

    // ① WiFi 已连上 → 一切正常
    if (wifi) {
      if (this.serial !== wifi.serial || this.transport !== 'wifi') {
        this.serial = wifi.serial
        this.transport = 'wifi'
        this.log(`WiFi 设备在线: ${wifi.serial}`)
        this.onOnline(wifi.serial)
      }
      return
    }

    // ② 只有 USB → 切换一次（限流：30 秒内不重复）
    if (usb && Date.now() - this._lastUsbPrepare > 30000) {
      this._lastUsbPrepare = Date.now()

      /**
       * ══════════ tcpip 会重启 adbd，采集期间必须绕开 ══════════
       *
       * `adb tcpip 5555` 的真实语义是 "restarting in TCP mode"，
       * adbd 一重启，正在跑的 scrcpy 当场 `Device disconnected`。
       *
       * 所以：
       *   ① 设备已经是 TCP 模式 → 只 adb connect，不重新下发
       *   ② 上层说正在采集 → 什么都不做
       */
      let alreadyTcp = false
      try {
        const g = await this._run([
          '-s', usb.serial, 'shell', 'getprop', 'service.adb.tcp.port'
        ], 6000)
        alreadyTcp = String(g.out || '').trim() === '5555'
      } catch {}

      if (!alreadyTcp) {
        if (this.isStreaming && this.isStreaming()) {
          this.log('采集进行中，跳过 tcpip（避免重启 adbd 断流）')
          return
        }
        this.log(`检测到 USB（${usb.serial}），正在开启 WiFi 通道…`)
        const r = await this._run(['-s', usb.serial, 'tcpip', '5555'], 15000)
        if (!r.ok) {
          this.log('tcpip 失败: ' + r.err.slice(0, 100))
          return
        }
        this.log('tcpip 已开启，等待设备上线…')
        await new Promise(r2 => setTimeout(r2, 3000))
      }

      // 拿手机 IP
      const ip = await this._phoneIp(usb.serial)
      if (!ip) { this.log('拿不到手机 WiFi IP'); return }
      this.log(`手机 WiFi IP: ${ip}`)

      const c = await this._run(['connect', `${ip}:5555`], 10000)
      if (c.out.includes('connected')) {
        this.log(`✓ WiFi 通道就绪: ${ip}:5555 —— 现在可以拔掉 USB`)
        this.preferIp = ip
        this.serial = `${ip}:5555`
        this.transport = 'wifi'
        this.onOnline(this.serial)
      } else {
        this.log('连接失败: ' + c.out.slice(0, 100))
      }
      return
    }

    // ③ 什么都没有 → 扫局域网 + 提示插 USB
    if (!this.scanning) {
      this.scanning = true
      const found = await this.scanLan()
      this.scanning = false
      if (found) {
        this.log(`扫描到设备: ${found}`)
        this.serial = found
        this.transport = 'wifi'
        this.onOnline(found)
        return
      }
    }
    this.onNeedUsb(true)
  }

  /** 读手机 WiFi IP */
  async _phoneIp (serial) {
    const r = await this._run(['-s', serial, 'shell',
      "ip -o addr show wlan0 2>/dev/null | grep 'inet ' | head -1"], 8000)
    const m = r.out.match(/inet (\d+\.\d+\.\d+\.\d+)/)
    return m ? m[1] : null
  }

  /**
   * 扫局域网 5555 端口。
   *
   * 只在「已知网段 + 优先 IP 附近」扫，全 /24 段扫一遍约 254 个连接，
   * 并发 32 的话 2 秒左右，不会拖慢主流程。
   */
  async scanLan () {
    const pcIp = await this._pcIp()
    if (!pcIp) return null

    // 优先试上次的 IP（内存或落盘缓存）
    if (this.preferIp) {
      if (await this._tryConnect(this.preferIp)) return `${this.preferIp}:5555`
    }

    /**
     * 交给 wifi-discovery 扫：多网卡多网段、并发 96、260ms 超时，
     * 比这里原来的「单网段 + 批 32 串行」快一倍以上，
     * 而且会顺带用 mDNS 找 Android 11+ 无线调试广播的端口。
     */
    try {
      const disc = require('./wifi-discovery.js')
      const r = await disc.discover({ adbPath: this.adb, port: 5555 })
      for (const c of r.candidates) {
        // connect() 内部会用 get-state 复核，避免把「端口开着但不是 adb」的主机写进缓存
        const ok = await disc.connect(this.adb, c.host, c.port)
        if (ok.ok) {
          this.preferIp = c.host
          return `${c.host}:${c.port}`
        }
      }
      return null
    } catch (e) {
      this.log('扫描失败，回退到内置扫描: ' + e.message)
    }

    const base = pcIp.split('.').slice(0, 3).join('.')
    const hosts = []
    for (let i = 1; i <= 254; i++) hosts.push(`${base}.${i}`)

    const CONCURRENCY = 32
    for (let i = 0; i < hosts.length; i += CONCURRENCY) {
      const batch = hosts.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(h => this._probe(h)))
      const hit = results.find(Boolean)
      if (hit) {
        this.preferIp = hit
        return `${hit}:5555`
      }
    }
    return null
  }

  /**
   * 拿本机局域网 IP —— 用 Node 原生 os.networkInterfaces()。
   *
   * 为什么不用 PowerShell：在 Electron 主进程里 spawn powershell
   * 有启动延迟（几百 ms）且容易被安全软件拦，而 os 模块是同步的、
   * 零开销。实测 PowerShell 版在打包环境里经常返回空。
   *
   * 挑选顺序：
   *   1. 优先 172.16~31 / 192.168 / 10 网段的私有地址（局域网）
   *   2. 排除 127.x、169.254.x（回环 / 自动分配失败）
   *   3. 排除 WSL / Hyper-V 虚拟网卡（它们的网段扫不到手机）
   */
  /**
   * 拿本机「WiFi 网卡」的局域网 IP。
   *
   * ── 为什么必须挑网卡而不是随便取一个 ──
   *
   * 这台机器上有 7 个 IPv4 地址：
   *   10.8.1.58      本地连接（代理软件的虚拟网卡）
   *   172.26.176.1   vEthernet (Default Switch)   Hyper-V
   *   172.25.16.1    vEthernet (WSL)              WSL
   *   169.254.229.164 Npcap Loopback              抓包工具
   *   192.168.174.62 以太网 2                      外接网卡
   *   172.31.100.174 WLAN                          ← 手机在这个网段
   *   127.0.0.1      Loopback
   *
   * 早期按「私有网段优先」挑，结果选中 10.8.1.58（代理网卡），
   * 扫了整个 10.8.1.0/24 也找不到手机。
   *
   * ── 现在的策略 ──
   *
   * 按网卡名前缀分级打分：
   *   1. WLAN / Wi-Fi / 无线        ← 最高优先级（手机连的就是这个）
   *   2. 以太网 / Ethernet          ← 有线也常见
   *   3. 其他（排除虚拟网卡）
   * 同分时优先 172.16~31 / 192.168 / 10 网段。
   */
  _pcIp () {
    const os = require('node:os')
    const ifaces = os.networkInterfaces()

    const VIRTUAL = /vEthernet|VirtualBox|VMware|WSL|Loopback|Npcap|Hyper-V|虚拟|TAP|代理/i
    const WIFI_NAME = /^(WLAN|Wi-?Fi|无线)/i
    const ETH_NAME = /^(以太网|Ethernet|本地连接 \d|Local Area)/i

    const scored = []
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue
      if (VIRTUAL.test(name)) continue
      for (const a of addrs) {
        if (a.family !== 'IPv4' && a.family !== 4) continue
        const ip = a.address
        if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue

        let score = 0
        if (WIFI_NAME.test(name)) score += 100
        else if (ETH_NAME.test(name)) score += 50
        // 私有网段加分
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score += 10
        else if (/^192\.168\./.test(ip)) score += 8
        else if (/^10\./.test(ip)) score += 3

        scored.push({ name, ip, score })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    if (scored.length) {
      this.log(`本机 IP: ${scored[0].ip}（${scored[0].name}）`)
      return scored[0].ip
    }
    return null
  }

  /** 探测主机 5555 端口是否开着 */
  _probe (host) {
    return new Promise(resolve => {
      const sock = new net.Socket()
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        try { sock.destroy() } catch {}
        resolve(v)
      }
      sock.setTimeout(600)
      sock.once('connect', () => finish(host))
      sock.once('timeout', () => finish(null))
      sock.once('error', () => finish(null))
      sock.connect(5555, host)
    })
  }

  async _tryConnect (ip) {
    const r = await this._run(['connect', `${ip}:5555`], 6000)
    return r.out.includes('connected')
  }
}

module.exports = { WifiAdbKeeper }
