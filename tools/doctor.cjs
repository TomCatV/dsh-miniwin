'use strict'
/**
 * 一键自检：把这套东西「现在到底卡在哪」打印出来。
 *
 * 为什么要它：用户每次报问题只能说「连不上」，而真正的原因可能分散在
 * adb / WiFi / 接收端 / Electron 路径 / 面板状态 五个地方。
 * 这个脚本把五层一次性摊开，谁坏了当场就能看出来。
 *
 * 用法：
 *   node tools/doctor.js                # 自动探测 DSH 端口
 *   node tools/doctor.js http://127.0.0.1:4019
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const PKG = path.resolve(__dirname, '..')
const RUNTIME = path.join(PKG, 'runtime')
const DSH_BASE = process.argv[2] || process.env.DSH_BASE || ''

const ok = m => console.log('  \x1b[32m✓\x1b[0m ' + m)
const warn = m => console.log('  \x1b[33m!\x1b[0m ' + m)
const bad = m => console.log('  \x1b[31m✗\x1b[0m ' + m)
const head = m => console.log('\n\x1b[1m' + m + '\x1b[0m')

function run (bin, args, timeout = 8000) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout, windowsHide: true }).trim()
  } catch (e) {
    return String((e && (e.stdout || e.message)) || '')
  }
}

async function main () {
  /* ---------- 1. 运行时文件 ---------- */
  head('1. 运行时')
  const need = ['main.js', 'ui.html', 'preload.js', 'device.js', 'audio-router.js',
    'pair-page.js', 'wifi-receiver.js', 'transport-pick.js']
  let missing = 0
  for (const f of need) {
    const p = path.join(RUNTIME, f)
    if (!fs.existsSync(p)) { bad('缺文件 ' + f); missing++ }
  }
  if (!missing) ok(`runtime 完整（${need.length} 个关键文件都在）`)

  const apk = path.join(RUNTIME, 'apk', 'miniwin.apk')
  if (fs.existsSync(apk)) ok(`APK ${(fs.statSync(apk).size / 1024).toFixed(0)} KB`)
  else bad('缺 apk/miniwin.apk（手机装不了 App，声音也没了）')

  const scrcpy = path.join(RUNTIME, 'tools', 'scrcpy', 'scrcpy-win64-v5.0.1', 'scrcpy.exe')
  const adb = path.join(RUNTIME, 'tools', 'scrcpy', 'scrcpy-win64-v5.0.1', 'adb.exe')
  fs.existsSync(scrcpy) ? ok('scrcpy.exe 在位') : bad('缺 scrcpy.exe')
  fs.existsSync(adb) ? ok('adb.exe 在位') : bad('缺 adb.exe')

  /* ---------- 2. Electron（迷你窗要它） ---------- */
  head('2. Electron')
  const cfg = path.join(os.homedir(), '.dsh', 'dsh-miniwin.json')
  try {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    if (j.electron && fs.existsSync(j.electron)) ok('缓存命中: ' + j.electron)
    else bad('缓存里的路径不存在: ' + j.electron + '（删掉这个文件会自动重找）')
  } catch {
    warn('还没有缓存（' + cfg + '）：第一次启动会自己找')
  }
  if (process.versions && process.versions.electron) {
    warn('当前进程跑在 Electron 里，宿主 execPath=' + process.execPath)
  }

  /* ---------- 3. 设备与通道 ---------- */
  head('3. 设备 / 通道')
  if (!fs.existsSync(adb)) { bad('没有 adb，跳过'); }
  else {
    const v = run(adb, ['version']).split('\n')[0]
    ok(v || 'adb 版本未知')
    const out = run(adb, ['devices', '-l'])
    const lines = out.split(/\r?\n/).slice(1).filter(l => l.trim())
    if (!lines.length) {
      warn('adb 里一台设备都没有（USB 没插 + WiFi 没连 = 只能走 App 推流）')
    } else {
      for (const l of lines) {
        const serial = l.split(/\s+/)[0]
        const state = (l.split(/\s+/)[1] || '')
        const isWifi = /:\d+$/.test(serial)
        const kind = isWifi ? 'WiFi' : 'USB '
        const mark = state === 'device' ? ok : bad
        mark(`${kind}  ${serial}  ${state}`)
      }
    }
    // 陈旧的 offline 条目会干扰判断
    const stale = lines.filter(l => /\soffline\s/.test(l))
    if (stale.length) warn(`有 ${stale.length} 条 offline 残留，建议 adb disconnect <ip:port>`)
  }

  /* ---------- 4. 局域网 ---------- */
  head('4. 局域网')
  try {
    const disc = require(path.join(RUNTIME, 'wifi-discovery.js'))
    const t0 = Date.now()
    const r = await disc.discover({ adbPath: adb, timeout: 180 })
    ok(`扫描耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log('    网段: ' + r.subnets.map(s => `${s.base}(${s.iface})`).join(', '))
    if (r.candidates.length) {
      for (const c of r.candidates.slice(0, 5)) console.log(`    候选 ${c.host}:${c.port}  ← ${c.from}`)
    } else warn('没扫到任何 5555 端口（手机没开无线调试 / 不在同一网段）')
  } catch (e) { bad('发现模块失败: ' + e.message) }

  /* ---------- 5. 接收端（App 推流 + 配对页） ---------- */
  head('5. 接收端')
  let meta = null
  try {
    const r = await fetch('http://127.0.0.1:43111/meta', { signal: AbortSignal.timeout(1500) })
    if (r.ok) { meta = await r.json(); ok(`/meta 在线  已连=${meta.connected} 帧=${meta.frames} 音频=${meta.hasAudio}`) }
  } catch {}
  if (!meta) warn('接收端没起（点一次「启动迷你窗」或 wifi-start 才会起）')
  try {
    const r = await fetch('http://127.0.0.1:43111/pair', { signal: AbortSignal.timeout(1500) })
    const html = await r.text()
    if (r.ok && /miniwin:\/\/stream/.test(html.replace(/&amp;/g, '&'))) ok('配对页正常，深链里有手机能用的 host:port')
    else bad('配对页异常（HTTP ' + r.status + '）')
  } catch { warn('配对页不可达') }

  /* ---------- 6. DSH 面板 ---------- */
  head('6. DSH 面板')
  const bases = DSH_BASE ? [DSH_BASE] : ['http://127.0.0.1:4019', 'http://127.0.0.1:7487']
  let panel = null
  for (const b of bases) {
    try {
      const r = await fetch(b + '/dsh-miniwin/state', { signal: AbortSignal.timeout(2000) })
      if (r.ok) { panel = { base: b, j: await r.json() }; break }
    } catch {}
  }
  if (!panel) warn('没找到 DSH（面板接口不可达）。用 node tools/doctor.js http://127.0.0.1:<端口> 指定')
  else {
    ok(`面板在线 ${panel.base}  phase=${panel.j.state && panel.j.state.phase}`)
    if (panel.j.wifi) console.log(`    App 推流: 已连=${panel.j.wifi.connected} 帧=${panel.j.wifi.frames}`)
    if (panel.j.lan && panel.j.lan.pairUrl) console.log('    手机打开: ' + panel.j.lan.pairUrl)
  }

  console.log('\n' + '─'.repeat(52))
  console.log('  哪一层坏了就修哪一层：上面 ✗ 的行就是答案。')
}

main().catch(e => { console.error('doctor 崩了:', e && e.stack || e); process.exit(1) })
