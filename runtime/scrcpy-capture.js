/**
 * scrcpy 采集引擎 —— 命名管道 + MKV 流式解析。
 *
 * ══════════ 为什么换掉 APK ══════════
 *
 * 我们的 App 用 MediaProjection + createVirtualDisplay 采集，
 * 在这台华为 Pura 70 Pro（HarmonyOS 4.2）上被系统限流到 4fps。
 * 同一设备上 scrcpy.exe 用 Android 12 的 SurfaceControl 路径，
 * 实测稳定 50~80fps —— 系统给两条 API 的合成优先级不同，
 * 不是参数能调的（官方 scrcpy-server 在我们的连接方式下也只有 0.1fps）。
 *
 * ══════════ 为什么用命名管道 ══════════
 *
 * 最初让 scrcpy 录到 mkv 文件、我们再增量读。Windows 上行不通：
 * scrcpy 用稀疏文件 + 大缓冲写入，Node 的 statSync 一直返回
 * size=0（PowerShell 也是），只有 cmd dir 能看到 139GB 的逻辑大小，
 * 实际数据憋在系统缓存里读不到 —— 表现为「文件 2.3MB 但一帧解析不出来」。
 *
 * 命名管道彻底绕开文件系统：scrcpy 直接往管道写，我们边收边解析，
 * 零文件 IO、零缓冲延迟，也不用清理临时文件。
 *
 * ══════════ 数据通路 ══════════
 *
 *   scrcpy.exe --record \\.\pipe\miniwin-stream --record-format mkv
 *        ↓  （管道字节流，约 400KB/s）
 *   net.createServer 接收
 *        ↓  reader.push(chunk)
 *   MkvReader 流式 EBML 解析
 *        ↓  SimpleBlock → AVCC 帧（4 字节长度前缀）
 *   onFrame(buf, ptsMs, isKey)
 *        ↓
 *   WebCodecs VideoDecoder
 */

const net = require('node:net')
const { spawn } = require('node:child_process')
const { MkvReader } = require('./mkv-reader.js')

const PIPE_NAME = `\\\\.\\pipe\\miniwin-stream-${process.pid}`

class ScrcpyCapture {
  /**
   * @param {object} o
   * @param {string} o.scrcpy    scrcpy.exe 路径
   * @param {string} [o.serial]  设备序列号
   * @param {number} [o.maxSize] 最长边像素
   * @param {string} [o.bitRate] 如 '8M'
   * @param {number} [o.maxFps]
   */
  constructor (o) {
    this.scrcpy = o.scrcpy
    this.serial = o.serial || null
    this.maxSize = o.maxSize || 720
    this.bitRate = o.bitRate || '8M'
    this.maxFps = o.maxFps || 30
    /**
     * adb.exe 路径 —— 用来清理手机侧的 scrcpy-server。
     *
     * scrcpy.exe 被 kill 之后，手机上那个 server 进程不会跟着死，
     * 它继续占着 MediaCodec；下一次启动抢不到编码器就是
     * 「管道连接超时」。做分辨率切换时这问题会稳定复现，
     * 所以把 adb 传进来，让 _killStale 能一起清掉。
     */
    this.adb = o.adb || null

    this.proc = null
    this.server = null
    this.sock = null
    this.reader = null
    this.running = false

    this.onFrame = null
    this.onLog = null
    this.onReady = null
    /** scrcpy 意外退出时回调（上层据此重连）*/
    this.onExit = null
    this.codecPrivate = null
    this.width = 0
    this.height = 0

    this._startedAt = 0
    this._frames = 0
    /** 滑动窗口用的帧样本 [{t, n}]，见 get fps */
    this._fpsSamples = []
  }

  log (m) { if (this.onLog) this.onLog(m) }

