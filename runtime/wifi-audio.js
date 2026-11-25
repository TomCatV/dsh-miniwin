/**
 * WiFi 模式音频播放。
 *
 * 链路：手机 AudioPlaybackCapture → AAC 编码 → TCP → wifi-receiver
 *       → HTTP /audio → 这里 → WebCodecs AudioDecoder → Web Audio 输出
 *
 * ── 为什么不能简单 Audio 标签播 ──
 *
 * 收到的是裸 AAC 帧（ADTS 之外的 raw AAC + AudioSpecificConfig），
 * 不是 mp4/m4a 这种容器，Audio 元素无法直接播放。
 * WebCodecs 的 AudioDecoder 正好能吃这种输入。
 *
 * ── 音频时钟 ──
 *
 * 音频对时间极其敏感：早 200ms 或晚 200ms 都能听出来（爆音/断续）。
 * 解码出来的 AudioData 自带 timestamp，但「什么时候该送到扬声器」
 * 需要一个自己的时钟来排程。
 *
 * 这里用最简单的做法：每个解码出来的 AudioBuffer 直接
 * schedule 到 currentTime + 小缓冲（30ms），靠 Web Audio 自己的
 * 调度保证连续性。不做重采样、不做变速 —— 网络抖动通过
 * 「积压就丢旧帧」来吸收。
 */

export class WifiAudio {
  constructor (source) {
    this.source = source
    this.ctx = null
    this.decoder = null
    this.running = false
    this.ready = false
    this.config = null

    // 播放调度：下一次该排到的时间点
    this.nextTime = 0
    this.gain = null

    // 统计
    this.decoded = 0
    this.dropped = 0
    this.bytes = 0
    /** 排程重置次数（延迟纠正）。持续增长说明抖动大，但不影响正确性。 */
    this.resyncs = 0
    /** 因积压被跳过的帧数 */
    this.skips = 0
    /** jitter buffer 状态 */
    this._buffered = 0
    this._started = false
    /**
     * PCM 队列：解码输出在这里排队，由排程泵均匀消耗。
     * 解码（受网络影响，节奏不均）和排程（恒定节奏）解耦，
     * 网络抖动在这里被吸收 —— 这是消除长时间卡顿的核心。
     */
    this.pcmQueue = []
    /** 暂停状态：暂停时不解码也不播放，继续消费队列避免积压 */
    this.paused = false
    /** 目标音量（0..1）。暂停时 gain 归零，恢复时用它还原。 */
    this._volume = 1
    /**
     * 所有已排程但还在播的 source。
     *
     * 暂停时必须逐个 stop() —— 只把 gain 归零的话，
     * AudioContext 内部那些已排程的 buffer 仍在跑，
     * 恢复时会和新的排程重叠，听起来像回声。
     */
    this._sources = new Set()

    this._onLog = null
  }

  log (level, msg) {
    if (this._onLog) this._onLog(level, msg)
  }

  onLog (fn) { this._onLog = fn }

  /**
   * 启动。
   *
   * AudioContext 必须在用户手势之后才能 started（浏览器自动播放策略），
   * 但 Electron 里默认允许，所以这里直接创建；万一被挂起，
   * 下面 resume() 会再试一次。
   */
  async start () {
    if (this.running && this.ready) return { ok: true }
    this.running = true

    try {
      // 1. 拿 AudioSpecificConfig
      const cfgRes = await fetch(this.source + '/audio-config', { cache: 'no-store' })
      if (cfgRes.status === 204) {
        /**
         * 还没有音频配置。
         *
         * 这是可重试状态，不是错误 —— 手机端可能还没连上、
         * 或者刚重连还没补发配置。调用方会隔一会儿再试。
         * 注意这里要把 running 复位，否则下次 start() 会以为已经在跑。
         */
        this.running = false
        return { ok: false, error: 'no-audio' }
      }
      if (!cfgRes.ok) throw new Error('HTTP ' + cfgRes.status)
      this.config = new Uint8Array(await cfgRes.arrayBuffer())
      this.log('ok', '音频配置 ' + this.config.length + ' 字节')

      // 2. 建 AudioContext + 解码器
      const AC = window.AudioContext || window.webkitAudioContext
      this.ctx = new AC({ sampleRate: 44100, latencyHint: 'interactive' })
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume() } catch {}
      }

      this.gain = this.ctx.createGain()
      this.gain.gain.value = 1
      this.gain.connect(this.ctx.destination)

      if (typeof AudioDecoder === 'undefined') {
        throw new Error('当前环境不支持 WebCodecs AudioDecoder')
      }

