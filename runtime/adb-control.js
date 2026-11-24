/**
 * 反向控制：持久 adb shell 会话。
 *
 * ── 为什么放弃 scrcpy 控制协议 ──
 *
 * scrcpy 的二进制控制通道理论上是最优解（1~3ms、支持 UTF-8 文本）。
 * 在这台华为（P70 Pro / HarmonyOS 4.2 / Android 12）上实测走不通：
 *
 *   server 正常启动，socket 也能连上、能保持空闲连接；
 *   但只要写入第一条控制消息（不管是 inject_touch 还是最简单的
 *   inject_keycode），server 立刻 SIGABRT 退出。
 *
 * 期间排除过的原因：
 *   - ClassNotFoundException → 定位到 scrcpy-server.jar 这个**文件名**
 *     会被安全策略清理，改成随机名后 jar 稳定存活
 *   - scid 必须是十六进制且值不超过 int 范围，否则 Options.parse 抛异常
 *   - pkill -f 会匹配到执行它的 sh 自身，把自己进程组杀掉
 *
 * 以上都修完之后 server 能稳跑，但仍在收到首个控制消息时崩溃，
 * 属于 server 侧与这套 ROM 的兼容问题，客户端无法绕过。
 * 因此改用下面的方案。
 *
 * ── 现在的方案 ──
 *
 * 起一个**长驻的 adb shell**，把 input 命令通过 stdin 喂进去。
 *
 * 关键细节：必须带 `-T`（禁用 PTY 分配）。不带的话 adb 会给远端分配
 * 伪终端，stdin 的换行处理会出问题，命令写进去没反应。
 *
 * 实测延迟对比（同一台设备）：
 *   每次 spawn adb + input tap    243 ms/次   ← 拖动完全不可用
 *   持久 shell + stdin 写入        13 ms/次    ← 可用
 *
 * 缺点：input 命令是逐条执行的，没有「按住-移动-抬起」的连续手势，
 * 所以拖动只能用 `input swipe`（系统自己插值）。
 * 对投屏远控这个场景足够 —— 滚动、翻页、拖拽都能用。
 */

const { spawn } = require('node:child_process')

/**
 * 设备自动切换看门狗。
 *
 * ── 要解决什么 ──
 *
 * 用户的两种连接方式各有失效场景：
 *   - WiFi adb（tcpip 5555）在手机休眠/切网后会掉，表现为
 *     `cannot connect ... (10061)`，而 App 的 TCP 推流还在跑
 *   - USB 会被拔掉
 *
 * 手动 adb connect 很烦，所以这里做成自动的：
 *   每 4 秒看一次设备表，按优先级挑一个可用的：
 *     WiFi 有效 → 继续用（省得反复重连）
 *     只有 USB  → 用 USB
 *     都没有    → 尝试重连上次的 WiFi 地址，并尝试用 USB 重新开 tcpip
 *
 * 切换时**不重建 shell**，只改 serial 并在下次重建时生效 ——
 * 正在跑的控制会话保持可用，用户感觉不到中断。
 */
class DeviceWatcher {
  /**
   * @param {object} o
   * @param {string} o.adb
   * @param {string[]} [o.wifiCandidates] 已知的 WiFi 地址（如 172.31.100.199:5555）
   */
  constructor (o) {
    this.adb = o.adb
    this.wifiCandidates = o.wifiCandidates || []
    this.current = null          // 当前使用的 serial
    this.lastKind = ''           // 'wifi' | 'usb' | ''
    this.timer = null
    this._onChange = null
    this._onLog = null
    this._busy = false
    /**
     * 「现在是否正在投屏采集」——由上层注入。
     *
     * ══════════ 这个回调是本文件最重要的一行防护 ══════════
     *
     * 用户的投诉原话：「投屏鼠标只要操作连接就会断」。
     *
     * 复现链路（实测）：
     *   ① 用户在画面上点一下 → 控制通道懒启动 → ensureCtrl()
     *   ② ensureCtrl 里 new DeviceWatcher(...).start(4000)
     *   ③ 第一次 _tick 立刻跑 → 只有 USB → _prepareTcpip(serial)
     *   ④ `adb tcpip 5555` → **手机侧 adbd 重启**
     *   ⑤ 重启瞬间 scrcpy 的 USB 传输被掐 → 打印
     *      `WARN: Device disconnected` → 退出 code=2
     *   ⑥ 上层看到 scrcpy 退出 → 断线重连 → 画面黑掉几秒
     *
     * 实测证据（scrcpy 录制中执行 tcpip）：
     *   [6s] 存活 → 执行 adb tcpip 5555 → [7s] 已退出 code=2
     * 对照组（录制中只发 input tap / swipe，不碰 tcpip）：
     *   连续 16 秒稳定出帧、文件持续增长，scrcpy 毫发无伤。
     *
     * 结论：**input 注入是安全的，tcpip 才是断流元凶。**
     * 所以采集期间一律不碰 adbd —— 宁可等下次冷启动再准备无线通道。
     */
    this.isStreaming = o.isStreaming || null
  }

