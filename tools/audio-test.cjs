/**
 * 声音路由策略的单测。
 *
 * 用户的规则（按时间顺序，最后一条是最新的）：
 *   1. 手机插着耳机（有线/蓝牙）→ 声音留在手机，不投电脑
 *   2. 手机外放、刚连上投屏     → 双端静音，投屏音量默认 0
 *   3. 手动调高投屏音量         → 才开始把手机声音投到电脑
 *   4. 投屏音量不影响手机音量
 *   5. 手机音量变化             → 投屏音量被重置成手机音量
 *   6. 耳机断开（拔线/蓝牙断）   → **自动**把声音接到电脑，不用手动开
 *
 * 运行：node tools/audio-test.cjs
 */
const { AudioRouter } = require('../runtime/audio-router.js')

function fake (devices, vol) {
  const r = new AudioRouter({
    adb: 'x', serial: 'y', httpPort: 0,
    onLog: () => {}, onState: () => {}
  })
  r._run = async () => ({
    ok: true,
    out: `- STREAM_MUSIC:\n   streamVolume:${vol}\n   Devices: ${devices}\n`
  })
  return r
}

let bad = 0
function eq (name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' (期望 ' + JSON.stringify(want) + ')'}`)
}

;(async () => {
  console.log('  -- 基础规则 --')

  let r = fake('speaker', 0)
  await r.poll()
  eq('外放·手机音量 0 → 不转发', [r.last.pcVolume, r.shouldForward()], [0, false])

  r.setPcVolume(8)
  await r.poll()
  eq('外放·手动调到 8 → 转发', [r.last.pcVolume, r.shouldForward()], [8, true])

  const r3 = fake('speaker', 5)
  r3.last.phoneVolume = 0
  r3.pcVolume = 8
  r3.manualOverride = true
  await r3.poll()
  eq('手机音量 0→5 → 投屏被重置为 5', [r3.last.pcVolume, r3.shouldForward()], [5, true])

  console.log('\n  -- 耳机规则 --')
  const r4 = fake('bt_a2dp,speaker', 9)
  r4.pcVolume = 9
  r4.manualOverride = true
  await r4.poll()
  eq('耳机在场 → 投屏音量归零、不转发', [r4.last.pcVolume, r4.shouldForward()], [0, false])

  console.log('\n  -- 耳机断开 → 自动接到电脑（最新规则）--')
  const r5 = fake('bt_a2dp', 6)
  await r5.poll()
  eq('耳机态', [r5.last.pcVolume, r5.shouldForward()], [0, false])

  // 模拟蓝牙断开：输出设备变成 speaker
  r5._run = async () => ({ ok: true, out: '- STREAM_MUSIC:\n   streamVolume:6\n   Devices: speaker\n' })
  await r5.poll()
  eq('耳机断开 → 自动转发、音量取手机音量', [r5.last.pcVolume, r5.shouldForward()], [6, true])

  console.log('\n  -- 耳机一直在，不抖 --')
  const r6 = fake('bt_a2dp', 7)
  await r6.poll()
  const first = r6.last.pcVolume
  await r6.poll()
  eq('连续两次耳机态都保持 0', [first, r6.last.pcVolume], [0, 0])

  console.log(bad ? `\n  ${bad} 项不符合预期` : '\n  全部符合预期')
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('  audio-test 崩了:', e && e.stack || e); process.exit(1) })
