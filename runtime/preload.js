const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: () => ipcRenderer.send('drag:move'),
  dragEnd: () => ipcRenderer.send('drag:end'),

  resizeStart: (dir) => ipcRenderer.send('resize:start', dir),
  resizeMove: () => ipcRenderer.send('resize:move'),
  resizeEnd: () => ipcRenderer.send('resize:end'),

  state: () => ipcRenderer.invoke('win:state'),
  setOpacity: (v) => ipcRenderer.send('win:opacity', v),
  setPin: (on) => ipcRenderer.send('win:pin', on),
  setRatio: (on) => ipcRenderer.send('win:ratio', on),
  scale: (f) => ipcRenderer.send('win:scale', f),
  reset: () => ipcRenderer.send('win:reset'),
  close: () => ipcRenderer.send('win:close'),

  /**
   * 视频真实分辨率 + 当前 chrome（标题栏+控制面板）实测高度。
   * 主进程据此把窗口收到「视频区正好是该比例」的尺寸，
   * chrome 高度由渲染层实测传入 —— 写死一定会错，因为紧凑档更高/更矮。
   */
  videoResized: (d) => ipcRenderer.send('win:video-size', d),

  /**
   * 帧消费回执：渲染进程处理完一帧就通知主进程。
   * 主进程用「已发未确认」计数做背压，防止 IPC 拷贝堆积导致内存持续上涨。
   */
  ackFrame: () => ipcRenderer.send('win:frame-ack'),

  listDevices: () => ipcRenderer.invoke('dev:list'),
  connectWifi: (p) => ipcRenderer.invoke('dev:connect-wifi', p),
  enableTcpip: () => ipcRenderer.invoke('dev:tcpip'),
  /** 一键 Wi-Fi 自动连接：缓存 → mDNS → 网段扫描，返回 { ok, target, via, took } */
  quickWifi: () => ipcRenderer.invoke('dev:wifi-quick'),
  /** 只发现候选设备，不连接 */
  discoverWifi: () => ipcRenderer.invoke('dev:wifi-discover'),
  startStream: (o) => ipcRenderer.invoke('stream:start', o),
  stopStream: () => ipcRenderer.invoke('stream:stop'),

  /* ---- 画质档位（切换 UI 用）---- */
  /**
   * 拿所有可用档位 + 当前选中的是哪个。
   * 返回 { ok, current, tiers: [{ id, name, maxSize, fps, bitRate, note }] }
   *
   * 面板渲染下拉/分段控件时直接读这个，不要在渲染层硬编码档位表 ——
   * 档位表只在主进程维护一份，加档/改参数不用两边同步。
   */
  qualityList: () => ipcRenderer.invoke('quality:list'),

  /** 只拿当前档位（含按设备原生长边收敛后的实际值） */
  qualityGet: () => ipcRenderer.invoke('quality:get'),

  /**
   * 切换档位。
   *
   * 行为：
   *   · 没在投屏 → 只改配置，下次启动生效（立刻返回）
   *   · 正在投屏 → 热切换，中间黑 1~2 秒（等返回值再更新 UI）
   *
   * 返回 { ok, current, tier } 或 { ok:false, error }
   */
  qualitySet: (id) => ipcRenderer.invoke('quality:set', id),

  /** 档位变化通知（热切换成功、或别处改了配置） */
  onQualityChanged: (cb) => ipcRenderer.on('quality:changed', (_e, d) => cb(d)),

  onSize: (cb) => ipcRenderer.on('size:update', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onFrame: (cb) => ipcRenderer.on('video:frame', (_e, d) => cb(d)),
  onConfig: (cb) => ipcRenderer.on('video:config', (_e, d) => cb(d)),

  /* ── 音频（APK 推流 → AudioDecoder → WebAudio）── */
  onAudioConfig: (cb) => ipcRenderer.on('audio:config', (_e, d) => cb(d)),
  onAudioFrame: (cb) => ipcRenderer.on('audio:frame', (_e, d) => cb(d)),

  /**
   * 置顶状态变更通知。
   *
   * 主进程有两个地方会改置顶：快捷键 Ctrl+Shift+F12、托盘/更多菜单。
   * 渲染层标题栏有一个常驻的置顶按钮，必须跟着真实状态亮灭，
   * 否则按钮显示和窗口实际行为会背离。
   */
  onPinned: (cb) => ipcRenderer.on('pinned', (_e, v) => cb(v)),

  /**
   * WiFi 模式：主进程通知渲染层从 HTTP 源拉帧（手机 App 推的流）。
   * 渲染层收到 { source } 后自己跑 fetch 循环，与 scrcpy 路径互不影响。
   */
  onWifiStart: (cb) => ipcRenderer.on('wifi:start', (_e, d) => cb(d)),

  /* ---- 反向控制：鼠标操作 → adb input ---- */
  ctlTap: (d) => ipcRenderer.send('ctl:tap', d),
  ctlSwipe: (d) => ipcRenderer.send('ctl:swipe', d),
  ctlLongPress: (d) => ipcRenderer.send('ctl:longpress', d),
  ctlKey: (code) => ipcRenderer.send('ctl:key', code),
  ctlText: (t) => ipcRenderer.send('ctl:text', t),
  ctlScroll: (d) => ipcRenderer.send('ctl:scroll', d),
  ctlInfo: () => ipcRenderer.invoke('ctl:info'),
  ctlSetSerial: (s) => ipcRenderer.send('ctl:setSerial', s),
  /** 主进程回报的控制提示（例如中文无法通过 adb 输入） */
  onCtlMsg: (cb) => ipcRenderer.on('ctl:msg', (_e, d) => cb(d))
})
