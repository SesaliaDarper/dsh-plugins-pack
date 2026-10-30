> **DSH 五件套之一** —— [← 回到总览](../README.md) · [兼容性记录](../COMPATIBILITY.md)

# dsh-task-notify — 任务完成右下角通知

DSH 每完成一轮对话，就在 Windows 右下角弹一条**跟随当前主题**的通知，带一张
美术立绘。

## 它长什么样

```
┌───────────────────────────────────────────────┬─────────┐
│ ● DeepSeek Harness                            │         │
│ 为 DSH 添加右下角弹窗通知                       │  ╭───╮  │
│ 任务完成：Host 插件已监听 turn/end…             │  │猫娘│  │
│ 任务完成 · 用时 2 分 14 秒                      │  ╰───╯  │
└───────────────────────────────────────────────┴─────────┘
```

- 配色全部取自 DSH 当前生效的 `--dsw-*` 设计 token，所以你换主题、
  甚至换 gemini-cat 的子主题（gemini-cat / zlm / grok / gpt），弹窗都会跟着变。
- 圆角是真透明的：窗口用 `WS_EX_LAYERED` + `UpdateLayeredWindow` 逐像素
  alpha 绘制，不会有黑角或白角。
- 6.5 秒后自动消失；最多同时堆叠 4 条；不抢焦点、不出现在任务栏。
- 角色使用当前主题插件的原始 WebP：Gemini 猫猫、ZLM 狐耳、Grok 金发哥特、GPT 银白龙角。原生主题不显示角色。
- 背景使用实时 token，并叠加对应主题的强调色与渐变细线。
- UI 主线程泵送 Win32 消息、处理到期销毁；stdin 在独立读取线程入队。`duration_ms: 0` 明确表示永久显示，Host 默认仍是 6500。
- 为支持点击收起及尝试聚焦 DSH，不使用 `WS_EX_TRANSPARENT`。窗口显示时保持不抢焦点；右键可直接关闭。

## 为什么不用系统 Toast

本来最自然的选择是 WinRT 的 `ToastNotificationManager`，但**本机不可用**：

| 尝试 | 结果 |
|---|---|
| `CreateToastNotifier("com.deepseek.dsh")` | `0x80073D54` The process has no package identity |
| `CreateToastNotifier()` 无参 | `0x80070490` Element not found |
| 先 `SetCurrentProcessExplicitAppUserModelID()` 再弹 | 仍然 `0x80073D54` |
| 改用 PowerShell 已注册的 AUMID | 仍然 `0x80073D54` |

这台 Windows 11 (22631) 对未打包进程封掉了 WinRT Toast。DSH 自己确实会弹
系统通知，但那是 Electron 外壳 `lib/main.js` 里的 `Notification`，**只用于强制
更新流程**，而且插件根本拿不到 Electron 外壳（Host 是被 fork 出来的
`ELECTRON_RUN_AS_NODE` 子进程）。

所以自绘窗口是唯一能同时做到「真的弹在右下角」+「完全跟随主题」+「带美术」
的路子。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 插件。订阅 `session/event`，在 `turn/end` 时组装并投递通知；另外提供 `/api/dsh-task-notify/theme` 收主题上报。 |
| `lib/client.js` | 浏览器侧。读 `getComputedStyle` 里的 `--dsw-*` 实测值 POST 给 Host。 |
| `lib/card.py` | 用 PIL 把一条通知画成 RGBA 卡片（渐变底、圆角、光晕、抗锯齿文字、右侧立绘）。 |
| `lib/popup.py` | 常驻渲染进程。从 stdin 读 NDJSON，把卡片画到右下角的分层窗口上。 |
| `assets/mascot.png` | 立绘（Q 版猫娘，透明背景）。 |

### 触发点为什么是 `turn/end`

`turn/end` 是 DSH 里唯一的 durable「这一轮结束了」信号，且带
`reason.kind ∈ completed | aborted | blocked | error | max-tokens | interrupted | forked`，
正好能区分「完成 / 中止 / 阻塞 / 失败」。

刻意**不用** `agent/status` 轮询 —— 官方 `cordis-plugin-development` 的
`practices.md` 明确禁止（多个输入会共享同一段 running 区间，`whenIdle()`
也不代表某一次 follow-up 结束）。job 的 `settled` 事件是另一条干净的信号，
但它只覆盖后台任务，不覆盖普通对话轮次。

### 主题为什么要在浏览器里读

DSH 的颜色真值全在 `--dsw-*` 上，而第三方主题（如 gemini-cat）是在运行时用
`ctx.theme.overrideTokens()` 覆盖 token 的 —— 磁盘上读不到。连「当前是哪个
子主题」都存在浏览器 localStorage 里。所以只有 `getComputedStyle` 拿到的
才是用户眼前那一套。

上报时机：插件启动、`theme/change`、以及 body 的 `data-ds-dark-theme`
属性变化（MutationObserver）。

## 自定义

- **换立绘**：替换 `assets/themes/` 中对应主题的 WebP，并保持 `manifest.json` 的映射。角色等比完整缩放，不裁剪头部。
- **改停留时长**：`lib/index.js` 里 `notify()` 的 `duration_ms`。
- **改文案**：`lib/index.js` 顶部的 `TONE` 表。
- **改配色**：`lib/card.py` 顶部的 `DEFAULTS` / `STATUS_COLORS`；
  但凡客户端能上报到 token，就会以实测值为准。

## 安装

本包是 `dsh-plugins-pack` 的一员，推荐用仓库脚本装（会一并写好 `dependencies` 与
`dsh.profile.bundles` 并跑 `pnpm install`）：

```powershell
pwsh -File scripts/install.ps1 -Only dsh-task-notify
```

```bash
bash scripts/install.sh dsh-task-notify
```

手动装也可以：把本目录拷到 `~/.dsh/profiles/desktop/dsh-task-notify`，在 profile 的
`package.json` 里加 `"dsh-task-notify": "file:./dsh-task-notify"`，并把包名追加到
`dsh.profile.bundles`，然后 `pnpm install`。

Python 解释器按这个顺序找：`$DSH_TASK_NOTIFY_PYTHON` →
`$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/python` → 系统 `python`。
DSH 自带运行时里的 Python 已经带 numpy + Pillow，不用另装。

## 卸载

1. 跑仓库脚本 `uninstall.ps1 -Only dsh-task-notify`（或 `uninstall.sh dsh-task-notify`）；
   或手工：删掉 profile `package.json` 里的 `dsh-task-notify` 依赖与 `dsh.profile.bundles` 里的同名项，
   删掉 `~/.dsh/profiles/desktop/dsh-task-notify` 目录，然后 `pnpm install`。
2. 也可以不卸载，直接从**侧栏 → 插件**页把 `dsh-task-notify` 组合包关掉：宿主监听、主题上报接口
   与弹窗进程一起停掉，文件留在原地。
