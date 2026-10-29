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
Start-Process -FilePath 'wscript.exe' -ArgumentList ('//B', '"' + $vbsPath + '"') -WindowStyle Hidden
Write-Host "已触发重启（wscript //B）"

if ($NoWait) { exit 0 }

# ── 4. 等 relaunch.log 出现 done / FAILED ──
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$done = $false
$failed = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (-not (Test-Path $logPath)) { continue }
  $text = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
  if ($null -eq $text) { continue }
  if ($text -match 'FAILED') { $failed = $true; break }
  if ($text -match '(?m)^\d{4}-\d{2}-\d{2} .* done$') { $done = $true; break }
}

Write-Host '--- relaunch.log ---'
if (Test-Path $logPath) { Get-Content $logPath | Select-Object -Last 10 }

if ($failed) { Fail "重启失败（见上面的日志）" }
if (-not $done) { Fail "等 $TimeoutSeconds 秒没有看到 done（可能还在启动，或日志没写）" }

# ── 5. 确认新进程真的在跑 ──
$after = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
if (-not $after) { Fail "日志说 done，但没有新的主进程 —— 请手动启动 DSH" }
if ([int]$after.ProcessId -eq $mainPid) { Fail "主进程还是原来那个（$mainPid），没有真正重启" }

Write-Host "OK    已重启：新主进程 $($after.ProcessId)" -ForegroundColor Green

# ── 6. 报出新的 GUI 端口（宿主每次重启会换端口）──
$listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -eq [int]$after.ProcessId } |
  Select-Object -ExpandProperty LocalPort -Unique | Sort-Object
if ($listen) { Write-Host "     监听端口：$($listen -join ', ')" }
exit 0
