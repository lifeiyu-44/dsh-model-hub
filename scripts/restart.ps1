# 重启 DSH Desktop（无需人工点确认）。
#
# ## 为什么不是一行命令
#
# 重启要杀掉承载本插件的 Electron 壳，因此执行者必须**比宿主活得更久**：
# 作为当前会话的子进程启动的 relauncher 会随调用者一起被杀（实测 WMI /
# Start-Process 都是如此），重启就只做了一半。官方 `dsh-restart-app` 用一个
# 一次性计划任务绕开这个问题，本脚本沿用它的 `relaunch.ps1`（停旧壳 → 等
# Host 自己退出 → 经 Explorer 拉起新壳 → 校验进程真的在），只换了个更省事
# 的触发方式。
#
# ## 为什么用 wscript 而不是 explorer
#
# 用 `explorer.exe <某个.vbs>` 触发会走文件关联，Windows 弹出
# 「打开文件 - 安全警告（发行商: 未知发布者）」，每次都要求人工点「打开」——
# 那就不是「自己重启」了。`wscript.exe //B`（批量模式）直接解释执行，
# 不弹任何对话框，也不会带控制台窗口。
#
# ## 用法
#
#   powershell -ExecutionPolicy Bypass -File scripts\restart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\restart.ps1 -NoWait
#
# 退出码：0 = 重启完成且新进程已起来；1 = 失败（日志里会有原因）。
param(
  # 只停不拉，用于排查「起不来」的场景
  [switch]$NoRelaunch,
  # 不等结果（默认等到 relaunch.log 出现 done）
  [switch]$NoWait,
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'

function Fail($message) {
  Write-Host "FAIL  $message" -ForegroundColor Red
  exit 1
}

# ── 1. 找到 Electron 主进程与它下面的 Host ──
$all = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue
if (-not $all) { Fail "没找到 DeepSeek Harness 进程（DSH 没在跑？）" }

$main = $all | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
if (-not $main) { Fail "找不到主进程（所有进程都带 --type=）" }
$mainPid = [int]$main.ProcessId

# Host 是主进程的子进程，命令行带 supervisor / --expose-internals
$hostProc = $all | Where-Object {
  $_.ParentProcessId -eq $mainPid -and $_.CommandLine -match 'dsh-supervisor|--expose-internals'
} | Select-Object -First 1
if (-not $hostProc) { Fail "找不到主进程 $mainPid 下的 Host 子进程" }
$hostPid = [int]$hostProc.ProcessId

Write-Host "main=$mainPid host=$hostPid"

# ── 2. 定位官方的 relaunch.ps1 ──
$helper = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@local\dsh-restart-app\relaunch.ps1'
if (-not (Test-Path $helper)) {
  # 回退到 local-plugins 里的源目录
  $helper = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\local-plugins\dsh-restart-app\relaunch.ps1'
}
if (-not (Test-Path $helper)) { Fail "找不到 relaunch.ps1（dsh-restart-app 插件没装？）" }
$logPath = Join-Path (Split-Path $helper -Parent) 'relaunch.log'

# ── 3. 写一个只含本次 pid 的 VBS，交给 wscript 批量模式执行 ──
$vbsPath = Join-Path (Split-Path $helper -Parent) 'relaunch-call.vbs'
$extra = if ($NoRelaunch) { ' -NoRelaunch' } else { '' }
$command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper +
           '" -MainPid ' + $mainPid + ' -HostPid ' + $hostPid + $extra
$vbs = 'CreateObject("Wscript.Shell").Run "' + $command.Replace('"', '""') + '", 0, False'
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

# 清掉上次的日志：判「这次是否成功」只能看新增内容
Remove-Item $logPath -ErrorAction SilentlyContinue

# //B = 批量模式，不弹任何对话框（这正是 explorer 触发时那个安全警告的来源）
# **不要加 //B**：实测（2026-10-29）带上它 wscript 直接不执行脚本，
# 日志一个字都不写、进程也没换。不加则正常跑完。
#
# 用 wscript 而不是 explorer：explorer 走文件关联，Windows 会弹
# 「打开文件 - 安全警告（发行商: 未知发布者）」，等于每次都要人工点一下。
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbsPath + '"') -WindowStyle Hidden
Write-Host "已触发重启（wscript）"

if ($NoWait) { exit 0 }

# ── 4. 等主进程真的换掉 ──
#
# **不能只等 relaunch.log 的 done**：relauncher 由 wscript 拉起，它自己也在
# 某条进程树里，本机会在「stopping main process」之后把它连带收掉
# （实测 2026-10-29：日志停在那一行，但应用其实已经重启好了）。
# 所以判据用「出现了一个 pid 不同的新主进程」—— 那才是用户真正关心的结果。
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$newMain = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $after = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
  if ($after -and [int]$after.ProcessId -ne $mainPid) { $newMain = $after; break }
}

Write-Host '--- relaunch.log ---'
if (Test-Path $logPath) { Get-Content $logPath | Select-Object -Last 10 } else { '（日志未生成）' }

if (-not $newMain) { Fail "等 $TimeoutSeconds 秒没有出现新的主进程（旧 $mainPid 可能还在）" }

Write-Host "OK    已重启：新主进程 $($newMain.ProcessId)" -ForegroundColor Green

# ── 5. 报出新的 GUI 端口（宿主每次重启会换端口）──
Start-Sleep -Milliseconds 800
$listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -eq [int]$newMain.ProcessId } |
  Select-Object -ExpandProperty LocalPort -Unique | Sort-Object
if ($listen) { Write-Host "     监听端口：$($listen -join ', ')" }
exit 0
