/* ── 代理绕过：本机与局域网请求不走代理 ──
 *
 * 用户开着本地代理时，Node 的 fetch/http 会读 HTTP_PROXY 环境变量，
 * 把 127.0.0.1 和 172.31.* 的请求也转发给代理 —— 必然失败。
 * 这里把回环和私有网段加入 NO_PROXY，保证本地链路直连。
 */
;(function () {
  const KEEP = '127.0.0.1,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'
  process.env.NO_PROXY = process.env.NO_PROXY ? process.env.NO_PROXY + ',' + KEEP : KEEP
  process.env.no_proxy = process.env.NO_PROXY
  delete process.env.HTTP_PROXY
  delete process.env.http_proxy
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  delete process.env.ALL_PROXY
  delete process.env.all_proxy
})()

/**
 * WiFi 接收端：监听 TCP，接收手机 App 推来的 H.264（帧头协议见 StreamActivity），
 * 转成本地 HTTP 轮询源，让 miniwin-stream 的窗口显示画面。
 *
 * 与真机 scrcpy 的关系：手机 App 编码出的就是 Annex-B AU（多 slice 已由
 * 编码器组装好），帧头格式对齐 ScrcpyParser 期望的 stage，所以这里直接
 * 复用 ScrcpyParser 解析 + frameToAvcc 转换 + 现有迷你窗渲染。
 */
const http = require('http')
const net = require('net')
const { ScrcpyParser } = require('./streamer.js')
const { makeDescriptionFromConfig, frameToAvcc } = require('./avcc.js')
const { AuAssembler, auToAnnexB } = require('./au.js')

/**
 * 端口约定：接收端 TCP = LAN 端口 + 1，HTTP = LAN 端口 + 2。
 * deep-link 路由（/deep-link）用同一公式算出给 App 的端口，两边必须一致。
 * 命令行 --lan <端口> 时自动对齐；否则用默认 27190/27191。
 */
let LISTEN_PORT = Number(process.argv[2] || 27190)
let HTTP_PORT = Number(process.argv[3] || 27191)
const lanIdx = process.argv.indexOf('--lan')
if (lanIdx >= 0 && process.argv[lanIdx + 1]) {
  const lanPort = Number(process.argv[lanIdx + 1])
  if (lanPort > 0) {
    LISTEN_PORT = lanPort + 1
    HTTP_PORT = lanPort + 2
  }
}
/* 2.0：命令行传 adb 路径与 server jar（供零 APK 配对页使用） */
let ADB_PATH = process.argv[4] || 'adb'
let SERVER_JAR = process.argv[5] || ''

const state = {
  codecString: null,
  description: null,
  videoSize: null,
  frames: 0,
  dropped: 0,
  lastFrame: null,     // { data(Uint8Array), pts, key }
  lastKey: null,       // 最后一个 IDR，渲染层启动时补帧用
  seq: 0,              // 帧序列号，渲染层据此跳过重复帧
  /**
   * 待取帧队列。渲染层按 seq 顺序消费，保证 P 帧参考链完整。
   * 详见 TCP 帧处理处的注释 —— 这是修花屏的关键结构。
   */
  queue: [],
  /**
   * 等待中的长轮询回调。
   *
   * /frames 在队列空时会把响应挂起，把「来帧了就叫我」这个回调存在这里。
   * TCP 收到新帧时遍历唤醒，实现「零往返延迟」的推送效果。
   */
  waiters: [],

  /* ---- 音频 ---- */
  hasAudio: false,
  audioConfig: null,     // AudioSpecificConfig 原始字节
  audioQueue: [],
  audioWaiters: [],
  audioFrames: 0,
  /** 手机上报的音量（0..255）。音量键 = 电脑音量遥控器 */
  phoneVolume: 0,
  fps: 0,
  connected: false,
  startedAt: Date.now()
}

