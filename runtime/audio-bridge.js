/**
 * 音频桥 —— 让「scrcpy 出画面 + APK 出声音」两种引擎并存。
 *
 * ══════════ 为什么需要它 ══════════
 *
 * 这台华为是 Android 12，scrcpy 的音频捕获要 Android 13+
 * （实测报错：audio playback capture source not supported
 *  before Android 13）。所以 scrcpy 只能给我们画面。
 *
 * 声音必须走我们自己的 APK —— 它用 AudioPlaybackCapture
 * 抓 Android 内部的播放流（Android 10 起就有），这是唯一
 * 能在 12 上拿到「手机正在播放的声音」的路径。
 *
 * ══════════ 职责边界 ══════════
 *
 *   画面：scrcpy.exe → 命名管道 → MkvReader → VideoDecoder
 *   声音：APK → TCP → wifi-receiver → /audio → AudioDecoder
 *
 * 两条链路完全独立：
 *   - 画面断了不影响声音
 *   - 声音断了不影响画面
 *   - 各自有独立的背压和重连
 *
 * ══════════ 静音 ══════════
 *
 * APK 侧在开始捕获时把 STREAM_MUSIC 调到 0（AudioEngine
 * 里的 mutePhone），手机不出声，声音只在电脑播放。
 * 停止投屏时自动恢复原音量。
 */

const { spawn } = require('node:child_process')
const path = require('node:path')
const net = require('node:net')

class AudioBridge {
  /**
   * @param {object} o
   * @param {string} o.node         node 可执行文件
   * @param {string} o.receiverJs   wifi-receiver.js 路径
   * @param {string} o.adb          adb 路径
   * @param {number} [o.lanPort]    receiver 的 LAN 端口
   * @param {(m:string)=>void} [o.onLog]
   * @param {(cfg:object)=>void} [o.onConfig]  收到 AudioSpecificConfig
   * @param {(buf:Buffer, pts:number)=>void} [o.onFrame]  收到音频帧
   * @param {(info:object)=>void} [o.onState]  状态变化
   */
  constructor (o) {
    this.node = o.node
    this.receiverJs = o.receiverJs
    this.adb = o.adb
    this.lanPort = o.lanPort || 27190
    this.onLog = o.onLog || (() => {})
    this.onConfig = o.onConfig || (() => {})
    this.onFrame = o.onFrame || (() => {})
    this.onState = o.onState || (() => {})

    this.proc = null
    this.httpPort = this.lanPort + 1
    this.pulling = false
    this.running = false
    this._frames = 0
    this._cfgSent = false
  }

  log (m) { this.onLog('[audio] ' + m) }

  get stats () { return { frames: this._frames, running: this.running } }

  /** 启动 wifi-receiver 子进程（如果还没起） */
  async startReceiver () {
    if (this.proc) return { ok: true, port: this.httpPort }

    const args = [this.receiverJs, String(this.lanPort), String(this.httpPort), this.adb]
    this.log(`启动接收端: node ${path.basename(this.receiverJs)} ${this.lanPort} ${this.httpPort}`)

    this.proc = spawn(this.node, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.proc.stdout.on('data', (d) => {
      const s = d.toString().trim()
      if (s) this.log(s.slice(0, 200))
    })
    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim()
      if (s && /error|fail|EADDR/i.test(s)) this.log('stderr: ' + s.slice(0, 200))
    })
    this.proc.on('exit', (code) => {
      this.log(`接收端退出 code=${code}`)
      this.proc = null
      this.running = false
    })

