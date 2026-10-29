# DSH 会话挂件（dsh-token-widget）

一个挂在 DSH 界面里的**会话挂件**：右下角一只 Q 版角色立绘，左上角气泡是一块**两页的牌子** ——
一页显示**本会话 token 用量 / 上下文占用**，一页显示**账户余额**，默认自动翻页。
点一下立绘弹出面板可以切换立绘、看余额明细，界面字体与强调色跟着所选角色的主题走。

灵感来自 [codex-gpt-widget（大肥龙 Codex 额度挂件）](https://github.com/if-u-can/codex-gpt-widget)，
按 DSH 的插件体系重做，不是桌面悬浮窗，而是 DSH 客户端插件。

## 效果一览

以 GLM 为例，气泡的两页分别是：

| 页面 | 预览 |
| --- | --- |
| 用量页（默认起点） | ![用量页](preview/glm-light.png) |
| 余额页 | ![余额页](preview/glm-balance-light.png) |

每个角色都有一张用量页与一张余额页预览（`preview/<角色>[-balance]-{light,dark}.png`）。
五个角色：Grok娘（黑金 / 酒红）、Claude娘（暖橙）、Gemini猫猫（蓝紫 / 星屑）、
GLM（黑白狐耳 / 冰蓝宝石）、GPT娘（银白龙角 / 青碧）。

## 交互

- **拖动立绘**：移动挂件，位置记在浏览器本地。拖动时**至少留 48px 在窗口里**，
  所以拖到屏幕外面也丢不了。
- **单击立绘**：开合切换面板。
- **单击气泡**：在「用量 / 余额」两页之间翻转，并**固定**在你翻到的那页
  （想恢复自动翻页，在面板里选「自动」）。气泡底部两个小圆点标出当前在哪一页。
- **面板里**：五个立绘 chip、`界面字体跟随角色` 开关、`显示挂件` 开关、
  账户余额明细 + ⟳ 刷新、`气泡显示：自动 / 用量 / 余额` 三选一、`缩放大小`、`复位位置`。
- **设置 → 通用**里还有一行同样的入口：`找回挂件` 按钮（挂件不见了时的兜底）。

### 挂件跑丢了怎么办

挂件会因为窗口变小、换朝向、分屏、页面缩放等等被挤出可视区。四条找回路径，任选一条：

| 路径 | 什么时候用 |
| --- | --- |
| 拖动时自动钳位 | 你正拖着它 —— 根本丢不出去 |
| 窗口尺寸 / 朝向变化时自动找回 | 你缩小窗口把它挤出去了 —— 什么都不用做 |
| `Ctrl+Alt+H` | 随手一按就叫回右下角（挂件卸载了也有效） |
| 设置 → 通用 → `找回挂件` | 挂件彻底不见了、快捷键也想不起来时 |

「找回」= 显示挂件 + 清掉存的自由坐标，回到默认的右下角（`visible: true, pos: null`）。
它**不会**动你的立绘、缩放、气泡页这些设置。判断「丢了」的规则是
**可见部分少于 48px**；量不到盒子尺寸时（立绘还没解码、宿主没有 DOM）
一律当作「不知道」，宁可不动也不复位 —— 免得把用户故意摆在角落的位置清掉。

> 快捷键装在插件级而不是组件里：挂件随路由卸载时（比如你正停在设置页）
> 组件里的监听也跟着没了，而这条快捷键恰恰是「挂件不见了」时的入口。

> **关于 `缩放大小`**：面板是「界面」，它的字号与几何**不跟随**立绘缩放
> （`.tw-panel` 上钉死了 `font-size`）。这不是审美选择，是修 bug 的必要条件 ——
> 面板宽度固定而内边距是 em，一旦字号跟着 `--tw-scale` 走，拖动滑块就会形成
> 「缩放↑ → 面板内边距↑ → 滑块轨道变窄 → 同一光标位置取值变大 → 缩放再↑」的自激振荡，
> 表现就是抽搐。同理，拖动过位置的挂件是左锚定的，面板相应地改挂左边缘，
> 免得右边缘随宽度平移；拖动滑块期间还会把面板高度钉住，松手再滑回原位。
> 改这块 CSS 前请先看 `tools/smoke-test.mjs` 里那一节回归守卫。

> 为什么用翻页而不是把余额加成第三行：气泡是立绘里画好的一个椭圆，
> 三行会挤到线稿上，而且两件事的更新节奏完全不同（token 每轮都在变、余额十分钟才变一次）。
> 翻页让每一页都有完整的空间。

## 数据来源

气泡「用量页」的数字来自 DSH 客户端已有的会话投影，**不额外请求任何接口**：

| 投影 | 字段 | 用途 |
| --- | --- | --- |
| `tokenUsage` | `uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens` | 用量页大号：本会话 token 总量 |
| `contextPressure` | `projectedTokens`（或 `pressureTokens`）/ `contextWindow` | 用量页小号：上下文占用百分比 |

当前会话取自 `ctx.uiWorkspace.selection`，投影从
`ctx.sessions.binding(sessionId).session.projections.faceOf(key)` 订阅。
拿不到数据时用量页显示「等待会话…」，不会报错。

**余额页是唯一的例外**：它来自 DSH 的账号服务（要真的打到 Platform），见下一节。

## 账户余额

气泡的余额页显示当前 DeepSeek 账号的余额（大号 `¥5.77`、小号 `余额`，
有赠金时小号变成 `余额 · 赠金 ¥3.50`）；点开面板能看到「充值余额 / 赠金」分行明细、
一个 ⟳ 立即刷新按钮，以及 `气泡显示：自动 / 用量 / 余额` 三选一。

数据走 DSH 自己的账号 Remote，**不读也不缓存任何凭据**：

```js
ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })
// → { ok: true, value: null                                    // 没登录账号
//              | { status: "ready",  value: [Wallet], bonusWallets: [Wallet] }
//              | { status: "failed" } }                        // 查询失败
// Wallet = { currency: "CNY" | "USD", balance: "5.7753636800000000" }
```

几个刻意的决定：

- **金额格式照抄 DSH 账号设置页的规则**：正金额**截断**到分（不是四舍五入），
  小于一分显示 `<0.01`，负金额四舍五入且显示绝对值至少 0.01。
  所以 `5.7753636800000000` 显示成 `¥5.77` 而不是 `¥5.78`。
- **余额放在可选子作用域里**（`ctx.inject(["remote", "remote.account"], …)`），
  **不在**插件级 `inject` 里。插件级 inject 缺一个服务就整个插件不加载 ——
  那会让账户服务缺席的部署里连挂件都没了。余额只是增值信息。
- **十分钟自动刷新一次**，另外打开面板和点 ⟳ 时立即读。
  余额是账号级数据、读取要打到 Platform，不值得频繁轮询。
  刷新时**保留上一次的金额**直到新值回来 —— 否则已经显示出来的余额每十分钟会先变成
  「读取中…」再变回来，连带自动轮播也闪回用量页。
- **查询失败不画成 ¥0.00**：`failed`、`signedOut`、`ready` 是三种不同状态，
  余额页分别显示「余额读取失败」「未登录账号」和真实金额（大号位置都是 `—` 或 `…`）。
  把失败画成 ¥0.00 会让人以为钱没了。
- **自动轮播只在余额可用时才翻到余额页**：没有账号时还翻过去，用户只会看到一块
  写着「未登录」的空牌子在闪。手动选「余额」页时则尊重选择，那时显示原因才对。

## 结构

```
dsh-token-widget/
├── package.json            # dsh.client 声明（web / immediately / inject ui-theme）
├── lib/
│   ├── index.js            # Host 侧入口（空实现，挂件只在客户端）
│   └── client.js           # ★ 构建产物，DSH 真正加载的文件
├── src/
│   └── client.template.js  # 可读源码（构建时注入立绘 data URL）
├── assets/
│   ├── art.json            # 立绘 data URL + 自动测出的气泡文字框
│   └── art/*.webp          # 处理好的透明立绘
└── tools/
    ├── prepare-art.py      # 素材 → 透明 WebP + 气泡框检测
    ├── preview.py          # 按真实气泡版式渲染各角色的预览图
    ├── build.mjs           # 模板 + art.json → lib/client.js（含语法检查）
    ├── smoke-test.mjs      # 模拟 DSH 模块加载器跑一遍插件（含余额的四种状态）
    ├── rename-zlm-to-glm.mjs # 一次性迁移：把笔误 ZLM 改成 GLM（幂等）
    └── install-profile.mjs # 接进 DSH desktop profile
```

## 改素材 / 加角色

1. 把新立绘（透明底 PNG、气泡内部留空）丢进用户素材目录；
2. 改 `tools/prepare-art.py` 里的 `SRC_DIR` 与 `CHARACTERS`；
3. `python tools/prepare-art.py` → 生成 `assets/art.json`（气泡文字框自动测出）；
4. 在 `src/client.template.js` 的 `CHARACTERS` 里加一项（名字、`ink`/`fill` 配色、`tokens` 主题覆盖）；
5. `node tools/build.mjs` → 刷新 `lib/client.js`；
6. `node tools/smoke-test.mjs` 自检，然后刷新 DSH 页面。

## 主题覆盖了什么

只覆盖**字体与强调色**相关 token（`--dsw-alias-label-*`、`--dsw-alias-brand-*`、
`--dsw-alias-link`、`--dsw-alias-state-business-primary`、`--dsw-focus-ring-color`），
背景与材质保持 DSH 原生。面板里可以随时关掉跟随。

## 安装 / 卸载

安装（已由 `tools/install-profile.mjs` 完成）：

- `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-token-widget` → 本目录（junction）
- `cordis.patch.yml` 末尾追加 `- insert: [{ id: token-widget, name: 'dsh-token-widget' }]`

卸载：删掉 `cordis.patch.yml` 里那段，并用同目录的 `*.bak-token-widget-*` 还原备份。

## 许可

代码 MIT。`assets/art` 里的角色素材来自用户提供，仅随本插件运行使用，不在 MIT 授权范围内。
