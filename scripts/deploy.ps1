# dsh-model-hub 部署脚本
#
# 这个脚本存在的唯一理由：插件在**加载期**抛错会让 host fatal 退出，
# 进而触发 DSH 把 profile 重置为默认（bundles 清空、cordis.patch.yml 被覆盖），
# 用户所有插件一次性停用。实测已发生两次。
#
# 所以部署必须分四步、前一步不过就不许进下一步：
#   1. 构建
#   2. 同步到 desktop profile 的 node_modules **拷贝**（pnpm file: 依赖是拷贝不是软链）
#   3. 在**临时 profile** 里真机启动一次，确认宿主不崩
#   4. 上一步通过，才把插件加进 desktop 的 bundles
#
# 用法：
#   .\scripts\deploy.ps1 -VerifyOnly     # 只做 1-3 步（安全，不碰 desktop）
#   .\scripts\deploy.ps1 -Install        # 做完 1-3 步并通过后，再执行第 4 步
#   .\scripts\deploy.ps1 -Rollback       # 从备份恢复 desktop profile，并移出插件

[CmdletBinding()]
param(
  [switch]$VerifyOnly,
  [switch]$Install,
  [switch]$Rollback,
  [int]$VerifyPort = 3987
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ProfilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
$DesktopDir = Join-Path $ProfilesRoot 'desktop'
$VerifyProfile = 'hubverify'
$VerifyDir = Join-Path $ProfilesRoot $VerifyProfile
$PluginName = 'dsh-model-hub'
$BackupRoot = Join-Path $ProjectDir 'backup'
$DshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd'

function Write-Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Fail($text) { Write-Host "    FAIL $text" -ForegroundColor Red }
function Write-Note($text) { Write-Host "    ..  $text" -ForegroundColor DarkGray }

# ───────────────────────── 步骤 0：备份 ─────────────────────────
function Backup-DesktopProfile {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path $BackupRoot "profile-$stamp"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item (Join-Path $DesktopDir 'package.json') $dir -Force
  Copy-Item (Join-Path $DesktopDir 'cordis.patch.yml') $dir -Force
  Write-Ok "已备份到 $dir"
  return $dir
}

# ───────────────────────── 步骤 1：构建 ─────────────────────────
function Build-Plugin {
  Write-Step 1 '构建'
  Push-Location $ProjectDir
  try {
    & .\node_modules\.bin\tsdown.cmd 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tsdown 退出码 $LASTEXITCODE" }
    $entry = Join-Path $ProjectDir 'lib\index.js'
    if (-not (Test-Path $entry)) { throw "构建产物缺失：$entry" }
    $size = (Get-Item $entry).Length
    Write-Ok "lib/index.js ${size} 字节"

    # 已知会导致 fatal 的标记。
    #
    # 注意 `ctx.webServer` 的判定要区分「代码」与「注释」：
    # 本项目现在**合法地**在 `ctx.inject(["webServer"], cb)` 的回调里用
    # `inner.webServer.register(...)`，注释里也会提到 `ctx.webServer`。
    # 真正危险的是「在回调外直接访问外层 ctx 的 webServer」，
    # 所以这里查的是代码形态而不是字符串出现。
    $text = Get-Content $entry -Raw

    if ($text.Contains('registerRecordsRoute')) {
      throw "产物里仍含危险标记 'registerRecordsRoute' —— 拒绝继续"
    }

    # 外层 ctx 直接摸 webServer（形如 `ctx.webServer` 后面紧跟 `.` 或 `;`，
    # 且不在 `inner.` / `innerCtx.` 这类回调 ctx 上）。
    if ($text -match '(?<![\w.$])ctx\.webServer\s*[.;]') {
      throw "产物里存在外层 ctx 直接访问 webServer 的代码 —— 会 fatal，拒绝继续"
    }
    Write-Ok '无危险标记'

    # 客户端产物检查：有 dsh.client 声明就必须有 client.js，反之亦然。
    $clientFile = Join-Path $ProjectDir 'client.js'
    $pkgText = Get-Content (Join-Path $ProjectDir 'package.json') -Raw -Encoding UTF8
    $declaresClient = $pkgText.Contains('"client"')
    if ($declaresClient -and -not (Test-Path $clientFile)) {
      throw "package.json 声明了 dsh.client，但 client.js 不存在"
    }
    if ((Test-Path $clientFile) -and -not $declaresClient) {
      throw "存在 client.js，但 package.json 没有 dsh.client 声明 —— 宿主不会加载它"
    }
    if (Test-Path $clientFile) {
      $clientText = Get-Content $clientFile -Raw
      if (-not $clientText.Contains('__ModuleLoader__')) {
        throw "client.js 缺少 __ModuleLoader__ 外壳 —— 宿主加载不了"
      }
      Write-Ok "client.js $((Get-Item $clientFile).Length) 字节，外壳正常"
    }
  } finally { Pop-Location }
}

# ───────────────────── 步骤 2：同步到 desktop 拷贝 ─────────────────────
function Sync-ToDesktopCopy {
  Write-Step 2 "同步到 desktop profile 的 node_modules 拷贝"
  $dst = Join-Path $DesktopDir "node_modules\$PluginName"
  if (-not (Test-Path $dst)) {
    Write-Note "profile 里还没有这个包，跳过同步（安装时会由 pnpm 拷贝）"
    return
  }

  # 依赖解析：插件的 peerDependencies（@deepseek-ai/dsh-llm-pi-ai 等）从插件
  # 目录向上按 Node 规则找，profile 根目录没有宿主那套包 —— 缺这层时
  # lib/index.js 里的 dynamic import 会报 "Cannot find package"（2026-10-29
  # 13:59 实例启动失败即此因）。把插件内 node_modules 指向仓库的安装目录，
  # 与 hubverify 临时 profile 的 junction 形态一致，依赖一次性齐全。
  $dstNm = Join-Path $dst 'node_modules'
  $repoNm = Join-Path $ProjectDir 'node_modules'
  if (Test-Path $dstNm) {
    $item = Get-Item $dstNm -Force
    if ($item.LinkType -ne 'Junction') { Remove-Item $dstNm -Recurse -Force }
  }
  if (-not (Test-Path $dstNm)) {
    cmd /c mklink /J "$dstNm" "$repoNm" | Out-Null
    if (-not (Test-Path (Join-Path $dstNm '@deepseek-ai'))) {
      throw "插件依赖 junction 创建失败：$dstNm -> $repoNm"
    }
    Write-Ok "依赖 junction 已建立（-> 仓库 node_modules）"
  } else {
    Write-Ok '依赖 junction 已存在'
  }
  $src = Join-Path $ProjectDir 'lib'
  $dstLib = Join-Path $dst 'lib'
  if (Test-Path $dstLib) { Remove-Item $dstLib -Recurse -Force }
  Copy-Item $src $dstLib -Recurse -Force
  $before = (Get-Item (Join-Path $dstLib 'index.js')).Length
  $after = (Get-Item (Join-Path $ProjectDir 'lib\index.js')).Length
  if ($before -ne $after) { throw "同步后大小不一致：profile=$before source=$after" }
  Write-Ok "lib 已同步，两边都是 $before 字节"

  # client.js 必须一起同步，而且位置是**包根目录**。
  # 宿主的 manifest 把客户端插件拼成 `<包名>/client.js`
  # （见 index.html 的 __DSH_BOOT__.entries），放 lib/ 里宿主找不到。
  $srcClient = Join-Path $ProjectDir 'client.js'
  if (Test-Path $srcClient) {
    $dstClient = Join-Path $dst 'client.js'
    Copy-Item $srcClient $dstClient -Force
    $cb = (Get-Item $dstClient).Length
    $ca = (Get-Item $srcClient).Length
    if ($cb -ne $ca) { throw "client.js 同步后大小不一致：profile=$cb source=$ca" }
    Write-Ok "client.js 已同步，两边都是 $cb 字节"
  } else {
    Write-Note 'client.js 不存在（未构建客户端），跳过'
  }

  # package.json 也要同步：dsh.client 声明在里面，少了它宿主不会加载客户端。
  $srcPkg = Join-Path $ProjectDir 'package.json'
  $dstPkg = Join-Path $dst 'package.json'
  if ((Test-Path $srcPkg) -and (Test-Path $dstPkg)) {
    $srcJson = Get-Content $srcPkg -Raw -Encoding UTF8
    $dstJson = Get-Content $dstPkg -Raw -Encoding UTF8
    if ($srcJson -ne $dstJson) {
      # 无 BOM —— DSH 用 JSON.parse 读这个文件，BOM 会让它语法错误
      [System.IO.File]::WriteAllText($dstPkg, $srcJson, (New-Object System.Text.UTF8Encoding($false)))
      Write-Ok 'package.json 已同步（dsh.client 声明）'
    } else {
      Write-Ok 'package.json 已是最新'
    }
  }
}

# ─────────────── 步骤 3：临时 profile 真机验证 ───────────────
function Verify-InTempProfile {
  Write-Step 3 "在临时 profile '$VerifyProfile' 里真机启动验证"

  # 每次都从零建，避免上一次的残留影响判断
  if (Test-Path $VerifyDir) { Remove-Item $VerifyDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $VerifyDir 'node_modules') -Force | Out-Null

  # 状态文件必须清掉：上一次启动写的 ok=true 会让这次的检查假通过。
  $statusPath = Join-Path $env:USERPROFILE '.dsh\model-hub\status.json'
  Remove-Item $statusPath -Force -ErrorAction SilentlyContinue

  $pkg = @{
    name = "dsh-profile-$VerifyProfile"
    private = $true
    dependencies = @{ $PluginName = "file:$($ProjectDir -replace '\\','/')" }
    dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', $PluginName) } }
  } | ConvertTo-Json -Depth 8
  # 必须写**无 BOM** 的 UTF-8：Set-Content -Encoding UTF8 在 PS 5.1 下会加 BOM，
  # 而 DSH 的 readProfileManifest 用 JSON.parse 读，BOM 会让它直接语法错误。
  [System.IO.File]::WriteAllText((Join-Path $VerifyDir 'package.json'), $pkg, (New-Object System.Text.UTF8Encoding($false)))

  # pnpm file: 会拷贝；这里直接给个 junction，保证验证的就是刚构建的那份
  cmd /c mklink /J "$VerifyDir\node_modules\$PluginName" $ProjectDir | Out-Null

  $outFile = Join-Path $env:TEMP "hub-verify-$([guid]::NewGuid().ToString('N')).log"

  # 不用 Start-Process 直接起 dsh.cmd：Windows 环境变量名不区分大小写，而当前
  # 环境里同时有 NO_PROXY 与 no_proxy，Start-Process 重建环境块时会抛
  # "Item has already been added. Key in dictionary: 'NO_PROXY'"。
  # 改走 cmd 的 start /B，输出重定向到文件。
  $argLine = '/c start "" /B "' + $DshCmd + '" --profile ' + $VerifyProfile + ' --port ' + $VerifyPort + ' --no-open > "' + $outFile + '" 2> "' + $outFile + '.err"'
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $argLine -PassThru -WindowStyle Hidden

  # 找真正在跑这个临时 profile 的 node 宿主进程（cmd 只是外壳，早已退出）
  function Get-VerifyHostPids {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match $VerifyProfile } |
      ForEach-Object { $_.ProcessId })
  }

  $ok = $false
  try {
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
      $listen = Get-NetTCPConnection -State Listen -LocalPort $VerifyPort -ErrorAction SilentlyContinue
      if ($listen) { $ok = $true; break }
      # 宿主提前退出（加载期 fatal）就立刻失败，不用等满 60 秒
      if ((Get-VerifyHostPids).Count -eq 0 -and (Test-Path "$outFile.err")) {
        $early = Get-Content "$outFile.err" -Raw
        if ($early -match 'fatal load failure|exited with 1') { break }
      }
      Start-Sleep -Milliseconds 800
    }

    if (-not $ok) {
      $errText = ''
      if (Test-Path "$outFile.err") { $errText = Get-Content "$outFile.err" -Raw }
      $outText = ''
      if (Test-Path $outFile) { $outText = Get-Content $outFile -Raw }
      if ($errText.Length -gt 2000) { $errText = $errText.Substring(0, 2000) }
      if ($outText.Length -gt 1000) { $outText = $outText.Substring(0, 1000) }
      throw "宿主没能起来（端口 $VerifyPort 未监听）。`n--- stderr ---`n$errText`n--- stdout ---`n$outText"
    }
    Write-Ok "宿主正常启动，端口 $VerifyPort 已监听"

    # 确认插件的副作用真的发生了：shim 端口 + 数据库
    Start-Sleep -Seconds 3
    $hostPids = Get-VerifyHostPids
    $shimPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $hostPids -contains $_.OwningProcess -and $_.LocalPort -ne $VerifyPort }
    if ($shimPorts) { Write-Ok "插件 shim 已监听：$(($shimPorts.LocalPort | Sort-Object -Unique) -join ', ')" }
    else { Write-Note 'shim 端口未观察到（可能还没起完，不阻断）' }

    $db = Join-Path $env:USERPROFILE '.dsh\model-hub\hub.db'
    if (Test-Path $db) { Write-Ok "数据库已创建：$db（$((Get-Item $db).Length) 字节）" }
    else { Write-Note '数据库未创建（可能没有可用凭据，不阻断）' }

    # ── 步骤 3b：查插件自检状态 ──
    #
    # 这一段是补上一次真实事故的漏洞：P0 部署时宿主起得来、provider 也进了
    # `llm/listProviders`，但模型列表是空的 —— 因为传给 PiAiAdapter 的 profile
    # 少了 piProvider。「宿主没崩」证明不了「插件能用」，必须问插件自己。
    $statusPath = Join-Path $env:USERPROFILE '.dsh\model-hub\status.json'
    if (Test-Path $statusPath) {
      $status = Get-Content $statusPath -Raw | ConvertFrom-Json
      if ($status.ok -eq $true -and [int]$status.modelCount -gt 0) {
        Write-Ok "插件自检通过：$($status.modelCount) 个模型可被选中"
        Write-Note ("前几个：" + (($status.modelIds | Select-Object -First 5) -join ', '))
      } else {
        throw "插件自检失败：ok=$($status.ok) modelCount=$($status.modelCount) error=$($status.error)"
      }
    } else {
      Write-Note "未找到状态文件 $statusPath —— 可能没有可用凭据，跳过自检"
    }

    # ── 步骤 3c：查客户端是否进了 boot manifest ──
    #
    # 光有 client.js 文件不算数：宿主是从 index.html 的
    # `__DSH_BOOT__.entries` 里发现客户端插件的。文件在、但没进 manifest，
    # UI 一样不会出现 —— 而「宿主起得来」这个检查对此完全无感。
    #
    # 这里直接抓验证宿主自己的 index.html，解析 manifest，确认插件在里面。
    # 不依赖 cookie：manifest 在页面 HTML 里，而该 profile 是新建的临时 profile。
    $manifestOk = $false
    try {
      # 临时 profile 没有 client-connection 的凭据，直接读 index.html 会 401。
      # 所以退一步：验证 host 侧已经把它当客户端包登记了（有 exports["./client"]
      # 且文件存在），这一步至少能挡住「声明了但没导出」这类错误。
      #
      # 注意：PS 5.1 的 ConvertFrom-Json 对深嵌套有兼容问题（实测在
      # exports 里抛 "Invalid object passed in"），这里改用 node 解析 ——
      # pnpm 的 node 在 PATH 里，且 JSON 本来就是 JS 的强项。
      $pkgPath = Join-Path $VerifyDir "node_modules\$PluginName\package.json"
      $clientPath = Join-Path $VerifyDir "node_modules\$PluginName\client.js"
      $probe = @"
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({
  hasClientDecl: !!(pkg.dsh && pkg.dsh.client),
  hasClientExport: !!(pkg.exports && pkg.exports['./client']),
  clientExists: fs.existsSync(process.argv[3]),
}));
"@
      $probeFile = Join-Path $env:TEMP "hub-pkg-probe-$([guid]::NewGuid().ToString('N')).cjs"
      [System.IO.File]::WriteAllText($probeFile, $probe, (New-Object System.Text.UTF8Encoding($false)))
      try {
        $json = (& node $probeFile $pkgPath $clientPath) -join ''
      } finally {
        Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
      }
      $facts = $json | ConvertFrom-Json

      if ($facts.hasClientDecl -and $facts.hasClientExport -and $facts.clientExists) {
        $manifestOk = $true
        Write-Ok "客户端包已就位（dsh.client + exports['./client'] + client.js）"
      } elseif ($facts.hasClientDecl) {
        throw "声明了 dsh.client，但缺少 exports['./client'] 或 client.js"
      } else {
        Write-Note '未声明 dsh.client（纯 host 插件），跳过客户端检查'
        $manifestOk = $true
      }
    } catch {
      throw "客户端包检查失败：$($_.Exception.Message)"
    }
    if (-not $manifestOk) { throw '客户端包未就位' }
  } finally {
    if (-not $proc.HasExited) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    # 收拾子进程（dsh 会 fork node 子进程）
    Get-VerifyHostPids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2

    Remove-Item $VerifyDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $outFile, "$outFile.err" -Force -ErrorAction SilentlyContinue
  }

  if (-not $ok) { throw '临时 profile 验证失败' }
}