  /** 实时帧率（用于状态显示） */
  /**
   * 实时帧率 —— 滑动窗口，不是累计均值。
   *
   * ── 为什么必须用滑动窗口 ──
   *
   * 原来写的是 `frames / (now - startedAt)`，也就是「从启动到现在的
   * 平均帧率」。这个值有两个致命问题：
   *
   *   ① 启动阶段的空窗被永久计入
   *      scrcpy 要 push server（约 0.3s）+ 等首帧（可能 5~10s），
   *      这段时间 frames=0。假设等首帧花了 8 秒、之后稳定 60fps，
   *      累计均值要好几分钟才能爬回 22 以上 —— 而自适应降档判的是
   *      「连续 5 秒 < 22」，于是刚启动就白降一档。
   *
   *   ② 抹平瞬时抖动
   *      某一秒掉到 15fps，累计均值几乎不动，看不出问题；
   *      反过来某一秒正常，均值也升不上去。两头都不准。
   *
   * 现在：维护最近 2 秒的帧计数（滑动窗口），反映真实瞬时帧率。
   * 窗口取 2 秒而不是 1 秒 —— 静止画面下编码器会主动降到 15~20fps
   * 省电，1 秒窗口的抖动太大，2 秒能滤掉这种正常波动。
   */
  get fps () {
    if (!this._startedAt) return 0
    const now = Date.now()
    const WINDOW = 2000
    // 丢弃窗口外的样本
    while (this._fpsSamples.length && now - this._fpsSamples[0].t > WINDOW) {
      this._fpsSamples.shift()
    }
    if (!this._fpsSamples.length) return 0
    const total = this._fpsSamples.reduce((a, s) => a + s.n, 0)
    /**
     * 分母用「窗口内实际跨度」而不是「到现在的跨度」。
     *
     * 踩过的坑：一开始写的是 now - samples[0].t。但最新的样本桶
     * 可能已经是 250ms 前的了（那段没有新帧），于是
     * 「n 帧 / 过长的跨度」把帧率算低；
     * 反过来如果桶刚好新鲜，跨度又偏短，帧率偏高（实测 60fps
     * 被算成 67fps，误差 12%）。
     *
     * 正确做法：跨度取「首样本到末样本 + 一个桶宽」——
     * 末桶里的帧发生在这 250ms 内，算进去才对。
     */
    const firstT = this._fpsSamples[0].t
    const lastT = this._fpsSamples[this._fpsSamples.length - 1].t
    const span = Math.max(250, (lastT - firstT) + 250)
    return total / (span / 1000)
  }

  /** 累加一个帧样本（由 onFrame 调用） */
  _tickFps () {
    const now = Date.now()
    const last = this._fpsSamples[this._fpsSamples.length - 1]
    // 每 250ms 归一个桶，避免每帧都 push 对象
    if (last && now - last.t < 250) last.n++
    else this._fpsSamples.push({ t: now, n: 1 })
    // 兜底：样本数组不会无限增长
    if (this._fpsSamples.length > 40) this._fpsSamples.shift()
  }

  /**
   * ══════════ 启动采集（带一次自动重试）══════════
   *
   * 用户的投诉：「怎么老是第一次启动失败，点一下重连才好」。
   *
   * 根因不是参数错，而是**手机侧残留**：
   * 上一次会话的 scrcpy-server 被强杀后，MediaCodec 归还编码器是异步的
   * （实测 500~1000ms，卡在 native 层时更久）。如果我们紧接着启动，
   * 新 server 抢不到硬编码器 → 一个字节都不写 → 35 秒后判定
   * 「管道连接超时」。而这时手动重试一次，编码器已经空出来了，立刻成功。
   *
   * 所以这里不在上层反复点，而是在采集层自己补一次：
   * 首次超时 → 清手机侧残留 → 等 1.2 秒（给 MediaCodec 归还时间）→ 再试一次。
   *
   * 只对「管道连接超时」重试 —— 设备没插、没授权这类错误重试一百次也没用。
   */
  async start () {
    if (this.running) return { ok: true }

    let r = await this._startOnce()
    if (r.ok) return r

    if (!/管道连接超时/.test(r.error || '')) return r

    this.log('首次启动失败（' + r.error + '），清理手机侧残留后重试一次')
    try { await this._killPhoneServer() } catch {}
    await new Promise(res => setTimeout(res, 1200))

    r = await this._startOnce()
    if (r.ok) {
      this.log('重试成功')
    } else {
      this.log('重试仍失败：' + (r.error || ''))
    }
    return r
  }

