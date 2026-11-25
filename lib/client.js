/**
 * dsh-miniwin — 浏览器半侧
 * ---------------------------------------------------------------------------
 * 侧边栏底部一个「投屏」按钮，点开是配对面板：
 *   1. 大二维码（PC 侧出码，手机扫码）
 *   2. 扫码方式说明（相机优先，微信兜底）
 *   3. 一键自动连接（不需要填任何东西）
 *   4. 连上后起桌面透明迷你窗
 *
 * 数据走 Host 半侧 HTTP 路由 /dsh-miniwin/*。
 * 注册 id 必须等于 loader entry 名（dsh-miniwin）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-miniwin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var API = '/dsh-miniwin'

    /* ══════════════════════════════════════════════════════════════════
       设计系统
       ══════════════════════════════════════════════════════════════════ */
    var CSS = [
      /* ---- 容器 ---- */
      '.__mw_root{display:flex;flex-direction:column;gap:16px;font-size:13px;',
      '  color:var(--dsw-alias-label-primary);letter-spacing:.005em}',
      '.__mw_root *{box-sizing:border-box}',

      /* ---- 状态灯（卡片里那一个）---- */
      '.__mw_dot{width:9px;height:9px;border-radius:50%;background:#4a5060;flex:0 0 auto;',
      '  position:relative;transition:background .25s}',
      '.__mw_dot::after{content:"";position:absolute;inset:-4px;border-radius:50%;',
      '  background:currentColor;opacity:0;transition:opacity .25s}',
      '.__mw_dot.live{background:#3ddc84;color:#3ddc84;box-shadow:0 0 10px rgba(61,220,132,.6)}',
      '.__mw_dot.live::after{opacity:.14}',
      '.__mw_dot.err{background:#ff5d55;color:#ff5d55;box-shadow:0 0 10px rgba(255,93,85,.55)}',
      '.__mw_dot.err::after{opacity:.12}',
      '.__mw_dot.wait{background:#f0b429;color:#f0b429;box-shadow:0 0 10px rgba(240,180,41,.5);',
      '  animation:__mw_pulse 1.4s ease-in-out infinite}',
      '.__mw_dot.wait::after{opacity:.14}',
      '@keyframes __mw_pulse{0%,100%{opacity:1}50%{opacity:.4}}',

      /* ---- 副标题 ---- */
      '.__mw_sub{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-tertiary)}',
      '.__mw_sub b{color:var(--dsw-alias-label-primary);font-weight:600}',

      /* ---- 卡片 ---- */
      '.__mw_card{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;',
      '  padding:16px;display:flex;flex-direction:column;gap:13px;',
      '  background:var(--dsw-alias-bg-layer-2)}',
      '.__mw_cardT{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;',
      '  color:var(--dsw-alias-label-tertiary)}',

      /* ---- 提示条 ---- */
      '.__mw_hint{display:flex;gap:10px;align-items:flex-start;padding:12px 13px;',
      '  border-radius:11px;font-size:12.5px;line-height:1.7;',
      '  background:rgba(74,144,248,.08);border:1px solid rgba(74,144,248,.2);',
      '  color:var(--dsw-alias-label-secondary,#bbc3d4)}',
      '.__mw_hint.warn{background:rgba(240,180,41,.09);border-color:rgba(240,180,41,.26)}',
      '.__mw_hint b{color:var(--dsw-alias-label-primary);font-weight:650}',
      '.__mw_hintIcon{width:17px;height:17px;flex:0 0 auto;margin-top:2px;stroke:#7ab0ff;',
      '  fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '.__mw_hint.warn .__mw_hintIcon{stroke:#e0b458}',

      /* ---- 步骤 ---- */
      '.__mw_steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}',
      '.__mw_steps li{display:flex;gap:11px;align-items:flex-start;font-size:12.5px;',
      '  line-height:1.65;color:var(--dsw-alias-label-secondary,#a8b0c4)}',
      '.__mw_steps li b{color:var(--dsw-alias-label-primary);font-weight:650}',
      '.__mw_steps .n{width:20px;height:20px;border-radius:6px;flex:0 0 auto;',
      '  display:grid;place-items:center;font-size:11px;font-weight:700;',
      '  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);',
      '  margin-top:1px;font-variant-numeric:tabular-nums}',
      '.__mw_steps li.k .n{background:rgba(74,144,248,.2);color:#9cc4ff;',
      '  box-shadow:inset 0 0 0 1px rgba(74,144,248,.22)}',

      /* ---- WiFi 模式的精简块 ---- */
      // 状态行：绿点=投屏中，灰点=等待。放在码上面，扫之前扫之后都能一眼看到
      '.__mw_state{display:flex;align-items:center;gap:8px;font-size:12.5px;',
      '  color:var(--dsw-alias-label-secondary,#9aa3b8);margin-bottom:12px}',
      '.__mw_state .d{width:7px;height:7px;border-radius:50%;flex:0 0 auto;',
      '  background:var(--dsw-alias-label-tertiary,#697);opacity:.5}',
      '.__mw_state.on{color:#48c98a}',
      '.__mw_state.on .d{background:#26c97a;opacity:1;box-shadow:0 0 8px rgba(38,201,122,.8)}',
      '.__mw_warn{font-size:12px;line-height:1.6;color:#e08a8a;margin-top:10px}',
      '.__mw_row{display:flex;gap:8px;margin-top:14px}',
      '.__mw_hintLine{font-size:11.5px;line-height:1.6;margin-top:12px;',
      '  color:var(--dsw-alias-label-tertiary)}',

      /* ---- 二维码 ---- */
      '.__mw_qrWrap{display:flex;justify-content:center;margin-top:12px}',
      '.__mw_qr{width:168px;height:168px;border-radius:12px;background:#fff;padding:8px;',
      '  box-sizing:border-box;display:block}',

      /* ---- 按钮 ---- */
      '.__mw_btns{display:flex;gap:9px}',
      '.__mw_btn{flex:1 1 0;border:1px solid var(--dsw-alias-border-l2);',
      '  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);',
      '  border-radius:10px;padding:10px 14px;font:inherit;font-size:13px;font-weight:560;',
      '  cursor:pointer;white-space:nowrap;transition:background .14s,border-color .14s}',
      '.__mw_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);',
      '  background:var(--dsw-alias-bg-layer-2)}',
      '.__mw_btn:active:not(:disabled){transform:translateY(1px)}',
      '.__mw_btn:disabled{opacity:.42;cursor:default}',
      '.__mw_btnPri{flex:1 1 0;border-color:transparent;',
      '  background:linear-gradient(180deg,#4a90f8,#2f6fd8);color:#fff;',
      '  box-shadow:0 3px 12px rgba(47,111,216,.32)}',
      '.__mw_btnPri:hover:not(:disabled){background:linear-gradient(180deg,#5b9bf9,#3a7ae2);',
      '  border-color:transparent}',
      '.__mw_btnIcon{width:15px;height:15px;vertical-align:-2px;margin-right:6px;',
      '  stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      /* ---- 消息 ---- */
      '.__mw_msg{font-size:12.5px;line-height:1.65;padding:11px 13px;border-radius:10px;',
      '  display:none;align-items:flex-start;gap:9px}',
      '.__mw_msg.ok{display:flex;background:rgba(61,220,132,.1);',
      '  border:1px solid rgba(61,220,132,.28);color:#6fdba0}',
      '.__mw_msg.err{display:flex;background:rgba(255,92,84,.1);',
      '  border:1px solid rgba(255,92,84,.28);color:#ff9b94}',
      '.__mw_msg.wait{display:flex;background:rgba(240,180,41,.1);',
      '  border:1px solid rgba(240,180,41,.28);color:#e8c46c}',
      '.__mw_msgIcon{width:15px;height:15px;flex:0 0 auto;margin-top:2px;',
      '  fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',
      '.__mw_msg.ok .__mw_msgIcon{stroke:#5fd394}',
      '.__mw_msg.err .__mw_msgIcon{stroke:#ff8d85}',
      '.__mw_msg.wait .__mw_msgIcon{stroke:#e0b458}',

      /* ---- 日志 ---- */
      '.__mw_logBox{margin-top:2px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:11px}',
      '.__mw_logToggle{display:flex;align-items:center;gap:7px;font-size:11.5px;',
      '  color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none}',
      '.__mw_logToggle:hover{color:var(--dsw-alias-label-primary)}',
      '.__mw_logToggle .arw{font-size:9px;transition:transform .16s;display:inline-block}',
      '.__mw_logToggle .arw.open{transform:rotate(90deg)}',
      '.__mw_logs{max-height:168px;overflow-y:auto;margin-top:9px;',
      '  font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-size:11px;',
      '  line-height:1.7;color:var(--dsw-alias-label-tertiary);',
      '  background:var(--dsw-alias-bg-layer-3);border-radius:9px;padding:10px 12px}',
      '.__mw_logs::-webkit-scrollbar{width:6px}',
      '.__mw_logs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}',
      '.__mw_logl{display:flex;gap:9px;margin-bottom:3px;word-break:break-word}',
      '.__mw_logl .lv{flex:0 0 auto;width:34px;font-weight:600}',
      '.__mw_logl .lv.ok{color:#5fd394}',
      '.__mw_logl .lv.err{color:#ff8d85}',
      '.__mw_logl .lv.warn{color:#e0b458}',
      '.__mw_logl .lv.info{color:#7ab0ff}'
    ].join('')

    var tagId = 'dsh-miniwin/main.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-miniwin'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ══════════════════════════════════════════════════════════════════
       图标
       ══════════════════════════════════════════════════════════════════ */
    function Icon(props) {
      return h('svg', {
        className: props.className,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round'
      }, props.children)
    }

    function IcoScan() {
      return h(Icon, { className: '__mw_hintIcon' },
        h('path', { d: 'M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3' }),
        h('path', { d: 'M3 12h18' })
      )
    }

    function IcoPhone() {
      return h(Icon, { className: '__mw_btnIcon' },
        h('rect', { x: 6, y: 2, width: 12, height: 20, rx: 2.5 }),
        h('path', { d: 'M11 18.5h2' })
      )
    }

    function IcoCheck() {
      return h(Icon, { className: '__mw_msgIcon' }, h('path', { d: 'M4 12.5l5 5L20 6.5' }))
    }

    function IcoWarn() {
      return h(Icon, { className: '__mw_msgIcon' },
        h('path', { d: 'M12 8.5v5M12 17h.01' }),
        h('circle', { cx: 12, cy: 12, r: 9 })
      )
    }

    function IcoWait() {
      return h(Icon, { className: '__mw_msgIcon' }, h('path', { d: 'M12 7v5l3.5 2' }),
        h('circle', { cx: 12, cy: 12, r: 9 }))
    }

    /* ══════════════════════════════════════════════════════════════════
       小组件
       ══════════════════════════════════════════════════════════════════ */
    function Msg(props) {
      if (!props.kind) return null
      var ico = props.kind === 'ok' ? IcoCheck() : props.kind === 'err' ? IcoWarn() : IcoWait()
      return h('div', { className: '__mw_msg ' + props.kind }, ico, h('span', null, props.children))
    }

    function Hint(props) {
      return h('div', { className: '__mw_hint' + (props.warn ? ' warn' : '') },
        props.warn ? h(Icon, { className: '__mw_hintIcon' },
          h('path', { d: 'M12 8.5v5M12 17h.01' }), h('circle', { cx: 12, cy: 12, r: 9 })) : IcoScan(),
        h('span', null, props.children))
    }

    /* ══════════════════════════════════════════════════════════════════
       主面板
       ══════════════════════════════════════════════════════════════════ */
    function Panel() {
      var st = react.useState({
        phase: 'idle', device: null, message: '', logs: [],
        busy: false, kind: '', showLogs: false
      })
      var s = st[0], setS = st[1]
      var upd = function (patch) { setS(function (prev) { return Object.assign({}, prev, patch) }) }

      /* ---- 轮询状态 ---- */
      /**
       * 面板状态以前只同步 phase / device / logs，于是迷你窗推上来的
       * 「在等手机上线（最长 3 分钟）」和「连接失败原因」都不会出现在
       * 侧边栏里 —— 用户点了按钮之后面板一动不动，看起来像卡死。
       *
       * 现在把 message / error 一起带过来，并在 phase=error 时把
       * 红灯和信息条点亮。
       */
      react.useEffect(function () {
        var timer = setInterval(function () {
          fetch(API + '/state', { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (!j || !j.ok) return
              var ss = j.state || {}
              setS(function (prev) {
                var next = Object.assign({}, prev, {
                  phase: ss.phase || prev.phase,
                  device: ss.device || prev.device,
                  logs: ss.logs || prev.logs
                })
                if (ss.phase === 'error') {
                  next.kind = 'err'
                  next.message = ss.error || ss.message || '连接失败'
                } else if (ss.message) {
                  // 等待/进行中的提示，只在没有本地消息时覆盖，避免打断按钮自己的提示
                  if (!prev.busy) { next.kind = prev.kind === 'err' ? 'wait' : prev.kind }
                  if (prev.phase !== ss.phase) next.message = ss.message
                }
                return next
              })
            })
            .catch(function () {})
        }, 1500)
        return function () { clearInterval(timer) }
      }, [])

      /* ---- 一键自动连接 ---- */
      function doAuto () {
        upd({ busy: true, kind: 'wait', message: '正在查找手机…' })
        fetch(API + '/auto', { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (j && j.ok) {
              return upd({
                busy: false,
                kind: 'ok',
                message: '找到手机：' + (j.model || j.serial),
                device: { serial: j.serial, model: j.model, transport: j.via }
              })
            }
            if (j && j.needPair) {
              return upd({
                busy: false,
                kind: 'wait',
                message: '手机已开无线调试，只差配对码。用手机扫码，在页面上填那 6 位数字即可。'
              })
            }
            upd({
              busy: false,
              kind: 'err',
              message: (j && j.message) || '没找到手机。请在手机上打开「开发人员选项 → 无线调试」。'
            })
          })
          .catch(function (e) { upd({ busy: false, kind: 'err', message: '请求失败: ' + e.message }) })
      }

      /**
       * 启动迷你窗。
       *
       * 2.0 架构下不需要预先知道 serial —— 迷你窗启动后会自己
       * 扫描局域网找手机（wifi-adb-keeper），连上自动出画面。
       * 旧版强制「先点自动连接找到手机」，那是 adb 插线流程的产物。
       *
       * 传 serial 仍然支持（可选优化）：已连过时传过去能省一次扫描。
       */
      function doLaunch () {
        var serial = s.device && s.device.serial
        upd({ busy: true, kind: 'wait', message: '正在启动桌面迷你窗…' })
        fetch(API + '/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(serial ? { serial: serial } : {})
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j.ok) return upd({ busy: false, kind: 'err', message: j.error || '启动失败' })
            upd({ busy: false, kind: 'ok', message: '迷你窗已打开，正在连接手机…' })
          })
          .catch(function (e) { upd({ busy: false, kind: 'err', message: '请求失败: ' + e.message }) })
      }

      /* ---- 状态灯：只保留卡片里那一个 ---- */
      var logs = Array.isArray(s.logs) ? s.logs.slice(-40) : []
      var connected = !!(s.device && s.device.serial)

      /**
       * 设备在线探测 —— 面板状态要反映「手机在不在」，不是「迷你窗开没开」。
       *
       * 之前只有 s.device，而它只在迷你窗启动后才被推上来。于是手机明明
       * 连着、adb 里能看到，面板照样写「未连接」，用户以为坏了。
       *
       * 每 10 秒问一次 /devices（本地 adb，几十毫秒），有设备就记下型号。
       * 频率刻意放低：这只是个状态提示，不值得频繁 fork adb。
       */
      var devRef = react.useState(null)
      var devInfo = devRef[0], setDevInfo = devRef[1]

      react.useEffect(function () {
        var alive = true
        function probe () {
          fetch(API + '/devices', { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (!alive || !j) return
              var list = Array.isArray(j.devices) ? j.devices : []
              var hit = list.filter(function (d) { return d.state === 'device' })[0] || null
              setDevInfo(hit)
            })
            .catch(function () {})
        }
        probe()
        var t = setInterval(probe, 10000)
        return function () { alive = false; clearInterval(t) }
      }, [])

      /**
       * 状态判定 —— 只认 adb。
       *
       * 原来的写法是 `streaming = wifi ? wifi.connected : connected`。
       * `wifi` 由 refreshWifiQr 在面板打开时填充，只要接收端**在跑**
       * 它就会变成非空对象（哪怕手机根本没连过来）。于是 adb 明明连着、
       * 画面明明在投，面板顶部却写「未连接」。
       *
       * 现在：判定只来自 adb（s.device.serial 优先，其次设备探测）。
       */
      var streaming = connected
      var phoneOnline = !!(devInfo && devInfo.serial)
      var phoneName = (connected && s.device && s.device.model) ||
        (devInfo && devInfo.model) || ''

      return h('div', { className: '__mw_root' },

        /**
         * ══════════ 面板主体 ══════════
         *
         * 手机端什么都不用装、不用扫码、不用配对。
         * 采集由 PC 侧的 scrcpy.exe 通过 adb 完成，手机只是个被采集的屏幕。
         *
         * 「手机投屏」这个标题在弹窗顶栏已经有了，这里不再重复一遍；
         * 状态也只说一次（卡片里那个带灯的），不要「未连接」写两遍。
         */
        h('div', { className: '__mw_card' },

          /* 状态行 —— 全面板唯一一处状态文字 */
          h('div', { className: '__mw_state' + (streaming || phoneOnline ? ' on' : '') },
            h('span', { className: 'd' }),
            h('span', null, (function () {
              if (s.busy) return '正在启动…'
              if (streaming) return phoneName ? '投屏中 · ' + phoneName : '投屏中'
              if (phoneOnline) return (phoneName || '手机') + ' 已连接，待启动'
              return '手机不在线'
            })())
          ),

          /* 一句话说明 —— 只在没连上时出现 */
          !streaming
            ? h('div', { className: '__mw_hintLine' },
                phoneOnline
                  ? '点下面的按钮，画面就出来。'
                  : '手机扫下面的码：装了 App 直接进投屏，没装会打开配对页。')
            : null,

          /**
           * 二维码 —— 第一次连接的唯一入口。
           *
           * 之前面板里**根本没有码**：用户装了 APK 之后找不到地方扫，
           * 点按钮只得到「手机不在线」。码的内容由 Host 端
           * /dsh-miniwin/qr 生成（miniwin://stream?host=<PC IP>&port=<推流端口>），
           * 前端只负责显示，避免自己算 IP 算错。
           */
          !streaming
            ? h('div', { className: '__mw_qrWrap' },
                h('img', {
                  className: '__mw_qr',
                  src: API + '/qr?format=svg&t=' + Date.now(),
                  alt: '手机扫码连接'
                })
              )
            : null,

          /* 唯一的按钮 */
          h('div', { className: '__mw_row' },
            h('button', {
              className: '__mw_btn __mw_btnPri',
              style: { flex: '1' },
              disabled: s.busy,
              onClick: doLaunch
            }, s.busy ? '启动中…' : (streaming ? '重开迷你窗' : '启动迷你窗'))
          ),

          /* 连不上时的排查提示 —— 折叠起来，不打扰正常使用 */
          phoneOnline && !streaming
            ? h('div', { className: '__mw_warn' },
                '一直没画面：手机重启后需要插一次 USB（3 秒），程序会自动切回无线。')
            : null
        ),

        h(Msg, { kind: s.kind }, s.message),

        /* ── 日志 ── */
        logs.length
          ? h('div', { className: '__mw_logBox' },
              h('div', {
                className: '__mw_logToggle',
                onClick: function () { upd({ showLogs: !s.showLogs }) }
              },
                h('span', { className: 'arw' + (s.showLogs ? ' open' : '') }, '▶'),
                h('span', null, '运行日志 (' + logs.length + ')')
              ),
              s.showLogs
                ? h('div', { className: '__mw_logs' },
                    logs.map(function (l, i) {
                      return h('div', { className: '__mw_logl', key: i },
                        h('span', { className: 'lv ' + (l.level || 'info') }, l.level || 'info'),
                        h('span', null, l.msg)
                      )
                    })
                  )
                : null
            )
          : null
      )
    }

    /* ══════════════════════════════════════════════════════════════════
       侧边栏入口
       ══════════════════════════════════════════════════════════════════ */
    function SidebarButton () {
      var open = react.useState(false)
      var o = open[0], setO = open[1]

      return h(react.Fragment, null,
        h('button', {
          title: '手机投屏',
          onClick: function () { setO(!o) },
          style: {
            display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
            padding: '9px 12px', border: '1px solid var(--dsw-alias-border-l2)',
            background: o ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            borderRadius: '10px', font: 'inherit', fontSize: '13px',
            fontWeight: '560', cursor: 'pointer', textAlign: 'left',
            transition: 'background .14s,border-color .14s'
          },
          onMouseEnter: function (e) { e.currentTarget.style.borderColor = 'var(--dsw-alias-state-business-primary)' },
          onMouseLeave: function (e) { e.currentTarget.style.borderColor = 'var(--dsw-alias-border-l2)' }
        },
          h(Icon, { className: '__mw_btnIcon', style: { marginRight: '0' } },
            h('rect', { x: 6, y: 2, width: 12, height: 20, rx: 2.5 }),
            h('path', { d: 'M11 18.5h2' })
          ),
          h('span', null, '投屏')
        ),
        o
          ? h('div', {
              style: {
                position: 'fixed', zIndex: 2147483000,
                right: '18px', bottom: '92px', width: '372px',
                maxHeight: 'calc(100vh - 130px)', overflowY: 'auto',
                background: 'var(--dsw-alias-bg-layer-1,#12141a)',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '16px', padding: '18px',
                boxShadow: '0 26px 70px rgba(0,0,0,.6)',
                overscrollBehavior: 'contain'
              }
            },
              h('div', {
                style: {
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', marginBottom: '14px'
                }
              },
                h('span', { style: { fontSize: '14px', fontWeight: '650' } }, '手机投屏'),
                h('span', {
                  style: {
                    cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)',
                    fontSize: '17px', lineHeight: 1, width: '24px', height: '24px',
                    display: 'grid', placeItems: 'center', borderRadius: '6px'
                  },
                  onMouseEnter: function (e) { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-3)' },
                  onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' },
                  onClick: function () { setO(false) }
                }, '×')
              ),
              h(Panel, null)
            )
          : null
      )
    }

    /* ══════════════════════════════════════════════════════════════════
       插件
       ══════════════════════════════════════════════════════════════════ */
    var inject = ['slots']

    function apply (ctx) {
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'miniwin-launch', order: 40, label: '手机投屏' },
          SidebarButton
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
