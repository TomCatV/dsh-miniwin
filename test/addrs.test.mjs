// 网卡排序单测：模拟这台机器上的 7 个网卡，验证选中 WLAN 而不是 FlClash
import { test } from 'node:test'
import assert from 'node:assert/strict'

const PLUGIN = 'C:/Users/Vincent/.dsh/plugins/dsh-miniwin/lib/index.js'

// 这台机器实测的网卡清单（顺序和系统返回一致）
const REAL_NICS = [
  { name: 'FlClash', address: '198.18.0.1' },
  { name: '本地连接', address: '10.8.0.75' },
  { name: 'vEthernet (Default Switch)', address: '172.21.64.1' },
  { name: 'vEthernet (WSL (Hyper-V firewall))', address: '172.25.16.1' },
  { name: 'Npcap Loopback Adapter', address: '169.254.229.164' },
  { name: '以太网 2', address: '192.168.172.122' },
  { name: 'WLAN', address: '172.31.100.174' }
]

function makeServer() {
  const routes = []
  return {
    routes,
    register(r) { routes.push(r); return () => {} },
    find(method, pathname) { return routes.find(x => x.path === pathname) }
  }
}

async function callGet(server, url) {
  const u = new URL(url, 'http://127.0.0.1')
  const route = server.find('GET', u.pathname)
  if (!route) throw new Error('no route ' + u.pathname)
  let payload = ''
  const res = {
    statusCode: 200,
    writeHead(c) { this.statusCode = c; return this },
    end(b) { if (b) payload += b.toString('utf8'); return this },
    setHeader() {}
  }
  await route.handler(
    { method: 'GET', url, headers: { host: '127.0.0.1:19328' }, on() {}, destroy() {} },
    res
  )
  return JSON.parse(payload)
}

const mod = await import('file:///' + PLUGIN.replace(/\\/g, '/'))
const server = makeServer()
mod.apply({
  get(n) { return n === 'webServer' ? server : undefined },
  webServer: server,
  effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
  logger: { warn() {} }
})

test('/addrs 把 WLAN 排在第一位（不能被 FlClash 抢）', async () => {
  const j = await callGet(server, '/dsh-miniwin/addrs')
  assert.equal(j.ok, true)
  assert.ok(j.addrs.length >= 1)
  const first = j.addrs[0]
  assert.equal(first.name, 'WLAN', '第一位应是 WLAN，实际: ' + JSON.stringify(first))
  assert.equal(first.address, '172.31.100.174')
})

test('虚拟网卡排在真网卡之后', async () => {
  const j = await callGet(server, '/dsh-miniwin/addrs')
  const idxOf = (pred) => j.addrs.findIndex(pred)
  const wlanIdx = idxOf(a => a.name === 'WLAN')
  const clashIdx = idxOf(a => /flclash/i.test(a.name))
  const wslIdx = idxOf(a => /WSL/i.test(a.name))
  const apipaIdx = idxOf(a => a.address.startsWith('169.254.'))

  assert.ok(wlanIdx >= 0)
  if (clashIdx >= 0) assert.ok(clashIdx > wlanIdx, 'FlClash 应排在 WLAN 之后')
  if (wslIdx >= 0) assert.ok(wslIdx > wlanIdx, 'WSL 应排在 WLAN 之后')
  if (apipaIdx >= 0) assert.ok(apipaIdx > wlanIdx, 'APIPA 应排在 WLAN 之后')
})

test('每个地址都带 score，且 WLAN 分数最高', async () => {
  const j = await callGet(server, '/dsh-miniwin/addrs')
  for (const a of j.addrs) assert.equal(typeof a.score, 'number', a.name + ' 缺 score')
  const maxScore = Math.max(...j.addrs.map(a => a.score))
  assert.equal(j.addrs[0].score, maxScore, '第一位应是最高分')
  const wlan = j.addrs.find(a => a.name === 'WLAN')
  const clash = j.addrs.find(a => /flclash/i.test(a.name))
  if (wlan && clash) assert.ok(wlan.score > clash.score, 'WLAN(' + wlan.score + ') 应高于 FlClash(' + clash.score + ')')
})

test('过滤掉 127.x 回环', async () => {
  const j = await callGet(server, '/dsh-miniwin/addrs')
  for (const a of j.addrs) {
    assert.ok(!a.address.startsWith('127.'), '不该有回环: ' + a.address)
  }
})

test('用第一位地址生成的二维码可正常产出', async () => {
  const j = await callGet(server, '/dsh-miniwin/addrs')
  const url = 'http://' + j.addrs[0].address + ':' + j.port + '/dsh-miniwin/m'
  const q = await callGet(server, '/dsh-miniwin/qr?text=' + encodeURIComponent(url))
  assert.equal(q.ok, true)
  assert.match(q.svg, /^<svg /)
  assert.ok(url.includes('172.31.100.174'), 'URL 应含 WLAN 地址，实际: ' + url)
})