  async _startOnce () {
    if (this.running) return { ok: true }
    this._sawData = false
    try {
      /**
       * 清掉上一次会话残留的 scrcpy 进程。
       *
       * 异常退出（崩溃、被强杀、调试中断）会留下孤儿进程，
       * 它们继续占着设备的编码器，而且 —— 如果旧版本用的是
       * --no-playback 而不是 --no-window —— 还会在屏幕上留下
       * 一个空的 scrcpy 窗口。
       *
       * 这里按「命令行里带我们的管道名前缀」精确匹配，
       * 不会误杀用户自己开的 scrcpy。
       */
      await this._killStale()

      /**
       * ══════════ 管道名必须每次都不一样 ══════════
       *
       * 踩过的坑：原来写的是 `miniwin-stream-${process.pid}` ——
       * 同一个进程内「降档重启」时 pid 不变，管道名也不变。
       * 而 stop() 里 server.close() 是异步的，句柄要等事件循环
       * 转一圈才真正释放。紧接着的 start() 立刻 listen 同一个名字：
       *
       *   listen EADDRINUSE: address already in use
       *   \\.\pipe\miniwin-stream-106080
       *
       * 结果是「重开迷你窗失败」，日志里刷几十条，得手动杀进程才好。
       *
       * 现在加一个自增序号：同一个进程内每次启动都是新名字，
       * 旧管道的释放和新管道的创建彻底解耦。序号只用于管道，
       * 不影响 _killStale 的匹配（它只看前缀）。
       */
      this._seq = (this._seq || 0) + 1
      this.pipeName = `\\\\.\\pipe\\miniwin-stream-${process.pid}-${this._seq}`

      // 1. 建管道，等 scrcpy 连上
      const pipeReady = this._createPipe()

      // 2. 起 scrcpy
      const args = [
        /**
         * --no-window 必须加，不能只用 --no-playback。
         *
         * 踩过的坑：以为 --no-playback 就等于「不要窗口」，结果
         * scrcpy 照样创建了一个标题为设备名的空窗口，里面显示它
         * 自带的 Android 图标占位图 —— 用户看到屏幕上莫名多出
         * 一个绿机器人窗口，不知道哪来的。
         *
         * --no-window 才是「完全不建窗口」，它同时隐含
         * --no-video-playback。我们只要它往管道里录流，
         * 窗口纯属多余。
         */
        '--no-window',
        '--no-audio',
        '--record', this.pipeName,
        '--record-format', 'mkv',
        '--max-size', String(this.maxSize),
        '--video-bit-rate', this.bitRate,
        '--max-fps', String(this.maxFps),
        /**
         * I 帧间隔缩到 1 秒（默认 2 秒）。
         *
         * 意义全在「丢帧后的恢复速度」上：
         * 我们的背压策略是一丢帧就丢弃后续所有 P 帧、等下一个 IDR
         * （因为 P 帧参考链断了，硬解只会得到花屏）。
         * 所以 IDR 来得越快，画面恢复越快：
         *
         *   默认 2 秒 → 最长定格 2 秒
         *   改成 1 秒 → 最长定格 1 秒
         *
         * 代价是码率略升（多一倍关键帧），实测在 16M 下完全看不出
         * 差别 —— 换 1 秒的恢复时间很值。
         *
         * 这两个参数名是 Android MediaFormat 的 key，
         * 通过 scrcpy 的 --video-codec-options 透传给设备端编码器。
         */
        '--video-codec-options', 'i-frame-interval=1'
      ]
      if (this.serial) args.unshift('--serial', this.serial)

      this.log('启动 scrcpy（管道输出）')
      this.log('管道名=' + JSON.stringify(this.pipeName))
      this.log('参数=' + JSON.stringify(args.slice(0, 8)))
      this.proc = spawn(this.scrcpy, args, { windowsHide: true })

      /**
       * 诊断：spawn 后立即看进程是否真的起来了。
       *
       * 重连场景下曾经出现「日志停在『管道就绪』，但 scrcpy 进程不存在」，
       * 而 stderr 里什么都没打 —— 说明进程可能在 spawn 阶段就失败了，
       * 或者启动后极短时间内被外部杀掉。
       *
       * 这两行能区分「没启动」和「启动后被杀了」。
       */
      if (this.proc.pid) {
        this.log(`scrcpy 进程已创建 pid=${this.proc.pid}`)
      } else {
        this.log('scrcpy 进程创建失败（pid 为空）')
      }
      this.proc.on('spawn', () => this.log(`scrcpy spawn 事件 pid=${this.proc && this.proc.pid}`))
      this.proc.stderr.on('data', d => {
        const s = d.toString().trim()
        if (!s) return
        // 只报关键信息，避免刷屏
        if (/error|warn|fail/i.test(s)) this.log('[scrcpy] ' + s.slice(0, 160))
      })
      /**
       * scrcpy 退出 —— 这里必须上报，不能只是置个 flag。
       *
       * ── 踩过的坑（用户原话：「我拔掉 usb 画面直接断开了」）──
       *
       * 原来的实现：
       *   this.proc.on('exit', (code) => {
       *     if (this.running) this.log(`scrcpy 退出 (code=${code})`)
       *     this.running = false        ← 就这样，没了
       *   })
       *
       * 拔掉 USB 后 adb 通道消失 → scrcpy 打印 Device disconnected
       * → 进程退出 → 这里把 running 置 false → **然后什么都发生了**。
       * 画面停在最后一帧，看起来像卡死，用户只能手动点重连。
       *
       * 现在改成回调 onExit，让上层（main.js）去决定是否重连 ——
       * 采集层不该自己管重连策略（它不知道设备列表、不知道用户意图）。
       */
      this.proc.on('exit', (code) => {
        const wasRunning = this.running
        this.running = false
        if (wasRunning) {
          this.log(`scrcpy 退出 (code=${code})`)
          if (this.onExit) {
            try { this.onExit(code) } catch {}
          }
        }
      })

      // 3. 等管道连接 + 首帧
      const ok = await pipeReady
      if (!ok) {
        await this.stop()
        return { ok: false, error: '管道连接超时（检查设备是否连接）' }
      }

      this.running = true
      this._startedAt = Date.now()
      // 重连/换档时清空帧样本，否则滑动窗口里还留着上一次的桶
      this._fpsSamples = []
      this.log('采集已启动（命名管道 + MKV 流式解析）')
      return { ok: true }
    } catch (e) {
      this.log('启动失败: ' + e.message)
      await this.stop()
      return { ok: false, error: String(e.message || e) }
    }
  }

