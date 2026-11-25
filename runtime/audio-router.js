'use strict'
/**
 * 音频路由策略（手机端声音到底去哪）。
 *
 * 用户规则：
 *   1. 手机插耳机（有线/蓝牙）时：不做任何投音频，声音留在手机
 *   2. 手机外放时：连接后默认「双端静音」——手机静音 + 投屏音量 0
 *   3. 手动把投屏音量调上去（>0）才把手机声音投到电脑
 *   4. 投屏音量不影响手机音量
 *   5. 手机音量变化 → 投屏音量被重置成手机音量
 *   6. 断开连接 → 音频断开，并杀掉手机端 APK
 *
 * 数据来源（实测这台 HBN-AL00 可用）：
 *   adb shell dumpsys audio   →  STREAM_MUSIC 段落里的
 *                                "Devices: speaker, bt_a2dp"
 *                                "streamVolume:10"
 */
const { execFile } = require('child_process')

const HEADSET_DEVICES = ['headset', 'headphone', 'bt_a2dp', 'bt_a2dp_hp', 'bt_a2dp_spk',
  'bt_sco', 'bt_sco_hs', 'bt_sco_carkit', 'usb_headset']
const SPEAKER_DEVICES = ['speaker', 'speaker_safe']

class AudioRouter {
  constructor (opts = {}) {
    this.adb = opts.adb
    this.serial = opts.serial
    this.apkPackage = opts.apkPackage || 'com.miniwin.stream'
    /** 接收端 HTTP 端口（/meta 的 phoneVolume 是手机音量意图的权威来源） */
    this.httpPort = opts.httpPort || 0
    this.onLog = opts.onLog || (() => {})
    this.onState = opts.onState || (() => {})
    this.timer = null
    this.last = { devices: [], headset: false, speaker: false, phoneVolume: 0, pcVolume: 0 }
    this.pcVolume = 0
    this.manualOverride = false
  }

