> **DSH 五件套之一** —— [← 回到总览](../README.md) · [兼容性记录](../COMPATIBILITY.md)

# 会话费用徽章（dsh-session-cost）

在 DSH 的**会话标题栏右侧工具区**放一枚小徽章，显示**本会话**在
**DeepSeek 官方模型**上花掉的钱；点开是一块明细面板（四个 token 桶各花了多少、
缓存命中省下多少、高峰/空闲时段拆分、按模型拆分、最近几笔调用、计价依据与口径说明）。

金额默认用**人民币**（中国大陆账号按人民币扣费），同时给出美元对照 —— 两份官方价目表
各自原样内置，**不做汇率折算**：

| 场景 | 徽章 |
| --- | --- |
| 会话全用官方路由 | `¥5.46` |
| 官方路由但模型不在价目表里 | `¥0.0000` + 面板里说明是哪几个模型没价 |
| 会话只用了中转站 / 其它厂商 | **不显示**（整格返回 null） |

价目表出处：[模型 & 价格（中文页，人民币）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) ·
[Models & Pricing（英文页，美元）](https://api-docs.deepseek.com/quick_start/pricing/)

> **v1.1 修正了什么**：v1 只内置了英文页的**美元**价目表，徽章显示 `$0.82`，而平台按
> 人民币那份表扣费（同一会话约 `¥5.46`）—— 看起来就「差 6.7 倍、不准确」。现在两张表
> 分别内置、分别计费，默认展示人民币。

## 只算官方，这一条落在哪

`deepseek-official`（API Key 路由）与 `deepseek-account`（账号路由）算官方；
其它任何路由（中转站、其它厂商、哪怕套着 DeepSeek 模型名）**只计数、不计价**，
而且一旦本会话没有任何官方计价，徽章根本不会渲染 —— 不是显示一个 `¥0.00`。

这条判断在**宿主**做（`lib/fold.js` 的 `isOfficialProvider`），不在客户端做：
客户端拿到的是已经算好的视图，它只负责画。路由列表可以在配置里改（见下）。

## 数据从哪来（不额外请求任何接口）

宿主注册一个会话投影 `sessionCost`（`ctx.sessionProjections.register`），按事件顺序折叠
**已有**的会话日志：

| 事件 | 用途 |
| --- | --- |
| `request/header` → `header.config.{provider,model}` | 这一段序列走的是哪条路由（同一序列内后续步骤继承 header，所以必须按顺序折叠，只看「当前模型选择」是不够的） |
| `step/start` / `llm/retry-started` | **请求发出时间** —— 高峰/空闲按它判定 |
| `assistant/message` → `usage` / 流式记录里最后一个 `usage` chunk | 提供商上报的真实用量：`inputTokens`（未命中）/ `cacheReadTokens` / `cacheWriteTokens` / `outputTokens` |
| `compaction/summary`（+ `compaction/start`） | 压缩本身也是一次要付钱的调用（**计入本会话**），峰谷按 `compaction/start` 判 |
| `assistant/attempt` | 失败/被打断的尝试：**只计数不计价**（用量是流式片段，不是完整结算） |

客户端用 slot props 的 `useProjection('sessionCost')` 读它，不需要自己翻事件流。

计费口径：

```
费用 = 未命中输入 × cacheMiss
    + 缓存命中输入 × cacheHit
    + 缓存写入输入 × cacheMiss     ← DeepSeek 不为缓存写入单独计价，宁可算贵不算便宜
    + 输出 × output                ← 思维链 token 已含在 outputTokens 里
缓存省下 = 命中 token × (cacheMiss − cacheHit)
```

**高峰时段 = 北京时间周一至周五 09:00–12:00、14:00–18:00**（英文页写成等价的
UTC 01:00–04:00、06:00–10:00），不含中国法定节假日；其余时段（含周末、节假日全天）
为空闲时段，空闲价 = 高峰价 × 0.5。中国调休表算不出来，所以节假日要用户给
（配置项 `holidays`，格式 `YYYY-MM-DD` 沪时）；不给的话工作日高峰会照常按高峰算，略偏贵。

两个容易错的地方都已经按「请求发出时间」处理 / 显式暴露：

- **跨时段边界的调用**：11:59 发出、12:00:30 落地的那笔，按落地时间会被错算成空闲价
  （便宜一半）。现在按 `step/start`（或重试的 `llm/retry-started`）判定。
- **失败/被打断的尝试**：不计入金额（避免把半截流式用量当完整调用），但会在面板里写明
  「另有 N 次失败尝试（M token）未计入」，不让少算悄悄发生。

## 三个刻意的设计

**1. 金额在 `wire.view` 里算，而不是在 `apply` 里。**
折叠只累计「路由 × 峰谷 × 四个 token 桶」的**用量**，钱在出站渲染视图时用**当前**价目表算。
于是：改价目表会立刻反映到所有已存在的会话上（包括几天前的老会话），
已落盘的投影检查点也不会因为改价而失效。峰谷与路由是时间序列相关的、推不回来的，
所以它们只能在折叠时判定并随用量存下来。

**2. 颜色全部走主题 token，一个写死的颜色都没有。**
`--dsw-alias-*` / `--dsw-elevation-panel` / `--dsw-radius-*`，所以浅色/深色、
以及像 `dsh-theme-gemini-cat` 那样覆盖 `--dsw-alias-*` 的主题插件，徽章与面板都会跟着变。
唯一的例外是面板头部那张立绘（美术素材允许有自己的颜色）。
`tools/verify-runtime.mjs` 里有一条检查：bundle 里不许出现写死的十六进制颜色。

另外，客户端**不 require 任何 Harness 客户端包**（不碰 `dsh-client-ui-primitives`）：
slot 里的组件一旦抛错，整格 UI 会直接空掉。气泡、面板、定位、关闭行为都是这里自己写的最小实现
（面板默认挂在徽章下方、下面放不下就翻到上方；点外面或按 Esc 关闭；`aria-haspopup` / `aria-expanded`）。

**3. 状态只存用量，币种只影响展示。**
状态里没有「金额」字段，所以加币种、改价目、改汇率都不需要动投影的 `stateVersion`；
`stateVersion` 只在**折叠语义**变化时 +1（v2 = 按请求发出时间判峰谷 + 失败尝试计数）。

## 配置（写在 `cordis.patch.yml` 的插件行里）

```yaml
- insert:
    - id: session-cost
      name: 'dsh-session-cost'
      config:
        displayCurrency: CNY                                  # 徽章主展示币种：CNY（默认）/ USD
        providers: ['deepseek-official', 'deepseek-account']  # 算作官方的路由 id
        holidays: ['2026-10-01', '2026-10-02']                # 沪时节假日（按空闲时段计）
        offPeakFactor: 0.5                                    # 空闲时段系数（官方口径 0.5）
        pricing:                                              # 覆盖/新增模型价（高峰价）
          - model: deepseek-flash
            currency: CNY                                     # 缺省 CNY；可写 USD
            cacheHit: 0.04
            cacheMiss: 2
            output: 8
        bills: 24        # 状态里保留最近多少笔调用（1–200）
        viewBills: 12    # 视图里最多带几笔给面板看（1–50）
        enabled: true    # 关掉后不注册投影，徽章消失
        statusRoute: true # 是否挂 /api/dsh-session-cost/status 自检口
```

内置价目表（**高峰时段**单价，空闲时段减半）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash`（V4.1-Flash） | 0.04 元 ／ $0.006 | 2 元 ／ $0.30 | 8 元 ／ $1.20 |
| `deepseek-v4-pro` | 0.30 元 ／ $0.044 | 9 元 ／ $1.32 | 27 元 ／ $3.96 |

两份表不是同一个汇率换算出来的（flash 隐含 6.667、pro 隐含 6.818），所以必须分开内置。
退役名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 会归并到 `deepseek-flash`
（官方文档写明它们按 Flash 价计费）。

## 结构

```
dsh-session-cost/
├── package.json              # dsh.client 声明（web / immediately / inject ui-conversation）+ 插件卡片元数据
├── lib/
│   ├── index.js              # Host 入口：配置 schema、投影注册、自检路由
│   ├── fold.js               # 折叠与视图（**零 DSH 依赖**，可纯 node 单测）
│   ├── pricing.js            # 两份币种价目表与计费纯函数（同样零依赖）
│   ├── schemas.js            # 状态 / 视图 schema
│   ├── schema.js             # 90 行的严格校验器（为什么不用 zod，见文件头）
│   └── client.js             # ★ 构建产物，DSH 真正加载的文件
├── src/client.template.js    # 客户端可读源码（构建时注入立绘 data URL）
├── assets/                   # 立绘（webp / data URL）与插件卡片图标
├── locale/{zh,en}.json       # 插件卡片标题与描述
└── tools/
    ├── build.mjs             # 模板 + art.json → lib/client.js（含语法检查）
    ├── smoke-test.mjs        # 108 项：峰谷/计价/折叠/视图/schema + 客户端加载与渲染不抛错
    ├── verify-runtime.mjs    # 运行时自查：与内置 tokenUsage 对账 + 两币种金额 + 客户端 bundle
    ├── audit-session.mjs     # 离线逐笔审计：解压会话日志、重放、两套口径并排对比
    ├── prepare-art.py        # 生图素材 → 透明底 WebP + data URL
    └── install-profile.mjs   # 接进 desktop profile（junction + package.json + patch + hmr）
```

## 对不上账时怎么查

```bash
node tools/audit-session.mjs --list                       # 最近的会话
node tools/audit-session.mjs session-bc600e46             # 逐笔审计某会话
node tools/verify-runtime.mjs http://127.0.0.1:19387      # 对着运行中的 DSH 对账
```

`audit-session.mjs` 会同时算两套口径并给出差值来源：本插件口径（官方路由 + 压缩 +
请求发出时间）对比内置 `tokenUsage`（所有路由 + 每次尝试 + 不计压缩），并逐条列出
「内置算了但本插件没算」的调用、它们的路由和原因。会话日志是**多帧 zstd**，
脚本里带着与 `dsh-session-persistence-jsonl` 相同的帧扫描算法（一次性解压只会得到第一帧）。

## 验证状态

已验证（`node tools/verify-runtime.mjs http://127.0.0.1:64279`，对着正在跑的 DSH 实测）：

- 插件在宿主里装载成功，`sessionCost` 投影注册并被驱动（stateVersion 2）；
- **与 DSH 内置的 `tokenUsage` 投影逐个 token 对账**：纯 chat 会话**完全一致（差 0）**；
  差值只出现在两种可解释的情况 —— 本插件计入的压缩调用（正差）、
  内置计入而本插件按设计不计的非官方路由调用（负差，实测 −2,565,070 token 正是 4 笔中转站调用）；
- 两币种比价 6.667（flash 官方比价），人民币金额按中文页价目表算；
- 峰谷判定实测正确（北京时间 11:33 落在高峰窗口；20:40 落在空闲窗口）；
- 宿主按 `@deepseek-ai/dsh-client-modules` 的 rev 算法送出了本插件的客户端 bundle
  （`/plugins/??dsh-session-cost/client.js&rev=…` → 200），bundle 里含 slot 注册且无写死颜色。

**没有验证**：徽章在页面里的实际外观（配色、与相邻工具按钮的间距、面板翻转、深色主题下的观感）。
这一项需要**刷新页面**后肉眼确认 —— 我没有浏览器控制权，也不去伪造一张截图充当验收。
若刷新后没看到徽章，先确认当前会话确实用过 `deepseek-official` / `deepseek-account`
（用中转站跑的会话按设计就是不显示的）。

## 卸载

```bash
# 1. 删掉 cordis.patch.yml 里那段 `# 会话费用徽章` 注释 + `- insert: … session-cost` 行
# 2. 用同目录下的 *.bak-session-cost-<时间戳> 还原 package.json 与 cordis.patch.yml
#    （hmr 的 root 列表里也要去掉 dsh-session-cost）
# 3. 删掉 node_modules\dsh-session-cost 这个 junction
```

## 已知边界

- **子代理是独立会话**，单独计价，不计入父会话（面板与 README 都写明了）。
- 压缩调用计入本会话，因此会比内置 `tokenUsage` 多出这一部分。
- 失败/被打断的尝试不计价（用量是半截流式片段），但会在面板里计数提示。
- 上游没有上报用量的调用无法计价，只计数（面板会写「有 N 次调用没有上报用量」）。
- 人民币与美元各自按官方那份表算，**不做汇率折算**；若账号实际是美元计费，
  把 `displayCurrency` 改成 `USD` 即可（美元金额本来就在视图里）。
- 单价会变。改价只需动配置里的 `pricing`（或改 `pricing.js` 的内置表），
  历史会话的金额会按新价重算（这是刻意的）。

## 许可

代码 MIT。`assets/art/mascot.webp` 的素材由生图模型生成，仅随本插件运行使用。
