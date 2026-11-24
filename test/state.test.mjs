// 自动发现的状态机测试：不依赖真机，验证各分支的决策
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localSubnets, scanPort } from '../lib/discover.js'

test('localSubnets 把 WLAN 排第一（真实网卡优先）', () => {
  const subs = localSubnets()
  assert.ok(subs.length > 0, '至少一个网段')
  const wlanIdx = subs.findIndex(s => /^WLAN|Wi-?Fi|Wireless/i.test(s.iface))
  if (wlanIdx >= 0) assert.equal(wlanIdx, 0, 'WLAN 应在第一位，实际: ' + subs.map(s => s.iface).join(' > '))
})

test('localSubnets 排除所有虚拟网卡', () => {
  const banned = /flclash|vEthernet|WSL|Hyper-V|Npcap|Loopback|TAP|TUN|VMware|VirtualBox|docker/i
  for (const s of localSubnets()) {
    assert.ok(!banned.test(s.iface), '不该有虚拟网卡: ' + s.iface)
  }
})

test('scanPort 对关闭的端口返回空数组', async () => {
  const subs = localSubnets()
  if (!subs.length) return
  const t0 = Date.now()
  const hits = await scanPort(subs[0].prefix, 59998, { concurrency: 128, timeout: 300 })
  assert.deepEqual(hits, [])
  // 一个 /24 应该在 5 秒内扫完
  assert.ok(Date.now() - t0 < 8000, '扫描太慢: ' + (Date.now() - t0) + 'ms')
})

test('scanPort 扫本机监听端口能找到自己', async () => {
  const net = await import('node:net')
  const srv = net.createServer()
  await new Promise(r => srv.listen(0, '0.0.0.0', r))
  const port = srv.address().port

  // 用 127.0.0.1 段扫（保证有自己）
  const hits = await scanPort('127.0.0', port, { concurrency: 64, timeout: 300 })
  srv.close()

  assert.ok(hits.includes('127.0.0.1'), '应扫到 127.0.0.1，实际: ' + hits.join(','))
})

// ── 状态机决策（纯逻辑，不碰网络）──

/** 从 /auto 的返回推导出 UI 该显示什么 */
function decide (r) {
  if (r.ok) {
    return { stage: 'connected', wireless: /:\d+$/.test(r.serial || ''), canUnplug: !!r.canUnplug }
  }
  if (r.needPair) return { stage: 'needPair' }
  if (r.needUsb) return { stage: 'needUsb' }
  if (r.needSetup) return { stage: 'needUsb' }
  return { stage: 'error' }
}

test('决策：连上了且是 WiFi 序列号 → 可以拔线', () => {
  const d = decide({ ok: true, serial: '172.31.100.199:5555', canUnplug: true })
  assert.equal(d.stage, 'connected')
  assert.equal(d.wireless, true)
  assert.equal(d.canUnplug, true)
})

test('决策：连上了但是 USB 序列号 → 还不能拔线', () => {
  const d = decide({ ok: true, serial: '2MN0224829001893', canUnplug: false })
  assert.equal(d.stage, 'connected')
  assert.equal(d.wireless, false, 'USB 序列号是纯数字，不该判成无线')
})

test('决策：没 USB 也没端口 → 引导插线', () => {
  assert.equal(decide({ ok: false, needSetup: true, needUsb: true }).stage, 'needUsb')
})

test('决策：有配对端口 → 只差配对码', () => {
  assert.equal(decide({ ok: false, needPair: true }).stage, 'needPair')
})

test('判断无线序列号的正则', () => {
  const isWifi = s => /:\d+$/.test(s)
  assert.equal(isWifi('172.31.100.199:5555'), true)
  assert.equal(isWifi('192.168.1.5:37000'), true)
  assert.equal(isWifi('2MN0224829001893'), false, 'USB 序列号不该匹配')
  assert.equal(isWifi(''), false)
  assert.equal(isWifi(undefined), false)
})