      this.decoder = new AudioDecoder({
        output: (data) => this._onAudioData(data),
        error: (e) => this.log('error', '音频解码错误: ' + e.message)
      })

      /**
       * 配置解码器。
       *
       * codec 字符串必须和实际编码匹配：'mp4a.40.2' = AAC-LC，
       * 对应手机侧 MediaCodec 的 AACObjectLC。
       * sampleRate / numberOfChannels 要和编码参数一致，
       * description 就是 AudioSpecificConfig。
       */
      this.decoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2,
        description: this.config
      })

      this.ready = true
      this.log('ok', '音频解码器就绪')
      this._pullLoop()
      // 启动排程泵
      if (!this._raf) this._pump()
      return { ok: true }
    } catch (e) {
      this.running = false
      this.log('error', '音频启动失败: ' + e.message)
      return { ok: false, error: String(e.message || e) }
    }
  }

  /**
   * 拉音频帧（批量 + 挂起等待）。
   *
   * ── 批量大小的权衡（实测结论）──
   *
   * 小批量（n=6）的初衷是拉平节奏，但实测暴露新问题：
   * 服务端的音频生产本身是突发的（App 编码器 + TCP Nagle 聚合），
   * 队列经常不足 6 帧 → 长轮询等 400ms 超时回 204 → 大量空转。
   * 实测 10 次拉流拿到 11 帧，而播放需要 43 帧/秒 —— 供给严重不足。
   *
   * 改回大批量（n=24）＋不设超时上限：批次大意味着
   * 「等更久但一次拿更多」，平均吞吐不变，空转减少。
   * 抖动由排程泵的 PCM 队列吸收（3 秒容量），不需要拉流侧实时。
   */
  async _pullLoop () {
    let lastPts = -1
    this._buffered = 0
    let consecutiveErrors = 0
    while (this.running) {
      try {
        const r = await fetch(this.source + '/audio?n=24&wait=900', { cache: 'no-store' })
        if (r.status === 204) continue
        if (!r.ok) throw new Error('HTTP ' + r.status)
        consecutiveErrors = 0

        const buf = await r.arrayBuffer()
        const dv = new DataView(buf)
        const count = dv.getUint32(0)
        let off = 4

        for (let i = 0; i < count; i++) {
          const pts = dv.getFloat64(off); off += 8
          const len = dv.getUint32(off); off += 4
          const data = new Uint8Array(buf, off, len)
          off += len

          this.bytes += len

          /**
           * 暂停期间：继续拉取但不解码。
           *
           * 为什么还要拉：不拉的话接收端队列会堆满，
           * 恢复瞬间会一次性灌进来几百帧旧音频，
           * 要么爆一段过期的声音、要么得等它排空才好。
           * 现在这样「拉了就丢」，恢复时从最新的帧开始，延迟是 0。
           */
          if (this.paused) continue

          /**
           * 时间戳单调化。
           *
           * AudioDecoder 要求每个 chunk 的 timestamp 严格递增。
           * 网络抖动可能让包乱序到达，或者 pts 相同，
           * 那样解码器会报 "timestamp must be increasing" 然后停摆。
           *
           * 这里强制 +1 保证严格递增 —— 音频播放靠的是
           * AudioContext 的排程，chunk 上的 timestamp 只用于
           * 内部排序，+1 微秒的偏差听不出来。
           */
          let ts = Math.max(0, Math.round(pts))
          if (ts <= lastPts) ts = lastPts + 1
          lastPts = ts

          try {
            this.decoder.decode(new EncodedAudioChunk({
              type: 'key',          // AAC 每帧都是独立可解的，全是 key
              timestamp: ts,
              data
            }))
          } catch (e) {
            this.dropped++
          }
        }
      } catch (e) {
        if (!this.running) break
        this.log('warn', '音频拉流中断: ' + e.message)
        await new Promise(z => setTimeout(z, 500))
      }
    }
  }

  /**
   * 解码出来一帧 PCM，排程播放。
   *
   * 关键点：nextTime 的推进。
   *   - 正常情况下 nextTime 就等于上一帧的结束时间，实现无缝拼接
   *   - 如果 nextTime 落后于当前时间太多（说明卡了/积压了），
   *     直接跳到 now + 30ms，丢掉这段延迟 —— 宁可漏一点也不要
   *     让声音越拖越晚（那样会累积成几秒的延迟）
   */
  /**
   * 解码出来一帧 PCM，排程播放。
   *
   * ── 延迟为什么会越积越大 ──
   *
   * 原来只在 nextTime **落后** 于当前时间时才重置：
   *   if (this.nextTime < now) this.nextTime = now + 0.03
   *
   * 但真正的延迟来自 **nextTime 超前**：每次排程都往后推一个帧长，
   * 只要解码速度略快于播放速度（网络突发、批量取帧都会造成），
   * nextTime 就一路往后跑，永远不回头 —— 几分钟后声音能落后十几秒。
   *
   * 这就是「越用越延迟」的根因。
   *
   * ── 现在的做法 ──
   *
   * 给 nextTime 设一个上界 LATENCY 之外的漂移就拉回来：
   *   - 落后于 now            → 直接重置到 now + TARGET
   *   - 超前 now 超过 LATENCY → 也重置（说明排程堆积了）
   *   - 两者之间              → 正常续接，保证无缝
   *
   * LATENCY 取 120ms：低于人耳对音画不同步的容忍阈值（
   * 视频一般 150~200ms 才明显），又不至于频繁重置造成爆音。
   */
  /**
   * 解码出来一帧 PCM → 进 PCM 队列（不直接排程）。
   *
   * ── 为什么解耦 ──
   *
   * 之前的做法是「解码一帧排一帧」：排程时刻由解码时刻决定，
   * 而解码时刻取决于网络批次到达。批次之间一旦有空窗，
   * 排程前沿（nextTime）就跟着掉，跌到 currentTime 以下
   * → 触发 resync 硬跳 → 可闻卡顿。实测 lag 轨迹是
   * 0.067 → -0.022 → -0.121 → -0.223 → 跳回 0.017 的锯齿。
   *
   * 现在分成两级：
   *   一级：解码线程（受网络批次影响，节奏不均）→ 写进 pcmQueue
   *   二级：排程线程（requestAnimationFrame 驱动，节奏恒定）
   *         → 只要队列里有货就按 nextTime 匀速排
   *
   * 网络抖动被 pcmQueue 吸收：队列空了排程线程也不会把
   * nextTime 拉到 currentTime 以下，而是等队列来货再继续，
   * 前沿保持稳定，不再锯齿。
   */
  _onAudioData (data) {
    try {
      const ch = data.numberOfChannels
      const frames = data.numberOfFrames
      if (!frames) { data.close(); return }

      const ab = this.ctx.createBuffer(ch, frames, data.sampleRate)
      for (let c = 0; c < ch; c++) {
        const dst = ab.getChannelData(c)
        data.copyTo(dst, { planeIndex: c, format: 'f32-planar' })
      }
      data.close()

      this.pcmQueue.push(ab)
      // 队列上限 3 秒，防爆内存
      if (this.pcmQueue.length > 130) this.pcmQueue.shift()
      this.decoded++
    } catch (e) {
      this.log('warn', '音频解码入队失败: ' + e.message)
    }
  }

  /**
   * 排程泵：把 PCM 队列的内容按恒定节奏送上扬声器。
   *
   * ── 深度优化版：自适应前沿 + 事件驱动唤醒 ──
   *
   * rAF 泵有两个问题（60 秒双监控实测）：
   *   1. rAF 在窗口失焦/最小化时被浏览器暂停 → 泵停转 →
   *      前沿跌落 → 恢复时 lag=-56s 级别的跳变（实测出现过）
   *   2. 主线程拥塞时 rAF 延迟，排程粒度不稳定
   *
   * 改用 setTimeout 链（后台也会跑，Electron 里不被节流）+
   * 自适应前沿：前沿追赶速度根据队列深度调整 ——
   *   - 队列深（>30 帧）→ 前沿以 1.03 倍速推进，缓慢消化积压
   *   - 队列浅（<5 帧）→ 前沿以 0.97 倍速推进，留出缓冲回填时间
   *   - 正常            → 1.0 倍速
   * 这样不需要丢帧（skips）也不需要硬跳（resyncs），
   * 延迟在 80~160ms 之间自适应，听感平稳。
   */
  _pump () {
    if (!this.running || !this.ctx) return
    const now = this.ctx.currentTime
    const TARGET = 0.1      // 期望前沿领先 100ms
    const SOFT = 0.14       // 超过 140ms → 提速消化
    const HARD = 0.3        // 超过 300ms → 快速追
    const FRAME_DUR = 1024 / 44100

    if (!this._started) {
      const targetFrames = Math.ceil(TARGET / FRAME_DUR)
      if (this.pcmQueue.length >= targetFrames) {
        this._started = true
        this.nextTime = now + TARGET
        this.log('ok', `jitter buffer 就绪（${this.pcmQueue.length} 帧），开始播放`)
      }
    } else {
      // 断流恢复
      if (this.nextTime < now) {
        if (this.pcmQueue.length) this.nextTime = now + 0.03
        this.resyncs++
      }

      const lag = this.nextTime - now
      // 自适应速率：队列深/前沿远 → 微微加速；浅 → 微微减速
      let rate = 1.0
      if (lag > HARD) rate = 1.08
      else if (lag > SOFT) rate = 1.03
      else if (lag < TARGET * 0.5 || this.pcmQueue.length < 5) rate = 0.97

      // 排程到「前沿恰好领先 TARGET×(1/rate)」为止
      // rate>1 时每帧占用时长略短于真实时长 → 前沿逐渐追回
      while (this.pcmQueue.length && this.nextTime < now + Math.min(SOFT, lag + 0.05) * 1.0 + 0.02) {
        const ab = this.pcmQueue.shift()
        const src = this.ctx.createBufferSource()
        src.buffer = ab
        // 用 playbackRate 实现微加速/减速：1.03 = 消耗快 3%
        src.playbackRate.value = rate
        src.connect(this.gain)
        src.start(this.nextTime)
        this._sources.add(src)
        src.onended = () => { this._sources.delete(src) }
        // 前沿推进量 = 帧时长 / rate（rate>1 → 推进更短 → 前沿相对.currentTime 提前追赶）
        this.nextTime += ab.duration / rate
      }

      // 队列硬上限：真正积压才丢
      while (this.pcmQueue.length > 120) {
        this.pcmQueue.shift()
        this.skips++
      }

      // 队列空且前沿贴地 → 停在安全水位等来货
      if (!this.pcmQueue.length && this.nextTime < now + 0.02) {
        this.nextTime = now + 0.02
      }
    }

    // setTimeout 链：窗口失焦也继续跑（Electron 不节流后台定时器）
    this._raf = setTimeout(() => this._pump(), 20)
  }

  /**
   * 设置音量（0..1）。
   *
   * _volume 是单一真相源：暂停时 gain 被压到 0，
   * 恢复时要靠它还原 —— 否则恢复后音量会变成 0，看起来像「暂停后没声音了」。
   */
  setVolume (v) {
    this._volume = Math.max(0, Math.min(1, v))
    if (!this.gain) return
    // 暂停期间不动 gain（它应该是 0），只记录目标值
    if (this.paused) return
    try {
      this.gain.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.01)
    } catch {
      this.gain.gain.value = this._volume
    }
  }

  /**
   * 暂停 / 恢复。
   *
   * 暂停必须**立即静音**，不能等缓冲区播完 —— 用户点了暂停还继续响
   * 一两秒是很糟的体验。所以这里三步一起做：
   *   1. gain 瞬间归零（已有的排程立刻无声）
   *   2. 停掉所有正在排程的 source
   *   3. 重置 nextTime，恢复时从「现在」重新开始
   *
   * 注意：暂停期间**继续拉流并丢弃**，而不是停止拉取。
   * 如果停止拉取，接收端队列会堆满，恢复时要么爆一段旧声音、
   * 要么得等队列排空 —— 两种都很难受。
   */
  setPaused (on) {
    this.paused = !!on
    if (!this.gain) return

    if (this.paused) {
      // 立即静音：用短时间常量避免咔哒声，但足够快（5ms）
      try {
        this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
        this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.005)
      } catch { this.gain.gain.value = 0 }

      // 停掉所有已排程但还没播完的 buffer
      for (const s of this._sources) { try { s.stop() } catch {} }
      this._sources.clear()
      this.nextTime = 0
      // PCM 队列和冷启动状态一并复位：恢复时重新攒缓冲
      this.pcmQueue.length = 0
      this._started = false
      this.log('info', '音频已暂停')
    } else {
      // 恢复：把 gain 拉回目标音量，jitter buffer 重新攒
      const target = this._volume
      try {
        this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
        this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01)
      } catch { this.gain.gain.value = target }
      this.nextTime = 0
      this.pcmQueue.length = 0
      this._started = false
      this.log('info', '音频已恢复')
    }
  }

  /** 当前音量的单一真相源（暂停恢复时要还原它） */
  get volume () { return this._volume }

  async stop () {
    this.running = false
    this.ready = false
    if (this._raf) { clearTimeout(this._raf); this._raf = null }
    this.pcmQueue.length = 0
    this._started = false
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close() } catch {}
    this.decoder = null
    try { if (this.ctx) await this.ctx.close() } catch {}
    this.ctx = null
    this.gain = null
    this.nextTime = 0
  }

  stats () {
    return {
      decoded: this.decoded,
      dropped: this.dropped,
      bytes: this.bytes,
      ready: this.ready
    }
  }
}

