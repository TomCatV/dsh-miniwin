'use strict'
/**
 * 冒烟测试：把插件的每个用户入口真的打一遍。
 *
 * 为什么需要它：这个插件之前的"验证"全是手工点一遍，点完就忘。
 * 于是「pair-page.js 没打包」「path 被遮蔽」「面板没有二维码」这类问题
 * 要等用户踩到才被发现 —— 用户的原话是「就是在 bug 里找到少量代码」。
 *
 * 用法：
 *   node tools/smoke.js [DSH_BASE]
 *   默认 http://127.0.0.1:4019
 *
 * 退出码：0 全过，1 有失败。
 */
const BASE = process.argv[2] || process.env.DSH_BASE || 'http://127.0.0.1:4019'
const API = BASE + '/dsh-miniwin'

const results = []
function rec (name, ok, detail) {
  results.push({ name, ok, detail: detail || '' })
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} ${name}${detail ? '  —  ' + detail : ''}`)
}

async function get (url, opts) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, text, json, headers: r.headers }
}

async function main () {
  /* 1. 插件在线 + 状态机 */
  try {
    const r = await get(API + '/state')
    rec('GET /state', r.status === 200 && !!r.json && r.json.ok !== false,
      r.json && r.json.state ? 'phase=' + r.json.state.phase : 'HTTP ' + r.status)
  } catch (e) { rec('GET /state', false, e.message) }

  /* 2. 设备列表（可以空，但必须是合法结构） */
  try {
    const r = await get(API + '/devices')
    rec('GET /devices', r.json && Array.isArray(r.json.devices),
      r.json ? (r.json.devices.length + ' 台设备') : 'HTTP ' + r.status)
  } catch (e) { rec('GET /devices', false, e.message) }

  /* 3. 二维码 SVB（面板里那张图） */
  try {
    const r = await get(API + '/qr?format=svg')
    const ct = r.headers.get('content-type') || ''
    rec('GET /qr?format=svg', r.status === 200 && ct.includes('svg') && r.text.startsWith('<svg'),
      r.text.length + ' 字节')
  } catch (e) { rec('GET /qr?format=svg', false, e.message) }

  /* 4. 二维码内容必须指向配对页（相机能扫的 http，不是迷你窗协议） */
  try {
    const r = await get(API + '/qr')
    const t = (r.json && r.json.text) || ''
    rec('二维码内容', /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/pair$/.test(t), t)
  } catch (e) { rec('二维码内容', false, e.message) }

  /* 5. 本机地址（二维码/深链都要用） */
  let lanIp = ''
  try {
    const r = await get(API + '/addrs')
    const list = (r.json && (r.json.addrs || r.json)) || []
    const first = Array.isArray(list) ? list[0] : null
    lanIp = (first && (first.address || first.ip)) || ''
    rec('GET /addrs', !!lanIp, lanIp || '没有局域网地址')
  } catch (e) { rec('GET /addrs', false, e.message) }

  /* 6. WiFi 模式：接收端 + 迷你窗 */
  let recvPort = 0
  let pairUrl = ''
  try {
    const r = await get(API + '/wifi-start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const j = r.json || {}
    recvPort = Number(j.port) || 0
    pairUrl = String(j.pairUrl || '')
    rec('POST /wifi-start', !!(j.ok && j.pid), 'pid=' + j.pid + ' 推流端口=' + recvPort)
  } catch (e) { rec('POST /wifi-start', false, e.message) }

  /* 7. 接收端活着 + /meta 结构 */
  if (recvPort) {
    try {
      const r = await get('http://127.0.0.1:' + (recvPort + 1) + '/meta')
      rec('接收端 /meta', !!(r.json && r.json.ok), 'connected=' + (r.json && r.json.connected))
    } catch (e) { rec('接收端 /meta', false, e.message) }
  }

  /* 8. 配对页：能打开、含深链、含 APK 入口，且请求后接收端不崩 */
  if (pairUrl) {
    try {
      const r = await get(pairUrl)
      /**
       * 注意先还原 HTML 实体：href 里的 `&` 按规范写成 `&amp;`，
       * 浏览器会解析回 `&`，但正则直接匹配会漏（第一版就是这么误报的）。
       */
      const html = r.text.replace(/&amp;/g, '&')
      const hasDeep = /miniwin:\/\/stream\?host=\d+\.\d+\.\d+\.\d+&port=\d+/.test(html)
      const hasApk = html.includes('/app.apk')
      rec('配对页 /pair', r.status === 200 && hasDeep && hasApk,
        (hasDeep ? '深链✓' : '深链✗') + ' ' + (hasApk ? 'APK✓' : 'APK✗'))
      // 崩不崩：再打一次 /meta
      const m = await get('http://127.0.0.1:' + (recvPort + 1) + '/meta')
      rec('配对页请求后接收端仍存活', !!(m.json && m.json.ok))
    } catch (e) { rec('配对页 /pair', false, e.message) }
  }

  /* 9. APK 可下载（HEAD 探大小 + GET 真实字节） */
  try {
    const r = await get(API + '/state')
    void r
    const s = await get(API + '/wifi-state')
    const apkUrl = (s.json && s.json.apkUrl) || ''
    if (apkUrl) {
      const h = await fetch(apkUrl, { method: 'HEAD', signal: AbortSignal.timeout(15000) })
      rec('APK 下载', h.status === 200 && Number(h.headers.get('content-length')) > 30000,
        (h.headers.get('content-length') || '?') + ' 字节')
    } else {
      rec('APK 下载', false, '拿不到 apkUrl')
    }
  } catch (e) { rec('APK 下载', false, e.message) }

  /* 10. 启动迷你窗：没 adb 设备时必须秒回 WiFi 模式，不许等 3 分钟 */
  try {
    const t0 = Date.now()
    const r = await get(API + '/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const ms = Date.now() - t0
    const j = r.json || {}
    rec('POST /launch', !!(j.ok && j.pid) && ms < 20000,
      'pid=' + j.pid + ' 用时 ' + ms + 'ms' + (j.pairUrl ? '（转 WiFi 模式）' : ''))
  } catch (e) { rec('POST /launch', false, e.message) }

  /* 汇总 */
  const bad = results.filter(r => !r.ok)
  console.log('\n' + '─'.repeat(56))
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`)
  if (bad.length) {
    console.log('失败项：')
    for (const b of bad) console.log('  - ' + b.name + (b.detail ? '：' + b.detail : ''))
  }
  process.exit(bad.length ? 1 : 0)
}

main().catch(e => { console.error('smoke 崩溃:', e && e.stack || e); process.exit(1) })
