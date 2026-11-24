/**
 * 极简 QR 码编码器（byte mode, 版本自动选择, EC level L/M/Q/H）
 * ---------------------------------------------------------------------------
 * 来源：按 ISO/IEC 18004 自行实现，无第三方依赖。
 * 只做 byte mode（URL/ASCII 足够），足够生成配对页链接。
 * 输出为 { size, modules } —— modules 是 size×size 的 0/1 二维数组。
 */

/* ---------- Reed-Solomon ---------- */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function initGF() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen)
  const res = new Array(data.length + ecLen).fill(0)
  for (let i = 0; i < data.length; i++) res[i] = data[i]
  for (let i = 0; i < data.length; i++) {
    const factor = res[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], factor)
    }
  }
  return res.slice(data.length)
}

/* ---------- 容量表（version 1..10, level L/M/Q/H） ---------- */
// [version][level] = { totalDataCodewords, ecPerBlock, blocks }
const CAP = {
  1: { L: [19, 7, 1], M: [16, 10, 1], Q: [13, 13, 1], H: [9, 17, 1] },
  2: { L: [34, 10, 1], M: [28, 16, 1], Q: [22, 22, 1], H: [16, 28, 1] },
  3: { L: [55, 15, 1], M: [44, 26, 1], Q: [34, 18, 2], H: [26, 22, 2] },
  4: { L: [80, 20, 1], M: [64, 18, 2], Q: [48, 26, 2], H: [36, 16, 4] },
  5: { L: [108, 26, 1], M: [86, 24, 2], Q: [62, 18, 4], H: [46, 22, 4] },
  6: { L: [136, 18, 2], M: [108, 16, 4], Q: [76, 24, 4], H: [60, 28, 4] },
  7: { L: [156, 20, 2], M: [124, 18, 4], Q: [88, 18, 6], H: [66, 26, 5] },
  8: { L: [194, 24, 2], M: [154, 22, 4], Q: [110, 22, 6], H: [86, 26, 6] },
  9: { L: [232, 30, 2], M: [182, 22, 5], Q: [132, 20, 8], H: [100, 24, 8] },
  10: { L: [274, 18, 4], M: [216, 26, 5], Q: [154, 24, 8], H: [122, 28, 8] }
}

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
}

function ecLevelIndex(lv) { return { L: 0, M: 1, Q: 2, H: 3 }[lv] }

/* ---------- 数据编码 ---------- */
function encodeData(text, version, level) {
  const [totalData, ec, blocks] = CAP[version][level]
  const bytes = Buffer.from(text, 'utf8')

  const bits = []
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }

  push(0b0100, 4) // byte mode
  push(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) push(b, 8)

  // terminator
  const capBits = totalData * 8
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  // pad
  const padBytes = [0xec, 0x11]
  let pi = 0
  while (bits.length < capBits) {
    push(padBytes[pi++ % 2], 8)
  }

  // 转字节
  const out = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    out.push(v)
  }

  // 分块 + RS
  const perBlock = Math.floor(totalData / blocks)
  const extra = totalData % blocks
  const dataBlocks = []
  const ecBlocks = []
  let off = 0
  for (let b = 0; b < blocks; b++) {
    const len = perBlock + (b >= blocks - extra ? 1 : 0)
    const d = out.slice(off, off + len)
    off += len
    dataBlocks.push(d)
    ecBlocks.push(rsEncode(d, ec))
  }

  // 交织
  const result = []
  const maxLen = Math.max(...dataBlocks.map(d => d.length))
  for (let i = 0; i < maxLen; i++) {
    for (const d of dataBlocks) if (i < d.length) result.push(d[i])
  }
  for (let i = 0; i < ec; i++) {
    for (const e of ecBlocks) result.push(e[i])
  }
  return result
}