  _run (args, timeout = 8000) {
    const full = this.serial ? ['-s', this.serial, ...args] : args
    return new Promise((resolve) => {
      execFile(this.adb, full, { timeout, windowsHide: true },
        (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }))
    })
  }

  /** 解析 dumpsys audio 里的音频路由与音乐音量 */
  static parse (text) {
    const idx = text.indexOf('STREAM_MUSIC')
    if (idx < 0) return { devices: [], streamVolume: 0 }
    const block = text.slice(idx, idx + 1200)
    const devLine = (block.match(/Devices:\s*([^\n\r]+)/) || [])[1] || ''
    const devices = devLine.split(',').map(s => s.trim()).filter(Boolean)
    const vol = parseInt((block.match(/streamVolume:(\d+)/) || [])[1] || '0', 10)
    return { devices, streamVolume: vol }
  }

  async poll () {
    /**
     * 没有 adb 通道时（纯 WiFi、手机没开 tcpip 也没插线），
     * 拿不到 dumpsys —— 这时候不能盲判成「外放」把手机静音掉。
     * 我们只保留「/meta 的手机音量」这一路，headset 记为未知(false)，
     * 由上层决定降级行为；投屏侧音量仍然默认 0。
     */
    let p = { devices: [], streamVolume: 0 }
    if (this.serial) {
      /**
       * 只取 STREAM_MUSIC 那一段。
       *
       * `dumpsys audio` 整份输出在华为上是 80~150KB，每 2 秒过一次 adb
       * 通道既慢又费电。改在设备端 grep，传输量降到 1KB 上下 ——
       * 解析不用改，parse() 本来就是从 'STREAM_MUSIC' 开始截的。
       */
      const { out } = await this._run(['shell', "dumpsys audio | grep -A40 '^- STREAM_MUSIC'"])
      p = AudioRouter.parse(out)
    }
    const headset = p.devices.some(d => HEADSET_DEVICES.includes(d))
    const speaker = p.devices.some(d => SPEAKER_DEVICES.includes(d))

    /**
     * 「用户按了手机音量键」这件事，dumpsys 的 streamVolume 看不出来 ——
     * APK 静音后它一直是 0。真正的意图值在 APK 读取的
     * Settings.System.volume_music 里，它通过接收端 /meta 的
     * phoneVolume（0..255）暴露出来。
     *
     * 所以：设备列表看 dumpsys，音量意图看 /meta。
     */
    let intentVol = p.streamVolume
    if (this.httpPort) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.httpPort}/meta`, {
          cache: 'no-store', signal: AbortSignal.timeout(1500)
        })
        const j = await r.json()
        if (j && typeof j.phoneVolume === 'number') {
          intentVol = Math.round((j.phoneVolume / 255) * 15)
        }
      } catch { /* 接收端没起就用 dumpsys 的值 */ }
    }

    const prev = this.last
    this.last = { devices: p.devices, headset, speaker, phoneVolume: intentVol, pcVolume: this.pcVolume }

    if (headset) {
      /**
       * 耳机在场：投屏音量归零，并且**清掉手动标记**。
       *
       * 不清会踩这个坑：耳机插着时用户拖过投屏音量（或手机音量被同步过来），
       * pcVolume 停在 7；耳机一拔条件立刻成立 → 手机声音突然被投到电脑，
       * 而用户根本没开。规则是「外放默认静音，手动调高才转发」。
       */
      if (this.pcVolume !== 0 || this.manualOverride) this.onLog('[audio] 耳机在场：投屏音量归零')
      this.pcVolume = 0
      this.manualOverride = false
      this.last.pcVolume = 0
    } else if (intentVol !== prev.phoneVolume) {
      /**
       * 规则 5：手机端音量变化 → 投屏端直接重置成手机端音量。
       * 不看 manualOverride —— 用户明确要求「手机端调音量就把投屏端重置过去」。
       */
      this.pcVolume = intentVol
      this.manualOverride = this.pcVolume > 0
      this.last.pcVolume = this.pcVolume
      this.onLog(`[audio] 手机音量 ${intentVol}/15 → 投屏音量重置为 ${this.pcVolume}/15`)
    }
    this.onState({ ...this.last, forwarding: this.shouldForward() })
  }

  /** 规则 1：耳机时永不转发 */
  shouldForward () {
    if (this.last.headset) return false
    return this.manualOverride && this.pcVolume > 0
  }

  /** 规则 3：用户手动调高投屏音量 → 允许转发 */
  setPcVolume (v) {
    this.pcVolume = Math.max(0, Math.min(15, Math.round(v)))
    this.manualOverride = this.pcVolume > 0
    this.last.pcVolume = this.pcVolume
    const fwd = this.shouldForward()
    this.onLog(`[audio] 投屏音量=${this.pcVolume} → ${fwd ? '开始转发手机声音' : '不转发'}`)
    this.onState({ ...this.last, forwarding: fwd })
    return { pcVolume: this.pcVolume, forwarding: fwd }
  }

  /** 规则 2：外放时连接即双端静音（用音量键把媒体音量降到 0） */
  async mutePhone () {
    if (!this.serial) return
    // `cmd media_session` 一条命令就能把媒体音量设到 0，比连按音量键干净得多
    const r = await this._run(['shell', 'cmd media_session volume --stream 3 --set 0'])
    if (r.ok) {
      this.last.phoneVolume = 0
      this.onLog('[audio] 手机媒体音量已设 0（外放默认静音）')
      return
    }
    // 老系统没有 cmd media_session：退回音量键
    for (let i = 0; i < 16; i++) {
      await this._run(['shell', 'input keyevent 25'])   // VOLUME_DOWN
    }
    this.last.phoneVolume = 0
    this.onLog('[audio] 手机媒体音量已降到 0（音量键兜底）')
  }

  /**
   * 只停手机端 APK，不停轮询。
   *
   * 耳机插上时用它：APK 会把手机 STREAM_MUSIC 锁在 0，
   * 不 force-stop 的话耳机里也没声。
   */
  async killApk () {
    /** 没有 adb 通道（纯 WiFi）时做不到，直接跳过 —— 别让 adb 报「no devices」刷屏 */
    if (!this.serial) return
    await this._run(['shell', `am force-stop ${this.apkPackage}`])
    this.onLog(`[audio] 已停止手机端 ${this.apkPackage}`)
  }

  /** 规则 6：断开时停音频并杀掉手机端 APK */
  async teardown () {
    this.stop()
    await this._run(['shell', `am force-stop ${this.apkPackage}`])
    this.onLog(`[audio] 已断开音频并停止手机端 ${this.apkPackage}`)
  }

  start (intervalMs = 2000) {
    if (this.timer) return
    this.timer = setInterval(() => { this.poll().catch(() => {}) }, intervalMs)
    this.poll().catch(() => {})
  }

  stop () {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

module.exports = { AudioRouter, HEADSET_DEVICES, SPEAKER_DEVICES }
