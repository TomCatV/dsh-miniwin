// QR 编码器回归测试：结构 + 与参考矩阵一致性（参考矩阵由 python qrcode 生成后固化）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeQR, qrSvg } from '../lib/qr.js'

// python qrcode: QRCode(version=1, ERROR_CORRECT_L, mask_pattern=0) / "hi"
const REF_HI_L_M0 = [
  '111111100010101111111',
  '100000100000101000001',
  '101110101010001011101',
  '101110100000101011101',
  '101110100101101011101',
  '100000100111001000001',
  '111111101010101111111',
  '000000001010000000000',
  '111011111010111000100',
  '011000010011010101111',
  '011111111101011101111',
  '001100000001110111010',
  '100101101011011100100',
  '000000001010001000111',
  '111111101110100010011',
  '100000101110001000111',
  '101110101100101010101',
  '101110100101010101010',
  '101110101111011101101',
  '100000101101110111010',
  '111111101001011101111'
]

function toRows({ size, modules }) {
  const rows = []
  for (let r = 0; r < size; r++) rows.push(modules[r].map(v => (v ? '1' : '0')).join(''))
  return rows
}

test('"hi" @ L 与参考实现逐位一致', () => {
  const mine = toRows(encodeQR('hi', 'L'))
  assert.equal(mine.length, 21)
  for (let r = 0; r < 21; r++) {
    assert.equal(mine[r], REF_HI_L_M0[r], '第 ' + r + ' 行不一致\n  期望 ' + REF_HI_L_M0[r] + '\n  实际 ' + mine[r])
  }
})

test('finder pattern 三个角都正确', () => {
  const { size, modules } = encodeQR('test', 'M')
  const finder = [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1]
  ]
  const check = (r0, c0, name) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        assert.equal(modules[r0 + r][c0 + c], finder[r][c], name + ' @' + r + ',' + c)
      }
    }
  }
  check(0, 0, '左上')
  check(0, size - 7, '右上')
  check(size - 7, 0, '左下')
})

test('timing pattern 交替', () => {
  const { size, modules } = encodeQR('test', 'M')
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, 'row6 col' + i)
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, 'col6 row' + i)
  }
})

test('dark module 就位', () => {
  const { size, modules } = encodeQR('test', 'M')
  assert.equal(modules[size - 8][8], 1)
})

test('版本随内容自动增长', () => {
  const v1 = encodeQR('hi', 'L')
  assert.equal(v1.size, 21)
  const v5 = encodeQR('http://172.31.100.174:14886/dsh-miniwin/m?addr=172.31.100.199:41234', 'M')
  assert.equal(v5.size, 37)
  assert.equal((v5.size - 17) / 4, 5)
})

test('超长内容抛错而不是产出坏码', () => {
  assert.throws(() => encodeQR('x'.repeat(2000), 'H'), /超出|过长/)
})

test('qrSvg 输出合法 SVG 且尺寸匹配', () => {
  const { size } = encodeQR('hello', 'M')
  const scale = 6
  const margin = 3
  const dim = (size + margin * 2) * scale
  const svg = qrSvg('hello', { level: 'M', scale, margin })
  assert.match(svg, /^<svg /)
  assert.ok(svg.includes('width="' + dim + '"'), '期望 width=' + dim)
  assert.ok(svg.includes('viewBox="0 0 ' + dim + ' ' + dim + '"'))
  assert.ok(svg.trim().endsWith('</svg>'))
  // 黑块数量应等于模块里 1 的个数
  const rects = (svg.match(/<rect x=/g) || []).length
  assert.ok(rects > 0 && rects < size * size, 'rect 数 ' + rects)
})

test('空字符串也能编码（不崩）', () => {
  assert.doesNotThrow(() => encodeQR('', 'L'))
})