    // 等端口就绪
    const ok = await this._waitPort(this.httpPort, 8000)
    if (!ok) {
      this.log('接收端启动超时')
      await this.stop()
      return { ok: false, error: '接收端启动超时' }
    }
    this.log('接收端已就绪')
    return { ok: true, port: this.httpPort }
  }

  /** 轮询 HTTP 端口直到可连 */
  _waitPort (port, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const tryOnce = () => {
        if (Date.now() > deadline) return resolve(false)
        const sock = new net.Socket()
        let done = false
        const finish = (v) => {
          if (done) return
          done = true
          try { sock.destroy() } catch {}
          if (v) resolve(true)
          else setTimeout(tryOnce, 250)
        }
        sock.setTimeout(400)
        sock.once('connect', () => finish(true))
        sock.once('timeout', () => finish(false))
        sock.once('error', () => finish(false))
        sock.connect(port, '127.0.0.1')
      }
      tryOnce()
    })
  }

  /**
   * 开始拉音频。
   *
   * 用「长轮询 + 批量」而不是每帧一个请求 —— 音频帧率约 43/s，
   * 每帧一次 HTTP 往返的开销太大了。
   */
  async startPulling () {
    if (this.pulling) return
    this.pulling = true
    this.running = true
    this._pullLoop()
    this.log('开始拉取音频流')

    // 先取一次解码器配置
    this._fetchConfig().catch(() => {})
  }

  /**
   * 取 AudioSpecificConfig。
   *
   * /audio-config 返回**裸二进制**（就是 AAC 的
   * AudioSpecificConfig 那几个字节），不是 JSON。
   * 204 = 还没有音频流（APK 没开始推）。
   */
  async _fetchConfig () {
    try {
      const r = await fetch(`http://127.0.0.1:${this.httpPort}/audio-config`)
      if (r.status === 204 || !r.ok) return false
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length) return false
      this.log(`音频配置 ${buf.length}B（AudioSpecificConfig）`)
      this.onConfig({ description: buf })
      this._cfgSent = true
      return true
    } catch { return false }
  }

  /**
   * 拉流主循环。
   *
   * /audio 返回的是一批帧（JSON 数组，每项 {data: base64, pts}），
   * 一次最多取 8 帧（receiver 内部队列上限）。取到就立刻解码，
   * 空了就等 20ms 再来 —— 这个节奏和音频帧率（~43/s）匹配。
   */
  async _pullLoop () {
    let idleStreak = 0
    while (this.pulling) {
      try {
        /**
         * /audio 是**二进制**协议，不是 JSON。
         *
         * 帧格式（receiver 侧 L467-488 写的）：
         *   [4B]  帧数量 N（大端 uint32）
         *   重复 N 次：
         *     [8B]  pts（大端 double）
         *     [4B]  数据长度 L（大端 uint32）
         *     [L]   AAC 裸帧
         *
         * HTTP 204 表示这次没数据（receiver 的长轮询超时）。
         */
        const r = await fetch(`http://127.0.0.1:${this.httpPort}/audio?n=24&wait=800`, {
          signal: AbortSignal.timeout(4000)
        })
        if (r.status === 204) {
          idleStreak++
          this.onState({ waiting: true })
          await sleep(20)
          continue
        }
        if (!r.ok) throw new Error('HTTP ' + r.status)

        const ab = Buffer.from(await r.arrayBuffer())
        const list = parseAudioBatch(ab)

        // 第一帧到达前再尝试一次配置（APK 可能刚推上来）
        if (list.length && !this._cfgSent) {
          await this._fetchConfig()
        }

        if (!list.length) {
          idleStreak++
          await sleep(idleStreak > 20 ? 100 : 20)
          if (idleStreak === 25) this.onState({ waiting: true })
          continue
        }

        idleStreak = 0
        this.onState({ waiting: false })

        for (const f of list) {
          if (!f || !f.data || !f.data.length) continue
          this._frames++
          this.onFrame(f.data, Number(f.pts) || 0)
        }
      } catch (e) {
        if (!this.pulling) break
        await sleep(200)
      }
    }
  }

  async stop () {
    this.pulling = false
    this.running = false
    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
    }
    this.log('已停止')
  }
}

/**
 * 解析 /audio 的二进制批。
 *
 * 布局：N(4) + N * [pts(8, double BE) + len(4) + data(len)]
 * 用 readDoubleBE 读 pts —— receiver 那边写的是 writeDoubleBE。
 */
function parseAudioBatch (buf) {
  if (!buf || buf.length < 4) return []
  const count = buf.readUInt32BE(0)
  const out = []
  let off = 4
  for (let i = 0; i < count; i++) {
    if (off + 12 > buf.length) break
    const pts = buf.readDoubleBE(off); off += 8
    const len = buf.readUInt32BE(off); off += 4
    if (len <= 0 || off + len > buf.length) break
    out.push({ data: buf.subarray(off, off + len), pts })
    off += len
  }
  return out
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { AudioBridge }