// ── TCP 接收：手机 App 推流到这里 ──
const tcpServer = net.createServer(sock => {
  sock.setNoDelay(true)
  state.connected = true
  state.frames = 0
  // 新连接从干净状态开始：旧队列里的帧属于上一路流，seq 也对不上
  state.queue.length = 0
  state.seq = 0
  state.dropped = 0
  state.lastFrame = null
  state.lastKey = null
  // 音频同样重置 —— 新连线的音频参数可能不同（换了设备/采样率）
  state.audioQueue.length = 0
  state.audioFrames = 0
  state.audioConfig = null
  state.hasAudio = false
  console.log('[tcp] 手机已连接 ' + sock.remoteAddress)

  const parser = new ScrcpyParser({ sendDummyByte: false, sendStreamMeta: false, sendDeviceMeta: false })
  const auAsm = new AuAssembler()
  let sawKey = false
  let buf = Buffer.alloc(0)

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    // 12 字节帧头循环切
    for (;;) {
      if (buf.length < 12) break
      const tag = buf.readBigUInt64BE(0)
      const size = buf.readUInt32BE(8)
      if (buf.length < 12 + size) break
      const payload = buf.subarray(12, 12 + size)
      buf = buf.subarray(12 + size)

      const isConfig = (tag & 0x4000000000000000n) !== 0n
      const isKey = (tag & 0x8000000000000000n) !== 0n
      /**
       * 音频标志。
       *
       * App 把视频和音频复用同一条 TCP（省端口，也天然对齐时间轴），
       * 靠帧头 tag 里的这一位区分：置位 = AAC 音频，不置位 = H.264 视频。
       *
       * 音频帧不能走 frameToAvcc（那是 H.264 的 Annex-B → AVCC 转换），
       * 也不参与关键帧/参考链逻辑，直接原样丢进音频队列。
       */
      const isAudio = (tag & 0x2000000000000000n) !== 0n
      const pts = Number(tag & 0x1fffffffffffffffn) / 1000   // 纳秒 → 微秒

      if (isAudio) {
        if (isConfig) {
          /**
           * AudioSpecificConfig（AAC 解码器初始化参数）。
           *
           * 通常是 2 字节，包含 object type / 采样率索引 / 声道数。
           * 渲染层用 WebCodecs 的 AudioDecoder 时需要它作为 description，
           * 不给的话 configure 会失败或解出噪音。
           */
          state.audioConfig = Buffer.from(payload)
          state.hasAudio = true
          console.log('[tcp] 音频配置 ' + payload.length + ' 字节: ' +
            Buffer.from(payload).toString('hex'))
          continue
        }

        /**
         * 音量控制消息：手机音量键 → 电脑音量。
         *
         * 特征是 size==1（AAC 帧都是几十字节起）。
         * 1 字节负载 = 归一化音量 0..255。
         *
         * 不进音频队列（那会当成一帧 AAC 解出噪音），
         * 存到 state.phoneVolume，渲染层通过 /meta 或
         * 音量拉流响应头拿到后同步滑块。
         */
        if (payload.length === 1) {
          state.phoneVolume = payload[0]
          continue
        }

        state.hasAudio = true
        state.audioFrames++
        /**
         * 音频队列 —— 保持很短。
         *
         * 音频对延迟极其敏感：队列里每积一帧就是 23ms 的延迟。
         * 120 帧的旧上限 = 2.8 秒的延迟，完全不可接受。
         *
         * 现在压到 8 帧（约 185ms）。超过就丢最旧的 ——
         * 音频丢一小段听感上是轻微「跳」一下，
         * 比听到几秒前的声音好得多。
         *
         * 渲染端是长轮询（来帧就取），正常情况下队列始终接近空，
         * 这个上限只是兜底。
         */
        state.audioQueue.push({ data: Buffer.from(payload), pts })
        if (state.audioQueue.length > 8) {
          state.audioQueue.splice(0, state.audioQueue.length - 8)
          state.audioDropped = (state.audioDropped || 0) + 1
        }
        /**
         * 唤醒挂起的拉流请求 —— 但延迟 35ms。
         *
         * 立刻唤醒的话队列里通常只有刚到的这 1 帧（23ms 音频），
         * 渲染端一趟往返只拿走 1 帧，实测吞吐掉到 14 帧/秒
         * （生产是 43）—— 一半以上的音频在传输层就被节奏差吃掉了。
         *
         * 延 35ms 给队列一个攒帧窗口（通常能攒 1~2 帧），
         * 每批平均 2~3 帧，吞吐回升到 30+/s。
         * 35ms 远小于渲染端 jitter buffer 的 90ms 缓冲，无感。
         */
        if (state.audioWaiters.length) {
          setTimeout(() => {
            const ws = state.audioWaiters.slice()
            for (const w of ws) { try { w() } catch {} }
          }, 35)
        }
        continue
      }

      if (isConfig) {
        // App 的 codec config 是 SPS+PPS 的 Annex-B
        const info = makeDescriptionFromConfig(payload)
        if (info) {
          state.codecString = info.codecString
          state.description = info.description
          console.log('[tcp] codec ' + info.codecString)
        }
        continue
      }

      // 普通帧：payload 是一个完整 AU（编码器已按 AU 输出）
      const packed = frameToAvcc(payload)
      if (!packed) continue
      // 诊断：前 20 帧打印 key 标志
      if (state.frames < 20) {
        console.log('[tcp] 帧' + state.frames + ' key=' + packed.key +
          ' nal0=' + (packed.data.length > 4 ? (packed.data[4] & 0x1f) : '?') +
          ' len=' + packed.data.length)
      }
      if (!sawKey) {
        if (!packed.key) {
          // 关键帧判定兜底：AVCC 首个 NAL 类型 5 = IDR。
          // 有些编码器（华为/海思）不置 BUFFER_FLAG_SYNC_FRAME，
          // 只能靠 NAL 类型判断。
          if (packed.data.length > 4 && (packed.data[4] & 0x1f) === 5) {
            console.log('[tcp] 通过 NAL 类型识别到关键帧（编码器未置 SYNC 标志）')
            packed.key = true
          } else {
            continue
          }
        }
        sawKey = true
        console.log('[tcp] 首个关键帧')
      }
      if (!state.videoSize) state.videoSize = { w: 720, h: 1600 }
      state.frames++
      // 用 NAL 类型判 IDR：AVCC 首 NAL（跳过 4 字节长度）type==5
      const isIdr = packed.data.length > 4 && (packed.data[4] & 0x1f) === 5
      const seq = ++state.seq
      state.lastFrame = { data: packed.data, pts, key: isIdr, seq }

      /**
       * 帧队列 —— 修花屏的核心。
       *
       * 之前 /frame 只返回「最新那一帧」。渲染层每次轮询拿到的都是当前槽位，
       * 轮询间隔一旦大于编码间隔，中间的 P 帧就被**整段跳过**。
       *
       * H.264 的 P 帧是帧间预测编码，必须按顺序解码：
       * 丢了中间帧不是「卡一下」，而是参考图像全错 ——
       * 屏幕上直接出现绿块、灰块、上一帧残影错位，也就是花屏。
       *
       * 所以这里改成有界队列，渲染层按 seq 顺序往后取，
       * 只要它跟得上就一帧不丢，花屏自然消失。
       *
       * 队列上限 90 帧（30fps 下约 3 秒）：正常延迟远低于此，
       * 真的积压到上限说明渲染端已经跟不上了，丢掉最旧的并打标记，
       * 让渲染层知道「参考链断了，必须等下一个 IDR」。
       */
      state.queue.push({ data: packed.data, pts, key: isIdr, seq })
      if (state.queue.length > 90) {
        state.queue.shift()
        state.dropped++
      }

      /**
       * 有新帧 → 立刻唤醒挂起的 /frames 请求。
       *
       * 这就是「推」而不是「拉」：渲染层不用每 16ms 空轮询一次，
       * 而是一帧到达就马上拿到。省掉的是每个往返 3~8ms 的开销，
       * 30fps 下相当于抢回 20% 的时间预算。
       *
       * 复制一份再遍历：回调里会自己从 waiters 里移除，直接遍历会跳过元素。
       */
      if (state.waiters.length) {
        const ws = state.waiters.slice()
        for (const w of ws) {
          try { w() } catch {}
        }
      }
      /**
       * 单独保存最后一个 IDR。
       *
       * 渲染层 configure() 后必须先吃关键帧才能解码，而 /frame 只留最新一帧，
       * 轮询极容易错过 2 秒才出现一次的 IDR —— 实测一直 decoded=0。
       * 提供 /keyframe 让渲染层启动时先补一个关键帧。
       */
      if (isIdr) state.lastKey = { data: packed.data, pts, key: true, seq }
    }
  })

  sock.on('close', () => { state.connected = false; console.log('[tcp] 断开') })
  sock.on('error', e => console.log('[tcp] 错误: ' + e.message))
})

