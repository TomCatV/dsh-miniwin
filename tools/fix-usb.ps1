# 一键修复「插上 USB 但 adb 看不到手机」
#
# 现象（这台机器实测）：每次拔插之后，设备管理器里的
#   ADB Interface   Status = Error
# 于是 adb devices 里根本没有 USB 设备 —— 用户说「插好了没反应」。
# 手动跑一次 `pnputil /restart-device` 就恢复。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\fix-usb.ps1
# 会自动提权（重启设备需要管理员），没有可修的就直接说一声。

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host '需要管理员权限，正在提权…' -ForegroundColor Yellow
  $self = $MyInvocation.MyCommand.Path
  Start-Process -Verb RunAs -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$self`""
  )
  exit
}

Write-Host ''
Write-Host '  ① 清理残留的幽灵节点…' -ForegroundColor Cyan
# 这台机器上每次拔插都会生成一个 USB\CLASS_CO&SUBCLASS_WI&PROT_ 的坏节点，
# Windows 下次插上时会优先匹配它 → Status=Error → adb 看不到手机。
# 这些节点 Present=False，删掉不影响正在用的设备。
$phantoms = Get-PnpDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'ADB Interface' -and -not $_.Present }
if ($phantoms) {
  foreach ($p in $phantoms) {
    Write-Host ("    删除 {0}" -f $p.InstanceId) -ForegroundColor Gray
    & pnputil /remove-device "$($p.InstanceId)" | Out-Null
  }
} else {
  Write-Host '    没有幽灵节点' -ForegroundColor Gray
}

Write-Host ''
Write-Host '  ② 扫描 ADB 接口…' -ForegroundColor Cyan

$targets = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'ADB Interface' -or $_.Class -eq 'AndroidUsbDeviceClass' }

if (-not $targets) {
  Write-Host '  没找到任何 ADB 接口。' -ForegroundColor Yellow
  Write-Host '  可能原因：线只能充电 / 手机没开「USB 调试」/ 没装驱动。' -ForegroundColor Gray
  Read-Host '  按回车关闭'
  exit 1
}

$fixed = 0
foreach ($d in $targets) {
  $status = $d.Status
  Write-Host ("  {0}  {1}" -f $d.InstanceId, $status) -ForegroundColor Gray
  if ($status -ne 'OK') {
    Write-Host '    → 重启这个设备…' -ForegroundColor Yellow
    & pnputil /restart-device "$($d.InstanceId)" | Out-Null
    Start-Sleep -Milliseconds 800
    $after = (Get-PnpDevice -InstanceId $d.InstanceId -ErrorAction SilentlyContinue).Status
    if ($after -eq 'OK') { Write-Host '    ✓ 已恢复' -ForegroundColor Green; $fixed++ }
    else { Write-Host "    ✗ 仍然是 $after（换根数据线或换个 USB 口试试）" -ForegroundColor Red }
  }
}

Start-Sleep -Seconds 2
$adb = Join-Path $PSScriptRoot '..\runtime\tools\scrcpy\scrcpy-win64-v5.0.1\adb.exe'
if (Test-Path $adb) {
  Write-Host ''
  Write-Host '  adb devices：' -ForegroundColor Cyan
  & $adb devices
}

Write-Host ''
if ($fixed) { Write-Host "  修好了 $fixed 个设备。" -ForegroundColor Green }
else { Write-Host '  没有需要修的（状态都是 OK）。' -ForegroundColor Green }
Read-Host '  按回车关闭'
