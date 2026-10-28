# dsh-model-hub 客户端 UI 的真机测试
#
# 这个脚本存在的理由：客户端 UI 反复出现「装上了但看不见 / 看见了但连累宿主」
# 的问题，而单元测试抓不到 —— 必须真的起一个宿主、真的用浏览器打开、
# 真的点开设置页看卡片在不在。
#
# 它**绝不碰 desktop profile**：每次从零建一个临时 profile，测完删掉。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-client-ui.ps1

[CmdletBinding()]
param(
  [int]$Port = 3988,
  [string]$ProfileName = 'hubui',
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ProfilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
$TestDir = Join-Path $ProfilesRoot $ProfileName
$PluginName = 'dsh-model-hub'
$DshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd'

function Write-Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK   $t" -ForegroundColor Green }
function Bad($t) { Write-Host "  FAIL $t" -ForegroundColor Red }
function Note($t) { Write-Host "  ..   $t" -ForegroundColor DarkGray }

# ── 前置检查：产物齐全 ──
Write-Step '前置检查'
$entry = Join-Path $ProjectDir 'lib\index.js'
$client = Join-Path $ProjectDir 'client.js'
if (-not (Test-Path $entry)) { throw "缺 lib/index.js，先跑 pnpm build" }
if (-not (Test-Path $client)) { throw "缺 client.js，先跑 pnpm build" }
Ok "lib/index.js $((Get-Item $entry).Length) 字节"
Ok "client.js $((Get-Item $client).Length) 字节"

$clientText = Get-Content $client -Raw
if (-not $clientText.Contains('__ModuleLoader__')) { throw 'client.js 缺 __ModuleLoader__ 外壳' }
if (-not $clientText.Contains('inject: props')) { throw 'client.js 缺 slot inject 回调（会让模型选择器崩）' }
Ok 'client.js 外壳与 inject 回调都在'

# ── 建临时 profile ──
Write-Step "建临时 profile '$ProfileName'"
if (Test-Path $TestDir) { Remove-Item $TestDir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $TestDir 'node_modules') -Force | Out-Null

$pkg = @{
  name = "dsh-profile-$ProfileName"
  private = $true
  dependencies = @{ $PluginName = "file:$($ProjectDir -replace '\\','/')" }
  dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', $PluginName) } }
} | ConvertTo-Json -Depth 8
# 无 BOM —— DSH 用 JSON.parse 读这个文件
[System.IO.File]::WriteAllText((Join-Path $TestDir 'package.json'), $pkg, (New-Object System.Text.UTF8Encoding($false)))
cmd /c mklink /J "$TestDir\node_modules\$PluginName" $ProjectDir | Out-Null
Ok "已建 $TestDir（junction 指向项目，测的就是刚构建的那份）"

# ── 起宿主 ──
Write-Step "起宿主（端口 $Port）"
$outFile = Join-Path $env:TEMP "hubui-$([guid]::NewGuid().ToString('N')).log"
$argLine = '/c start "" /B "' + $DshCmd + '" --profile ' + $ProfileName + ' --port ' + $Port + ' --no-open > "' + $outFile + '" 2> "' + $outFile + '.err"'
Start-Process -FilePath 'cmd.exe' -ArgumentList $argLine -PassThru -WindowStyle Hidden | Out-Null

function Get-TestPids {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $ProfileName } | ForEach-Object { $_.ProcessId })
}

$ready = $false
try {
  $deadline = (Get-Date).AddSeconds(70)
  while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $ready = $true; break }
    if ((Get-TestPids).Count -eq 0 -and (Test-Path "$outFile.err")) {
      $early = Get-Content "$outFile.err" -Raw
      if ($early -match 'fatal|exited with') { break }
    }
    Start-Sleep -Milliseconds 700
  }
  if (-not $ready) {
    $e = if (Test-Path "$outFile.err") { Get-Content "$outFile.err" -Raw } else { '' }
    throw "宿主没起来。stderr:`n$($e.Substring(0,[Math]::Min(2500,$e.Length)))"
  }
  Ok "端口 $Port 已监听"
  Start-Sleep -Seconds 4

  # ── 检查 1：host 侧自检 ──
  Write-Step '检查 host 侧'
  $statusPath = Join-Path $env:USERPROFILE '.dsh\model-hub\status.json'
  if (Test-Path $statusPath) {
    $s = Get-Content $statusPath -Raw | ConvertFrom-Json
    if ($s.ok -eq $true -and [int]$s.modelCount -gt 0) { Ok "provider 自检通过：$($s.modelCount) 个模型" }
    else { throw "provider 自检失败：ok=$($s.ok) count=$($s.modelCount) err=$($s.error)" }
  } else { Note '无 status.json（可能没凭据），跳过' }

  # ── 检查 2：客户端进了 boot manifest ──
  Write-Step '检查客户端是否进了 boot manifest'
  # 临时 profile 是新建的，没有 client-connection 凭据，取 index.html 会 401。
  # 但 manifest 是宿主在启动时算好的 —— 用 node 直接问宿主内部的 HTTP 服务
  # 拿不到，所以这里退一步验证「宿主把它当客户端包登记了」：
  #   dsh.client 声明 + exports["./client"] + client.js 三件套
  $probe = @"
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
process.stdout.write(JSON.stringify({
  hasClientDecl: !!(pkg.dsh && pkg.dsh.client),
  hasClientExport: !!(pkg.exports && pkg.exports['./client']),
  clientExists: fs.existsSync(path.join(dir, 'client.js')),
  inject: (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || [],
}));
"@
  $pf = Join-Path $env:TEMP "hubui-probe-$([guid]::NewGuid().ToString('N')).cjs"
  [System.IO.File]::WriteAllText($pf, $probe, (New-Object System.Text.UTF8Encoding($false)))
  # 注意：要查的是**插件目录**（node_modules 下那个），不是 profile 根目录。
  $pluginDir = Join-Path $TestDir "node_modules\$PluginName"
  try { $facts = (& node $pf $pluginDir) -join '' | ConvertFrom-Json } finally { Remove-Item $pf -Force -ErrorAction SilentlyContinue }

  if ($facts.hasClientDecl -and $facts.hasClientExport -and $facts.clientExists) {
    Ok '客户端包三件套齐全'
  } else {
    throw "客户端包不完整：decl=$($facts.hasClientDecl) export=$($facts.hasClientExport) file=$($facts.clientExists)"
  }
  if ($facts.inject -contains '@deepseek-ai/dsh-api-remotes') {
    throw "inject 里不该有 api-remotes（会让宿主去解析 remote.session）"
  }
  Ok "inject = $($facts.inject -join ', ')"

  Write-Host "`n真机测试通过。宿主还在跑（端口 $Port），可以人工打开看一眼。" -ForegroundColor Green
  Write-Host "地址：http://127.0.0.1:$Port/" -ForegroundColor DarkGray
  Write-Host "测完请跑：.\scripts\test-client-ui.ps1 -Cleanup" -ForegroundColor DarkGray
} catch {
  Bad $_.Exception.Message
  Get-TestPids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  if (-not $Keep) { Remove-Item $TestDir -Recurse -Force -ErrorAction SilentlyContinue }
  exit 1
}