tcpServer.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log('[tcp] 监听 0.0.0.0:' + LISTEN_PORT + '（手机 App 推流到这里）')
})

// ── HTTP：给迷你窗拉帧 ──
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')
  const u = new URL(req.url, 'http://x')

  if (u.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      codecString: state.codecString,
      description: state.description ? Array.from(state.description) : null,
      videoSize: state.videoSize,
      // 音频信息一起返回，渲染层可以据此决定要不要起音频链路
      hasAudio: state.hasAudio,
      audioConfigLen: state.audioConfig ? state.audioConfig.length : 0
    }))
    return
  }

  /**
   * 批量取帧 —— 渲染层的唯一取帧入口。
   *
   * 一次返回队列里最多 N 帧（默认 12），按 seq 升序。
   * 这样即使轮询是 60ms 一次、编码是 33ms 一帧，也能一次把中间攒的
   * 两三帧全取走，P 帧参考链不会断 —— 花屏就没了。
   *
   * **长轮询**：队列空的时候不立刻回 204，而是把响应挂起来，
   * 最多等 timeout 毫秒；期间一有帧进来就马上返回。
   *
   * 为什么必须这样做：
   * 之前是「立刻返回 204 → 渲染层再发一次请求」的忙轮询。
   * 每次往返（HTTP 握手 + 头部 + 空响应）大约 3~8ms，
   * 而一帧的编码间隔只有 33ms —— 光往返就吃掉了三分之一的时间窗，
   * 实测帧率在 0 / 63 / 4.5 之间乱跳。
   * 改成挂起式之后，一次请求拿到新帧就返回，没有无效往返。
   */
  if (u.pathname === '/frames' || u.pathname === '/frames-next') {
    const n = Math.max(1, Math.min(60, Number(u.searchParams.get('n') || 12)))
    const waitMs = Math.max(0, Math.min(3000, Number(u.searchParams.get('wait') || 500)))

    const flush = () => {
      const out = state.queue.splice(0, n)
      if (!out.length) return false

      // 4 + 每帧(4B seq + 4B len) + 数据
      let total = 4
      for (const f of out) total += 8 + f.data.length
      const buf = Buffer.allocUnsafe(total)
      let off = 0
      buf.writeUInt32BE(out.length, off); off += 4
      for (const f of out) {
        buf.writeUInt32BE(f.seq >>> 0, off); off += 4
        buf.writeUInt32BE(f.data.length, off); off += 4
        Buffer.from(f.data).copy(buf, off)
        off += f.data.length
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(total),
        'Cache-Control': 'no-store',
        'X-Count': String(out.length),
        'X-Dropped': String(state.dropped),
        'X-First-Seq': String(out[0].seq),
        'X-Last-Seq': String(out[out.length - 1].seq)
      })
      res.end(buf)
      return true
    }

    // 有货就直接给
    if (flush()) return

    /**
     * 没货：挂起等待。
     *
     * 用数组存回调而不是只存一个 —— 万一有两端同时请求（比如小窗重连期间
     * 旧的请求还没断），都该被唤醒，否则会有一个永远挂着。
     */
    let done = false
    const waiter = () => {
      if (done) return
      if (flush()) {
        done = true
        cleanup()
      }
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      // 超时：回 204，渲染层立刻再发一次（此时通常已有新帧）
      try {
        res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Dropped': String(state.dropped) })
        res.end()
      } catch {}
    }, waitMs)

    const cleanup = () => {
      clearTimeout(timer)
      const i = state.waiters.indexOf(waiter)
      if (i >= 0) state.waiters.splice(i, 1)
    }

    state.waiters.push(waiter)
    // 客户端提前断开也要清理，不然 waiters 会越积越多
    res.on('close', () => {
      if (done) return
      done = true
      cleanup()
    })
    return
  }

  if (u.pathname === '/frame') {
    const f = state.lastFrame
    if (!f) {
      res.writeHead(204)
      res.end()
      return
    }
    /**
     * 带序列号返回。
     * 渲染层轮询很快，会反复拿到同一帧；重复喂给解码器会导致
     * "Decoding error" 然后 closed（实测只解 5 帧就崩）。
     * 渲染层靠 X-Seq 跳过重复帧。
     */
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Seq': String(f.seq)
    })
    res.end(Buffer.from(f.data))
    return
  }

  /** 最后一个 IDR 关键帧。渲染层启动时先 GET 这个补帧。 */
  if (u.pathname === '/keyframe') {
    const k = state.lastKey
    if (!k) {
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Seq': String(k.seq)
    })
    res.end(Buffer.from(k.data))
    return
  }

  /**
   * 音频批量取帧 —— 和 /frames 完全同构（长轮询 + 二进制容器）。
   *
   * 容器格式：[4B 帧数][每帧: 8B pts(微秒) | 4B 长度 | 数据]
   * pts 用 float64 存微秒，因为音频包间隔不均匀，需要时间戳来
   * 驱动 AudioDecoder 和音频时钟，不能像视频那样用「到达时间」凑。
   */
  if (u.pathname === '/audio') {
    const n = Math.max(1, Math.min(120, Number(u.searchParams.get('n') || 24)))
    const waitMs = Math.max(0, Math.min(3000, Number(u.searchParams.get('wait') || 800)))

    const flush = () => {
      const out = state.audioQueue.splice(0, n)
      if (!out.length) return false
      let total = 4
      for (const f of out) total += 12 + f.data.length
      const buf = Buffer.allocUnsafe(total)
      let off = 0
      buf.writeUInt32BE(out.length, off); off += 4
      for (const f of out) {
        buf.writeDoubleBE(f.pts || 0, off); off += 8
        buf.writeUInt32BE(f.data.length, off); off += 4
        f.data.copy(buf, off); off += f.data.length
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(total),
        'Cache-Control': 'no-store',
        'X-Count': String(out.length)
      })
      res.end(buf)
      return true
    }

    if (flush()) return

    let done = false
    const waiter = () => {
      if (done) return
      if (flush()) { done = true; cleanup() }
    }
    const cleanup = () => {
      clearTimeout(timer)
      const i = state.audioWaiters.indexOf(waiter)
      if (i >= 0) state.audioWaiters.splice(i, 1)
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      try { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end() } catch {}
    }, waitMs)

    state.audioWaiters.push(waiter)
    res.on('close', () => { if (!done) { done = true; cleanup() } })
    return
  }

  /** 音频解码器初始化参数（AudioSpecificConfig） */
  if (u.pathname === '/audio-config') {
    if (!state.hasAudio || !state.audioConfig) {
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(state.audioConfig.length),
      'Cache-Control': 'no-store'
    })
    res.end(state.audioConfig)
    return
  }

  /* ══════════ 2.0：网页配对 + 零 APK 直连 ══════════ */

  /** 配对页（手机扫码后打开的页面，GET） */
  if (u.pathname === '/pair' && req.method === 'GET') {
    const { pairPageHtml } = require('./pair-page.js')
    const html = pairPageHtml(state.lanIp || '本机', LISTEN_PORT + 2)
    const buf = Buffer.from(html, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(buf.length), 'Cache-Control': 'no-store' })
    res.end(buf)
    return
  }

  /**
   * POST /pair —— 手机网页提交配对码，PC 执行 adb pair。
   *
   * body: { addr: "172.31.100.199:38571", code: "123456" }
   * 成功返回 { ok:true, stage:'paired', wlanPort } —— 页面随后调 /start-zero
   */
  if (u.pathname === '/pair' && req.method === 'POST') {
    let body = ''
    req.on('data', d => { body += d; if (body.length > 4096) req.destroy() })
    req.on('end', async () => {
      try {
        const j = JSON.parse(body)
        const addr = String(j.addr || '').trim()
        const code = String(j.code || '').trim()
        if (!/^\d+\.\d+\.\d+\.\d+:\d+$/.test(addr) || !/^\d{6}$/.test(code)) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '参数格式错误' }))
          return
        }
        const adbPath = ADB_PATH
        const { execFile } = require('child_process')
        const run = (args, timeout = 20000) => new Promise((resolve, reject) => {
          execFile(adbPath, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim()))
            else resolve(String(stdout || '').trim())
          })
        })

        // 1. adb pair
        const pairOut = await run(['pair', addr, code])
        if (!/Successfully paired|paired with/i.test(pairOut)) {
          throw new Error('配对失败: ' + pairOut.slice(0, 120))
        }
        state.pairIp = addr.split(':')[0]

        // 2. 查无线调试的 connect 端口（配对端口 ≠ 连接端口）
        //    mDNS 服务 _adb-tls-connect._tcp 会广播真实端口；这里先试常用端口段
        let wlanPort = 0
        for (const p of [5555, addr.split(':')[1]]) {
          const r = await run(['connect', `${state.pairIp}:${p}`], 8000).catch(() => '')
          if (/connected to/i.test(r)) { wlanPort = Number(p); break }
        }
        if (!wlanPort) {
          // 5555 不通时提示用户查看「无线调试」主页面的端口
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, stage: 'paired', needPort: true,
            error: '配对成功，但未找到连接端口。请查看「无线调试」主页面显示的 IP 地址和端口（不是配对页的端口）' }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, stage: 'paired', wlanPort, phoneIp: state.pairIp }))
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      }
    })
    return
  }

  /**
   * POST /start-zero —— 配对完成后启动零 APK 投屏。
   *
   * body: { phoneIp, wlanPort? } —— 用户可在页面补填「无线调试主页面」的端口
   * 流程：adb connect → ScrcpyTransport.start() → 视频帧推入渲染管线
   */
  if (u.pathname === '/start-zero' && req.method === 'POST') {
    let body = ''
    req.on('data', d => { body += d; if (body.length > 4096) req.destroy() })
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}')
        const adbPath = ADB_PATH
        const { execFile } = require('child_process')
        const run = (args, timeout = 20000) => new Promise((resolve, reject) => {
          execFile(adbPath, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim()))
            else resolve(String(stdout || '').trim())
          })
        })

        let ip = j.phoneIp || state.pairIp
        let port = Number(j.wlanPort || 5555)
        if (!ip) throw new Error('缺少手机地址')

        // 尝试连接（可能要试多个端口：用户补填的优先）
        let connected = false
        const tryPorts = j.wlanPort ? [port] : [port, 5555, 37123, 40123, 42123]
        for (const p of tryPorts) {
          const r = await run(['connect', `${ip}:${p}`], 8000).catch(() => '')
          if (/connected to/i.test(r)) { port = p; connected = true; break }
        }
        if (!connected) throw new Error('无法连接手机。请查看「无线调试」主页面上的端口并填入上方输入框')

        // 启动 scrcpy 传输（零 APK：视频+控制）
        const { ScrcpyTransport } = require('./scrcpy-transport.js')
        if (state.transport) { try { await state.transport.stop() } catch {} }
        const t = new ScrcpyTransport({
          adb: adbPath,
          serial: `${ip}:${port}`,
          serverJar: SERVER_JAR,
          maxSize: 720, bitRate: 6000000, maxFps: 30
        })
        t.onLog(m => console.log('[2.0]', m))
        // 视频帧直接进渲染管线（与 1.x App 推流同一出口）
        t.onVideo(f => {
          if (f.type === 'config') {
            // SPS/PPS → 生成 description 供渲染层 configure
            try {
              const info = makeDescriptionFromConfig(f.data)
              if (info) {
                state.codecString = info.codecString
                state.description = info.description
                console.log('[2.0] codec ' + info.codecString)
              }
            } catch {}
            return
          }
          const seq = ++state.seq
          state.lastFrame = { data: f.data, pts: 0, key: f.type === 'key', seq }
          state.queue.push({ data: f.data, pts: 0, key: f.type === 'key', seq })
          if (state.queue.length > 90) { state.queue.shift(); state.dropped++ }
          if (state.waiters.length) {
            const ws = state.waiters.slice()
            for (const w of ws) { try { w() } catch {} }
          }
        })
        const r = await t.start()
        if (!r.ok) throw new Error('传输启动失败: ' + (r.error || ''))

        state.zeroMode = true
        state.hasAudio = false    // 2.0 音频暂缺（华为 audio socket 兼容问题）
        console.log('[2.0] 零 APK 投屏已启动')

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, videoW: t.videoW, videoH: t.videoH }))
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      }
    })
    return
  }
  if (u.pathname === '/meta') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      frames: state.frames,
      connected: state.connected,
      codecString: state.codecString,
      videoSize: state.videoSize,
      hasAudio: state.hasAudio,
      audioFrames: state.audioFrames,
      audioConfigLen: state.audioConfig ? state.audioConfig.length : 0,
      phoneVolume: state.phoneVolume,
      uptime: Math.round((Date.now() - state.startedAt) / 1000)
    }))
    return
  }

  res.writeHead(404)
  res.end()
})

/**
 * 2.0：HTTP 改绑 0.0.0.0。
 *
 * 之前只绑 127.0.0.1（迷你窗在本机拉流就够了）。2.0 的配对页 /pair
 * 要让手机浏览器直接访问 —— 扫码后的 URL 是
 * http://<PC局域网IP>:HTTP_PORT/pair，必须绑通配地址。
 * 数据端点（/audio /frames）无鉴权但仅局域网可达，与 LAN server 一致。
 */
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('[http] 监听 0.0.0.0:' + HTTP_PORT + '（迷你窗拉流 + 2.0 配对页）')
  console.log('')
  console.log('把下面两个数字告诉手机 App：')
  console.log('  host = 本机任一局域网 IP（172.31.100.174）')
  console.log('  port = ' + LISTEN_PORT)
})

// 1 秒窗口统计
setInterval(() => {
  const prev = state._f || 0
  state.fps = state.frames - prev
  state._f = state.frames
}, 1000)






