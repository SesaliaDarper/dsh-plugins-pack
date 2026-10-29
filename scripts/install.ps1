#Requires -Version 5.1
<#
.SYNOPSIS
    把 dsh-plugins-pack 里的插件装进指定的 DSH profile。

.DESCRIPTION
    对每个包做四件事：
      1. 拷到 <DSH_HOME>/profiles/<Profile>/<包名>（已存在则先备份）
      2. 备份 profile 的 package.json
      3. dependencies 写 file:./<包名>，dsh.profile.bundles 追加包名（去重、保持顺序）
      4. 在 profile 目录跑 pnpm install

    装之前请完全退出 DSH Desktop：profile 目录被占用时 pnpm 会失败。

.PARAMETER Profile
    profile 名，默认 desktop（桌面客户端用的那个）。

.PARAMETER DshHome
    DSH 的家目录，默认 $env:DSH_HOME，否则 ~/.dsh。

.PARAMETER Only
    只装这些包（可写多个）。默认三个都装。

.PARAMETER SkipInstall
    只拷文件、改 manifest，不跑 pnpm install。

.EXAMPLE
    pwsh -File scripts/install.ps1
    pwsh -File scripts/install.ps1 -Only dsh-session-cost
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$DshHome,
    [string[]]$Only = @(),
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AllPackages = @('dsh-image-gen', 'dsh-token-widget', 'dsh-session-cost', 'dsh-task-notify', 'dsh-theme-gemini-cat')
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DshHome -or $DshHome.Trim() -eq '') {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
}
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$ManifestPath = Join-Path $ProfileDir 'package.json'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "!!! $msg" -ForegroundColor Yellow }

if (-not (Test-Path $ManifestPath)) {
    throw "找不到 profile：$ProfileDir（先启动一次 DSH Desktop 让它初始化 profile，然后退出 DSH 再装）"
}

$targets = if ($Only.Count -gt 0) { $Only } else { $AllPackages }
foreach ($name in $targets) {
    if ($AllPackages -notcontains $name) { throw "未知包名：$name（可选：$($AllPackages -join ', ')）" }
    if (-not (Test-Path (Join-Path $RepoRoot "packages/$name/package.json"))) {
        throw "仓库里没有 packages/$name —— 请在仓库根目录运行 scripts/install.ps1"
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $ManifestPath "$ManifestPath.bak-plugins-$stamp" -Force
Write-Step "已备份 manifest → package.json.bak-plugins-$stamp"

foreach ($name in $targets) {
    $dst = Join-Path $ProfileDir $name
    if (Test-Path $dst) {
        $bak = "$dst.bak-$stamp"
        Move-Item $dst $bak -Force
        Write-Warn "$name 已存在，旧目录改名为 $(Split-Path -Leaf $bak)"
    }
    Copy-Item (Join-Path $RepoRoot "packages/$name") $dst -Recurse -Force
    Write-Step "已拷入 $name"
}

# 改 manifest：dependencies + dsh.profile.bundles
$manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
if (-not $manifest.PSObject.Properties['dependencies']) {
    $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.PSObject.Properties['dsh']) {
    $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dsh.PSObject.Properties['profile']) {
    $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dsh.profile.PSObject.Properties['bundles']) {
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}

foreach ($name in $targets) {
    $spec = "file:./$name"
    if ($manifest.dependencies.PSObject.Properties[$name]) {
        $manifest.dependencies.$name = $spec
    } else {
        $manifest.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $spec
    }
    $bundles = @($manifest.dsh.profile.bundles)
    if ($bundles -notcontains $name) { $bundles += $name }
    $manifest.dsh.profile.bundles = $bundles
}

$json = ($manifest | ConvertTo-Json -Depth 16) + "`n"
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Step "已更新 package.json：$($targets -join ', ')"
Write-Host "    bundles = $($manifest.dsh.profile.bundles -join ' → ')"

if ($SkipInstall) {
    Write-Warn "-SkipInstall：跳过 pnpm install。装完前必须自己跑一次：cd `"$ProfileDir`"; pnpm install"
    return
}

# 找 pnpm：PATH → DSH 自带运行时
function Resolve-Pnpm {
    $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($cmd) { return @{ Exe = $cmd.Source; Args = @() } }

    $roots = @($DshHome, (Join-Path $HOME '.dsh')) | Select-Object -Unique
    foreach ($root in $roots) {
        $runtimes = Join-Path $root 'dsh-runtimes'
        if (-not (Test-Path $runtimes)) { continue }
        foreach ($rt in Get-ChildItem $runtimes -Directory) {
            $pnpmMjs = Join-Path $rt.FullName 'dependencies/pnpm/bin/pnpm.mjs'
            $nodeExe = Join-Path $rt.FullName 'dependencies/node/bin/node.exe'
            if ((Test-Path $pnpmMjs) -and (Test-Path $nodeExe)) {
                return @{ Exe = $nodeExe; Args = @($pnpmMjs) }
            }
        }
    }
    return $null
}

$pnpm = Resolve-Pnpm
if (-not $pnpm) {
    Write-Warn '找不到 pnpm（PATH 上没有，DSH 运行时里也没有）。请手动执行：'
    Write-Host "    cd `"$ProfileDir`"; pnpm install"
    exit 2
}

Write-Step "pnpm install（$([System.IO.Path]::GetFileName($pnpm.Exe))）"
Push-Location $ProfileDir
try {
    & $pnpm.Exe @($pnpm.Args + @('install', '--reporter=append-only'))
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Step '装好了。启动 DSH Desktop 即可：'
Write-Host '    · 右下角出现角色挂件（余额）'
Write-Host '    · 会话标题栏出现金额徽章（消费）'
Write-Host '    · 设置 → 通用 → 自定义主题（美化）'
Write-Host ''
Write-Host "回滚：把 package.json.bak-plugins-$stamp 覆盖回去，并删掉 $($targets -join ' / ') 目录"
