'use strict'
/**
 * H.264 Annex-B ⇄ AVCC 转换，以及 AVCDecoderConfigurationRecord 构造
 *
 * 为什么需要：WebCodecs VideoDecoder 对 AVC 期望 AVCC 格式
 *   - EncodedVideoChunk 的 data 是 AVCC（每个 NAL 前 4 字节大端长度）
 *   - config.description 是 AVCDecoderConfigurationRecord（含 SPS/PPS）
 * scrcpy 送来的是 Annex-B（00 00 00 01 起始码），必须转换。
 */

/** 把 Annex-B 拆成 NAL 单元数组（不含起始码） */
function splitAnnexB (buf) {
  const nals = []

  // 收集所有起始码位置（先匹配 3 字节，若前面还有 0 则整体视为 4 字节起始码 + 前导 0）
  const marks = []
  let i = 0
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      let pos = i
      let len = 3
      // 向前吸收多余的 0，它们属于 trailing_zero_8bits
      while (pos > 0 && buf[pos - 1] === 0) { pos--; len++ }
      marks.push({ pos, start: i + 3 })
      i += 3
    } else {
      i++
    }
  }
  if (!marks.length) return nals

  for (let m = 0; m < marks.length; m++) {
    const start = marks[m].start
    const end = m + 1 < marks.length ? marks[m + 1].pos : buf.length
    if (end <= start) continue

    // H.264 Annex-B：rbsp_trailing_bits 结尾一定是 1 位，
    // 因此 NAL 最后一个字节不会是 0x00，末尾的 0 一律属于 trailing_zero_8bits
    let e = end
    while (e > start && buf[e - 1] === 0) e--
    if (e > start) nals.push(buf.subarray(start, e))
  }
  return nals
}

/** NAL 单元类型 */
const nalType = nal => nal[0] & 0x1f

/** Annex-B → AVCC（4 字节长度前缀） */
function annexBToAvcc (buf) {
  const nals = splitAnnexB(buf)
  if (!nals.length) return Buffer.alloc(0)

  let total = 0
  for (const n of nals) total += 4 + n.length

  const out = Buffer.allocUnsafe(total)
  let off = 0
  for (const n of nals) {
    out.writeUInt32BE(n.length, off)
    off += 4
    n.copy(out, off)
    off += n.length
  }
  return out
}

/**
 * 构造 AVCDecoderConfigurationRecord
 * @param {Buffer} sps 不含起始码的 SPS NAL
 * @param {Buffer} pps 不含起始码的 PPS NAL
 * @param {number} [nalLengthSize=4]
 */
function buildAvcDescription (sps, pps, nalLengthSize = 4) {
  if (!sps || !sps.length || !pps || !pps.length) throw new Error('SPS/PPS 不能为空')

  // AVCDecoderConfigurationRecord 布局：
  //   0      configurationVersion = 1
  //   1      AVCProfileIndication
  //   2      profile_compatibility
  //   3      AVCLevelIndication
  //   4      111111 + lengthSizeMinusOne (2b)
  //   5      111 + numOfSPS (5b)
  //   6..7   SPS length (u16 BE)
  //   8..    SPS
  //   +0     numOfPPS (1B)
  //   +1..2  PPS length (u16 BE)
  //   +3..   PPS
  const header = Buffer.alloc(8)
  header[0] = 1
  header[1] = sps[1]
  header[2] = sps[2]
  header[3] = sps[3]
  header[4] = 0xfc | (nalLengthSize - 1)
  header[5] = 0xe0 | 1
  header.writeUInt16BE(sps.length, 6)

  const ppsCountAndLen = Buffer.alloc(3)
  ppsCountAndLen[0] = 1
  ppsCountAndLen.writeUInt16BE(pps.length, 1)

  return Buffer.concat([header, sps, ppsCountAndLen, pps])
}

/**
 * 从 Annex-B config 包里抽出 SPS/PPS，构造 description
 * @returns {{description: Buffer, sps: Buffer, pps: Buffer, codecString: string} | null}
 */
function makeDescriptionFromConfig (configBuf) {
  const nals = splitAnnexB(configBuf)
  let sps = null
  let pps = null
  for (const n of nals) {
    const t = nalType(n)
    if (t === 7 && !sps) sps = n
    else if (t === 8 && !pps) pps = n
  }
  if (!sps || !pps) return null

  const hx = n => n.toString(16).padStart(2, '0')
  return {
    description: buildAvcDescription(sps, pps, 4),
    sps,
    pps,
    codecString: `avc1.${hx(sps[1])}${hx(sps[2])}${hx(sps[3])}`
  }
}

/**
 * 判断一段 Annex-B 里是否含 SPS/PPS（有些流每个关键帧都带）
 */
function hasParamSets (buf) {
  for (const n of splitAnnexB(buf)) {
    const t = nalType(n)
    if (t === 7 || t === 8) return true
  }
  return false
}

/** 按 nalLengthSize 重新打包（scrcpy 固定 4） */
function repackWithLengthSize (buf, nalLengthSize = 4) {
  return annexBToAvcc(buf)
}

/**
 * 把一帧 Annex-B 转成 AVCC，并剥掉 SPS/PPS/AUD/SEI
 *
 * 关于关键帧：scrcpy 的 PACKET_FLAG_KEY_FRAME 理论上靠谱，但实际链路里
 * 一旦有丢包或封装差异，标志可能和真实 NAL 类型不一致。VideoDecoder
 * 对「configure 后第一帧不是 key」会直接抛错，所以这里以 NAL 类型为准：
 * 含 IDR(5) 才是关键帧，并把它一起返回，让调用方覆盖 flag。
 *
 * @returns {{ data: Buffer, key: boolean } | null}  null = 整帧只有参数集
 */
function frameToAvcc (buf) {
  const nals = splitAnnexB(buf)
  const keep = []
  let hasIdr = false

  for (const n of nals) {
    const t = nalType(n)
    if (t === 7 || t === 8) continue   // SPS / PPS：已在 description 里
    if (t === 9) continue              // AUD：解码器不需要
    if (t === 6) continue              // SEI：对纯画面无意义，且部分解码器会报错
    if (t === 5) hasIdr = true         // IDR = 关键帧
    if (t >= 1 && t <= 5) keep.push(n) // 真正的 slice 数据
  }
  if (!keep.length) return null

  let total = 0
  for (const n of keep) total += 4 + n.length
  const out = Buffer.allocUnsafe(total)
  let off = 0
  for (const n of keep) {
    out.writeUInt32BE(n.length, off)
    off += 4
    n.copy(out, off)
    off += n.length
  }
  return { data: out, key: hasIdr }
}

module.exports = {
  splitAnnexB, annexBToAvcc, buildAvcDescription, makeDescriptionFromConfig,
  hasParamSets, repackWithLengthSize, frameToAvcc, nalType
}