/* ---------- 矩阵 ---------- */
function makeMatrix(version) {
  const size = version * 4 + 17
  const m = Array.from({ length: size }, () => new Array(size).fill(null))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))

  const setF = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    m[r][c] = v
    reserved[r][c] = true
  }

  // finder patterns
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr
        const cc = c + dc
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
        const inRing = (dr === 0 || dr === 6 || dc === 0 || dc === 6) && dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        setF(rr, cc, (inRing || inCore) ? 1 : 0)
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  // alignment
  const al = ALIGN[version] || []
  for (const r of al) {
    for (const c of al) {
      if (m[r] && m[r][c] !== null) continue
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          setF(r + dr, c + dc, on ? 1 : 0)
        }
      }
    }
  }

  // timing
  for (let i = 8; i < size - 8; i++) {
    setF(6, i, i % 2 === 0 ? 1 : 0)
    setF(i, 6, i % 2 === 0 ? 1 : 0)
  }

  // dark module
  setF(size - 8, 8, 1)

  // format info placeholder
  for (let i = 0; i < 9; i++) {
    if (m[8] && m[8][i] === null) setF(8, i, 0)
    if (m[i] && m[i][8] === null) setF(i, 8, 0)
  }
  for (let i = 0; i < 8; i++) {
    setF(8, size - 1 - i, 0)
    setF(size - 1 - i, 8, 0)
  }
  setF(8, size - 8, 1)

  // version info (>=7)
  if (version >= 7) {
    let v = version
    let rem = v
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    }
    const bits = (v << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1
      const r = Math.floor(i / 3)
      const c = size - 11 + (i % 3)
      setF(r, c, bit)
      setF(c, r, bit)
    }
  }

  return { m, reserved, size }
}

function placeData(version, codewords, level) {
  const { m, reserved, size } = makeMatrix(version)

  let bitIdx = 0
  const totalBits = codewords.length * 8
  const getBit = (i) => (i < totalBits ? (codewords[i >> 3] >>> (7 - (i & 7))) & 1 : 0)

  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (let k = 0; k < 2; k++) {
        const c = col - k
        if (reserved[row][c]) continue
        let bit = getBit(bitIdx++)
        // mask 0: (r+c) % 2 == 0
        if ((row + c) % 2 === 0) bit ^= 1
        m[row][c] = bit
      }
    }
    upward = !upward
  }

  // format info for mask 0
  // 位序（LSB = bit0）：按 ISO/IEC 18004 §8.9，副本 1 沿左上角 L 形，
  // 副本 2 沿右上 + 左下。这里逐位按参考实现对齐，不要想当然。
  const fmt = formatBits(level, 0)
  const putFmt = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v }
  const bit = i => (fmt >>> i) & 1

  // 副本 1：列 8 从下往上（跳过 timing 行 6），然后行 8 从右往左
  for (let i = 0; i < 6; i++) putFmt(i, 8, bit(i))          // r=0..5, c=8
  putFmt(7, 8, bit(6))                                       // 跳过 r=6 (timing)
  putFmt(8, 8, bit(7))
  putFmt(8, 7, bit(8))                                       // 跳过 c=6 (timing)
  for (let i = 9; i < 15; i++) putFmt(8, 14 - i, bit(i))     // r=8, c=5..0

  // 副本 2：行 8 右侧 + 列 8 底部
  for (let i = 0; i < 8; i++) putFmt(8, size - 1 - i, bit(i))       // c=size-1..size-8
  for (let i = 8; i < 15; i++) putFmt(size - 15 + i, 8, bit(i))     // r=size-7..size-1

  // dark module
  putFmt(size - 8, 8, 1)

  return { size, modules: m }
}

function formatBits(level, mask) {
  // 2 bit EC level + 3 bit mask，BCH(15,5)，再异或 0x5412
  const lvBits = { L: 1, M: 0, Q: 3, H: 2 }[level]
  let data = (lvBits << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  return bits & 0x7fff
}

/**
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} [level='M']
 * @returns {{size:number, modules:number[][]}}
 */
export function encodeQR(text, level = 'M') {
  const bytes = Buffer.from(text, 'utf8')
  let version = 1
  for (let v = 1; v <= 10; v++) {
    const cap = CAP[v][level]
    const dataBytes = cap[0]
    const headerBits = 4 + (v < 10 ? 8 : 16)
    if (headerBits + bytes.length * 8 <= dataBytes * 8) { version = v; break }
    if (v === 10) throw new Error('内容过长，超出 QR 版本 10 容量')
  }
  const cw = encodeData(text, version, level)
  return placeData(version, cw, level)
}

/** 生成 SVG 字符串（方便直接塞进 DOM） */
export function qrSvg(text, { level = 'M', scale = 6, margin = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, modules } = encodeQR(text, level)
  const dim = (size + margin * 2) * scale
  const rects = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        rects.push(`<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${scale}" height="${scale}"/>`)
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join('')}</g></svg>`
}
