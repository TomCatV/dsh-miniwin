/**
 * 音频链路自愈 —— 让声音断了能自己接回来，不用手动重启。
 *
 * ══════════ 要解决什么 ══════════
 *
 * 这台华为（HarmonyOS 4.2）对「第三方 App 持续占用 MediaProjection」
 * 管得非常严：
 *
 *   - 已经加进 deviceidle whitelist
 *   - 已经 appops RUN_IN_BACKGROUND allow
 *   - 前台服务 + 通知栏常驻
 *
 * 仍然会被杀。实测表现：
 *   audioFrames 停止增长 → /meta 返回 connected=false → ps 查不到进程
 *
 * 被杀之后声音就断了，而画面（scrcpy）还在，用户看到的就是
 * 「有画面没声音」，必须手动重新推深链才有声 —— 这个体验不可接受。
 *
 * ══════════ 怎么自愈 ══════════
 *
 * 每 3 秒探一次 /meta：
 *   connected=true          → 正常，重置计数
 *   connected=false 但刚断   → 容忍期（APK 可能在重启）
 *   连续 N 次 false          → 判定死了，自动：
 *       ① adb reverse 重建（隧道可能随 App 一起丢了）
 *       ② am start 深链拉起 APK
 *       ③ 若弹了 MediaProjection 授权框，自动点「允许」
 *
 * 授权框的坐标不固定，所以用 uiautomator dump 找「允许」按钮的真实
 * bounds，不硬编码坐标 —— 硬编码会点错地方（实测点到了红果短剧）。
 */

const { execFile } = require('node:child_process')

class AudioHealer {
  /**
   * @param {object} o
   * @param {string} o.adb       adb 路径
   * @param {string} o.serial    设备序列号
   * @param {number} [o.port]    接收端 TCP 端口（默认 27190）
   * @param {number} [o.httpPort] 接收端 HTTP 端口（默认 27191）
   * @param {(m:string)=>void} [o.onLog]
   * @param {()=>void} [o.onRecovered] 恢复成功回调
   */
  constructor (o) {
    this.adb = o.adb
    this.serial = o.serial
    this.port = o.port || 27190
    this.httpPort = o.httpPort || 27191
    this.onLog = o.onLog || (() => {})
    this.onRecovered = o.onRecovered || (() => {})

    this.timer = null
    this.deadStreak = 0
    this.recovering = false
    this.lastRecoverAt = 0
    this.recoverCount = 0

    /** 连续多少次探测不到连接才判定死亡（3 秒一次 → 9 秒） */
    this.DEAD_THRESHOLD = 3
    /** 两次恢复尝试的最小间隔，避免风暴 */
    this.RECOVER_COOLDOWN = 12000
  }

  log (m) { this.onLog('[heal] ' + m) }

  _run (args, timeout = 10000) {
    return new Promise(resolve => {
      execFile(this.adb, args, { timeout, windowsHide: true },
        (err, stdout, stderr) => resolve({
          ok: !err,
          out: String(stdout || ''),
          err: String(stderr || (err && err.message) || '')
        }))
    })
  }

  start () {
    this.stop()
    this.log('音频自愈已启动')

    /**
     * ══════════ 首次立即拉起，不等 9 秒 ══════════
     *
     * 用户的原话：「码呢，手机上扫码我扫你妈」。
     *
     * 之前的设计要求用户在手机上点「扫码连接」再对准 PC 的二维码 ——
     * 但 PC 端根本没展示二维码，这个流程完全是多余的仪式。
     *
     * 现在 PC 侧会话一开，这里就主动：
     *   ① adb reverse
     *   ② am start 深链（拉起 APK 并直接进入投屏）
     *   ③ 自动点「允许」授权
     *
     * 用户插上线（或 WiFi 连着）什么都不用做，声音就通了。
     */
    this._kickoff().finally(() => {
      const tick = async () => {
        try { await this._check() } catch {}
        this.timer = setTimeout(tick, 3000)
      }
      tick()
    })
  }

  /** 首次拉起：会话一开始就主动把 APK 拉起来并授权 */
  async _kickoff () {
    try {
      // 隧道先建好，否则 APK 启动后连不上
      await this._run(['-s', this.serial, 'reverse',
        `tcp:${this.port}`, `tcp:${this.port}`], 8000)

      const alive = await this._apkAlive()
      if (alive) {
        // 已在跑，看看连上没。没连上就重推一次深链。
        const m = await this._meta()
        if (m && m.connected) {
          this.log('音频已在线，无需拉起')
          return
        }
      }

      this.log('正在自动拉起手机端…')
      await this._startViaDeeplink()

      await this._autoGrant()

      await new Promise(r => setTimeout(r, 12000))
      const m2 = await this._meta()
      if (m2 && m2.connected) {
        this.log('✓ 音频已自动连通（无需手动操作手机）')
        this.onRecovered()
      } else {
        this.log('自动拉起后仍未连通，转入周期性重试')
      }
    } catch (e) {
      this.log('自动拉起异常: ' + e.message)
    }
  }

