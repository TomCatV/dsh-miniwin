'use strict'
/**
 * 通道选择：当前通道没了，接下来该连哪条。
 *
 * 这是纯函数，不碰 adb、不碰定时器 —— 因为「USB 拔掉切 WiFi /
 * WiFi 断开切 USB」这种判断一旦混进副作用就很难验，而它恰恰是
 * 用户反复提的那件事（「你总得做吧」）。
 *
 * 规则（用户口径）：
 *   1. 当前 USB 没了  → 用 WiFi
 *   2. 当前 WiFi 没了 → 用 USB
 *   3. 只认 state === 'device'：断线时 adb 表里那条会变 offline
 *      而不是消失，拿 offline 的 serial 去连必然失败
 *   4. 另一边也没有 → 返回 null，交给调用方去「唤醒」（adb connect）
 */

/**
 * @param {string} currentSerial 当前正在用的 serial（USB 是物理号，WiFi 是 ip:port）
 * @param {Array<{serial:string, isWifi:boolean, state?:string}>} devices
 * @returns {{target: string|null, reason: string}}
 */
function pickFallbackSerial (currentSerial, devices) {
  const list = Array.isArray(devices) ? devices : []
  const isWifi = /:\d+$/.test(String(currentSerial || ''))
  const live = d => d && d.state === 'device'
  const usb = list.find(d => d && !d.isWifi && live(d))
  const wifi = list.find(d => d && d.isWifi && live(d))

  if (isWifi) {
    if (usb) return { target: usb.serial, reason: 'wifi→usb' }
    return { target: null, reason: 'wifi 掉了，USB 也不在' }
  }
  if (wifi) return { target: wifi.serial, reason: 'usb→wifi' }
  return { target: null, reason: 'usb 掉了，WiFi 也不在' }
}

/** 当前通道是否还活着 */
function isCurrentAlive (currentSerial, devices) {
  const list = Array.isArray(devices) ? devices : []
  return list.some(d => d && d.serial === currentSerial && d.state === 'device')
}

/** 从 adb 表里挑一条 WiFi 条目（哪怕它是 offline 的），用来做唤醒 */
function findStaleWifi (devices) {
  const list = Array.isArray(devices) ? devices : []
  const d = list.find(x => x && x.isWifi)
  if (!d) return null
  const ip = String(d.serial).split(':')[0]
  return { serial: d.serial, ip, live: d.state === 'device' }
}

module.exports = { pickFallbackSerial, isCurrentAlive, findStaleWifi }
