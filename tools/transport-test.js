/**
 * 通道切换规则的单测。
 *
 * 用户要求：「USB 拔掉切 WiFi、WiFi 断开切 USB」。
 *
 * 规则拆成两个纯函数：
 *   isCurrentAlive(serial, devs)   当前通道是否还活着 —— 活着绝不切换
 *   pickFallbackSerial(serial, devs) 该切到哪一条（没有返回 null）
 *
 * 运行：node tools/transport-test.js
 */
const { pickFallbackSerial, isCurrentAlive, findStaleWifi } =
  require('../transport-pick.js')

const USB = '2MN0224829001893'
const WIFI = '172.31.100.199:5555'
const dev = (serial, isWifi, state = 'device') => ({ serial, isWifi, state })

let bad = 0
function eq (name, got, want) {
  const ok = got === want
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${got === null ? 'null' : got}` +
    (ok ? '' : `  (期望 ${want === null ? 'null' : want})`))
}

console.log('  -- 当前通道存活判断 --')
eq('USB 在表里且 device → 活着', isCurrentAlive(USB, [dev(USB, false)]), true)
eq('USB 变 offline → 已死', isCurrentAlive(USB, [dev(USB, false, 'offline')]), false)
eq('USB 从表里消失 → 已死', isCurrentAlive(USB, [dev(WIFI, true)]), false)

console.log('\n  -- 该切到哪一条 --')
eq('USB 掉了、WiFi 在线 → 切 WiFi',
  pickFallbackSerial(USB, [dev(WIFI, true)]).target, WIFI)
eq('USB 掉了、WiFi 是 offline → 不切（等唤醒）',
  pickFallbackSerial(USB, [dev(WIFI, true, 'offline')]).target, null)
eq('USB 掉了、表里空 → 不切',
  pickFallbackSerial(USB, []).target, null)
eq('WiFi 掉了、USB 在线 → 切 USB',
  pickFallbackSerial(WIFI, [dev(USB, false)]).target, USB)
eq('WiFi 掉了、USB 也不在 → 不切',
  pickFallbackSerial(WIFI, [dev(WIFI, true, 'offline')]).target, null)
eq('两条都在、当前 USB → 若被问到就切 WiFi',
  pickFallbackSerial(USB, [dev(USB, false), dev(WIFI, true)]).target, WIFI)
eq('两条都在、当前 WiFi → 若被问到就切 USB',
  pickFallbackSerial(WIFI, [dev(USB, false), dev(WIFI, true)]).target, USB)
eq('USB 自己变 offline、WiFi 在线 → 切 WiFi',
  pickFallbackSerial(USB, [dev(USB, false, 'offline'), dev(WIFI, true)]).target, WIFI)

console.log('\n  -- 唤醒用的 offline 条目 --')
const stale = findStaleWifi([dev(WIFI, true, 'offline')])
eq('能取到 wifi 的 ip', stale && stale.ip, '172.31.100.199')
eq('并标出它不是 live', stale && stale.live, false)
eq('只有 USB 时没有 wifi 条目', findStaleWifi([dev(USB, false)]), null)

console.log(bad ? `\n  ${bad} 项不符合预期` : '\n  全部符合预期')
process.exit(bad ? 1 : 0)
