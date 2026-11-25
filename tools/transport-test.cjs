const { isCurrentAlive, pickFallbackSerial, findStaleWifi, shouldUpgradeToUsb } =
  require('C:/Users/Vincent/dsh/miniwin-stream/transport-pick.js')

const USB = '2MN0224829001893'
const WIFI = '172.31.100.199:5555'
const dev = (serial, isWifi, state = 'device') => ({ serial, isWifi, state })
let bad = 0
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' (期望 ' + JSON.stringify(want) + ')'}`)
}

console.log('  -- 基础规则（回归）--')
eq('USB 掉了 WiFi 在线 → 切 WiFi', pickFallbackSerial(USB, [dev(WIFI, true)]).target, WIFI)
eq('WiFi 掉了 USB 在线 → 切 USB', pickFallbackSerial(WIFI, [dev(USB, false)]).target, USB)
eq('当前还活着', isCurrentAlive(WIFI, [dev(WIFI, true)]), true)

console.log('\n  -- 插回 USB 自动切回 --')
eq('WiFi 中且 USB 在线、只看到 1 次 → 不切',
  shouldUpgradeToUsb(WIFI, [dev(USB, false)], 1), { upgrade: false, serial: null })
eq('连续第 3 次 → 切',
  shouldUpgradeToUsb(WIFI, [dev(USB, false)], 3), { upgrade: true, serial: USB })
eq('已经在 USB 上 → 不切',
  shouldUpgradeToUsb(USB, [dev(USB, false), dev(WIFI, true)], 9), { upgrade: false, serial: null })
eq('USB 是 offline → 不切',
  shouldUpgradeToUsb(WIFI, [dev(USB, false, 'offline')], 9), { upgrade: false, serial: null })
eq('表格里没有 USB → 不切',
  shouldUpgradeToUsb(WIFI, [dev(WIFI, true)], 9), { upgrade: false, serial: null })

console.log(bad ? `\n  ${bad} 项不符合` : '\n  全部符合预期')
process.exit(bad ? 1 : 0)