  /**
   * 杀掉本项目残留的 scrcpy 进程 **+ 手机侧的 scrcpy-server**。
   *
   * ── 为什么必须连手机侧一起清 ──
   *
   * scrcpy 的架构是：PC 上的 scrcpy.exe 通过 adb 把 scrcpy-server
   * 推到手机 /data/local/tmp/，用 app_process 跑起来，再由 server
   * 把画面编码后送回来。
   *
   * PC 侧进程被 kill 之后，**手机侧的 server 进程不会跟着死**。
   * 它继续占着 MediaCodec 硬编码器；下一次启动时新的 server 抢不到
   * 编码器，表现就是：
   *
   *   [error] 启动失败: 管道连接超时（检查设备是否连接）
   *
   * 而 adb devices 明明是好着的。这就是「连续切分辨率时后几档
   * 必然失败」的根因 —— 做分辨率切换功能时这里是硬门槛。
   *
   * 修法：清理 PC 侧进程之后，再通过 adb 把手机上的
   * com.genymobile.scrcpy.Server 一起 pkill 掉，并等一下让它彻底退出。
   */
  async _killStale () {
    try {
      const { execFileSync } = require('node:child_process')
      const out = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='scrcpy.exe'\" " +
        "| ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true })

      const pids = []
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\t(.*)$/)
        if (!m) continue
        const pid = parseInt(m[1], 10)
        if (!(pid > 0) || pid === process.pid) continue
        // 只杀我们自己的（命令行里带 miniwin-stream 管道名）
        if (!/miniwin-stream/.test(m[2])) continue
        pids.push(pid)
      }

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
          this.log(`清理残留 scrcpy 进程 ${pid}`)
        } catch {}
      }
      if (pids.length) await new Promise(r => setTimeout(r, 600))
    } catch (e) {
      this.log('残留进程清理失败（不影响本次启动）: ' + (e.message || e))
    }

    await this._killPhoneServer()
  }

  /**
   * 清掉手机侧的 scrcpy-server。
   *
   * ── 为什么这一步这么讲究 ──
   *
   * scrcpy 的 server 是个 app_process 起的 Java 进程，它持有
   * MediaCodec 硬编码器。PC 侧被强杀后它变成孤儿，继续占着编码器，
   * 新 server 抢不到就表现为「管道连接超时」——而 adb devices 好着。
   *
   * ── 三个必须做对的细节 ──
   *
   * ① pkill -f 用 SIGTERM，Java 进程不一定响应
   *    必须 -9 强杀。之前只写 pkill -f，对卡在 native 层（等编码器
   *    的 surface）的进程经常杀不掉。
   *
   * ② 杀完要**验证**，不能只 sleep 一下就当它死了
   *    所以循环 3 次：杀 → 查 → 还在就再杀，每次间隔递增。
   *
   * ③ MediaCodec 的释放是异步的
   *    kill 返回 ≠ 编码器已归还。实测需要等 500~1000ms，
   *    只等 400ms 时偶发「编码器已占用」。
   */
  async _killPhoneServer () {
    if (!this.adb || !this.serial) return
    const { execFile } = require('node:child_process')
    const run = (args) => new Promise(resolve => {
      execFile(this.adb, args, { timeout: 10000, windowsHide: true },
        (err, stdout, stderr) => resolve({ err, out: String(stdout || '') + String(stderr || '') }))
    })

    const countAlive = async () => {
      const r = await run([
        '-s', this.serial, 'shell',
        'ps -A 2>/dev/null | grep -c "[c]om.genymobile.scrcpy" || echo 0'
      ])
      const m = r.out.match(/(\d+)\s*$/)
      return m ? parseInt(m[1], 10) : 0
    }

    try {
      let alive = await countAlive()
      if (alive === 0) {
        // 干净，仍然给编码器一点归还时间
        await new Promise(r => setTimeout(r, 250))
        return
      }

      this.log(`手机侧有 ${alive} 个 scrcpy-server 残留，正在清理`)

      for (let attempt = 0; attempt < 3; attempt++) {
        await run([
          '-s', this.serial, 'shell',
          'pkill -9 -f com.genymobile.scrcpy 2>/dev/null; ' +
          'pkill -9 -f "app_process.*scrcpy" 2>/dev/null; true'
        ])
        await new Promise(r => setTimeout(r, 400))
        alive = await countAlive()
        if (alive === 0) break
        this.log(`第 ${attempt + 1} 次清理后仍有 ${alive} 个，重试`)
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
      }

      if (alive > 0) {
        this.log(`⚠ 手机侧仍有 ${alive} 个 scrcpy-server 无法清理，本次可能启动失败`)
      } else {
        this.log('手机侧已清空')
      }
    } catch {
      // adb 不可用就算了，让后面的 start 自己报错（错误信息更具体）
    }

    // ③ 给 MediaCodec 归还硬编码器的时间
    await new Promise(r => setTimeout(r, 700))
  }

  /** 创建命名管道服务器，返回「拿到首个数据块」的 Promise */
  _createPipe () {
    return new Promise((resolve) => {
      let settled = false
      let done = (v) => { if (!settled) { settled = true; resolve(v) } }

      this.reader = new MkvReader()
      this.reader.onLog = (m) => this.log('[mkv] ' + m)
      this.reader.onSample = (buf, ptsMs, isKey) => {
        // 首次拿到 CodecPrivate → 通知上层 configure
        if (!this.codecPrivate && this.reader.codecPrivate) {
          this.codecPrivate = this.reader.codecPrivate
          this.log(`CodecPrivate ${this.codecPrivate.length}B`)
          if (this.onReady) {
            this.onReady({
              codecPrivate: this.codecPrivate,
              width: this.width,
              height: this.height
            })
          }
        }
        this._frames++
        this._tickFps()
        if (this.onFrame) this.onFrame(buf, ptsMs, isKey)
      }

      this.server = net.createServer(sock => {
        this.sock = sock
        sock.on('data', chunk => {
          try { this.reader.push(chunk) } catch (e) {
            this.log('解析异常: ' + e.message)
          }
          this._sawData = true
          done(true)          // 收到数据就算连上了
        })
        sock.on('error', e => this.log('管道错误: ' + e.message))
        sock.on('close', () => {
          if (this.running) this.log('管道关闭')
        })
      })

      this.server.once('error', (e) => {
        this.log('管道创建失败: ' + e.message)
        done(false)
      })

      this.server.listen(this.pipeName, () => {
        this.log('管道已就绪，等 scrcpy 连接')
      })

      /**
       * ══════════ 超时保护：35 秒，且进程死了就立刻放弃 ══════════
       *
       * 为什么从 20 秒提到 35 秒：
       *
       * 实测这台手机的 scrcpy 首块数据要等 10~14 秒才写出来
       * （它是大缓冲批量落盘，不是流式）。加上 adb push server
       * 约 2~4 秒、server 启动 1~2 秒，20 秒的红线经常不够 ——
       * 表现就是「管道连接超时」但设备明明在线、手动跑又正常。
       *
       * 另外加了「进程存活检查」：如果 scrcpy 进程已经退出，
       * 没必要傻等满 35 秒，直接判失败并重试。
       */
      const HARD_TIMEOUT = 35000
      const timer = setTimeout(() => done(false), HARD_TIMEOUT)

      /**
       * 进程死了就立刻放弃等待。
       *
       * ⚠️ 必须跳过「this.proc 还没赋值」的阶段：
       * _createPipe() 在 spawn 之前就被调用，那时 this.proc 是 null。
       * 早期版本没判这个，于是 500ms 后立刻判定「进程不存在」→
       * 直接判失败，超时设多大都没用（实测 35 秒的设置 10 秒就失败）。
       *
       * 现在：只有当 proc 存在且确实退出过，才算失败。
       */
      /**
       * ⚠️ 只检查「本次 spawn 出来的那个进程」。
       *
       * 踩过的坑（这次是真正的元凶）：
       * _createPipe() 是在 spawn 之前调用的，而 this.proc 此时
       * 仍然指向**上一次会话的旧对象**（已经 exitCode !== null）。
       * 于是 500ms 后这里立刻判定「进程已死」→ done(false) →
       * 上层看到「管道连接超时」。
       *
       * 表现就是：手动跑 scrcpy 18 秒能出 543KB，主进程却
       * 10 秒（其实是 0.5 秒）就报超时 —— 超时设 35 秒完全没用。
       *
       * 现在用 procAtCreate 快照：只认 spawn 之后的那个新进程。
       */
      const procAtCreate = this.proc
      const procWatch = setInterval(() => {
        const p = this.proc
        if (!p) return                                 // spawn 还没发生
        if (p === procAtCreate && procAtCreate !== null) {
          // 还是创建管道时那个旧进程 → 说明 spawn 尚未替换它，继续等
          return
        }
        if (p.exitCode === null && !p.killed) return    // 新进程还活着
        clearInterval(procWatch)
        done(this._sawData === true)
      }, 500)

      const origDone = done
      done = (v) => {
        clearTimeout(timer)
        clearInterval(procWatch)
        origDone(v)
      }
    })
  }

  async stop () {
    this.running = false
    try { if (this.sock) this.sock.destroy() } catch {}
    this.sock = null
    /**
     * close() 之后要等 'close' 事件，句柄才算真的释放。
     *
     * Windows 命名管道被占用时不会立刻归还 —— 只调 close() 不 await，
     * 紧接着 listen 同一个名字就会 EADDRINUSE。虽然现在管道名带序号
     * 已经不会再撞，但这里等一等能让「连续重启」的时序更干净，
     * 也少一处在事件循环里飘着的句柄。
     */
    const srv = this.server
    this.server = null
    if (srv) {
      try {
        await new Promise((resolve) => {
          let done = false
          const fin = () => { if (!done) { done = true; resolve() } }
          srv.once('close', fin)
          srv.close(fin)
          // 兜底：万一 'close' 不触发（句柄已经烂掉），最多等 300ms
          setTimeout(fin, 300)
        })
      } catch {}
    }
    try { if (this.proc) this.proc.kill() } catch {}
    this.proc = null
    this.reader = null
  }
}

module.exports = { ScrcpyCapture }
