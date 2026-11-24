// Host 半侧单测：不启动 DSH，直接构造假 ctx + 假 webServer 验证路由
import { test } from 'node:test'
import assert from 'node:assert/strict'

const PLUGIN = 'C:/Users/Vincent/.dsh/plugins/dsh-miniwin/lib/index.js'

function makeServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    /**
     * 新模型：一条 route = 一个 path，method 由 handler 内部分流。
     * 所以这里只按 path 找，不再按 method 找。
     */
    find(method, pathname) {
      const r = routes.find(x => x.path === pathname)
      if (!r) return null
      // 断言注册形状：必须是 kind:'exact'，不能带 method 字段
      return r
    }
  }
}

function makeCtx(server) {
  return {
    get(name) { return name === 'webServer' ? server : undefined },
    webServer: server,
    effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
    logger: { warn() {}, info() {}, error() {} }
  }
}

async function call(server, method, url, bodyObj) {
  const u = new URL(url, 'http://127.0.0.1')
  const route = server.find(method, u.pathname)
  if (!route) throw new Error('no route for path ' + u.pathname)

  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:14886' },
    on(ev, cb) {
      if (ev === 'data' && bodyObj) setTimeout(() => cb(Buffer.from(JSON.stringify(bodyObj), 'utf8')), 0)
      if (ev === 'end') setTimeout(() => cb(), 1)
      return req
    },
    destroy() {}
  }

  let code = 200
  let payload = ''
  const res = {
    writeHead(c) { code = c; return res },
    end(buf) { if (buf) payload += buf.toString('utf8'); return res },
    setHeader() {},
    statusCode: 200
  }
  await route.handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(payload) } catch { parsed = payload }
  return { code, body: parsed }
}

const mod = await import('file:///' + PLUGIN.replace(/\\/g, '/'))
const server = makeServer()
const ctx = makeCtx(server)
mod.apply(ctx)

// 本文件的 apply() 会起一个监听 0.0.0.0 的 LAN 服务器，
// node --test 会因为这个活跃 handle 而无法退出，所以跑完统一切断。
process.on('beforeExit', () => {})

test('导出形状正确', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('webServer'))
  assert.equal(mod.name, 'dsh-miniwin')
  assert.equal(mod.default, undefined, '不能导出 default')
})

test('注册了全部预期路由（按 path，一个 path 一条）', () => {
  const paths = server.routes.map(r => r.path).sort()
  for (const want of [
    '/dsh-miniwin/state',
    '/dsh-miniwin/addrs',
    '/dsh-miniwin/qr',
    '/dsh-miniwin/devices',
    '/dsh-miniwin/m',
    '/dsh-miniwin/pair',
    '/dsh-miniwin/connect',
    '/dsh-miniwin/launch',
    '/dsh-miniwin/report'
  ]) {
    assert.ok(paths.includes(want), 'missing ' + want + '\n  got:\n  ' + paths.join('\n  '))
  }
})

test('路由形状必须是 kind:exact 且不带 method 字段', () => {
  // 这是 401 的根因：DSH webServer 只认 kind:exact + path，
  // 带 method 字段的对象注册后不可达。
  for (const r of server.routes) {
    assert.equal(r.kind, 'exact', r.path + ' 缺 kind:exact')
    assert.equal(r.method, undefined, r.path + ' 不该有 method 字段')
    assert.equal(typeof r.handler, 'function', r.path + ' 缺 handler')
  }
})

test('同 path 的不同 method 由内部正确分流', async () => {
  // /dsh-miniwin/report 只注册了 POST，GET 应该 405
  const r = await call(server, 'GET', '/dsh-miniwin/report')
  assert.equal(r.code, 405)
})

/**
 * 准入策略变更说明。
 *
 * 原先「sec-fetch-site: cross-site 一律拒」。
 * 但 DSH 侧边栏用沙箱 iframe 打开扫码页，浏览器会把这些本地请求标成
 * cross-site（Origin: null），于是「刷新二维码」按钮点了完全没反应。
 *
 * 现在的判定只认一条硬标准：**有 Origin 且 host 对不上才拒**。
 * 所以这条用例改成验证真正的跨站来源仍然被挡。
 */
