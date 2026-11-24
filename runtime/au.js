/**
 * AU（Access Unit）组装器 —— 把「多 slice 组成的一帧」正确还原成一帧。
 *
 * 为什么必须有这个：
 *   H.264 允许把一帧画面切成多个 slice 分别编码（x264 的 `slices` 参数，
 *   手机硬编码器为了降延迟常开 4~17 片）。这些 slice 共享同一个时间戳，
 *   合起来才是一帧完整画面。
 *
 *   如果按「一个 NAL = 一帧」喂给 WebCodecs，解码器会收到半个画面，
 *   表现为：第 1 帧（IDR）能解出来，第 2 帧立刻 `Decoding error`，
 *   之后解码器直接进入 closed 状态，画面永久冻结。
 *
 *   实测：476×1080 的视频被切成 17 片，30600 个 NAL 其实只有 1800 帧。
 *
 * 切分依据（按 H.264 规范，不靠时间戳）：
 *   1. first_mb_in_slice === 0 且已有累积 slice → 新的一帧开始
 *   2. 遇到 AUD(9) / SPS(7) / PPS(8) / SEI(6) → 上一帧结束
 *   3. 帧类型变化（IDR ↔ 非 IDR）→ 新的一帧
 *   4. finish() 时把剩下的吐出来
 */

/**
 * 读 slice header 里的 first_mb_in_slice（第一个指数哥伦布码）。
 * @returns {number} 0 表示这是新一帧的第一个 slice
 */
function firstMbInSlice (nal) {
  // nal[0] 是 NAL header，从 nal[1] 的 bit 0 开始
  let pos = 8
  const getBit = () => {
    const byte = nal[pos >> 3]
    if (byte === undefined) return 0
    const b = (byte >> (7 - (pos & 7))) & 1
    pos++
    return b
  }
  // 指数哥伦布：数前导 0，然后读出 (zeros) 位
  let zeros = 0
  while (getBit() === 0 && zeros < 32) zeros++
  if (zeros === 0) return 0
  let v = 0
  for (let i = 0; i < zeros; i++) v = (v << 1) | getBit()
  return (1 << zeros) - 1 + v
}

class AuAssembler {
  constructor () {
    this.pendingSlices = []
    this.pendingPrefix = []   // SPS/PPS/SEI，跟着下一个 AU 走
    this.hasIdr = false
    this.maxSlices = 512      // 防御：异常数据不要把内存吃光
  }

  /**
   * 喂一个 NAL。
   * @param {Buffer|Uint8Array} nal 不含起始码的 NAL
   * @returns {Array<{nals: Buffer[], key: boolean}>} 已完成的 AU
   */
  push (nal) {
    if (!nal || !nal.length) return []
    const t = nal[0] & 0x1f
    const done = []

    const flush = () => {
      if (!this.pendingSlices.length) return
      done.push({ nals: this.pendingSlices, key: this.hasIdr })
      this.pendingSlices = []
      this.hasIdr = false
    }

    // AUD：显式的一帧边界，AUD 自身丢弃
    if (t === 9) {
      flush()
      return done
    }

    // 参数集 / SEI：已累积 slice 则上一帧结束
    if (t === 7 || t === 8 || t === 6) {
      flush()
      if (this.pendingPrefix.length < 16) this.pendingPrefix.push(nal)
      return done
    }

    // slice（1=非IDR, 2=分区A, 5=IDR）
    if (t === 1 || t === 2 || t === 5) {
      const firstMb = firstMbInSlice(nal)
      if (this.pendingSlices.length && firstMb === 0) flush()
      // 类型翻转也算新帧（IDR 之后跟非 IDR）
      if (this.pendingSlices.length && this.hasIdr && t !== 5) flush()
      if (this.pendingSlices.length >= this.maxSlices) flush()

      this.pendingSlices.push(nal)
      if (t === 5) this.hasIdr = true
      return done
    }

    // 其他类型（数据分区等）忽略
    return done
  }

  /** 收尾：把还没吐出的 AU 交出来 */
  finish () {
    const done = []
    if (this.pendingSlices.length) {
      done.push({ nals: this.pendingSlices, key: this.hasIdr })
      this.pendingSlices = []
      this.hasIdr = false
    }
    return done
  }

  reset () {
    this.pendingSlices = []
    this.pendingPrefix = []
    this.hasIdr = false
  }
}

/**
 * 把 AU 里的多个 slice 拼成一段 Annex-B（带起始码）。
 * @param {Array<{nals: Buffer[]}>} au
 */
function auToAnnexB (au) {
  const parts = []
  for (const nal of au.nals) {
    parts.push(Buffer.from([0, 0, 0, 1]))
    parts.push(Buffer.isBuffer(nal) ? nal : Buffer.from(nal))
  }
  return Buffer.concat(parts)
}

module.exports = { AuAssembler, auToAnnexB, firstMbInSlice }
