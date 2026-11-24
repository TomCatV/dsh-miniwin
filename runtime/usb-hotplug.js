/**
 * USB 热插拔快速重连 —— 用 adb 的事件流，不用轮询。
 *
 * ══════════ 为什么放弃轮询 ══════════
 *
 * 最初想每 250ms 跑一次 `adb devices`。实测单次 38~152ms（抖动大），
 * 250ms 间隔意味着 adb 进程几乎一直在 fork，CPU 白烧，而且
 * 仍然有最多 250ms 的发现延迟。
 *
 * ══════════ adb track-devices ══════════
 *
 * adb 自带一个长连接命令：`adb track-devices`
 *
 *   - 它是一条只会往前流的**事件流**，设备有任何变化立刻推一行
 *   - 零轮询、零 fork，一个进程常驻
 *   - 实测格式：
 *       00352MN0224829001893<TAB>device
 *       00192.168.172.118:5555<TAB>offline
 *       00                          ← 空列表（前面 00 是长度的十六进制）
 *
 * 所以设备一插上，这里几乎是「立刻」收到，不用等任何轮询周期。
 *
 * ══════════ 触发策略 ══════════
 *
 * 只在「无 → 有」的边沿触发一次重连，且加 1.5 秒冷却 ——
 * USB 枚举过程中 adb 可能连推好几次事件（offline → device），
 * 不去重会发起多次并发重连。
 */

const { spawn } = require('node:child_process')

class UsbHotplugWatcher {
  /**
   * @param {object} o
   * @param {string} o.adb
   * @param {(serial:string)=>void} o.onDeviceBack   设备回来（边沿触发）
   * @param {(serial:string)=>void} [o.onDeviceLost]
   * @param {(m:string)=>void} [o.onLog]
   */
  constructor (o) {
    this.adb = o.adb
    this.onDeviceBack = o.onDeviceBack
    this.onDeviceLost = o.onDeviceLost || (() => {})
    this.onLog = o.onLog || (() => {})

    this.proc = null
    this.online = null          // 当前已知的唯一在线设备
    this.recovering = false
    this._cooldown = null
    this._restartTimer = null
    this.stopped = false
  }

  log (m) { this.onLog('[usb] ' + m) }

  start () {
    this.stopped = false
    this._spawn()
    this.log('热插拔监听已启动（adb track-devices 事件流）')
  }

  _spawn () {
    if (this.stopped) return
    try {
      this.proc = spawn(this.adb, ['track-devices'], { windowsHide: true })
    } catch (e) {
      this.log('启动失败: ' + e.message)
      this._scheduleRestart()
      return
    }

    let buf = ''

    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      /**
       * track-devices 的输出是「4 位十六进制长度 + 内容」分帧，
       * 但实际解析不需要那么严格 —— 直接按行取「serial<TAB>state」
       * 更稳，因为长度前缀里可能夹着换行。
       */
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        this._handleLine(line)
      }
      // 防止异常输入把 buffer 撑爆
      if (buf.length > 65536) buf = ''
    })

    this.proc.stderr.on('data', () => {})

    this.proc.on('exit', () => {
      if (this.stopped) return
      this.log('监听进程退出，1 秒后重启')
      this._scheduleRestart()
    })

    this.proc.on('error', (e) => {
      this.log('监听进程错误: ' + e.message)
      this._scheduleRestart()
    })
  }

  _scheduleRestart () {
    if (this.stopped || this._restartTimer) return
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      this._spawn()
    }, 1000)
  }

  /**
   * 解析一行：
   *   "00122MN0224829001893\tdevice"     ← 正常（前 4 位是长度）
   *   "00122MN0224829001893\toffline"
   *   "" 或 "00"                          ← 设备列表空
   */
  _handleLine (raw) {
    const line = raw.replace(/\r/g, '').trim()
    if (!line) {
      // 空行在部分版本里代表「列表空了」
      this._onEmpty()
      return
    }

    // 去掉可能存在的长度前缀
    let s = line
    if (/^[0-9a-f]{4}/.test(s) && s.includes('\t')) {
      s = s.slice(4)
    }

    const parts = s.split('\t')
    if (parts.length < 2) {
      if (/^[0-9a-f]+$/i.test(s)) this._onEmpty()
      return
    }

    const serial = parts[0].trim()
    const state = parts[1].trim()
    if (!serial) return

    if (state === 'device') {
      this._onOnline(serial)
    } else if (state === 'offline' || state === 'unauthorized') {
      // offline → 不算在线，但如果之前是我们用的那个，视为掉线
      if (this.online === serial) {
        this.log(`设备转为 ${state}：${serial}`)
        this.online = null
        try { this.onDeviceLost(serial) } catch {}
      }
    }
  }

  _onEmpty () {
    if (this.online) {
      this.log(`设备列表已空（原 ${this.online}）`)
      const lost = this.online
      this.online = null
      try { this.onDeviceLost(lost) } catch {}
    }
  }

  _onOnline (serial) {
    if (this.online === serial) return   // 已经是这个了，不重复触发

    const isNew = !this.online
    this.online = serial
    this.log(`设备在线：${serial}`)

    // 只处理「从无到有」；如果是不同设备切换，也当作新的
    if (!isNew && this.recovering) return
    if (this.recovering) return

    this.recovering = true
    try { this.onDeviceBack(serial) } catch {}
    this._cooldown = setTimeout(() => {
      this.recovering = false
      this._cooldown = null
    }, 1500)
  }

  stop () {
    this.stopped = true
    if (this._cooldown) { clearTimeout(this._cooldown); this._cooldown = null }
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null }
    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
    }
  }
}

module.exports = { UsbHotplugWatcher }