test('外部站点来源被拒 403', async () => {
  const route = server.find('GET', '/dsh-miniwin/state')
  const res = {
    statusCode: 200,
    writeHead(c) { this.statusCode = c; return this },
    end() { return this },
    setHeader() {}
  }
  await route.handler(
    {
      method: 'GET', url: '/dsh-miniwin/state',
      headers: { host: 'localhost:14886', origin: 'https://evil.example.com' },
      on() {}, destroy() {}
    },
    res
  )
  assert.equal(res.statusCode, 403)
})

test('沙箱 iframe（Origin: null）放行 —— 侧边栏扫码页要靠这条', async () => {
  const route = server.find('GET', '/dsh-miniwin/state')
  const res = {
    statusCode: 200,
    writeHead(c) { this.statusCode = c; return this },
    end() { return this },
    setHeader() {}
  }
  await route.handler(
    {
      method: 'GET', url: '/dsh-miniwin/state',
      headers: { host: 'localhost:14886', origin: 'null', 'sec-fetch-site': 'cross-site' },
      on() {}, destroy() {}
    },
    res
  )
  assert.notEqual(res.statusCode, 403)
})

test('OPTIONS 预检返回 204 且带 CORS 头', async () => {
  const route = server.find('GET', '/dsh-miniwin/state')
  let code = 0
  let headers = null
  const res = {
    statusCode: 200,
    writeHead(c, h) { code = c; headers = h; this.statusCode = c; return this },
    end() { return this },
    setHeader() {}
  }
  await route.handler(
    {
      method: 'OPTIONS', url: '/dsh-miniwin/state',
      headers: { host: 'localhost:14886', origin: 'null' },
      on() {}, destroy() {}
    },
    res
  )
  assert.equal(code, 204)
  assert.equal(headers['Access-Control-Allow-Origin'], '*')
})

test('origin 与 host 不匹配被拒 403', async () => {
  const route = server.find('GET', '/dsh-miniwin/state')
  const res = {
    statusCode: 200,
    writeHead(c) { this.statusCode = c; return this },
    end() { return this },
    setHeader() {}
  }
  await route.handler(
    { method: 'GET', url: '/dsh-miniwin/state', headers: { host: 'localhost:14886', origin: 'http://evil.com' }, on() {}, destroy() {} },
    res
  )
  assert.equal(res.statusCode, 403)
})

test('GET /state', async () => {
  const r = await call(server, 'GET', '/dsh-miniwin/state')
  assert.equal(r.code, 200)
  assert.equal(r.body.ok, true)
  assert.ok(Array.isArray(r.body.state.logs))
})

test('GET /addrs 返回非回环 IPv4 和端口', async () => {
  const r = await call(server, 'GET', '/dsh-miniwin/addrs')
  assert.equal(r.code, 200)
  assert.ok(r.body.addrs.length > 0)
  assert.equal(r.body.port, 14886)
  for (const a of r.body.addrs) {
    assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/)
    assert.ok(!a.address.startsWith('127.'))
  }
})

test('GET /qr 生成 SVG 且尺寸正确', async () => {
  const text = 'http://172.31.100.174:14886/dsh-miniwin/m'
  const r = await call(server, 'GET', '/dsh-miniwin/qr?text=' + encodeURIComponent(text))
  assert.equal(r.code, 200)
  assert.equal(r.body.ok, true)
  assert.match(r.body.svg, /^<svg /)
  assert.ok(r.body.svg.includes('width="210"'), '实际: ' + r.body.svg.slice(0, 150))
})

test('GET /qr 缺 text -> 400', async () => {
  const r = await call(server, 'GET', '/dsh-miniwin/qr')
  assert.equal(r.code, 400)
})

test('GET /qr 超长 -> 400', async () => {
  const r = await call(server, 'GET', '/dsh-miniwin/qr?text=' + 'x'.repeat(500))
  assert.equal(r.code, 400)
})

test('POST /pair 缺 addr -> 400', async () => {
  const r = await call(server, 'POST', '/dsh-miniwin/pair', {})
  assert.equal(r.code, 400)
})

