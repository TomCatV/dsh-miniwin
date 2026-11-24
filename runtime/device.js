'use strict'
/**
 * 设备连接层：USB（adb forward）与 WiFi（adb connect + forward）统一入口
 *
 * scrcpy v5 的启动方式：
 *   1) adb push scrcpy-server /data/local/tmp/scrcpy-server.jar
 *   2) adb [shell] CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 5.0.1 <args...>
 *   3) 参数里 tunnel_forward=true 时：设备侧 LocalServerSocket("scrcpy") 等客户端
 *      客户端通过 adb forward tcp:LOCAL localabstract:scrcpy 接进来
 */

const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const net = require('net')

const SERVER_VERSION = '5.0.1'
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar'
const SOCKET_NAME = 'scrcpy'

class Adb {
  constructor (adbPath) {
    this.adb = adbPath
    this.serial = null
  }

  run (args, opts = {}) {
    return new Promise((resolve, reject) => {
      const full = this.serial ? ['-s', this.serial, ...args] : args
      execFile(this.adb, full, { timeout: opts.timeout || 30000, windowsHide: true, maxBuffer: 8 << 20 },
        (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout
            err.stderr = stderr
            return reject(err)
          }
          resolve({ stdout, stderr })
        })
    })
  }

  /** @returns {Promise<Array<{serial:string,state:string,model:string,transport:string}>>} */
  async devices () {
    const { stdout } = await this.run(['devices', '-l'])
    const out = []
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+(device|unauthorized|offline|no permissions)\b(.*)$/)
      if (!m) continue
      const rest = m[3] || ''
      const modelM = rest.match(/model:(\S+)/)
      out.push({
        serial: m[1],
        state: m[2],
        model: modelM ? modelM[1].replace(/_/g, ' ') : '',
        transport: m[1].includes(':') ? 'wifi' : 'usb'
      })
    }
    return out
  }

  async pickDevice (wantSerial) {
    const list = await this.devices()
    if (!list.length) {
      throw new Error('没有检测到设备。请确认：USB 线已连接 + 手机已开「USB 调试」+ 手机上点了「允许调试」')
    }
    if (wantSerial) {
      const hit = list.find(d => d.serial === wantSerial)
      if (!hit) throw new Error(`指定的设备 ${wantSerial} 不在列表里：${list.map(d => d.serial).join(', ')}`)
      if (hit.state !== 'device') throw new Error(`设备 ${wantSerial} 状态是 ${hit.state}，需要在手机上授权调试`)
      this.serial = hit.serial
      return hit
    }
    const ready = list.filter(d => d.state === 'device')
    if (!ready.length) {
      const bad = list[0]
      throw new Error(`设备 ${bad.serial} 状态是 ${bad.state}。${bad.state === 'unauthorized' ? '请在手机上点「允许 USB 调试」' : '请检查连接'}`)
    }
    this.serial = ready[0].serial
    return ready[0]
  }

  async props () {
    const { stdout } = await this.run(['shell', 'getprop'])
    const get = k => {
      const m = stdout.match(new RegExp(`\\[${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]: \\[(.*?)\\]`))
      return m ? m[1] : ''
    }
    return {
      model: get('ro.product.model'),
      brand: get('ro.product.brand'),
      release: get('ro.build.version.release'),
      sdk: parseInt(get('ro.build.version.sdk') || '0', 10),
      abi: get('ro.product.cpu.abi'),
      wm: await this.screenSize()
    }
  }

  async screenSize () {
    try {
      const { stdout } = await this.run(['shell', 'wm', 'size'])
      const m = stdout.match(/Override size:\s*(\d+)x(\d+)/) || stdout.match(/Physical size:\s*(\d+)x(\d+)/)
      if (m) return { width: +m[1], height: +m[2] }
    } catch { /* ignore */ }
    return null
  }

  async pushServer (localJar) {
    if (!fs.existsSync(localJar)) throw new Error('找不到 scrcpy-server: ' + localJar)
    const remoteSize = await this.remoteFileSize()
    const localSize = fs.statSync(localJar).size
    if (remoteSize === localSize) return { pushed: false, size: localSize }
    await this.run(['push', localJar, REMOTE_JAR], { timeout: 60000 })
    return { pushed: true, size: localSize }
  }

  async remoteFileSize () {
    try {
      const { stdout } = await this.run(['shell', `stat -c %s ${REMOTE_JAR} 2>/dev/null || echo 0`])
      return parseInt(stdout.trim(), 10) || 0
    } catch { return 0 }
  }

  /** WiFi 连接：先配对（Android 11+ 无线调试），再连接 */
  async connectWifi (host, port = 5555) {
    const target = `${host}:${port}`
    const { stdout, stderr } = await this.run(['connect', target], { timeout: 15000 })
    const msg = (stdout + stderr).trim()
    if (!/connected to/i.test(msg) && !/already connected/i.test(msg)) {
      throw new Error('连接失败: ' + msg)
    }
    this.serial = target
    return { target, message: msg }
  }

  /** 把当前 USB 设备切到 TCP 模式（Android 11+ 需先手动配对的端口） */
  async enableTcpip (port = 5555) {
    await this.run(['tcpip', String(port)], { timeout: 15000 })
    const ip = await this.deviceWifiIp()
    return { port, ip, target: ip ? `${ip}:${port}` : null }
  }

  async deviceWifiIp () {
    try {
      const { stdout } = await this.run(['shell', 'ip', 'route'])
      const m = stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/)
      if (m) return m[1]
    } catch { /* ignore */ }
    try {
      const { stdout } = await this.run(['shell', 'ifconfig', 'wlan0'])
      const m = stdout.match(/inet addr:(\d+\.\d+\.\d+\.\d+)/) || stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/)
      if (m) return m[1]
    } catch { /* ignore */ }
    return null
  }

  async forward (localPort) {
    await this.run(['forward', `tcp:${localPort}`, `localabstract:${SOCKET_NAME}`])
    return localPort
  }

  async removeForward (localPort) {
    try { await this.run(['forward', '--remove', `tcp:${localPort}`]) } catch { /* ignore */ }
  }

  async removeAllForwards () {
    try { await this.run(['forward', '--remove-all']) } catch { /* ignore */ }
  }
}

