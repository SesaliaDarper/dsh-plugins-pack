# dsh-image-gen

给 DSH 加生图能力，三个入口：

| 入口 | 谁发起 | 提示词的实际来源 |
|---|---|---|
| **生图台**（输入框左边的按钮 → 切到「生图」视图） | 你 | 面板里敲的字，拼成 `/image …` 交给 Host 命令执行器 |
| **`/image <提示词>`** | 你 | 命令行的字节本身 |
| **对话里说「画一张……」** | 你 | 你的消息原文（宿主直接取，模型写的 `prompt` 一律丢弃） |

生图模型**不要**挂进 `llm-pi-ai` 的 providers —— 那是给对话模型用的（`/chat/completions`）。

## 生图台（v2，重做过界面）

**它是全局一个共用的工作台**（左栏「生图」入口 → 中间栏一页），不按会话拆分：
成图、提示词、参数、参考图、进行中的任务都在模块级 store 里，切到任何会话再回来看到的都是同一份。
输出目录由 `studioDir` 决定（留空则回落 `$DSH_HOME/image-studio`，也可以填一个固定的绝对路径；
本包自带的 patch 里默认留空）。这个字段在「设置 → 生图」里可改、改完立刻生效。图片经同源路由
`/image-gen/file` 读取 —— 只允许当前目录与旧的 `$DSH_HOME/image-studio`（旧成图仍可显示）。

**离开页面不会打断生图**：请求生命周期在 store 里，组件只是它的一张脸 ——
切走再回来，计时接着走；回来时如果已经跑完，成品就在成图墙最上面。

进到「生图」视图后，**原版对话输入框会隐藏**（只藏默认输入条；审批 / 提问是同一位置上的
当选内容，不会被藏掉，工具调用照常能确认），页面自带输入区：

- 输入区**常驻底部**（sticky）：提示词框 + 模型 / 张数 / 参考图 / 生成，图在上面翻，输入永远在手边；
- 成图**点一下就放大**，`←`/`→` 翻看、`Esc` 关闭，灯箱里也能「参考」这张继续改 —— 不用离开生图页。

- **首屏搞定**：提示词框 + 一行工具栏（模型 / 张数步进 / 参考图 / 生成）+ 尺寸片选
  （`方形 1:1`、`竖版 2:3`、`横版 3:2`、`自动`），不再需要记 `1024x1536`。
- **等待有数**：生成时按钮与状态条显示秒数（上游常见 20–60 秒）。
- **失败可救**：错误就地展开详情（Cloudflare 的 502 也能看原文），旁边一个「重试」，不用重新打字。
- **成图墙**：两列缩略图，悬停出现「参考 / 复制」，点整块在右栏预览；
  **按会话持久化到 localStorage**，刷新、切 tab、切会话回来都还在。
- **参考图**：拖入、粘贴、选文件，最多 4 张；每张带 **图一/图二/…** 角标，可用 `‹ ›` 调整顺序
  （上游按送入顺序收图，提示词里的「图一/图二」就是这个顺序）；成图也能一键「参考」回来接着改。
  参考图按会话缓存在内存里 —— 切到对话再切回来，托盘还在，不用重选。
- 结果里写明这次**送了几张参考图**，方便核对是不是真的带上了。
- **完全隔离**：生图台走宿主自己的同源路由 `POST /image-gen/studio`，不再经过 `/image` 命令 ——
  所以**不会**在会话日志里留下 `command/run`/`command/done`，对话里也不会多出一张卡。
  提示词、参考图、成图、历史全部只在生图视图里（成图墙按会话存 localStorage）。
  （`/image` 命令仍然保留：那是你在输入框手敲时才用的另一条入口。）
- 键盘：`Enter` 生成、`Shift+Enter` 换行、`Esc` 清空提示词。

## `/image` 命令

```
/image 一只戴帽子的猫，水墨                     ← 文生图
/image 改成水彩（先附一张参考图）                ← 图生图，附件即参考图
/image --n 2 --size 1024x1536 一张海报          ← 可选旗标必须写在提示词前面
/image --ref dsh-images/img-xxx.png 改成水彩    ← 盘上已有的图当参考图（可重复，最多 4 张）
```

旗标五个：`--n` / `--model` / `--size` / `--name` / `--ref`。写在提示词中间的
`--ref` 不会被吃掉 —— 「原封不动」不能因为顺手解析参数就破掉。

## 设置（「设置 → 生图」）

接口地址、密钥引用名（值放 `$DSH_HOME/.credentials.yaml` 的 refs 节）、可用模型清单
（加一行删一行立刻生效）、默认尺寸、单次最多张数、输出目录。

## 自检

```bash
node tools/verify.mjs            # 离线跑真实代码路径
node tools/verify.mjs --keep     # 保留临时目录
```

覆盖：原话转发 / `user-append` 前缀与字数上限 / `self` 必须给理由 / 一轮一次的额外生图闸门 /
多参考图 `image[]` 保序 / `/image` 五个旗标（含 `--ref` 的路径、引号、上限、位置）/
上游错误收口 / 客户端命令行与 Host 解析逐字节对齐 / 生图台「输入 → 生成 → 成图墙 →
以这张为参考 → 再生成」的端到端回环 / 成图墙持久化 / 设置分区注册。

## 目录

```
dsh-image-gen/
├─ lib/index.js      Host：image_generate 工具 + /image 命令
├─ lib/client.js     客户端：生图台 + /image 卡片 + 设置页 + 输入框按钮
├─ cordis.patch.yml  组合包 patch（配置默认值）
├─ icon.svg
├─ tools/verify.mjs  离线自检
└─ node_modules/@deepseek-ai/{cosmokit,schemastery,dsh-tools,dsh-home-paths}
                     Host 半边要 import 的包 —— 指向 DSH 安装目录的 junction
```

> `node_modules` 里那四个 junction 是必需的：插件目录不在 DSH 安装目录下，
> 裸模块名（`@deepseek-ai/cosmokit` 等）只能靠它解析，否则挂载时会报
> `ERR_MODULE_NOT_FOUND`。**升级 DSH 后安装路径变了**，用下面的命令重建：
>
> ```powershell
> $app = "<DSH 安装目录>\resources\app\dsh\node_modules\@deepseek-ai"
> foreach ($p in "cosmokit","schemastery","dsh-tools","dsh-home-paths") {
>   $link = "D:\SAVE\AI-Work\Dsh-Work\plugins\dsh-image-gen\node_modules\@deepseek-ai\$p"
>   if (Test-Path $link) { cmd /c rmdir $link }
>   New-Item -ItemType Junction -Path $link -Target (Join-Path $app $p) | Out-Null
> }
> ```