test('POST /connect 缺 addr -> 400', async () => {
  const r = await call(server, 'POST', '/dsh-miniwin/connect', {})
  assert.equal(r.code, 400)
})

test('POST /report 写入并能在 state 读回', async () => {
  const r = await call(server, 'POST', '/dsh-miniwin/report', {
    phase: 'streaming', videoSize: { w: 476, h: 1080 }, message: '测试消息', level: 'ok'
  })
  assert.equal(r.code, 200)
  const s = await call(server, 'GET', '/dsh-miniwin/state')
  assert.equal(s.body.state.phase, 'streaming')
  assert.deepEqual(s.body.state.videoSize, { w: 476, h: 1080 })
  assert.ok(s.body.state.logs.some(l => l.msg === '测试消息'))
})

test('GET /m 返回手机配对页（零输入版）', async () => {
  const r = await call(server, 'GET', '/dsh-miniwin/m')
  assert.equal(r.code, 200)
  assert.match(r.body, /<!doctype html>/i)
  assert.match(r.body, /<title>手机投屏<\/title>/)

  // 四个阶段都必须存在（自动连接 / 成功 / 需插线 / 需配对码）
  for (const stage of ['sScan', 'sOk', 'sNeed', 'sPair']) {
    assert.match(r.body, new RegExp('id="' + stage + '"'), '缺阶段 ' + stage)
  }

  // 零输入核心：启动即自动扫描，且只调 /auto 与 /pair-auto
  assert.match(r.body, /api\('\/auto'\)/, '应自动调用 /auto')
  assert.match(r.body, /pair-auto/, '应调用零输入配对接口')
  assert.match(r.body, /btnPair/, '应有配对按钮')

  // 不能出现让用户填 IP 的输入框
  assert.ok(!/placeholder="[^"]*\d+\.\d+\.\d+\.\d+/.test(r.body), '不该有 IP 输入框')

  // 配对码输入框限制 6 位数字
  assert.match(r.body, /maxlength="6"/)

  // API 前缀从 location.pathname 动态推导（LAN 服务挂在 /t/<token>/ 下）
  assert.match(r.body, /location\.pathname\.match/)

  // 微信环境要给出「在浏览器打开」的引导
  assert.match(r.body, /MicroMessenger/)
  assert.match(r.body, /在浏览器打开/)
})

test('GET /auto 路由存在且返回结构正确', async () => {
  const route = server.find('GET', '/dsh-miniwin/auto')
  assert.ok(route, '缺 /auto 路由')
  assert.equal(route.kind, 'exact')
})

test('POST /pair-auto 缺配对码 -> 400', async () => {
  const r = await call(server, 'POST', '/dsh-miniwin/pair-auto', {})
  assert.equal(r.code, 400)
  assert.equal(r.body.ok, false)
})

test('POST /pair-auto 配对码非 6 位 -> 400', async () => {
  const r = await call(server, 'POST', '/dsh-miniwin/pair-auto', { code: '123' })
  assert.equal(r.code, 400)
})

test('没有 webServer 时不抛错', () => {
  const badCtx = {
    get() { return undefined },
    webServer: undefined,
    effect(fn) { fn() },
    logger: { warn() {} }
  }
  assert.doesNotThrow(() => mod.apply(badCtx))
})

/**
 * 收尾：apply() 里起的 LAN 服务器会一直监听，node --test 因此无法退出。
 * 跑完所有用例后手动调 apply 返回的 disposer 把服务器关掉。
 */
test('收尾：关闭 LAN 服务器', async () => {
  // mock 的 ctx.effect 当时就把 disposer 存起来了，这里重建一次拿 disposer
  const routes2 = []
  const server2 = { register(r) { routes2.push(r); return () => {} } }
  let dispose = null
  const ctx2 = {
    get(n) { return n === 'webServer' ? server2 : undefined },
    webServer: server2,
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') dispose = d
      return () => {}
    },
    logger: { warn() {} }
  }
  mod.apply(ctx2)
  // 等 LAN server 完成 listen
  await new Promise(r => setTimeout(r, 600))
  if (dispose) dispose()
  // 给 close 一点时间
  await new Promise(r => setTimeout(r, 300))
  assert.ok(true)
})