/** 起 server 进程并保持引用，便于 kill */
function startServer (adb, options) {
  const {
    maxSize = 1080, bitRate = 8000000, maxFps = 60, codec = 'h264',
    tunnelForward = true, sendDummyByte = true, sendStreamMeta = true,
    sendFrameMeta = true, sendDeviceMeta = true, control = true,
    video = true, audio = false
  } = options

  const args = [
    `CLASSPATH=${REMOTE_JAR}`,
    'app_process', '/', 'com.genymobile.scrcpy.Server', SERVER_VERSION,
    `log_level=${options.logLevel || 'info'}`,
    // 不传 scid：传了 socket 名会变成 scrcpy_xxxxxxxx，与 localabstract:scrcpy 对不上
    `video=${video}`,
    `audio=${audio}`,
    `video_codec=${codec}`,
    `max_size=${maxSize}`,
    `video_bit_rate=${bitRate}`,
    `max_fps=${maxFps}`,
    `tunnel_forward=${tunnelForward}`,
    `control=${control}`,
    // send_device_meta=true 时 server 先发 64 字节定长设备名，解析器必须跳过
    `send_device_meta=${sendDeviceMeta}`,
    `send_frame_meta=${sendFrameMeta}`,
    `send_dummy_byte=${sendDummyByte}`,
    `send_stream_meta=${sendStreamMeta}`
  ]

  const full = adb.serial ? ['-s', adb.serial, 'shell', ...args] : ['shell', ...args]
  const { spawn } = require('child_process')
  const child = spawn(adb.adb, full, { windowsHide: true })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += d.toString() })
  child.stderr.on('data', d => { stderr += d.toString() })

  return {
    child,
    getLog: () => ({ stdout, stderr }),
    kill: () => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      // 设备侧进程也要杀，否则残留占用 scrcpy socket
      return adb.run(['shell', 'pkill -f com.genymobile.scrcpy.Server']).catch(() => {})
    }
  }
}

/** 连本地 forward 端口，带重试（server 起得慢） */
function connectLocal (port, { retries = 40, interval = 150, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryOnce = () => {
      attempt++
      const sock = net.connect({ host: '127.0.0.1', port })
      sock.setNoDelay(true)
      let settled = false

      const cleanup = () => {
        sock.removeListener('connect', onConnect)
        sock.removeListener('error', onError)
      }
      const onConnect = () => { if (settled) return; settled = true; cleanup(); resolve(sock) }
      const onError = (err) => {
        if (settled) return
        settled = true
        cleanup()
        sock.destroy()
        if (attempt >= retries) return reject(new Error(`连不上本地端口 ${port}：${err.message}`))
        setTimeout(tryOnce, interval)
      }

      sock.once('connect', onConnect)
      sock.once('error', onError)
      sock.setTimeout(timeout, () => { if (!settled) { settled = true; cleanup(); sock.destroy(); onError(new Error('超时')) } })
    }
    tryOnce()
  })
}

/**
 * reverse 模式（tunnel_forward=false）：
 *   - server 侧 connect("scrcpy") 到本地抽象 socket
 *   - 我们用 adb reverse 把设备上的 localabstract:scrcpy 映射回 PC 的 tcp 端口
 *   - PC 起监听，server 主动连进来
 * 相比 forward 模式，这里 PC 是服务端，能先就绪再让 server 连，时序更稳。
 */
function startReverse (adb, port) {
  return adb.run(['reverse', `localabstract:${SOCKET_NAME}`, `tcp:${port}`])
}

/** 起本地 TCP 监听，等 server 连进来 */
function listenLocal (port, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { srv.close() } catch {}
      reject(new Error(`等待 server 连接超时（${timeout}ms）`))
    }, timeout)

    srv.once('connection', sock => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.setNoDelay(true)
      try { srv.close() } catch {}
      resolve({ sock, server: srv })
    })
    srv.once('error', e => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    srv.listen(port, '127.0.0.1')
  })
}

function findPort (start = 27183) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', () => findPort(start + 1).then(resolve, reject))
    srv.once('listening', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
    srv.listen(start, '127.0.0.1')
  })
}

module.exports = {
  Adb, startServer, connectLocal, listenLocal, startReverse, findPort,
  SERVER_VERSION, REMOTE_JAR, SOCKET_NAME
}