  onLog (fn) { this._onLog = fn }
  onChange (fn) { this._onChange = fn }
  log (m) { if (this._onLog) this._onLog(m) }

  _run (args, timeout = 6000) {
    const { execFile } = require('node:child_process')
    return new Promise((resolve) => {
      execFile(this.adb, args, { timeout, windowsHide: true },
        (err, stdout, stderr) => resolve(String(stdout || '') + String(stderr || '')))
    })
  }

  /** 读设备表，返回 { wifi: [], usb: [] } */
  async _list () {
    const out = await this._run(['devices'])
    const wifi = []
    const usb = []
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+device\b/)
      if (!m) continue
      const s = m[1]
      if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) wifi.push(s)
      else usb.push(s)
    }
    return { wifi, usb }
  }

  async _tick () {
    if (this._busy) return
    this._busy = true
    try {
      const { wifi, usb } = await this._list()

      /**
       * 选择顺序很重要。
       *
       * 优先 WiFi：一旦无线通了就别再切回 USB —— 用户插着线时
       * 我们也不想把正在用的无线会话切走，那会造成无谓的抖动。
       *
       * 只有在完全没有 WiFi 时才用 USB，同时**顺手给它开 tcpip**，
       * 这样拔线后能自动回到无线。
       */
      let pick = null
      let kind = ''

      if (wifi.length) {
        pick = this.current && wifi.includes(this.current) ? this.current : wifi[0]
        kind = 'wifi'
      } else if (usb.length) {
        pick = this.current && usb.includes(this.current) ? this.current : usb[0]
        kind = 'usb'
        // 用 USB 时开无线通道，为后续拔线做准备
        this._prepareTcpip(pick).catch(() => {})
      }

      if (!pick) {
        // 什么都没有：尝试重连已知的 WiFi 地址
        await this._reconnectWifi()
        return
      }

      if (pick !== this.current) {
        const prev = this.current
        this.current = pick
        this.lastKind = kind
        this.log(`设备${prev ? '切换' : '就绪'}: ${pick}（${kind === 'wifi' ? '无线' : 'USB'}）`)
        if (this._onChange) this._onChange({ serial: pick, kind, previous: prev })
      }
    } finally {
      this._busy = false
    }
  }

  /**
   * USB 在场时开 tcpip，让拔线后能自动回无线。
   *
   * ══════════ 默认关闭，且采集期间硬阻断 ══════════
   *
   * 这个方法会执行 `adb tcpip 5555`，而 adb 的手册写得很清楚：
   *   "restarting in TCP mode port: 5555"
   * 它是**重启 adbd**，不是「加个监听」。
   *
   * adbd 一重启，走 USB 传输的所有连接立刻失效 —— 包括
   * scrcpy 的 forward/reverse 隧道。现象就是用户说的：
   * 「投屏鼠标只要操作连接就会断」（点一下 → 触发控制通道
   * → 触发本方法 → 画面断）。
   *
   * 而且设备一旦被设成 tcpip 模式，`getprop service.adb.tcp.port`
   * 就一直是 5555，**根本不需要每次重新下发**。重复下发只是白挨
   * 一次 adbd 重启。
   *
   * 所以这里三道闸：
   *   ① isStreaming() 为真 → 直接跳过（采集期绝不碰 adbd）
   *   ② 设备已经是 tcpip 模式 → 跳过（没必要重启）
   *   ③ 本实例已经准备过 → 跳过
   */
  async _prepareTcpip (usbSerial) {
    if (this._tcpipDone === usbSerial) return

    if (this.isStreaming && this.isStreaming()) {
      this.log('采集进行中，跳过 tcpip（它会重启 adbd 导致断流）')
      return
    }

    /**
     * 先问设备：你现在是 TCP 模式吗？
     * 已经是 5555 就什么都不做 —— 拔线后 adb connect 直接能连上，
     * 不需要再让它重启一次。
     */
    try {
      const cur = await this._run([
        '-s', usbSerial, 'shell', 'getprop', 'service.adb.tcp.port'
      ], 6000)
      if (String(cur).trim() === '5555') {
        this._tcpipDone = usbSerial
        this.log('设备已在 TCP 模式（service.adb.tcp.port=5555），无需重启 adbd')
        return
      }
    } catch { /* 查不到就按未开启处理 */ }

    this._tcpipDone = usbSerial
    await this._run(['-s', usbSerial, 'tcpip', '5555'], 12000).catch(() => {})
    this.log('已为 USB 设备开启无线通道（拔线后可自动切换）')
  }

  /** 尝试重连已知的 WiFi 地址 */
  async _reconnectWifi () {
    if (!this.wifiCandidates.length) return
    for (const addr of this.wifiCandidates) {
      const out = await this._run(['connect', addr], 5000)
      if (/connected to/.test(out)) {
        this.log('已重连无线: ' + addr)
        return
      }
    }
  }

  start (intervalMs = 4000) {
    if (this.timer) return
    this._tick().catch(() => {})
    this.timer = setInterval(() => { this._tick().catch(() => {}) }, intervalMs)
  }

  stop () {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

class AdbShellControl {
  /**
   * @param {object} o
   * @param {string} o.adb     adb 可执行文件
   * @param {string} o.serial  设备序列号
   */
  constructor (o) {
    this.adb = o.adb
    this.serial = o.serial
    this.sh = null
    this.ready = false
    this.physW = 0
    this.physH = 0
    this.screenW = 0      // 视频像素宽（调用方坐标基准）
    this.screenH = 0
    this._buf = ''
    this._waiters = []
  }

  log (msg) { if (this._onLog) this._onLog(msg) }
  onLog (fn) { this._onLog = fn }

  _run (args, timeout = 15000) {
    const { execFile } = require('node:child_process')
    return new Promise((resolve, reject) => {
      execFile(this.adb, ['-s', this.serial, ...args],
        { timeout, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message).trim()))
          else resolve(String(stdout || '').trim())
        })
    })
  }

  /** 查手机物理分辨率 —— input 命令的坐标基准 */
  async _querySize () {
    try {
      const out = await this._run(['shell', 'wm', 'size'], 8000)
      const m = out.match(/Physical size:\s*(\d+)x(\d+)/)
      if (m) { this.physW = Number(m[1]); this.physH = Number(m[2]) }
    } catch {}
    if (!this.physW) { this.physW = this.screenW || 1080; this.physH = this.screenH || 2400 }
    this.log(`物理分辨率 ${this.physW}×${this.physH}`)
  }

  async start () {
    if (this.ready) return { ok: true, mode: 'adb-shell' }
    try {
      await this._querySize()

      /**
       * 起持久 shell。
       *
       * -T 是必需的：不加的话 adb 会分配 PTY，stdin 写入的命令
       * 会被终端的行编辑逻辑吞掉，表现为「写了没反应」。
       */
      this.sh = spawn(this.adb, ['-s', this.serial, 'shell', '-T'],
        { windowsHide: true })

      this.sh.stdout.on('data', d => { this._buf += d.toString() })
      this.sh.stderr.on('data', d => { this._buf += d.toString() })
      this.sh.on('exit', () => { this.ready = false; this.sh = null })
      this.sh.on('error', (e) => this.log('shell 错误: ' + e.message))

      // 等 shell 真正可用：写一条 echo 并等回显
      const ok = await this._ping()
      if (!ok) throw new Error('shell 无响应')

      this.ready = true
      this.log('控制通道就绪（持久 adb shell）')
      return { ok: true, mode: 'adb-shell' }
    } catch (e) {
      this.log('控制通道启动失败: ' + String(e.message || e))
      await this.stop()
      return { ok: false, error: String(e.message || e) }
    }
  }

  /** 写一条命令进 shell，等它回显一个标记确认执行完 */
  _ping (timeoutMs = 3000) {
    return new Promise((resolve) => {
      if (!this.sh) return resolve(false)
      const mark = '__p' + Math.random().toString(36).slice(2, 7) + '__'
      const t = setTimeout(() => resolve(false), timeoutMs)
      const check = () => {
        if (this._buf.includes(mark)) {
          clearTimeout(t)
          this.sh.stdout.removeListener('data', check)
          resolve(true)
        }
      }
      this.sh.stdout.on('data', check)
      this.sh.stdin.write(`echo ${mark}\n`)
      setTimeout(check, 50)
    })
  }

  async stop () {
    this.ready = false
    try { if (this.sh) this.sh.kill() } catch {}
    this.sh = null
  }

  /**
   * 切换目标设备（USB ↔ WiFi 无感切换）。
   *
   * 只改 serial 并异步重建 shell，不阻塞调用方。
   * 重建期间旧的 shell 还能继续用（它连着自己的设备），
   * 所以用户感觉不到中断 —— 最多是切换瞬间的一两条命令丢失。
   *
   * 关键：**不 kill 旧 shell 直到新 shell 起来**，
   * 否则会出现「两边都不可用」的窗口期。
   */
  switchTo (newSerial) {
    if (!newSerial || newSerial === this.serial) return
    const oldSerial = this.serial
    this.serial = newSerial

    // 异步重建，先让旧 shell 继续服务
    ;(async () => {
      const oldSh = this.sh
      this.sh = null
      this.ready = false
      try {
        await this.start()
        // 新 shell 起来了，才关旧的
        try { if (oldSh) oldSh.kill() } catch {}
        this.log(`已切到 ${newSerial}（原 ${oldSerial}）`)
      } catch (e) {
        this.log('切换失败，回滚: ' + String(e.message || e))
        this.serial = oldSerial
        this.sh = oldSh
        this.ready = !!oldSh
      }
    })()
  }

  setScreen (w, h) {
    if (w > 0) this.screenW = Math.round(w)
    if (h > 0) this.screenH = Math.round(h)
  }

  /**
   * 视频坐标 → 物理坐标。
   *
   * 画面是 720×1626（编码器缩放后的），而 input 命令要的是
   * 屏幕物理坐标 1260×2844。不换算的话点击全部偏到别处，
   * 看起来就像「点了没反应」。
   */
  toPhysical (x, y) {
    const sx = (this.physW || 1260) / (this.screenW || this.physW || 1260)
    const sy = (this.physH || 2844) / (this.screenH || this.physH || 2844)
    return { x: Math.round(x * sx), y: Math.round(y * sy) }
  }

  _cmd (line) {
    if (!this.sh || !this.sh.stdin.writable) {
      this.log('命令丢弃：shell 不可用')
      return false
    }
    try { this.sh.stdin.write(line + '\n') } catch (e) {
      this.log('写入失败: ' + e.message)
      return false
    }
    return true
  }

  tap (x, y) {
    const p = this.toPhysical(x, y)
    this._cmd(`input tap ${p.x} ${p.y}`)
  }

  /**
   * 滑动。
   *
   * adb 的 input swipe 支持时长参数，系统自己插值中间帧，
   * 比逐个 move 去喂要稳得多（后者在持久 shell 里会被
   * 命令队列拖慢，反而更卡）。
   */
  swipe (x1, y1, x2, y2, ms) {
    const a = this.toPhysical(x1, y1)
    const b = this.toPhysical(x2, y2)
    const dur = Math.max(40, Math.min(2000, Math.round(ms || 200)))
    this._cmd(`input swipe ${a.x} ${a.y} ${b.x} ${b.y} ${dur}`)
  }

  /** 长按：起点终点相同的 swipe */
  longPress (x, y, ms) {
    const p = this.toPhysical(x, y)
    const dur = Math.max(400, Math.min(3000, Math.round(ms || 650)))
    this._cmd(`input swipe ${p.x} ${p.y} ${p.x} ${p.y} ${dur}`)
  }

  key (code) {
    this._cmd(`input keyevent ${code}`)
  }

  /**
   * 输入文字。
   *
   * input text 不支持中文（非 ASCII 会丢），也不支持空格（要写成 %s）。
   * 这里做空格转义；中文直接拒绝并提示，避免用户以为输入了实际没进去。
   */
  text (str) {
    if (!str) return
    if (!/^[\x20-\x7E]*$/.test(str)) {
      this.log('adb 只能输入英文数字和符号，中文请用手机输入法')
      return
    }
    this._cmd('input text ' + str.replace(/ /g, '%s').replace(/([&|;<>()$`\\"'])/g, '\\$1'))
  }

  /** 滚动：用短距离 swipe 模拟 */
  scroll (x, y, hscroll, vscroll) {
    const p = this.toPhysical(x, y)
    const stepY = Math.round(this.physH * 0.15) * (vscroll > 0 ? 1 : -1)
    this._cmd(`input swipe ${p.x} ${p.y - stepY / 2} ${p.x} ${p.y + stepY / 2} 150`)
  }
}

module.exports = { AdbShellControl, DeviceWatcher }
