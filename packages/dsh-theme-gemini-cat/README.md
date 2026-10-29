# 美化包（dsh-theme-gemini-cat）

给 DeepSeek Harness 的界面整套换装：**配色 + 侧栏角色立绘 + 极简对话背景 + 品牌标识 + 强调色**。
五套角色：**Gemini猫猫 / GLM / Grok娘 / GPT娘 / Claude娘**，每套都有浅色与深色两版。

- 对话背景是**极简**取向：纯色底 + 角色纹样淡色水印 + 右侧立绘，不是把整张插画铺满屏幕 —— 文字始终是主角。
- 「对话背景透明度」「背景磨砂度」两根滑块可调，深浅两套分别记忆。
- 关掉后界面**完全回到原生**：所有外观规则都以 `body[data-gc-theme]` 为前提，不写 `!important` 去污染原生样式。

## 装在哪

设置 → **通用** → `自定义主题` 一行：

| 控件 | 作用 |
| --- | --- |
| 角色 chip ×5 | 切换主题（Gemini猫猫 / GLM / Grok娘 / GPT娘 / Claude娘） |
| `对话背景透明度` | 0% = 主题原本的磨砂厚度，100% = 完全没有磨砂（背景最清楚） |
| `背景磨砂度` | 0 = 不额外模糊，往右加大 `blur()` 半径 |

选择记在浏览器 `localStorage`（`dsh-theme-gemini-cat.selected` / `.chatVeil` / `.chatFrost`），换设备不跟随。

## 它改了界面的哪些地方

- 侧栏：星屑/光晕层、底部角色立绘、品牌 logo 换成主题标识、主按钮虹彩渐变
- 会话列：顶部虹彩发丝线、极简对话背景（`::after` 定位层，模糊只糊背景不糊文字）
- 输入区：去掉原生那条「渐变到不透明底色」的硬切，让背景连到窗口底部
- 滚动条与选中态跟随主题色

侧栏立绘/星屑画在**定位层**上而不是元素自身背景 —— 侧栏内部那层不透明的 `_root` 会把
元素背景整块盖住（Windows 上尤其明显），所以立绘走 `::after`、星屑走 `::before`，`z-index: 0`，
可交互行统一抬到 `z-index: 2`。

## 实现方式

- `lib/index.js`：Host 侧入口，空实现（主题只作用于客户端）。
- `lib/client.js`：客户端 bundle。注入 `["slots", "locale", "theme"]`，往 `settings.general.item` 注册一行设置，
  并把整套 CSS 与立绘 data URL 内联进去（单文件、无额外请求、不需要静态资源服务器）。
- `cordis.patch.yml`：把本包 insert 进 profile 树，id 为 `theme-gemini-cat`。

立绘以 data URL 内联（`lib/client.js` 约 1.4 MB），换来的是「拷一个目录就能用」：
不依赖 assets 目录的 HTTP 路由，也不需要 DSH 提供静态资源挂载点。

## 卸载

侧栏 → 插件页关掉 `dsh-theme-gemini-cat` 组合包，或从 profile 的 `dsh.profile.bundles` 里删掉本包。
关掉后主题行消失，界面立即回到原生配色。

## 许可

MIT。立绘与主题素材随包分发，供个人在本机 DSH 里使用。