  stop () {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  async _meta () {
    try {
      const r = await fetch(`http://127.0.0.1:${this.httpPort}/meta`, {
        signal: AbortSignal.timeout(2500)
      })
      if (!r.ok) return null
      return await r.json()
    } catch { return null }
  }

  async _check () {
    if (this.recovering) return

    const m = await this._meta()
    if (!m) return   // 接收端自己没跑，不管

    /**
     * 把「音频到底通没通」暴露出去 —— 主进程要把它并进每秒的状态推送里，
     * 让界面上能看见音频状态。
     *
     * 用户的投诉：「有时候画面在跑但电脑没声音，我根本不知道是没连上
     * 还是我电脑静音了」。以前这个信息只躺在日志里。
     */
    this.connected = !!m.connected
    this.frames = m.audioFrames || 0

    if (m.connected) {
      if (this.deadStreak > 0) this.log('音频连接已恢复')
      this.deadStreak = 0
      return
    }

    this.deadStreak++

    /**
     * 关键：区分「APK 活着但还没连上」和「APK 真的死了」。
     *
     * 实测：APK 从启动到建立起 TCP 连接要 8~12 秒
     * （MediaProjection 授权 → 前台服务 → 建 socket → 推首帧）。
     * 早期版本 9 秒就判死，于是「刚拉起 → 判定失败 → 再拉起」死循环，
     * 每次重拉还会把已经快建好的连接掐断，永远连不上。
     *
     * 现在：先看进程在不在。
     *   进程在 → 只等，不重拉（耐心等它自己连上）
     *   进程没了 → 立刻重拉
     */
    if (this.deadStreak < this.DEAD_THRESHOLD) return
    if (Date.now() - this.lastRecoverAt < this.RECOVER_COOLDOWN) return

    const alive = await this._apkAlive()
    if (alive) {
      // APK 还活着，只是在建连接阶段。再给它一个周期，不打断。
      if (this.deadStreak < this.DEAD_THRESHOLD * 4) return
      this.log('APK 存活但长时间连不上，重建隧道')
    } else {
      this.log('APK 已退出，重新拉起')
    }

    this.lastRecoverAt = Date.now()
    this.deadStreak = 0
    await this._recover()
  }

  /** APK 进程是否还在 */
  async _apkAlive () {
    try {
      const r = await this._run(['-s', this.serial, 'shell',
        'ps -A 2>/dev/null | grep -c com.miniwin.stream'], 6000)
      const n = parseInt((r.out || '0').trim(), 10)
      return n > 0
    } catch { return false }
  }

  async _recover () {
    if (this.recovering) return
    this.recovering = true
    this.recoverCount++
    this.log(`音频断开，第 ${this.recoverCount} 次自动恢复…`)

    try {
      /**
       * ⓪ 先检查是否有**僵尸 MediaProjection 会话**。
       *
       * 踩过的坑（实测）：
       *   dumpsys media_projection 显示
       *     Media Projection:
       *     (com.miniwin.stream, uid=10617): TYPE_SCREEN_CAPTURE
       *   但进程其实早就不在了。
       *
       * Android 规定同一 UID 只能有一个活跃投影会话，
       * 所以后续所有授权请求都被**静默拒绝**：
       *   - 不弹授权框
       *   - Service 不启动
       *   - 界面停在「启动投屏服务…」
       *   - 音频链路完全起不来 → 手机继续外放、电脑没声音
       *
       * 更坑的是 `am force-stop` 清不掉它，必须 `pm clear`。
       * 所以这里主动检测并清理。
       */
      const stale = await this._run(['-s', this.serial, 'shell',
        'dumpsys media_projection | grep -c "com.miniwin.stream"'], 6000)
      const hasStale = parseInt((stale.out || '0').trim(), 10) > 0

      if (hasStale) {
        const alive = await this._apkAlive()
        if (!alive) {
          this.log('检测到僵尸投影会话（进程已死但会话未释放），正在清理…')
          // pm clear 是唯一能强制释放的手段
          await this._run(['-s', this.serial, 'shell', 'pm', 'clear', 'com.miniwin.stream'], 15000)
          await new Promise(r => setTimeout(r, 1500))
          // pm clear 会清掉运行时权限，必须补回来
          await this._run(['-s', this.serial, 'shell', 'pm', 'grant',
            'com.miniwin.stream', 'android.permission.RECORD_AUDIO'], 8000)
          this.log('僵尸会话已清理，权限已恢复')
        }
      }

      // ① 重建反向隧道（App 被杀时隧道通常还在，但重建一次更稳）
      await this._run(['-s', this.serial, 'reverse',
        `tcp:${this.port}`, `tcp:${this.port}`], 8000)

      /**
       * ①.5 APK 活着但没连上 → 必须先 force-stop。
       *
       * StreamService.onStartCommand 里写着：
       *   if (intent == null || engine != null) return START_NOT_STICKY;
       * engine 在 onDestroy 里才置空。也就是说一旦引擎进入
       * 「连接断开，已停止重连」状态，进程还在、engine 还在，
       * 之后**所有**深链都会被这一行直接吞掉 —— 界面永远停在
       * 「重新连接」，点它也只是重连旧引擎。
       */
      const mNow = await this._meta()
      if ((await this._apkAlive()) && !(mNow && mNow.connected)) {
        this.log('APK 存活但连接已死，强制重启 App 以清掉僵死引擎')
        await this._run(['-s', this.serial, 'shell', 'am', 'force-stop', 'com.miniwin.stream'], 10000)
        await new Promise(r => setTimeout(r, 1200))
      }

      // ② 拉起 APK
      const r = await this._startViaDeeplink()
      if (!r.ok) this.log('拉起 APK 失败: ' + String(r.err || '').slice(0, 80))

      // ③ 等授权框出现并自动点「允许」
      await this._autoGrant()

      // ④ 验证 —— 给足 12 秒（授权 + 建连接 + 首帧）
      await new Promise(r2 => setTimeout(r2, 12000))
      const m = await this._meta()
      if (m && m.connected) {
        this.log('✓ 音频已恢复')
        this.onRecovered()
      } else {
        this.log('恢复未成功，下轮再试')
      }
    } catch (e) {
      this.log('恢复异常: ' + e.message)
    } finally {
      this.recovering = false
    }
  }

  /**
   * ══════════ 用深链拉起 APK（带端口，必须加引号）══════════
   *
   * ── 这里是「声音永远连不上」的真正元凶 ──
   *
   * 原来是这么发的：
   *   am start -a android.intent.action.VIEW \
   *     -d miniwin://stream?host=127.0.0.1&port=27190
   *
   * 走的是 `adb shell`，而 adb 会把这些 argv 用空格拼成**一条**命令行
   * 交给手机上的 /system/bin/sh 去解析。于是那个 `&` 变成了
   * shell 的后台运算符：
   *
   *   sh -c "am start ... -d miniwin://stream?host=127.0.0.1" &
   *         "port=27190"            ← 被当成一条新命令，直接失败
   *
   * 结果 APK 收到的 Intent 里**只有 host，没有 port**：
   *   dat=miniwin://stream?host=127.0.0.1        ← logcat 实证
   *
   * 而 StreamActivity 的判断是 `h != null && p != null` 才连 ——
   * host 有、port 没有，条件不成立，既不连接也不报错，
   * 界面停在「重新连接 / 连接断开，已停止重连」，
   * 手机继续外放、电脑永远没声音。
   *
   * 修法：把整条 URL 用单引号包起来，让手机端 shell 不再拆它。
   * 实测验证：加引号后 logcat 里出现完整
   *   dat=miniwin://stream?host=127.0.0.1&port=27190
   * 授权弹窗随即出现，音频建立成功。
   */
  async _startViaDeeplink () {
    return this._run(['-s', this.serial, 'shell', 'am', 'start',
      '-a', 'android.intent.action.VIEW',
      '-d', `'miniwin://stream?host=127.0.0.1&port=${this.port}'`], 15000)
  }

  /**
   * 自动点「允许」。
   *
   * 不硬编码坐标 —— 不同 ROM / 不同分辨率下按钮位置差别很大，
   * 硬编码会点错（实测点早跳到红果短剧去了）。
   *
   * 做法：uiautomator dump 出 XML，正则找 text="允许" 的 bounds，
   * 取中心点。找不到就说明没弹窗（已授权过），直接返回。
   */
  async _autoGrant () {
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 1200))
      const dump = await this._run(['-s', this.serial, 'shell',
        'uiautomator dump /sdcard/_heal.xml >/dev/null 2>&1; cat /sdcard/_heal.xml'], 8000)
      if (!dump.out) continue

      const hit = /text="(?:允许|立即开始)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(dump.out)
      if (!hit) continue

      const x = Math.round((Number(hit[1]) + Number(hit[3])) / 2)
      const y = Math.round((Number(hit[2]) + Number(hit[4])) / 2)
      await this._run(['-s', this.serial, 'shell', 'input', 'tap', String(x), String(y)], 8000)
      this.log(`已点授权 (${x},${y})`)
      return
    }
  }
}

module.exports = { AudioHealer }
