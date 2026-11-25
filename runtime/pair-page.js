'use strict'
/**
 * 手机扫码后打开的「配对页」。
 *
 * ── 这个文件为什么曾经是空的 ──
 *
 * wifi-receiver.js 里有 `require('./pair-page.js')`，但仓库里根本没有这个文件：
 * 一访问 /pair 就抛 MODULE_NOT_FOUND，**整个接收端进程直接退出**。
 * 用户看到的现象就是「纯 WiFi 连不上」：二维码扫开是空白，随后连 APK
 * 推流也一起断了（同一个进程）。
 *
 * 现在的实现：一张自包含的页面，不依赖任何外网资源。
 *   ① 无线调试配对（Android 11+）：填「IP:端口」+ 6 位配对码 → POST /pair
 *   ② 配对成功后自动 POST /start-zero 起传输
 *   ③ 上面两条走不通时，页面直接给出 APK 下载入口（走 App 推流那条路）
 */

function esc (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * @param {string} lanIp  PC 的局域网 IP（页面会用到）
 * @param {number} port   接收端 HTTP 端口（页面里的请求都打自己所在的 origin）
 */
function pairPageHtml (lanIp, port) {
  const ip = esc(lanIp)
  const p = Number(port) || 0
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0e14">
<title>MiniWin 投屏配对</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;padding:24px 18px calc(28px + env(safe-area-inset-bottom));
    background:#0b0e14;color:#e9ebf2;
    font:15px/1.6 -apple-system,"PingFang SC","HarmonyOS Sans SC",system-ui,sans-serif}
  h1{font-size:19px;margin:6px 0 4px}
  .sub{color:rgba(233,235,242,.55);font-size:13px;margin-bottom:22px}
  .card{background:#141922;border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:16px;margin-bottom:16px}
  .card h2{font-size:14px;margin:0 0 10px;font-weight:600;color:rgba(233,235,242,.9)}
  label{display:block;font-size:12px;color:rgba(233,235,242,.55);margin:10px 0 4px}
  input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);
    background:#0e1219;color:#e9ebf2;font:inherit;font-variant-numeric:tabular-nums}
  input:focus{outline:none;border-color:#4a90f8}
  button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:11px;
    background:linear-gradient(180deg,#4a90f8,#2b6fe0);color:#fff;font:600 15px/1 inherit;letter-spacing:.02em}
  button:disabled{opacity:.5}
  .alt{margin-top:12px;padding:13px;border-radius:11px;border:1px solid rgba(255,255,255,.14);
    background:transparent;color:#a9ccff;font-weight:600;text-align:center;display:block;text-decoration:none}
  .hint{font-size:12px;color:rgba(233,235,242,.45);margin-top:8px}
  .msg{margin-top:14px;padding:11px 12px;border-radius:10px;font-size:13px;display:none;white-space:pre-wrap}
  .msg.ok{display:block;background:rgba(61,220,132,.12);border:1px solid rgba(61,220,132,.3);color:#9ff0c4}
  .msg.err{display:block;background:rgba(255,93,85,.12);border:1px solid rgba(255,93,85,.3);color:#ffb3ae}
  .ip{font-family:Consolas,monospace;color:#a9ccff}
</style>
</head>
<body>
  <h1>MiniWin 投屏配对</h1>
  <div class="sub">电脑：<span class="ip">${ip}${p ? ':' + p : ''}</span></div>

  <div class="card">
    <h2>方式一 · 无线调试配对（Android 11+）</h2>
    <label>配对地址（手机：开发者选项 → 无线调试 → 使用配对码配对设备）</label>
    <input id="addr" placeholder="192.168.1.23:38571" autocapitalize="off" autocomplete="off" spellcheck="false">
    <label>6 位配对码</label>
    <input id="code" placeholder="123456" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
    <button id="go">配对并开始投屏</button>
    <div class="hint">配对成功后手机会被 adb 接管，电脑上的迷你窗会自己亮起来。</div>
  </div>

  <div class="card">
    <h2>方式二 · 装 App（任何安卓版本都行）</h2>
    <a class="alt" href="/app.apk">下载 MiniWin 投屏 APK</a>
    <div class="hint">装好后点开 App，它会把画面和声音直接推给这台电脑，不需要 adb。</div>
  </div>

  <div id="msg" class="msg"></div>

<script>
(function () {
  var addr = document.getElementById('addr')
  var code = document.getElementById('code')
  var btn = document.getElementById('go')
  var msg = document.getElementById('msg')

  function say (text, kind) {
    msg.className = 'msg ' + (kind || 'ok')
    msg.textContent = text
  }

  function post (path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json() })
  }

  btn.addEventListener('click', function () {
    var a = (addr.value || '').trim()
    var c = (code.value || '').trim()
    if (!/^\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+$/.test(a)) return say('配对地址要写成 IP:端口', 'err')
    if (!/^\\d{6}$/.test(c)) return say('配对码是 6 位数字', 'err')

    btn.disabled = true
    say('正在配对…')
    post('/pair', { addr: a, code: c })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '配对失败')
        say('配对成功，正在连接…')
        return post('/start-zero', { addr: a, wlanPort: r.wlanPort })
      })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '连接失败')
        say('已连上。看电脑上的迷你窗，画面应该出来了。')
      })
      .catch(function (e) { say(String(e.message || e), 'err') })
      .finally(function () { btn.disabled = false })
  })
})()
</script>
</body>
</html>`
}

module.exports = { pairPageHtml }
