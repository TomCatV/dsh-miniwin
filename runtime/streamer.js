'use strict'
/**
 * scrcpy 视频流协议解析器（纯 Node，无 Electron 依赖，可单测）
 *
 * 协议常量取自 scrcpy v5.0.1 server 源码：
 *   server/src/main/java/com/genymobile/scrcpy/device/Streamer.java
 *
 * 连接建立后的字节序列：
 *   [1 字节 dummy]                    仅 send_dummy_byte=true
 *   [4 字节 codec id]                 仅 send_stream_meta=true；"h264"/"h265"/"av1 "
 *   [12 字节 session meta]            flags(高 32 位含 0x80000000) + width + height
 *   loop:
 *     [12 字节 frame header]          ptsAndFlags(u64 LE) + size(u32 LE)
 *     [size 字节 payload]
 *
 * ptsAndFlags 的高位标志：
 *   PACKET_FLAG_SESSION  = 1 << 63
 *   PACKET_FLAG_CONFIG   = 1 << 62
 *   PACKET_FLAG_KEY_FRAME= 1 << 61
 */

const FLAG_SESSION = 1n << 63n
const FLAG_CONFIG = 1n << 62n
const FLAG_KEY_FRAME = 1n << 61n
const PTS_MASK = FLAG_KEY_FRAME - 1n

const CODEC_IDS = {
  0x68323634: 'h264', // "h264"
  0x68323635: 'h265', // "h265"
  0x00687631: 'av1', // "\0hv1"
  0x61763120: 'av1' // "av1 "
}

const DEVICE_NAME_FIELD_LENGTH = 64

class ScrcpyParser {
  /**
   * @param {object} opts
   * @param {boolean} [opts.sendDummyByte=true]
   * @param {boolean} [opts.sendStreamMeta=true]
   * @param {boolean} [opts.sendDeviceMeta=true]  设备名：64 字节定长，先于 codec id
   */
  constructor (opts = {}) {
    this.sendStreamMeta = opts.sendStreamMeta !== false
    this.sendDeviceMeta = opts.sendDeviceMeta === true

    if (opts.sendDummyByte === false) this.stage = 'deviceMeta'
    else this.stage = 'dummy'
    if (!this.sendDeviceMeta && this.stage === 'deviceMeta') this.stage = this.sendStreamMeta ? 'codec' : 'frames'

    this.buf = Buffer.alloc(0)
    this.codec = null
    this.width = 0
    this.height = 0
    this.deviceName = null
    this.pendingSession = null
  }

  get ready () {
    return this.stage === 'frames' && this.width > 0 && this.height > 0
  }

  /**
   * @param {Buffer} chunk
   * @returns {Array<{type:'device'|'codec'|'session'|'config'|'frame', ...}>}
   */
  push (chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []

    for (;;) {
      if (this.stage === 'dummy') {
        if (this.buf.length < 1) break
        this.buf = this.buf.subarray(1)
        this.stage = 'deviceMeta'
        continue
      }

      if (this.stage === 'deviceMeta') {
        if (!this.sendDeviceMeta) { this.stage = this.sendStreamMeta ? 'codec' : 'frames'; continue }
        if (this.buf.length < DEVICE_NAME_FIELD_LENGTH) break
        this.deviceName = this.buf.subarray(0, DEVICE_NAME_FIELD_LENGTH).toString('utf8').replace(/\0.*$/, '')
        this.buf = this.buf.subarray(DEVICE_NAME_FIELD_LENGTH)
        out.push({ type: 'device', name: this.deviceName })
        this.stage = this.sendStreamMeta ? 'codec' : 'frames'
        continue
      }

      if (this.stage === 'codec') {
        if (this.buf.length < 4) break
        // server 侧 ByteBuffer.putInt 默认大端，所以是 BE 读
        // "h264"=0x68323634 / "h265"=0x68323635 / "av1 "=0x61763120
        const id = this.buf.readUInt32BE(0)
        this.buf = this.buf.subarray(4)
        this.codec = CODEC_IDS[id] || null
        out.push({ type: 'codec', id, name: this.codec, raw: id })
        this.stage = 'session'
        continue
      }

      if (this.stage === 'session') {
        if (this.buf.length < 12) break
        // 同样是大端
        const flags = this.buf.readUInt32BE(0)
        const width = this.buf.readUInt32BE(4)
        const height = this.buf.readUInt32BE(8)
        this.buf = this.buf.subarray(12)
        this.pendingSession = { flags, width, height }
        out.push({ type: 'session', flags, width, height })
        this.stage = 'frames'
        continue
      }

      // --- frames ---
      if (this.buf.length < 12) break
      // ptsAndFlags 是 putLong（BE）；size 是 putInt（BE）
      const ptsAndFlags = this.buf.readBigUInt64BE(0)
      const size = this.buf.readUInt32BE(8)

      if (ptsAndFlags & FLAG_SESSION) {
        if (this.buf.length < 24) break
        const flags = this.buf.readUInt32BE(8)
        const width = this.buf.readUInt32BE(12)
        const height = this.buf.readUInt32BE(16)
        this.buf = this.buf.subarray(24)
        this.width = width
        this.height = height
        out.push({ type: 'session', flags, width, height, repeat: true })
        continue
      }

      if (size > 32 * 1024 * 1024) {
        throw new Error('帧长度异常: ' + size + '（协议错位）')
      }
      if (this.buf.length < 12 + size) break
      const payload = Buffer.from(this.buf.subarray(12, 12 + size))
      this.buf = this.buf.subarray(12 + size)

      const isConfig = (ptsAndFlags & FLAG_CONFIG) !== 0n
      const isKey = (ptsAndFlags & FLAG_KEY_FRAME) !== 0n
      const pts = Number(ptsAndFlags & PTS_MASK)

      if (isConfig) out.push({ type: 'config', pts, data: payload })
      else out.push({ type: 'frame', pts, key: isKey, data: payload })
    }

    if (this.pendingSession) {
      this.width = this.pendingSession.width
      this.height = this.pendingSession.height
      this.pendingSession = null
    }

    return out
  }
}

/**
 * 从 Annex-B 码流里取 SPS，构造 WebCodecs 需要的 codec 字符串
 *   avc1.[profile_idc][constraint_flags][level_idc]  十六进制
 */
function codecStringFromAnnexB (buf) {
  for (let i = 0; i + 4 < buf.length; i++) {
    // 找 00 00 01 或 00 00 00 01
    let start = -1
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) start = i + 3
    else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) start = i + 4
    if (start < 0 || start + 3 >= buf.length) continue

    const nalType = buf[start] & 0x1f
    if (nalType !== 7) continue // 7 = SPS

    const profile = buf[start + 1]
    const constraints = buf[start + 2]
    const level = buf[start + 3]
    const hex = n => n.toString(16).padStart(2, '0')
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`
  }
  return null
}

/** 把 scrcpy 帧重新打包（给合成流测试 / 录制用） */
function encodeFrameHeader (pts, size, { config = false, key = false } = {}) {
  const h = Buffer.alloc(12)
  let f = BigInt(pts >>> 0)
  if (config) f |= FLAG_CONFIG
  else if (key) f |= FLAG_KEY_FRAME
  h.writeBigUInt64BE(f, 0)   // server 侧 putLong 为大端
  h.writeUInt32BE(size, 8)
  return h
}

module.exports = { ScrcpyParser, codecStringFromAnnexB, encodeFrameHeader, FLAG_CONFIG, FLAG_KEY_FRAME, FLAG_SESSION }
