/**
 * MKV 实时解析器 —— 从「正在写入的 mkv 文件」里抽取 H.264 帧。
 *
 * ══════════ 为什么走这条路 ══════════
 *
 * 我们的 App 用 MediaProjection + createVirtualDisplay 采集，在这台
 * 华为上被系统限流到 4fps（VirtualDisplay 不主动送帧）。而 scrcpy.exe
 * 用 Android 12 的 SurfaceControl 路径，实测能稳定 50fps。
 *
 * 但 scrcpy 只能「录到文件」，不支持输出裸流到 stdout。所以：
 *
 *   scrcpy.exe --no-playback --record live.mkv  （持续写入）
 *        ↓  以共享读方式打开
 *   MkvReader.poll()                            （增量解析）
 *        ↓  SimpleBlock 里的 H.264 数据
 *   现有 WebCodecs 解码链路                      （不用改）
 *
 * ── 为什么 mkv 能实时读而 mp4 不能 ──
 *
 * mp4 的 moov（索引）默认写在文件末尾，录制中读不到；
 * mkv 的 Cluster 是顺序追加的，每个 Cluster 自带时间戳，
 * 边写边读完全没问题。
 *
 * ── EBML 结构（只解析需要的部分）──
 *
 *   1A45DFA3 EBML header
 *   18538067 Segment
 *     1549A966 Info          → TimecodeScale（默认 1000000ns=1ms）
 *     1654AE6B Tracks        → CodecID（V_MPEG4/ISO/AVC）、CodecPrivate
 *     1F43B675 Cluster       → Timecode + 多个 SimpleBlock
 *        A3 SimpleBlock      → [track# vint][2B timecode][1B flags][数据]
 *
 * ── 时间戳换算 ──
 *
 * 帧时间 = (Cluster.Timecode + SimpleBlock.timecode) × TimecodeScale / 1e6
 * 单位毫秒。给渲染层当 pts 用。
 */

const fs = require('fs')

/* EBML Element ID（只列用到的） */
const ID = {
  EBML: 0x1A45DFA3,
  SEGMENT: 0x18538067,
  INFO: 0x1549A966,
  TIMECODE_SCALE: 0x2AD7B1,
  TRACKS: 0x1654AE6B,
  TRACK_ENTRY: 0xAE,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63A2,
  CLUSTER: 0x1F43B675,
  TIMECODE: 0xE7,
  SIMPLE_BLOCK: 0xA3,
  BLOCK_GROUP: 0xA0,
  BLOCK: 0xA1,
  DEFAULT_DURATION: 0x23E383
}

/**
 * MKV 流式解析器 —— 从「字节流」里抽取 H.264 帧。
 *
 * ══════════ 为什么不用文件 ══════════
 *
 * 最初的设计是「scrcpy 录到 mkv 文件，我们增量读」。
 * 在 Windows 上这条路走不通：scrcpy 用大缓冲 + 稀疏文件写入，
 * Node/PowerShell 的 statSync 一直报 size=0（只有 cmd dir 能
 * 看到 139GB 的逻辑大小），数据憋在系统缓存里读不到。
 *
 * ══════════ 现在的做法 ══════════
 *
 *   命名管道 \\.\pipe\miniwin-stream
 *        ↓  scrcpy --record <pipe> --record-format mkv
 *   Node net.createServer 接收字节流
 *        ↓  push(chunk)
 *   MkvReader 增量解析 → onSample(帧)
 *
 * 好处：
 *   - 零文件 IO，无缓冲延迟
 *   - 数据一到就解析，延迟 ≈ 1 帧
 *   - 不用清理临时文件
 *
 * ══════════ EBML 解析要点 ══════════
 *
 * 顶层只处理小元素（EBML/Info/Tracks 拿 CodecPrivate），
 * 遇到 Cluster 后进入「流式模式」：不管 Cluster 声明的 size
 * （录制器常写一个巨大的预留值），有多少数据就解析多少，
 * 只消费完整的 SimpleBlock，半截的留到下个 chunk。
 */
class MkvReader {
  constructor () {
    this.timecodeScale = 1e6   // 纳秒，默认 1ms
    this.clusterTime = 0
    this.codecPrivate = null
    this.codecId = null
    this.onSample = null       // (buf, ptsMs, isKey) => void
    this.onLog = null

    this._pending = Buffer.alloc(0)
    this._inCluster = false
    this._pushed = 0
    this._samples = 0
  }

  log (m) { if (this.onLog) this.onLog(m) }

  /** 喂一块字节流（管道 data 事件里调用） */
  push (chunk) {
    this._pushed += chunk.length
    this._pending = this._pending.length
      ? Buffer.concat([this._pending, chunk])
      : chunk
    this._parse()
  }

  /** 排空残留（stop 时调用一次） */
  flush () {
    this._parse()
  }

  get stats () {
    return { pushed: this._pushed, samples: this._samples, buffered: this._pending.length }
  }

  /* ────────── EBML 基础读取 ────────── */

  /** 读 EBML 变长 ID（保留 marker bit） */
  _readId (b, o) {
    if (o >= b.length) return null
    const first = b[o]
    let len = 0
    for (let i = 0; i < 4; i++) {
      if (first & (0x80 >> i)) { len = i + 1; break }
    }
    if (!len || o + len > b.length) return null
    let v = 0
    for (let i = 0; i < len; i++) v = (v * 256) + b[o + i]
    return { id: v, len }
  }

