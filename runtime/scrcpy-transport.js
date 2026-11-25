'use strict'
/**
 * 零 APK 直连的 scrcpy 传输层。
 *
 * ── 现状 ──
 *
 * wifi-receiver.js 的 /start-zero 会 `require('./scrcpy-transport.js')`，
 * 但这个模块从来没有进过仓库。以前它的后果被 pair-page.js 的崩溃掩盖了；
 * 现在 pair-page 修好了，走到这里会抛出明确的错误，而不是让整个接收端
 * 进程挂掉。
 *
 * ── 为什么先不实现 ──
 *
 * 真正的实现要跑完整的 scrcpy 控制协议（握手 → video socket + control
 * socket → 自己解 SPS/PPS → 转发 input 事件）。而这条路只在
 * 「Android 11+ 无线调试 + 不想装 App」时才用得上，且**必须先有 adb 通道**
 * （adb pair + adb connect）。本机实测的结论是：装了 APK 的推流链路
 * 更稳、帧率更高、还带声音。
 *
 * 所以这里给出一个显式失败，让上层把原因原样回给手机页面：
 * 用户看到的是「这条通道没打包，请用 App」，而不是一个转圈。
 */
class ScrcpyTransport {
  constructor () {
    throw new Error(
      '零 APK 直连（scrcpy 传输层）在当前版本未打包。' +
      '请改用手机端 MiniWin 投屏 App 推流（方式二），或先用 adb 连上手机走 scrcpy 采集。'
    )
  }
}

module.exports = { ScrcpyTransport }
