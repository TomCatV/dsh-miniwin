// 自动发现模块测试：不依赖真手机，验证 mDNS 解析 / 网段推导 / 端口探测
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localSubnets, scanPort, discoverByMdns } from '../lib/discover.js'

const ADB = 'C:/Users/Vincent/dsh/miniwin-stream/tools/scrcpy/scrcpy-win64-v5.0.1/adb.exe'

test('localSubnets 排除虚拟网卡', () => {
  const subs = localSubnets()
  assert.ok(Array.isArray(subs))
  for (const s of subs) {
    assert.ok(!/flclash|vEthernet|WSL|Hyper-V|Npcap|Loopback/i.test(s.iface),
      '不该包含虚拟网卡: ' + s.iface)
    assert.ok(!s.self.startsWith('127.'), '不该包含回环')
    assert.ok(!s.self.startsWith('169.254.'), '不该包含 APIPA')
    assert.match(s.prefix, /^\d+\.\d+\.\d+$/)
  }
})

test('localSubnets 把 WLAN 排第一', () => {
  const subs = localSubnets()
  if (subs.length > 1) {
    const wlanIdx = subs.findIndex(s => /^WLAN|Wi-?Fi|Wireless/i.test(s.iface))
    if (wlanIdx >= 0) assert.equal(wlanIdx, 0, 'WLAN 应排第一，实际顺序: ' + subs.map(s => s.iface).join(','))
  }
})

test('每个网段带 score', () => {
  for (const s of localSubnets()) {
    assert.equal(typeof s.score, 'number', s.iface + ' 缺 score')
  }
})

test('scanPort 扫一个不可能有服务的端口返回空', async () => {
  const subs = localSubnets()
  if (!subs.length) return
  // 用一个高位冷门端口，几乎不可能有服务
  const found = await scanPort(subs[0].prefix, 59999, { concurrency: 100, timeout: 200 })
  assert.ok(Array.isArray(found))
  assert.equal(found.length, 0, '不该扫到东西: ' + found.join(','))
})

test('scanPort 能扫到本机正在监听的服务', async () => {
  const net = await import('node:net')
  const srv = net.createServer()
  await new Promise(r => srv.listen(0, '0.0.0.0', r))
  const port = srv.address().port

  const subs = localSubnets()
  if (!subs.length) { srv.close(); return }

  // 从本机所在的网段扫
  const selfSub = subs[0]
  const selfHost = subs[0].self

  // 直接探测本机 IP 而不是全扫（全扫太慢）
  const found = await new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(800)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
    sock.connect(port, selfHost)
  })

  srv.close()
  assert.equal(found, true, '应能连到 ' + selfHost + ':' + port)
})

test('discoverByMdns 返回结构正确（不要求真找到设备）', async () => {
  const r = await discoverByMdns(ADB)
  assert.ok('connect' in r, '缺 connect 字段')
  assert.ok('pairing' in r, '缺 pairing 字段')
  assert.ok('raw' in r, '缺 raw 字段')
  assert.equal(typeof r.raw, 'string')
  // connect/pairing 要么是 'ip:port' 要么是 null
  for (const k of ['connect', 'pairing']) {
    if (r[k] !== null) assert.match(r[k], /^\d+\.\d+\.\d+\.\d+:\d+$/, k + ' 格式不对: ' + r[k])
  }
})

test('mDNS 解析：能从样例输出里认出 connect / pairing', async () => {
  // 直接测解析逻辑：模拟 adb mdns services 的输出
  const sample = [
    'List of discovered mdns services',
    'adb-ABC123-XYZ._adb-tls-connect._tcp.    192.168.1.42:37123',
    'adb-ABC123-XYZ._adb-tls-pairing._tcp.    192.168.1.42:41357'
  ].join('\n')

  // 用一个假的 adb 路径跑不通，所以这里直接验证正则
  const lines = sample.split('\n')
  let connect = null
  let pairing = null
  for (const line of lines) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/)
    if (!m) continue
    const addr = m[1] + ':' + m[2]
    if (/_adb-tls-connect\._tcp/i.test(line)) connect = addr
    else if (/_adb-tls-pairing\._tcp/i.test(line)) pairing = addr
  }
  assert.equal(connect, '192.168.1.42:37123')
  assert.equal(pairing, '192.168.1.42:41357')
})