  /**
   * 读 EBML 变长 size。
   *
   * 严格按规范清除 marker bit；首值全 1 视为「未知长度」。
   * 用 BigInt 累加避免大 Cluster 尺寸溢出精度。
   */
  _readSize (b, o) {
    if (o >= b.length) return null
    const first = b[o]
    let len = 0
    for (let i = 0; i < 8; i++) {
      if (first & (0x80 >> i)) { len = i + 1; break }
    }
    if (!len || o + len > b.length) return null

    const mask = 0xFF >> len
    let firstVal = first & mask
    let allOnes = firstVal === mask
    let v = BigInt(firstVal)
    for (let i = 1; i < len; i++) {
      const byte = b[o + i]
      v = (v << 8n) | BigInt(byte)
      if (byte !== 0xFF) allOnes = false
    }
    const safe = v <= BigInt(Number.MAX_SAFE_INTEGER)
    return {
      size: safe ? Number(v) : 0,
      len,
      unknown: allOnes || !safe
    }
  }

  /* ────────── 解析主循环 ────────── */

  _parse () {
    const b = this._pending
    let o = 0

    while (o < b.length) {
      // 已进入 Cluster → 全是 block，流式处理
      if (this._inCluster) {
        const used = this._parseClusterStream(b, o)
        if (used === 0) break          // 剩余不完整，等更多数据
        o += used
        continue
      }

      const idr = this._readId(b, o)
      if (!idr) break
      const szr = this._readSize(b, o + idr.len)
      if (!szr) break
      const ds = o + idr.len + szr.len

      // Cluster：进入流式模式，忽略它声明的 size
      if (idr.id === ID.CLUSTER) {
        this._inCluster = true
        o = ds
        continue
      }

      if (szr.unknown) { o = ds; continue }
      if (ds + szr.size > b.length) break

      const data = b.subarray(ds, ds + szr.size)
      switch (idr.id) {
        case ID.TIMECODE_SCALE: {
          let v = 0
          for (let i = 0; i < data.length; i++) v = v * 256 + data[i]
          if (v > 0) this.timecodeScale = v
          break
        }
        case ID.TRACK_ENTRY:
          this._parseTrackEntry(data)
          break
        case ID.INFO:
        case ID.TRACKS:
          o = ds          // 进入容器找子元素
          continue
        default:
          break
      }
      o = ds + szr.size
    }

    this._pending = o >= b.length ? Buffer.alloc(0) : Buffer.from(b.subarray(o))
  }

  _parseTrackEntry (data) {
    let o = 0
    while (o < data.length) {
      const idr = this._readId(data, o)
      if (!idr) return
      const szr = this._readSize(data, o + idr.len)
      if (!szr || szr.unknown) return
      const ds = o + idr.len + szr.len
      if (ds + szr.size > data.length) return
      const d = data.subarray(ds, ds + szr.size)

      if (idr.id === ID.CODEC_ID) {
        const cid = d.toString('ascii').replace(/\0+$/, '')
        this.codecId = cid
        this.log(`codec: ${cid}`)
      } else if (idr.id === ID.CODEC_PRIVATE) {
        this.codecPrivate = Buffer.from(d)
        this.log(`CodecPrivate: ${d.length} 字节（含 SPS/PPS）`)
      }
      o = ds + szr.size
    }
  }

  /**
   * 流式解析 Cluster 内部：处理所有已完整的子元素，
   * 返回消费的字节数（0 = 没有完整元素）。
   */
  _parseClusterStream (b, start) {
    let o = start
    while (o < b.length) {
      const idr = this._readId(b, o)
      if (!idr) break
      const szr = this._readSize(b, o + idr.len)
      if (!szr) break
      const ds = o + idr.len + szr.len

      if (szr.unknown) { o = ds; continue }
      if (ds + szr.size > b.length) break

      /**
       * 遇到新的 Cluster：只跳过它的 header，继续往后处理。
       *
       * 关键：Cluster 的声明 size 不可信（录制器常写巨大预留值），
       * 所以不能用 `o = ds + szr.size` 跳过去 —— 那会把整个后续
       * 数据当成 Cluster 内部内容跳过，帧就没了。
       *
       * 实测症状：管道方式下只有第一帧（第一个 Cluster 的首个 block），
       * 后面全被跳过。
       */
      if (idr.id === ID.CLUSTER) {
        o = ds            // 只跳 header，继续解析内部
        continue
      }

      const d = b.subarray(ds, ds + szr.size)
      if (idr.id === ID.TIMECODE) {
        let v = 0
        for (let i = 0; i < d.length; i++) v = v * 256 + d[i]
        this.clusterTime = v
      } else if (idr.id === ID.SIMPLE_BLOCK || idr.id === ID.BLOCK) {
        this._handleBlock(d)
      } else if (idr.id === ID.BLOCK_GROUP) {
        this._parseClusterStream(d, 0)
      }
      o = ds + szr.size
    }
    return o - start
  }

  /**
   * SimpleBlock：[track vint][2B 相对时间][1B flags][帧数据]
   * flags bit7 = 是否关键帧
   */
  _handleBlock (d) {
    if (!d.length) return
    const first = d[0]
    let tlen = 0
    for (let i = 0; i < 8; i++) {
      if (first & (0x80 >> i)) { tlen = i + 1; break }
    }
    if (!tlen || d.length < tlen + 3) return

    let track = first & (0xFF >> tlen)
    for (let i = 1; i < tlen; i++) track = track * 256 + d[i]

    const to = tlen
    let rel = (d[to] << 8) | d[to + 1]
    if (rel > 0x7FFF) rel -= 0x10000
    const flags = d[to + 2]
    const payload = d.subarray(to + 3)
    if (!payload.length) return

    const isKey = (flags & 0x80) !== 0
    const ptsMs = (this.clusterTime + rel) * this.timecodeScale / 1e6
    this._samples++
    if (this.onSample) this.onSample(payload, ptsMs, isKey)
  }
}

module.exports = { MkvReader }