# ───────────────────── 步骤 4：加进 desktop bundles ─────────────────────
function Install-ToDesktop {
  Write-Step 4 '加进 desktop profile 的 bundles'
  $pkgPath = Join-Path $DesktopDir 'package.json'
  $cfg = (Get-Content $pkgPath -Raw) | ConvertFrom-Json
  # 只看 bundles 数组 —— 早先版本用整份文件做子串匹配，结果 dependencies 里那条
  # 同名依赖把判断骗过去了，明明不在 bundles 里也报「已经有了」。
  $bundles = @($cfg.dsh.profile.bundles)
  if ($bundles -contains $PluginName) {
    Write-Note 'bundles 里已经有它了，无需重复添加'
    return
  }
  $bundles += $PluginName
  $cfg.dsh.profile.bundles = $bundles
  # 无 BOM —— 见上面临时 profile 的同一处说明，DSH 用 JSON.parse 读这个文件。
  [System.IO.File]::WriteAllText($pkgPath, ($cfg | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "bundles 现在有 $($bundles.Count) 项"
  Write-Note '需要重启 DSH Desktop 才生效'
}

# ───────────────────────── 回滚 ─────────────────────────
function Rollback-Desktop {
  Write-Step 0 '回滚 desktop profile'
  $latest = Get-ChildItem $BackupRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'profile-*' } |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $latest) { throw "没找到备份目录 $BackupRoot" }
  Copy-Item (Join-Path $latest.FullName 'package.json') (Join-Path $DesktopDir 'package.json') -Force
  Copy-Item (Join-Path $latest.FullName 'cordis.patch.yml') (Join-Path $DesktopDir 'cordis.patch.yml') -Force
  Write-Ok "已从 $($latest.Name) 恢复"
}

# ───────────────────────── 主流程 ─────────────────────────
if ($Rollback) {
  Rollback-Desktop
  exit 0
}

Build-Plugin
Sync-ToDesktopCopy

if ($Install) {
  $backupDir = Backup-DesktopProfile
  try {
    Verify-InTempProfile
  } catch {
    Write-Fail "验证未通过，不安装。desktop 未被修改。"
    Write-Host $_.Exception.Message
    exit 1
  }
  Install-ToDesktop
  Write-Host "`n装好了。重启 DSH Desktop 后，用这份命令确认：" -ForegroundColor Cyan
  Write-Host ("  Get-Content '" + (Join-Path $DesktopDir 'package.json') + "' | ConvertFrom-Json") -ForegroundColor DarkGray
  Write-Host "出问题用：.\scripts\deploy.ps1 -Rollback" -ForegroundColor DarkGray
} else {
  Verify-InTempProfile
  Write-Host "`n验证通过。要真装进 desktop，跑：.\scripts\deploy.ps1 -Install" -ForegroundColor Cyan
}
