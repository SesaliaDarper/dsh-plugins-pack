# 兼容性实测记录

四个包不是"写完就发"，是**在一套干净的 DSH profile 里装上去、启起来、把 bundle 拉下来验过**才发布的。
这份文件记下验的时间、环境、每一项检查和证据，方便你复验，也方便 DSH 升级后快速判断还能不能用。

## 结论

**四个包在 DSH `0.2.1-rc.2` 上全部通过**：宿主侧装载无报错、客户端 bundle 全部构建成功并正常下发、
会话费用投影注册成功、自检接口 200、通知弹窗渲染进程能在 DSH 自带 Python 下起活、
安装脚本与卸载脚本各跑通一次。

## 环境

| 项 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.2`（commit `332895e`） |
| 形态 | Electron 桌面版安装目录里的运行时，用 `node <安装目录>/resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` 启动 |
| 启动的 profile | 由 `--from-default-profile web` 生成的全新 profile（**不是**作者本人的 `desktop` profile） |
| DSH_HOME | 独立的临时目录，真实 profile 一行未动 |
| 操作系统 | Windows 11 x64 |
| Node | v24.19.0 |
| pnpm | 11.28.5（DSH 自带运行时里的那份） |
| HMR | 未启用（干净 profile 无 `hmr.root`，排除"热替换掩盖了装载错误"） |

## 检查项

| # | 检查 | 方法 | 结果 |
| --- | --- | --- | --- |
| 1 | 清单结构 | 四个 `package.json` 都有 `dsh.bundle.patch`、`dsh.client.inject`、`exports["./client"]` | 通过 |
| 2 | 运行时版本约束 | `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`，按 DSH 自己的 `evaluatePluginCompatibility` 语义（prerelease 参与匹配） | 通过 |
| 3 | 语法与 JSON | 全部 `lib/*.js`、`tools/*.mjs` 过 `node --check`；全部 `*.json` 过 `JSON.parse` | 通过（0 错误） |
| 4 | profile 组合 | `dsh --profile <p> --dump-config`，确认四行 insert 落在组合树末尾 | 通过（`theme-gemini-cat` / `session-cost` / `task-notify` / `token-widget` 各一行） |
| 5 | 宿主装载 | 启动 web 服务，读 stderr/stdout | 通过（只有一行 `dsh web: http://…`，无 loader 报错） |
| 6 | 客户端 bundle 构建 | 拉 `/?token=…` 的 `__DSH_BOOT__`，再逐个 GET `plugins/??<id>/client.js` | 通过（见下表，全部 HTTP 200） |
| 6b | 通知渲染进程 | 用 DSH 自带 Python 直接跑 `lib/popup.py`，喂 `{"cmd":"ping"}` | 通过（回 `{"cmd":"pong","visible":0}`，即 ctypes/分层窗口/numpy/PIL 全链路可导入） |
| 7b | 通知的主题上报接口 | `GET /api/dsh-task-notify/theme` | 通过（HTTP 405 = 路由已注册、只收 POST；404 才代表没装上） |
| 7 | 投影注册 | `GET /api/dsh-session-cost/status` | 通过（HTTP 200，`ok: true`，`projectionKey: sessionCost`） |
| 8 | 安装脚本 | `scripts/install.ps1` 装进全新 profile，再启动一次 | 通过（装完能起、能出 bundle） |
| 9 | 卸载脚本 | `scripts/uninstall.ps1` / `uninstall.sh` | 通过（manifest 回到基线，`pnpm` 移除对应链接） |
| 10 | 不依赖个人环境 | 全程用全新 profile + 临时 DSH_HOME；包内无绝对路径、无用户名、无 token | 通过 |

### 第 6 项的具体证据

| 包 | bundle 下发 | 字节数 |
| --- | --- | --- |
| `dsh-theme-gemini-cat` | HTTP 200 | 1,467,939 |
| `dsh-task-notify` | HTTP 200 | 4,623 |
| `dsh-session-cost` | HTTP 200 | 67,495 |
| `dsh-token-widget` | HTTP 200 | 542,599 |

`__DSH_BOOT__` 里 73 个客户端条目全部进了 `batches`，四个包都在 `application` 批次的 URL 清单里
（`…,dsh-token-widget/client.js,dsh-session-cost/client.js,dsh-task-notify/client.js,dsh-theme-gemini-cat/client.js,…`），
即"构建完成且随首屏一起下发"，不是延迟加载失败。

## 依赖的 DSH 契约（升级时重点看这几处）

| 契约 | 谁在用 | 断了会怎样 |
| --- | --- | --- |
| `dsh.bundle.patch` + bundle insert | 四个包 | 装载直接失败（插件页报错），最容易被发现 |
| client slot `settings.general.item` | 美化包、余额挂件（`token-widget` 的找回入口） | 设置里那几行消失，其余功能正常 |
| client slot（会话标题栏）`@deepseek-ai/dsh-client-ui-conversation` | 会话费用徽章 | 徽章不渲染 |
| `ctx.sessionProjections.register` + 事件 `request/header` / `assistant/message` / `compaction/*` | 会话费用徽章 | 金额算不出来 → 徽章返回 null（不显示），不崩 |
| DSH 客户端 class 名子串（`_sidebarCol` / `_centerCol` / `_composerSeat` / `_brandMark` …） | 美化包 | 部分外观失效（立绘/星屑/渐变不出现），功能不崩 |
| 宿主 HTTP 路由注册 | 会话费用徽章自检口、任务通知主题上报口 | 那两个接口 404；徽章与弹窗照常 |
| 会话事件 `turn/end`（含 `reason.kind`）与 `--dsw-*` 设计 token | 任务完成通知 | 不弹通知，或弹了但配色回落到内置默认值 |

## 已知的兼容边界

- **DSH 0.3 起**：`engines.dsh` 上限卡在 `<0.3.0`。DSH 装/载这些包时会拿运行时版本比对，
  不匹配会在插件页给出提示，不会静默出错。要在 0.3 上用，先改 `engines.dsh` 再回归一遍。
- **class 名变动**：美化包按 DSH 客户端产物的 class 名**子串**匹配（`[class*="_sidebarCol"]`），
  这是客户端 bundle 里唯一稳定的抓手。DSH 改了这些前缀，主题会"少一块"而不是整页错乱。
- **费用口径**：会话费用徽章内置 DeepSeek 官方价目表（人民币/美元两份，各自计费不做汇率折算）。
  官方调价后需要更新 `packages/dsh-session-cost/lib/pricing.js`，或在 `cordis.patch.yml` 里用
  `config.pricing` 覆盖单价 —— 这一项与 DSH 版本无关。
- **余额来源**：余额挂件读的是 DSH 已有的账号/余额接口，不额外夹带请求；上游接口改名会表现为余额页空。

## 想自己复验

```bash
# 1. 建一个隔离的 DSH_HOME，从官方模板生成一个干净 profile
export DSH_HOME=/tmp/dsh-compat
node "<DSH安装目录>/resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile compat --from-default-profile web --dump-config >/dev/null

# 2. 用本仓库脚本装进去
DSH_HOME=$DSH_HOME DSH_PROFILE=compat bash scripts/install.sh

# 3. 起服务，看日志里有没有 loader 报错
node "<DSH安装目录>/resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile compat --no-open --port 51999

# 4. 验三件事
#    · 首页返回 200（带 ?token=，token 在启动那行日志里）
#    · __DSH_BOOT__ 的 batches 里出现三个包名
#    · curl /api/dsh-session-cost/status 返回 {"ok":true,...}
```

复验用的是全新的 profile，所以**不会**受作者本机 `desktop` profile 里的其它插件影响 ——
这一点很关键：兼容性结论要能在别人机器上复现，而不是"在作者机器上恰好能跑"。
