<#
  dsh-task-notify 自检脚本

  直接驱动弹窗渲染进程弹一条通知，用来在不重启 DSH 的前提下确认
  「渲染 + 右下角窗口」这一段是好的。它不经过 Host 插件，
  所以只验证渲染侧；Host 侧的 turn/end 触发要重启 DSH 后由真实对话验证。

  用法：powershell -ExecutionPolicy Bypass -File verify.ps1
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$popup = Join-Path $root "lib\popup.py"
$mascot = Join-Path $root "assets\mascot.png"

$python = $env:DSH_TASK_NOTIFY_PYTHON
if (-not $python) {
  $home2 = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
  $candidates = @(
    (Join-Path $home2 "dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"),
    (Join-Path $home2 "dsh-runtimes\dsh-primary-runtime\dependencies\python\bin\python3")
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $python = $c; break } }
}
if (-not $python) { $python = "python" }

Write-Host "python : $python"
Write-Host "popup  : $popup"

# 造一条带 gemini-cat 深色 token 的通知，走和 Host 完全一样的数据形状
$spec = [ordered]@{
  cmd         = "show"
  id          = "selfcheck"
  status      = "done"
  title       = "为 DSH 添加右下角弹窗通知"
  body        = "任务完成：Host 插件已监听 session/event 的 turn/end。"
  meta        = "任务完成 · 用时 2 分 14 秒"
  dark        = $true
  duration_ms = 0
  animate     = $true
  art_path    = $mascot
  tokens      = [ordered]@{
    "--dsw-alias-bg-layer-1"                = "#15172F"
    "--dsw-alias-bg-layer-2"                = "#1C1E3C"
    "--dsw-alias-label-primary"             = "#EEEBFF"
    "--dsw-alias-label-secondary"           = "#A9A6CF"
    "--dsw-alias-label-tertiary"            = "#7B78A6"
    "--dsw-alias-state-business-primary"    = "#A5A2FF"
    "--dsw-alias-border-l3"                 = "#ffffff38"
  }
}

$specPath = Join-Path $env:TEMP "dsh-task-notify-selfcheck.json"
$json = $spec | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($specPath, $json, (New-Object System.Text.UTF8Encoding $false))

# 用 Node 走管道，和 Host 插件的 spawn 路径一致；没有 Node 就退回 --show-file
$node = $null
foreach ($c in @(
    (Join-Path (Split-Path -Parent (Split-Path -Parent $python)) "node\bin\node.exe"),
    "node"
  )) { if ($c -eq "node" -or (Test-Path $c)) { $node = $c; break } }

$hold = 6
if ($node) {
  Write-Host "mode   : stdin NDJSON pipe (via node)"
  & $node -e @"
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const spec = fs.readFileSync(process.argv[1], 'utf8');
const child = spawn(process.argv[2], ['-u', process.argv[3]], {
  stdio: ['pipe','pipe','pipe'], windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
child.stdout.resume();
child.stderr.on('data', (c) => process.stderr.write('[popup] ' + c));
child.stdin.write(spec.trim() + '\n');
setTimeout(() => { child.stdin.write('{"cmd":"dismiss-all"}\n'); child.stdin.end();
  setTimeout(() => { if (child.exitCode === null) child.kill(); }, 500); }, $hold * 1000);
"@ $specPath $python $popup
} else {
  Write-Host "mode   : --show-file (node not found)"
  $env:DSH_NOTIFY_HOLD = "$hold"
  & $python $popup --show-file $specPath
}

Write-Host ""
Write-Host "如果刚才右下角出现了带猫娘立绘的卡片，渲染侧就是好的。"
