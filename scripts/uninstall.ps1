#Requires -Version 5.1
<#
.SYNOPSIS
    从 DSH profile 里卸掉 dsh-plugins-pack 的插件。

.DESCRIPTION
    从 dependencies 与 dsh.profile.bundles 里摘掉包名、删掉 profile 下的包目录，
    然后重跑 pnpm install 把链接清掉。package.json 改动前先备份。

    装之前/卸之前都请完全退出 DSH Desktop。

.EXAMPLE
    pwsh -File scripts/uninstall.ps1
    pwsh -File scripts/uninstall.ps1 -Only dsh-token-widget
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$DshHome,
    [string[]]$Only = @(),
    [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AllPackages = @('dsh-image-gen', 'dsh-token-widget', 'dsh-session-cost', 'dsh-task-notify', 'dsh-theme-gemini-cat')
if (-not $DshHome -or $DshHome.Trim() -eq '') {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
}
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$ManifestPath = Join-Path $ProfileDir 'package.json'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "!!! $msg" -ForegroundColor Yellow }

if (-not (Test-Path $ManifestPath)) { throw "找不到 profile：$ProfileDir" }

$targets = if ($Only.Count -gt 0) { $Only } else { $AllPackages }
foreach ($name in $targets) {
    if ($AllPackages -notcontains $name) { throw "未知包名：$name（可选：$($AllPackages -join ', ')）" }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $ManifestPath "$ManifestPath.bak-uninstall-$stamp" -Force

$manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.PSObject.Properties['dependencies']) {
    foreach ($name in $targets) {
        if ($manifest.dependencies.PSObject.Properties[$name]) {
            $manifest.dependencies.PSObject.Properties.Remove($name)
        }
    }
}
if ($manifest.PSObject.Properties['dsh'] -and $manifest.dsh.PSObject.Properties['profile'] -and
    $manifest.dsh.profile.PSObject.Properties['bundles']) {
    $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $targets -notcontains $_ })
}

$json = ($manifest | ConvertTo-Json -Depth 16) + "`n"
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Step "已从 manifest 摘除：$($targets -join ', ')"

if (-not $KeepFiles) {
    foreach ($name in $targets) {
        $dir = Join-Path $ProfileDir $name
        if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Step "已删除目录 $name" }
    }
}

$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
$pnpm = $null
if ($pnpmCmd) { $pnpm = @{ Exe = $pnpmCmd.Source; Args = @() } }
else {
    $roots = @($DshHome, (Join-Path $HOME '.dsh')) | Select-Object -Unique
    foreach ($root in $roots) {
        $runtimes = Join-Path $root 'dsh-runtimes'
        if (-not (Test-Path $runtimes)) { continue }
        foreach ($rt in Get-ChildItem $runtimes -Directory) {
            $pnpmMjs = Join-Path $rt.FullName 'dependencies/pnpm/bin/pnpm.mjs'
            $nodeExe = Join-Path $rt.FullName 'dependencies/node/bin/node.exe'
            if ((Test-Path $pnpmMjs) -and (Test-Path $nodeExe)) {
                $pnpm = @{ Exe = $nodeExe; Args = @($pnpmMjs) }
                break
            }
        }
        if ($pnpm) { break }
    }
}
if (-not $pnpm) {
    Write-Warn '找不到 pnpm，请手动执行：'
    Write-Host "    cd `"$ProfileDir`"; pnpm install"
    exit 2
}

Push-Location $ProfileDir
try {
    & $pnpm.Exe @($pnpm.Args + @('install', '--reporter=append-only'))
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 退出码 $LASTEXITCODE" }
} finally { Pop-Location }

Write-Step '卸干净了，重启 DSH Desktop 生效。'
Write-Host "回滚：把 package.json.bak-uninstall-$stamp 覆盖回去，并把备份目录改回原名"
