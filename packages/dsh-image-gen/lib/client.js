/**
 * dsh-image-gen — 客户端半边。
 *
 * 三块界面，共用一份「命令行拼装 + 结果解析」：
 *
 *   1. 「生图台」—— 会话里的一个视图（conversation.view）：提示词 + 模型/尺寸/张数
 *      + 参考图 + 成图墙。它把请求 POST 给宿主的 `/image-gen/studio` 路由，
 *      **全程没有对话模型参与，也不往会话日志里写任何东西**。
 *   2. `/image` 结果卡片 —— 对话里的命令行换成一张卡（提示词、文件、缩略图）。
 *   3. 「设置 → 生图」—— 端点、密钥引用名、模型清单、默认尺寸/张数。
 *
 * 设计约束（这一版重写时定下的）：
 *
 *   - **单手可用**：提示词框 + 一行工具栏 + 结果网格，全部在首屏，不用上下找；
 *     Enter 生成、Shift+Enter 换行、Esc 清空。
 *   - **等待可见**：生成时显示秒数，失败时原地给「重试」，不用重新打字。
 *   - **不丢东西**：提示词、参数与成图墙按会话存 localStorage，刷新/切 tab 都在。
 *   - **尺寸说人话**：`1024x1536` 显示成「竖版 2:3」，不让人记数字。
 *
 * 模块封装格式（`window.__ModuleLoader__.load`）是 DSH 客户端插件唯一认的形态，
 * 不要改成 ESM export。
 */

window.__ModuleLoader__.load({
	id: "dsh-image-gen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/* ─────────────────────────── 常量 ─────────────────────────── */

		/** Host 侧配置命名空间 = cordis.patch.yml 里那条 insert 的 `id`。 */
		const NS = "image-gen";

		/** 词典命名空间。 */
		const LOCALE_NS = "settings.image-gen";

		/** 「设置 → 生图」分区 id。 */
		const SECTION_ID = "image-gen";

		/** 右栏 tab 类型判别符（保留给 `/image` 卡片等处复用文案）。 */
		const STUDIO_KIND = "image-studio";
		const STUDIO_ID = "dsh-image-gen/studio";

		/**
		 * 「生图」主面板 id：左栏 panellist 的条目 id，也是 `main` 槽位的 key。
		 *
		 * 生图台是**全局一个**的工作台，不按会话拆分 —— 状态在模块级 store 里。
		 */
		const PAGE_ID = "image-studio-page";

		/** 生图台的直连路由（同源 HTTP）：结果只回面板，不写会话日志。 */
		const STUDIO_ROUTE = "image-gen/studio";

		/** 与 Host 的 `MAX_REFERENCE_IMAGES` 对齐。 */
		const MAX_REFS = 4;

		/** 上游接受的参考图 MIME（`/images/edits` 按 MIME 解码，写错就是 502）。 */
		const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

		/** 配置读不到时的兜底模型清单（与 Host 的 DEFAULT_MODELS 一致）。 */
		const DEFAULT_MODELS = [
			"gpt-image-2",
			"gpt-image-2.5",
			"gpt-image-2.5-flare",
			"gpt-image-2.5-sunburst",
			"grok-imagine-image-2.0",
		];

		/** 尺寸选项：值发给上游，标签给人看。 */
		const SIZE_OPTIONS = [
			{ value: "auto", ratio: "auto", zh: "自动", en: "Auto" },
			{ value: "1024x1024", ratio: "1:1", zh: "方形 1:1", en: "Square 1:1" },
			{ value: "1024x1536", ratio: "2:3", zh: "竖版 2:3", en: "Portrait 2:3" },
			{ value: "1536x1024", ratio: "3:2", zh: "横版 3:2", en: "Landscape 3:2" },
		];

		/** 成图墙最多留多少张（localStorage 里只存路径，不存字节）。 */
		const GALLERY_LIMIT = 24;

		/** `/image` 结果里的哨兵行前缀，必须与 Host 的 RESULT_SENTINEL 一致。 */
		const RESULT_SENTINEL = "@@image-gen";

		/* ─────────────────────────── 文案 ─────────────────────────── */

		const zh = {
			nav: "生图",
			title: "生图",
			desc:
				"对话模型自己画不了图，只能调用这里的 image_generate 工具；「生图台」则让你自己直接对生图模型提要求。" +
				"你主动要图时，原话会原封不动发给生图模型，不被改写、不被翻译、不会被补风格词。",
			"card.generate": "生图",
			"card.edit": "改图",
			"card.running": "生图请求已发出，等待上游返回……",
			"card.done": "已完成",
			"card.failed": "生图失败",
			"card.prompt": "提示词（原样发给生图模型）",
			"card.copy": "复制提示词",
			"card.copied": "已复制",
			"card.preview": "在侧边栏预览",
			"card.count": "张",
			endpoint: "服务端点",
			baseUrl: "接口地址",
			baseUrlHint: "OpenAI 兼容网关：文生图打 /images/generations，图生图打 /images/edits。",
			apiKeyEnv: "密钥引用名",
			apiKeyEnvHint:
				"这里只写引用名。密钥值放在 $DSH_HOME/.credentials.yaml 的 refs 节，不落进配置文件。",
			models: "可用生图模型",
			modelsHint: "工具描述照着这份清单写；加进来就立刻可用。",
			modelsEmpty: "清单是空的 —— 会回落到插件内置的默认清单。",
			addPlaceholder: "模型 id，例如 gpt-image-2.5",
			add: "添加",
			remove: "删除",
			setDefault: "设为默认",
			isDefault: "默认",
			defaultModel: "默认生图模型",
			defaultModelHint: "对话模型没点名、面板没选时用这个。",
			defaultModelOrphan: "默认模型不在上面的清单里，建议改成一个清单内的。",
			defaultSize: "默认尺寸",
			maxImages: "单次最多张数",
			outputDir: "输出目录",
			outputDirHint: "相对路径按会话工作目录解析；绝对路径原样使用。（/image 命令与工具用这个）",
			studioDir: "生图台目录",
			studioDirHint: "面板的成图存这里，绝对路径；留空用 $DSH_HOME/image-studio。",
			loading: "加载中…",
			unavailable: "当前部署不支持持久化设置，这里的修改不会被保存。",
			writeFailed: "写入被拒绝 —— 配置文件可能刚在别处被改过，请重试。",
			"studio.panel": "生图台",
			"studio.viewLabel": "生图",
			"studio.viewTitle": "生图",
			"studio.viewDesc":
				"直接对生图模型提要求：写提示词、选模型与尺寸、拖参考图，按 Enter 出图。" +
				"提示词原样直发，不经过对话模型；成图与命令记录都留在这个会话里。",
			"studio.sessionEmpty": "这个会话还不可用。回到对话新建一个会话，再切到「生图」。",
			"studio.guideTitle": "生图台",
			"studio.guideDescription": "直接对生图模型提要求",
			"studio.placeholder": "描述你想要的图……（Enter 生成，Shift+Enter 换行）",
			"studio.hint": "提示词原样直发，不经过对话模型 · Enter 生成 · Esc 清空",
			"studio.model": "模型",
			"studio.size": "尺寸",
			"studio.count": "张数",
			"studio.reference": "参考图",
			"studio.addReference": "参考图",
			"studio.referenceHint": "拖入 / 粘贴 / 选择本地图片，最多 4 张；也可把下面的成图点「参考」加回来。",
			"studio.generate": "生成",
			"studio.generating": "生成中",
			"studio.needPrompt": "先写提示词。",
			"studio.running": "已交给生图模型，等待上游返回……",
			"studio.done": "完成",
			"studio.failed": "生图失败",
			"studio.retry": "重试",
			"studio.details": "详情",
			"studio.hideDetails": "收起",
			"studio.results": "成图",
			"studio.resultsEmpty": "还没有图。写一句，按 Enter。",
			"studio.useAsRef": "参考",
			"studio.openPreview": "预览",
			"studio.copyPath": "复制",
			"studio.copied": "已复制",
			"studio.remove": "移除",
			"studio.clear": "清空",
			"studio.clearConfirm": "再点一次清空",
			"studio.noRemote": "当前部署没有命令通道，生图台用不了。",
			"studio.routeMissing": "生图服务还没加载：重启一次 DSH 就能用（插件升级后的第一次重启）。",
			"studio.unknownCommand": "命令没被受理（/image 可能被卸掉了）。",
			"studio.tooManyRefs": "参考图最多 4 张。",
			"studio.unsupported": "参考图只支持 PNG / JPEG / WebP / GIF。",
			"studio.readingReference": "正在读参考图……",
			"studio.editMode": "带参考图 · 图生图",
			"studio.generateMode": "文生图",
			"studio.openTooltip": "切到「生图」视图：直接对生图模型提要求",
			"studio.elapsed": "已用",
			"studio.examples": "试试这些",
			"studio.example1": "赛博朋克风的猫，霓虹紫青，夜景",
			"studio.example2": "极简线稿 logo，一头鲸，纯白底",
			"studio.example3": "水彩风景，黄昏的湖面与远山",
			"studio.refsOf": "参考图",
			"studio.ref1": "图一",
			"studio.ref2": "图二",
			"studio.ref3": "图三",
			"studio.ref4": "图四",
			"studio.orderHint": "顺序就是「图一 → 图二」：提示词里说的图一/图二按这个顺序送达。",
			"studio.moveLeft": "往前移",
			"studio.moveRight": "往后移",
			"studio.skipped": "{n} 张参考图类型不支持（只收 PNG/JPEG/WebP/GIF），已跳过。",
			"studio.refCount": "参考图 {n} 张",
			"studio.prev": "上一张",
			"studio.next": "下一张",
			"studio.close": "关闭",
			"studio.browseHint": "点任意一张放大，←/→ 翻看，Esc 关闭。",
			"studio.willSend": "将发送",
			"studio.promptLabel": "提示词",
		};

		const en = {
			nav: "Image",
			title: "Image generation",
			desc:
				"The chat model cannot draw — it can only call the image_generate tool below. The studio lets you " +
				"talk to the image model yourself. When you ask for a picture, your own wording goes out verbatim.",
			"card.generate": "Generated",
			"card.edit": "Edited",
			"card.running": "Image request sent; waiting for the upstream model…",
			"card.done": "Done",
			"card.failed": "Image generation failed",
			"card.prompt": "Prompt (sent to the image model verbatim)",
			"card.copy": "Copy prompt",
			"card.copied": "Copied",
			"card.preview": "Preview in sidebar",
			"card.count": "image(s)",
			endpoint: "Endpoint",
			baseUrl: "Base URL",
			baseUrlHint: "OpenAI-compatible gateway: /images/generations for text-to-image, /images/edits for editing.",
			apiKeyEnv: "Credential reference",
			apiKeyEnvHint: "Only the reference name lives here; the value stays in $DSH_HOME/.credentials.yaml.",
			models: "Available image models",
			modelsHint: "The tool description is generated from this list; anything added here works immediately.",
			modelsEmpty: "The list is empty — the plugin falls back to its built-in defaults.",
			addPlaceholder: "Model id, e.g. gpt-image-2.5",
			add: "Add",
			remove: "Delete",
			setDefault: "Set default",
			isDefault: "Default",
			defaultModel: "Default image model",
			defaultModelHint: "Used when neither the conversation nor the studio names one.",
			defaultModelOrphan: "The default model is not in the list above; pick one that is.",
			defaultSize: "Default size",
			maxImages: "Max images per call",
			outputDir: "Output directory",
			outputDirHint: "Relative paths resolve against the session working directory. (Used by /image and the tool.)",
			studioDir: "Studio output directory",
			studioDirHint: "Absolute path for the studio’s images; empty means $DSH_HOME/image-studio.",
			loading: "Loading…",
			unavailable: "This deployment cannot persist settings; edits here will not be saved.",
			writeFailed: "The write was refused — the config file may have changed elsewhere. Please retry.",
			"studio.panel": "Image studio",
			"studio.viewLabel": "Image",
			"studio.viewTitle": "Image generation",
			"studio.viewDesc":
				"Talk to the image model directly: write a prompt, pick model and size, drop reference images, press Enter. " +
				"Your wording goes upstream verbatim — the chat model is not involved, and results stay in this session.",
			"studio.sessionEmpty": "This session is not available yet. Open or start a session, then switch to “Image”.",
			"studio.guideTitle": "Image studio",
			"studio.guideDescription": "Talk to the image model directly",
			"studio.placeholder": "Describe the picture… (Enter generates, Shift+Enter adds a line)",
			"studio.hint": "Prompts go out verbatim · Enter generates · Esc clears",
			"studio.model": "Model",
			"studio.size": "Size",
			"studio.count": "Images",
			"studio.reference": "References",
			"studio.addReference": "Reference",
			"studio.referenceHint":
				"Drop, paste or pick local images — up to 4; or send a result below back in with “Ref”.",
			"studio.generate": "Generate",
			"studio.generating": "Generating",
			"studio.needPrompt": "Write a prompt first.",
			"studio.running": "Sent to the image model; waiting for the upstream…",
			"studio.done": "Done",
			"studio.failed": "Image generation failed",
			"studio.retry": "Retry",
			"studio.details": "Details",
			"studio.hideDetails": "Hide",
			"studio.results": "Results",
			"studio.resultsEmpty": "No images yet. Type above and press Enter.",
			"studio.useAsRef": "Ref",
			"studio.openPreview": "Open",
			"studio.copyPath": "Copy",
			"studio.copied": "Copied",
			"studio.remove": "Remove",
			"studio.clear": "Clear",
			"studio.clearConfirm": "Click again to clear",
			"studio.noRemote": "This deployment has no command channel, so the studio cannot run.",
			"studio.routeMissing": "The image service is not loaded yet — restart DSH once to enable it.",
			"studio.unknownCommand": "The command was not admitted (/image may be unloaded).",
			"studio.tooManyRefs": "At most 4 reference images.",
			"studio.unsupported": "Reference images must be PNG, JPEG, WebP or GIF.",
			"studio.readingReference": "Reading the reference image…",
			"studio.editMode": "With references · image to image",
			"studio.generateMode": "Text to image",
			"studio.openTooltip": "Switch to the Image view: talk to the image model directly",
			"studio.elapsed": "elapsed",
			"studio.examples": "Try one",
			"studio.example1": "Cyberpunk cat, neon magenta and cyan, night city",
			"studio.example2": "Minimal line-art logo, a whale, pure white",
			"studio.example3": "Watercolour landscape, lake at dusk, distant hills",
			"studio.refsOf": "References",
			"studio.ref1": "#1",
			"studio.ref2": "#2",
			"studio.ref3": "#3",
			"studio.ref4": "#4",
			"studio.orderHint": "Order is 图一 → 图二: the references are sent in exactly this order.",
			"studio.moveLeft": "Move earlier",
			"studio.moveRight": "Move later",
			"studio.skipped": "{n} reference image(s) skipped — only PNG, JPEG, WebP and GIF are accepted.",
			"studio.refCount": "{n} reference image(s)",
			"studio.prev": "Previous",
			"studio.next": "Next",
			"studio.close": "Close",
			"studio.browseHint": "Click any image to enlarge, ←/→ to browse, Esc to close.",
			"studio.willSend": "Will send",
			"studio.promptLabel": "Prompt",
		};

		/* ─────────────────────────── 样式 ─────────────────────────── */

		/** 只用 currentColor 派生的颜色，浅色/深色主题都跟着走。 */
		const CSS = `
/* ── 生图台 ─────────────────────────────────────────────────────────── */
.ig2 { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 28px; box-sizing: border-box; font-size: 12.5px; line-height: 1.55; color-scheme: light dark; }
.ig2-bar { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  background: color-mix(in srgb, currentColor 3.5%, transparent); }
.ig2-bar[data-busy] { border-color: color-mix(in srgb, currentColor 26%, transparent); }
.ig2-prompt { font: inherit; font-size: 12.5px; line-height: 1.6; color: inherit; background: transparent;
  border: none; outline: none; resize: none; width: 100%; min-height: 66px; max-height: 220px; padding: 0; }
.ig2-prompt::placeholder { color: inherit; opacity: .35; }
.ig2-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ig2-grow { flex: 1; min-width: 0; }
.ig2-pill { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px;
  font: inherit; font-size: 11.5px; color: inherit; background: color-mix(in srgb, currentColor 5%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 999px;
  cursor: pointer; white-space: nowrap; max-width: 100%; }
.ig2-pill:hover { border-color: color-mix(in srgb, currentColor 34%, transparent); }
.ig2-pill[data-on] { border-color: color-mix(in srgb, currentColor 48%, transparent); background: color-mix(in srgb, currentColor 12%, transparent); font-weight: 600; }
.ig2-pill:disabled { opacity: .4; cursor: default; }
.ig2-select { appearance: none; -webkit-appearance: none; height: 26px; padding: 0 22px 0 9px; font: inherit;
  font-size: 11.5px; color: inherit; cursor: pointer; max-width: 168px; text-overflow: ellipsis;
  background: color-mix(in srgb, currentColor 5%, transparent)
    url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E")
    no-repeat right 7px center;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 999px; outline: none; }
.ig2-select:focus-visible { border-color: color-mix(in srgb, currentColor 46%, transparent); }
.ig2-stepper { display: inline-flex; align-items: center; height: 26px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 999px; overflow: hidden; }
.ig2-stepper button { width: 24px; height: 24px; padding: 0; font: inherit; font-size: 13px; line-height: 1; color: inherit;
  background: transparent; border: none; cursor: pointer; opacity: .7; }
.ig2-stepper button:hover:not(:disabled) { opacity: 1; background: color-mix(in srgb, currentColor 9%, transparent); }
.ig2-stepper button:disabled { opacity: .25; cursor: default; }
.ig2-stepper span { min-width: 18px; text-align: center; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.ig2-send { height: 28px; padding: 0 16px; font: inherit; font-size: 12.5px; font-weight: 600; color: inherit;
  background: color-mix(in srgb, currentColor 16%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 40%, transparent); border-radius: 999px; cursor: pointer; }
.ig2-send:hover:not(:disabled) { background: color-mix(in srgb, currentColor 24%, transparent); }
.ig2-send:disabled { opacity: .45; cursor: default; }
.ig2-hint { font-size: 11px; line-height: 1.5; opacity: .45; overflow-wrap: anywhere; }
.ig2-status { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 9px; font-size: 11.5px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent); background: color-mix(in srgb, currentColor 4%, transparent); }
.ig2-status[data-error] { border-color: color-mix(in srgb, #e5484d 45%, transparent); background: color-mix(in srgb, #e5484d 9%, transparent); }
.ig2-statusText { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
.ig2-statusText[data-long] { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.ig2-linkBtn { font: inherit; font-size: 11.5px; color: inherit; background: none; border: none; padding: 0 2px;
  cursor: pointer; opacity: .7; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
.ig2-linkBtn:hover { opacity: 1; }
.ig2-refs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ig2-ref { position: relative; width: 52px; height: 52px; border-radius: 9px; overflow: hidden;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent); background: color-mix(in srgb, currentColor 6%, transparent); }
.ig2-ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ig2-refX { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; padding: 0; border: none; border-radius: 999px;
  font: 600 11px/1 system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.58); cursor: pointer; }
.ig2-refMove { position: absolute; left: 2px; top: 2px; display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
.ig2-ref:hover .ig2-refMove, .ig2-ref:focus-within .ig2-refMove { opacity: 1; }
.ig2-refMove button { width: 15px; height: 15px; padding: 0; border: none; border-radius: 4px;
  font: 600 9px/15px system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.62); cursor: pointer; }
.ig2-refNo { position: absolute; left: 2px; bottom: 2px; padding: 0 5px; height: 15px; border-radius: 999px;
  font: 600 9.5px/15px system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.62); }
.ig2-refAdd { width: 52px; height: 52px; border-radius: 9px; font: inherit; font-size: 11px; color: inherit;
  background: transparent; border: 1px dashed color-mix(in srgb, currentColor 30%, transparent); cursor: pointer; opacity: .75; }
.ig2-refAdd:hover { opacity: 1; border-color: color-mix(in srgb, currentColor 52%, transparent); }
.ig2-drop { outline: 2px dashed color-mix(in srgb, currentColor 42%, transparent); outline-offset: 4px; border-radius: 12px; }
.ig2-secHead { display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 11px; font-weight: 600; opacity: .55; }
.ig2-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ig2-tile { position: relative; border-radius: 10px; overflow: hidden; cursor: zoom-in;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent); background: color-mix(in srgb, currentColor 5%, transparent); aspect-ratio: 1 / 1; }
.ig2-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ig2-tileEmpty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: .35; font-size: 11px; }
.ig2-tileMeta { position: absolute; inset: auto 0 0 0; padding: 12px 6px 4px; font-size: 10px; color: #fff;
  background: linear-gradient(to top, rgba(0,0,0,.62), transparent); display: flex; gap: 5px; opacity: 0; transition: opacity .12s; }
.ig2-tile:hover .ig2-tileMeta, .ig2-tile:focus-within .ig2-tileMeta { opacity: 1; }
.ig2-tileMeta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ig2-tileActions { position: absolute; inset: 4px 4px auto auto; display: flex; gap: 4px; opacity: 0; transition: opacity .12s; }
.ig2-tile:hover .ig2-tileActions, .ig2-tile:focus-within .ig2-tileActions { opacity: 1; }
.ig2-tileActions button { height: 22px; padding: 0 7px; font: inherit; font-size: 10.5px; color: #fff;
  background: rgba(0,0,0,.56); border: none; border-radius: 6px; cursor: pointer; backdrop-filter: blur(2px); }
.ig2-tileActions button:hover { background: rgba(0,0,0,.78); }
.ig2-empty { display: flex; flex-direction: column; gap: 8px; padding: 6px 0 2px; }
.ig2-examples { display: flex; flex-wrap: wrap; gap: 6px; }
.ig2-example { font: inherit; font-size: 11px; color: inherit; background: transparent; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 999px; padding: 3px 9px; opacity: .7; }
.ig2-example:hover { opacity: 1; border-color: color-mix(in srgb, currentColor 38%, transparent); }

/* 灯箱：点成图就地放大，←/→ 翻页，Esc 关闭 */
.ig2-lightbox { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
  gap: 12px; padding: 28px; box-sizing: border-box;
  background: color-mix(in srgb, #000 72%, transparent); backdrop-filter: blur(3px); }
.ig2-lbFigure { display: flex; flex-direction: column; gap: 8px; max-width: min(92vw, 1100px); max-height: 92vh;
  margin: 0; color: #fff; }
.ig2-lbImage { max-width: 100%; max-height: 74vh; object-fit: contain; border-radius: 10px;
  background: rgba(255,255,255,.04); box-shadow: 0 18px 60px rgba(0,0,0,.45); }
.ig2-lbMeta { font-size: 11.5px; opacity: .72; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ig2-lbPrompt { margin: 0; font: inherit; font-size: 12px; line-height: 1.6; opacity: .82;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 4.8em; overflow-y: auto; }
.ig2-lbNav, .ig2-lbClose { flex: none; width: 38px; height: 38px; border-radius: 999px; cursor: pointer;
  font: 400 20px/1 system-ui, sans-serif; color: #fff; border: 1px solid rgba(255,255,255,.28);
  background: rgba(0,0,0,.35); }
.ig2-lbNav:hover, .ig2-lbClose:hover { background: rgba(0,0,0,.6); border-color: rgba(255,255,255,.5); }
.ig2-lbClose { position: absolute; top: 16px; right: 16px; }
.ig2-lbCount { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
  font-size: 11.5px; color: #fff; opacity: .7; }

/* ── 设置页 ─────────────────────────────────────────────────────────── */
.igWrap { display: flex; flex-direction: column; gap: 20px; padding: 4px 0 40px; max-width: 720px; color-scheme: light dark; }
.igHead { display: flex; flex-direction: column; gap: 5px; }
.igTitle { font-size: 15px; font-weight: 600; margin: 0; }
.igDesc { font-size: 12.5px; line-height: 1.7; opacity: .68; margin: 0; }
.igBlock { display: flex; flex-direction: column; gap: 9px; }
.igBlockTitle { font-size: 13px; font-weight: 600; margin: 0; display: flex; align-items: baseline; gap: 8px; }
.igCount { font-size: 11.5px; font-weight: 400; opacity: .5; }
.igList { display: flex; flex-direction: column; gap: 5px; }
.igRow { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
.igRowDefault { border-color: color-mix(in srgb, currentColor 32%, transparent); }
.igName { flex: 1; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.igBadge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); opacity: .8; }
.igBtn { font: inherit; font-size: 12px; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 26%, transparent);
  border-radius: 7px; padding: 3px 9px; cursor: pointer; white-space: nowrap; opacity: .85; }
.igBtn:hover:not(:disabled) { opacity: 1; border-color: color-mix(in srgb, currentColor 45%, transparent); background: color-mix(in srgb, currentColor 7%, transparent); }
.igBtn:disabled { opacity: .3; cursor: default; }
.igInput { font: inherit; font-size: 12.5px; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 7px; padding: 5px 9px; min-width: 0; width: 100%; box-sizing: border-box; }
.igInput:focus { outline: none; border-color: color-mix(in srgb, currentColor 48%, transparent); background: color-mix(in srgb, currentColor 4%, transparent); }
.igField { display: flex; flex-direction: column; gap: 4px; }
.igLabel { font-size: 12.5px; font-weight: 500; }
.igHint { font-size: 11.5px; line-height: 1.6; opacity: .55; }
.igWarn { font-size: 11.5px; line-height: 1.6; color: #e5484d; }
.igEmpty { font-size: 12px; opacity: .5; padding: 2px 0; }
.igGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }

/* ── 命令卡片 ───────────────────────────────────────────────────────── */
.igCmd { display: flex; flex-direction: column; gap: 8px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 10px; padding: 9px 11px; margin: 2px 0; font-size: 12.5px; line-height: 1.6; }
.igCmdHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.igCmdBadge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 28%, transparent); }
.igCmdMeta { opacity: .62; overflow-wrap: anywhere; }
.igCmdSpacer { flex: 1; min-width: 0; }
.igCmdPrompt { display: block; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: 7px 9px; border-radius: 8px;
  background: color-mix(in srgb, currentColor 6%, transparent); font-family: inherit; }
.igCmdLabel { font-size: 11.5px; opacity: .55; }
.igCmdFiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 6px; }
.igCmdFile { display: flex; flex-direction: column; gap: 4px; }
.igThumb { width: 100%; aspect-ratio: 1/1; object-fit: cover; border-radius: 7px; border: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.igCmdPath { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; opacity: .6; overflow-wrap: anywhere; }
.igCmdBody { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.igCmdBody[data-error] { color: #e5484d; }

/* ── 输入框旁边的按钮 ───────────────────────────────────────────────── */
.igComposerBtn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none; padding: 0;
  font: inherit; color: inherit; background: transparent; border: none; border-radius: 7px; cursor: pointer; opacity: .62; }
.igComposerBtn:hover { opacity: 1; background: color-mix(in srgb, currentColor 9%, transparent); }

/* ══ 会话视图：生图 ══════════════════════════════════════════════════
   它是 conversation.view 的一页（和「对话」并列、会话作用域），占满会话正文区，
   所以这里比右栏那份放宽：更大的正文、更松的间距、更明确的层级。 */

.ig2-page { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; padding: 18px 24px 0;
  display: flex; flex-direction: column; gap: 12px; font-size: 13.5px; line-height: 1.68; }
.ig2-pageInner { width: 100%; max-width: 1040px; margin: 0 auto; min-height: 100%;
  display: flex; flex-direction: column; gap: 12px; }
/* 生图视图里不要默认对话输入框（它自己的 dock 就是输入区）。
   只藏 chain 的 fallback（默认输入条）——审批/提问是同一 chain 的**当选**内容，
   不能被一起藏掉，否则工具调用会卡在没人看见的确认框上。 */
[data-conversation-content][data-image-studio="on"]
  [data-chain-overlay-fallback="conversation.composer"] { display: none !important; }
/* 成图区滚动；输入区（bar / 状态 / 参考图）按 order 钉在下方。 */
.ig2-stream { order: 1; display: flex; flex-direction: column; gap: 10px; }
/* 输入区常驻底部：图在上面翻，提示词框永远在手边。 */
.ig2-dock { order: 2; position: sticky; bottom: 0; z-index: 3; display: flex; flex-direction: column; gap: 8px;
  padding: 10px 0 8px; margin-top: auto;
  background: var(--dsw-alias-bg-base, Canvas);
  border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.ig2-foot { order: 3; padding-bottom: 6px; }

/* 页头：标题 + 一句话说明 */
.ig2-head { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; flex: none;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.ig2-headTitle { margin: 0; font-size: 17px; line-height: 1.3; font-weight: 650; letter-spacing: -.01em; }
.ig2-headDesc { margin: 0; font-size: 13px; line-height: 1.65; opacity: .62; max-width: 68ch; }
.ig2-headRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ig2-headLabel { font-size: 12.5px; opacity: .55; }
.ig2-headSpacer { flex: 1; min-width: 0; }

/* 会话缺失时的提示条 */
.ig2-notice { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px; border-radius: 12px;
  font-size: 13px; line-height: 1.6;
  border: 1px solid color-mix(in srgb, #e5a13a 45%, transparent);
  background: color-mix(in srgb, #e5a13a 10%, transparent); }

/* 页面里的输入区：比右栏版更大、更好读 */
.ig2-page .ig2 { padding: 0; gap: 14px; font-size: 13.5px; line-height: 1.68; flex: 1; min-height: 0; }
.ig2-page .ig2-bar { padding: 14px 16px; border-radius: 14px; gap: 12px;
  border-width: 1px; border-color: color-mix(in srgb, currentColor 18%, transparent);
  background: color-mix(in srgb, currentColor 3%, transparent); }
.ig2-page .ig2-prompt { font-size: 14.5px; line-height: 1.7; min-height: 92px; }
.ig2-page .ig2-prompt::placeholder { opacity: .42; }
.ig2-page .ig2-pill, .ig2-page .ig2-select { height: 30px; font-size: 12.5px; }
.ig2-page .ig2-stepper { height: 30px; }
.ig2-page .ig2-stepper button { width: 28px; height: 28px; }
.ig2-page .ig2-send { height: 34px; padding: 0 20px; font-size: 13.5px; }
.ig2-page .ig2-status { padding: 10px 12px; font-size: 12.5px; border-radius: 10px; }
.ig2-page .ig2-secHead { font-size: 13px; font-weight: 600; letter-spacing: .01em; opacity: .82; padding-top: 4px; }
.ig2-page .ig2-grid { gap: 14px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
.ig2-page .ig2-tile { border-radius: 12px; }
.ig2-page .ig2-tileMeta { font-size: 11.5px; opacity: .62; }
.ig2-page .ig2-hint { font-size: 12px; line-height: 1.6; opacity: .5; }
.ig2-page .ig2-empty { padding: 26px 20px; border-radius: 12px;
  border: 1px dashed color-mix(in srgb, currentColor 18%, transparent);
  background: color-mix(in srgb, currentColor 2%, transparent); }
.ig2-page .ig2-example { font-size: 12.5px; padding: 8px 12px; }

/* 键盘可达：整页统一焦点环 */
.ig2-page :is(button, select, textarea, article):focus-visible {
  outline: 2px solid color-mix(in srgb, currentColor 52%, transparent);
  outline-offset: 2px; border-radius: 8px; }

/* 窄窗口：收紧外留白，别把内容挤成一条 */
@media (max-width: 760px) {
  .ig2-page { padding: 18px 14px 40px; gap: 14px; }
  .ig2-pageInner { gap: 14px; }
  .ig2-headTitle { font-size: 18px; }
}
`;

		/* ─────────────────────────── 小工具 ─────────────────────────── */

		/** 取一个客户端服务；服务可能比插件晚挂载，取不到就当没有。 */
		function serviceOf(ctx, name) {
			try {
				if (typeof ctx.get === "function") return ctx.get(name);
				return ctx[name];
			} catch {
				return undefined;
			}
		}

		/** 图片地址：走宿主自己的文件路由，绝对路径也能预览。 */
		function previewUrl(path) {
			if (typeof path !== "string" || path.length === 0) return undefined;
			if (typeof document === "undefined") return undefined;
			try {
				return new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI).href;
			} catch {
				return undefined;
			}
		}

		/** `dsh-resource://file/session/<id>/<相对路径>` —— 侧边栏文档预览认的地址。 */
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}

		function fileAddress(sessionId, relPath) {
			const normalized = String(relPath).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
			return (
				`dsh-resource://file/session/${encodeSegment(sessionId)}/` +
				normalized.split("/").map(encodeSegment).join("/")
			);
		}

		/**
		 * 从命令结果文本里取出哨兵 JSON。
		 *
		 * 命令结果只有一段纯文本通道（`command/done` 的 `text`），结构化字段由 Host
		 * 追加的一行 `@@image-gen {...}` 承载。解析不到就当「不认识的结果」原样显示。
		 */
		function parseSentinelText(text) {
			const value = typeof text === "string" ? text : "";
			const at = value.lastIndexOf(RESULT_SENTINEL);
			if (at === -1) return { data: undefined, text: value };
			const end = value.indexOf("\n", at);
			const line = value.slice(at + RESULT_SENTINEL.length, end === -1 ? undefined : end);
			let data;
			try {
				data = JSON.parse(line);
			} catch {
				data = undefined;
			}
			const shaped = data !== null && typeof data === "object" && data.v === 1 ? data : undefined;
			return { data: shaped, text: value.slice(0, at).replace(/\s+$/, "") };
		}

		/** 含空白的参数用双引号括起来（Host 的旗标解析认 `"…"` / `'…'` / 裸词）。 */
		function quoteCommandArg(value) {
			const text = String(value ?? "");
			if (text.length > 0 && !/[\s"']/.test(text)) return text;
			return `"${text.replace(/"/g, "")}"`;
		}

		/**
		 * 拼出 `/image` 命令行。
		 *
		 * 这是**唯一**需要懂命令语法的客户端代码；`tools/verify.mjs` 拿它拼出来的线
		 * 去跑真实的 Host 命令处理器，保证「面板里敲的字 = 上游收到的字」。
		 * 结尾那个裸 `--` 是护栏：提示词第一句就是 `--model` 也不会被当成旗标。
		 */
		function buildImageCommandLine(options) {
			const parts = ["/image"];
			if (typeof options?.model === "string" && options.model.length > 0) {
				parts.push("--model", quoteCommandArg(options.model));
			}
			if (typeof options?.size === "string" && options.size.length > 0) {
				parts.push("--size", quoteCommandArg(options.size));
			}
			if (Number.isInteger(options?.n) && options.n > 1) parts.push("--n", String(options.n));
			if (typeof options?.name === "string" && options.name.length > 0) {
				parts.push("--name", quoteCommandArg(options.name));
			}
			for (const ref of Array.isArray(options?.refs) ? options.refs : []) {
				if (typeof ref === "string" && ref.trim().length > 0) {
					parts.push("--ref", quoteCommandArg(ref.trim()));
				}
			}
			parts.push("--");
			return `${parts.join(" ")} ${String(options?.prompt ?? "").trim()}`;
		}

		/** 本地文件 → base64 图片块（命令附件走 wire 的 `{type:"image"}` 形状）。 */
		function readImageFile(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = typeof reader.result === "string" ? reader.result : "";
					const comma = result.indexOf(",");
					resolve({
						data: comma === -1 ? "" : result.slice(comma + 1),
						mediaType:
							typeof file.type === "string" && file.type.startsWith("image/")
								? file.type
								: "image/png",
						name: typeof file.name === "string" ? file.name : undefined,
					});
				};
				reader.onerror = () => reject(reader.error ?? new Error("read failed"));
				reader.readAsDataURL(file);
			});
		}

		/** 按魔数认类型（生成物是 .png，但参考图也可能是盘上的 jpg/webp）。 */
		function sniffMediaType(bytes) {
			if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
			if (
				bytes.length >= 12 &&
				bytes[8] === 0x57 &&
				bytes[9] === 0x45 &&
				bytes[10] === 0x42 &&
				bytes[11] === 0x50
			) {
				return "image/webp";
			}
			if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
				return "image/gif";
			}
			return "image/png";
		}

		/**
		 * 把一张成图读成参考图字节。
		 *
		 * 「成图 → 参考」走这条：经生图台自己的文件路由取回字节，再塞进请求体。
		 */
		async function readImagePath(path) {
			const url = studioImageUrl(path);
			if (url === undefined) throw new Error("cannot address the file");
			const response = await fetch(url, { credentials: "same-origin" });
			if (response?.ok !== true) throw new Error(`HTTP ${response?.status ?? "?"}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			let binary = "";
			const chunk = 0x8000;
			for (let index = 0; index < bytes.length; index += chunk) {
				binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
			}
			return { data: btoa(binary), mediaType: sniffMediaType(bytes) };
		}

		function refKey(prefix) {
			return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		}

		/** 尺寸值 → 「竖版 2:3」这种给人看的标签。 */
		function sizeLabel(value, locale) {
			const known = SIZE_OPTIONS.find((option) => option.value === value);
			if (known !== undefined) return locale === "en" ? known.en : known.zh;
			return String(value ?? "");
		}

		function sizeRatio(value) {
			const known = SIZE_OPTIONS.find((option) => option.value === value);
			return known === undefined ? String(value ?? "") : known.ratio;
		}

		function clockOf(at) {
			try {
				return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			} catch {
				return "";
			}
		}

		/* ───────────────── 生图台的共享状态（全局一份） ───────────────── */

		/**
		 * 生图台不是「每个会话一份」，而是一个**共用的工作台**：
		 *
		 *   - 成图、提示词、参数、参考图、进行中的任务都放在这个模块级 store 里；
		 *   - 组件只是它的一张脸：切走/切回来（卸载 → 重挂载）什么都不丢，
		 *     正在跑的那次请求也继续跑 —— 回来就能看到计时和结果。
		 *
		 * 以前这些状态挂在组件内部：一离开页面，计时停了、`busy` 没了，
		 * 请求完成时组件已卸载，新图也就不会进成图墙。
		 */
		const STUDIO_STORE_KEY = "dsh-image-gen.studio.v2";
		const STUDIO_FILE_ROUTE = "image-gen/file";

		/** 同源 URL（相对应用根）。 */
		function studioUrl(path) {
			if (typeof document === "undefined") return undefined;
			try {
				return new URL(path, document.baseURI).href;
			} catch {
				return undefined;
			}
		}

		/** 成图的读图地址：走宿主自己的文件路由（只允许生图目录内的文件）。 */
		function studioImageUrl(filePath) {
			if (typeof filePath !== "string" || filePath.length === 0) return undefined;
			return studioUrl(`${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(filePath)}`);
		}

		const EMPTY_STUDIO_STATE = () => ({
			items: [],
			refs: [],
			job: null,
			draft: { prompt: "", model: null, size: null, count: 1 },
		});

		function loadStudioSnapshot() {
			const empty = EMPTY_STUDIO_STATE();
			try {
				if (typeof localStorage === "undefined") return empty;
				const raw = localStorage.getItem(STUDIO_STORE_KEY);
				if (raw === null) return empty;
				const parsed = JSON.parse(raw);
				const items = Array.isArray(parsed?.items)
					? parsed.items.filter(
							(entry) =>
								entry !== null &&
								typeof entry === "object" &&
								entry.data !== undefined &&
								Array.isArray(entry.data?.files),
						)
					: [];
				const draft = parsed?.draft ?? {};
				return {
					items: items.slice(0, GALLERY_LIMIT),
					refs: [],
					job: null,
					draft: {
						prompt: typeof draft.prompt === "string" ? draft.prompt : "",
						model: typeof draft.model === "string" ? draft.model : null,
						size: typeof draft.size === "string" ? draft.size : null,
						count: Number.isInteger(draft.count) && draft.count >= 1 ? draft.count : 1,
					},
				};
			} catch {
				return empty;
			}
		}

		function createStudioStore() {
			let state = loadStudioSnapshot();
			const listeners = new Set();

			const save = () => {
				try {
					if (typeof localStorage === "undefined") return;
					localStorage.setItem(
						STUDIO_STORE_KEY,
						JSON.stringify({
							v: 2,
							items: state.items.slice(0, GALLERY_LIMIT),
							draft: state.draft,
						}),
					);
				} catch {
					/* 配额满了 / 隐私模式：不写就行，界面照常用。 */
				}
			};

			const set = (patch) => {
				state = { ...state, ...patch };
				save();
				for (const listener of [...listeners]) listener();
			};

			/** 面板请求：同源路由，结果只回这里，不碰会话日志。 */
			const post = async (payload) => {
				const endpoint = studioUrl(STUDIO_ROUTE);
				if (endpoint === undefined) {
					const error = new Error("studio route unavailable");
					error.code = "route-missing";
					throw error;
				}
				const response = await fetch(endpoint, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				});
				if (response?.ok !== true) {
					const status = response?.status ?? "?";
					const error = new Error(`HTTP ${status}`);
					error.code = status === 404 || status === 405 ? "route-missing" : "http";
					throw error;
				}
				const result = await response.json();
				if (result?.ok !== true) throw new Error(String(result?.error ?? "image request failed"));
				return result;
			};

			/**
			 * 起一次生图任务。
			 *
			 * 关键点：**任务生命周期在 store 里**，不在组件里 —— 组件卸载了它照跑，
			 * 完成后照样把成品推进成图墙；回来时看到的是「计时还在走」或「图好了」。
			 */
			const startJob = async (request) => {
				if (state.job?.status === "running") return;
				const job = {
					id: refKey("job"),
					startedAt: Date.now(),
					status: "running",
					prompt: request.prompt,
					model: request.model,
					size: request.size,
					count: request.n,
				};
				set({ job });
				try {
					const result = await post({
						prompt: request.prompt,
						model: request.model,
						size: request.size,
						n: request.n,
						references: Array.isArray(request.references) ? request.references : [],
					});
					const data = {
						prompt: result.prompt,
						model: result.model,
						size: result.size,
						mode: result.mode,
						references: result.references,
						files: Array.isArray(result.files) ? result.files : [],
					};
					set({
						items: [{ id: refKey("out"), at: Date.now(), data }, ...state.items].slice(0, GALLERY_LIMIT),
						job: { ...job, status: "done", finishedAt: Date.now(), references: data.references },
					});
				} catch (error) {
					set({
						job: {
							...job,
							status: "error",
							error: error instanceof Error ? error.message : String(error),
							code: error?.code,
							finishedAt: Date.now(),
						},
					});
				}
			};

			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				patchDraft: (patch) => set({ draft: { ...state.draft, ...patch } }),
				setRefs: (next) => set({ refs: typeof next === "function" ? next(state.refs) : next }),
				startJob,
				clearItems: () => set({ items: [] }),
				/** 只给自检用：把 store 恢复成冷启动状态。 */
				reset: () => {
					state = EMPTY_STUDIO_STATE();
					save();
					for (const listener of [...listeners]) listener();
				},
			};
		}

		const studioStore = createStudioStore();

		/* ─────────────────────── 生图台的选项 store ─────────────────────── */

		/**
		 * 模型清单 / 默认尺寸 / 张数上限 —— 数据源就是「设置 → 生图」那张表。
		 *
		 * 包装成依赖注入的 store（`getSnapshot` 引用稳定），组件用
		 * `useSyncExternalStore` 订阅：设置页里加的模型，面板立刻能选。
		 */
		function createStudioOptions(ctx) {
			const fallback = {
				models: DEFAULT_MODELS.slice(),
				model: DEFAULT_MODELS[1] ?? DEFAULT_MODELS[0],
				defaultSize: "1024x1024",
				maxImages: MAX_REFS,
			};
			let current = fallback;
			const listeners = new Set();

			const sameAs = (next) =>
				next.model === current.model &&
				next.defaultSize === current.defaultSize &&
				next.maxImages === current.maxImages &&
				next.models.join("\u0000") === current.models.join("\u0000");

			const publish = (next) => {
				if (sameAs(next)) return;
				current = next;
				for (const listener of [...listeners]) listener();
			};

			let controller;
			const read = () => {
				if (controller === undefined) return;
				const snapshot = controller.getSnapshot?.();
				const value = snapshot?.value ?? {};
				const declared = Array.isArray(value.models)
					? value.models.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
					: [];
				const models = declared.length > 0 ? declared : DEFAULT_MODELS.slice();
				publish({
					models,
					model: typeof value.model === "string" && value.model.length > 0 ? value.model : models[0],
					defaultSize:
						typeof value.defaultSize === "string" && value.defaultSize.length > 0
							? value.defaultSize
							: "1024x1024",
					maxImages:
						Number.isFinite(value.maxImages) && value.maxImages >= 1
							? Math.floor(value.maxImages)
							: MAX_REFS,
				});
			};

			if (typeof ctx.configForms?.whileServed === "function") {
				ctx.effect(
					() =>
						ctx.configForms.whileServed([NS], () => {
							controller = ctx.configForms.get(NS);
							read();
							const off =
								typeof controller?.subscribe === "function" ? controller.subscribe(read) : undefined;
							return () => {
								if (typeof off === "function") off();
								controller = undefined;
							};
						}),
					"image-gen: studio options",
				);
			}

			return {
				getSnapshot: () => current,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
		}

		/* ─────────────────────────── 图标 ─────────────────────────── */

		/** 画框 + 山线 + 太阳点；内联、跟随 currentColor。 */
		function StudioGlyph({ size = 16, className }) {
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					className,
				},
				h("rect", {
					x: 2.1,
					y: 2.6,
					width: 11.8,
					height: 10.8,
					rx: 2.2,
					stroke: "currentColor",
					strokeWidth: 1.3,
				}),
				h("path", {
					d: "M4.5 11.2l3-3.7 2.2 2.5 1.2-1.4 1.8 2.6",
					stroke: "currentColor",
					strokeWidth: 1.3,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
				h("circle", { cx: 10.9, cy: 5.9, r: 1.05, fill: "currentColor" }),
			);
		}

		/* ────────────────────────── 生图台 ────────────────────────── */

		/** 成图瓦片：图片、悬停操作、元信息。点整块 = 在右栏预览。 */
		function ResultTile({ item, t, locale, onUseAsRef, onOpen, onCopy, copied }) {
			const files = Array.isArray(item?.data?.files) ? item.data.files : [];
			const file = files[0];
			const url = studioImageUrl(file?.path);
			const label = `${String(item?.data?.model ?? "")} · ${sizeRatio(item?.data?.size)} · ${clockOf(item?.at)}`;
			return h(
				"article",
				{
					className: "ig2-tile",
					title: String(item?.data?.prompt ?? ""),
					tabIndex: 0,
					onClick: () => onOpen?.(),
					onKeyDown: (event) => {
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						onOpen?.();
					},
				},
				url === undefined
					? h("div", { className: "ig2-tileEmpty" }, "…")
					: h("img", { src: url, alt: "", loading: "lazy", draggable: false }),
				h(
					"div",
					{ className: "ig2-tileActions" },
					h(
						"button",
						{
							type: "button",
							onClick: (event) => {
								event.stopPropagation();
								onUseAsRef(file?.path);
							},
						},
						t("studio.useAsRef"),
					),
					h(
						"button",
						{
							type: "button",
							onClick: (event) => {
								event.stopPropagation();
								onCopy(file?.path);
							},
						},
						copied ? t("studio.copied") : t("studio.copyPath"),
					),
				),
				h("div", { className: "ig2-tileMeta" }, h("span", null, label)),
			);
		}

		/**
		 * 生图台正文。
		 *
		 * 直接打宿主的 `/image-gen/studio` 路由：提示词原样进请求体，**没有模型参与**，
		 * 结果只回给这个面板 —— 会话日志与对话里都不会多出任何东西。
		 */
		function StudioBody(props) {
			const { options } = props;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const locale = typeof props.locale === "string" ? props.locale : undefined;

			const snapshot = React.useSyncExternalStore(options.subscribe, options.getSnapshot);
			const studio = React.useSyncExternalStore(studioStore.subscribe, studioStore.getSnapshot);
			const { items, refs, job } = studio;
			const draft = studio.draft;

			const prompt = draft.prompt;
			const model = draft.model;
			const size = draft.size;
			const count = draft.count;

			const effectiveModel =
				typeof model === "string" && snapshot.models.includes(model)
					? model
					: snapshot.models.includes(snapshot.model)
						? snapshot.model
						: snapshot.models[0];
			const effectiveSize = typeof size === "string" && size.length > 0 ? size : snapshot.defaultSize;
			const maxCount = Math.max(1, Math.min(snapshot.maxImages, 4));

			const setPrompt = (value) =>
				studioStore.patchDraft({ prompt: typeof value === "function" ? value(draft.prompt) : value });
			const setModel = (value) => studioStore.patchDraft({ model: value });
			const setSize = (value) => studioStore.patchDraft({ size: value });
			const setCount = (value) =>
				studioStore.patchDraft({ count: typeof value === "function" ? value(draft.count) : value });
			const setRefs = (next) => studioStore.setRefs(next);

			// 只影响「此刻怎么显示」的状态：离开页面就该重置，所以放在组件里。
			const [notice, setNotice] = React.useState(undefined);
			const [expanded, setExpanded] = React.useState(false);
			const [dragging, setDragging] = React.useState(false);
			const [copiedId, setCopiedId] = React.useState(undefined);
			// 灯箱：undefined = 关；数字 = 正在看哪一张（items 的索引）。
			const [lightbox, setLightbox] = React.useState(undefined);
			const [clearArmed, setClearArmed] = React.useState(false);
			const [now, setNow] = React.useState(() => Date.now());
			const fileInput = React.useRef(null);

			/** 本地校验错误（空提示词、格式不支持）沿用 setStatus 的写法，但不进 store。 */
			const setStatus = (value) => setNotice(value);

			const busy = job?.status === "running";
			const startedAt = typeof job?.startedAt === "number" ? job.startedAt : 0;
			const elapsed = busy && startedAt > 0 ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;

			// 任务进行时刷新计时；任务在 store 里，切走再回来计时接着走。
			React.useEffect(() => {
				if (!busy) return undefined;
				const timer = setInterval(() => setNow(Date.now()), 500);
				return () => clearInterval(timer);
			}, [busy]);

			const status =
				notice ??
				(job === null
					? undefined
					: job.status === "running"
						? { kind: "busy", text: t("studio.running") }
						: job.status === "error"
							? {
									kind: "error",
									text:
										job.code === "route-missing"
											? t("studio.routeMissing")
											: job.error || t("studio.failed"),
								}
							: {
									kind: "done",
									text:
										t("studio.done") +
										(Number(job.references) > 0
											? ` · ${t("studio.refCount").replace("{n}", String(job.references))}`
											: ""),
								});

			// 灯箱的键盘：←/→ 翻页、Esc 关闭（挂 window，点开就有效）。
			React.useEffect(() => {
				if (
					lightbox === undefined ||
					typeof window === "undefined" ||
					typeof window.addEventListener !== "function"
				) {
					return undefined;
				}
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						setLightbox(undefined);
						return;
					}
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					event.preventDefault();
					const delta = event.key === "ArrowLeft" ? -1 : 1;
					setLightbox((prev) =>
						prev === undefined ? prev : (prev + delta + items.length) % items.length,
					);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [lightbox, items.length]);

			const addFiles = React.useCallback(
				async (files) => {
					const all = Array.from(files ?? []).filter(
						(file) => file !== null && typeof file?.type === "string" && file.type.startsWith("image/"),
					);
					if (all.length === 0) return;
					const list = all.filter((file) => SUPPORTED_TYPES.includes(file.type));
					if (list.length === 0) {
						setStatus({ kind: "error", text: t("studio.unsupported") });
						return;
					}
					// 一批里混了不支持的格式时**必须说出来**：静默丢掉一张，用户会以为
					// 自己送了两张（「图二」于是在模型眼里不存在）。
					if (list.length < all.length) {
						setStatus({
							kind: "error",
							text: t("studio.skipped").replace("{n}", String(all.length - list.length)),
						});
					}
					const room = MAX_REFS - refs.length;
					if (room <= 0) {
						setStatus({ kind: "error", text: t("studio.tooManyRefs") });
						return;
					}
					if (list.length > room) setStatus({ kind: "error", text: t("studio.tooManyRefs") });
					const added = [];
					for (const file of list.slice(0, room)) {
						try {
							const read = await readImageFile(file);
							added.push({ key: refKey("file"), ...read });
						} catch {
							setStatus({ kind: "error", text: t("studio.failed") });
						}
					}
					if (added.length === 0) return;
					setRefs((prev) => [...prev, ...added].slice(0, MAX_REFS));
				},
				[refs.length, t],
			);

			const useAsRef = React.useCallback(
				async (path) => {
					if (typeof path !== "string" || path.length === 0) return;
					if (refs.some((entry) => entry.path === path)) return;
					if (refs.length >= MAX_REFS) {
						setStatus({ kind: "error", text: t("studio.tooManyRefs") });
						return;
					}
					setStatus({ kind: "notice", text: t("studio.readingReference") });
					try {
						const read = await readImagePath(path);
						setRefs((prev) =>
							prev.some((entry) => entry.path === path) || prev.length >= MAX_REFS
								? prev
								: [...prev, { key: refKey("ref"), path, ...read }],
						);
						setStatus(undefined);
					} catch (error) {
						setStatus({
							kind: "error",
							text: error instanceof Error ? error.message : String(error),
						});
					}
				},
				[refs, t],
			);

			const copyPath = React.useCallback((path) => {
				const write = navigator.clipboard?.writeText?.(String(path ?? ""));
				if (write === undefined) return;
				write.then(() => setCopiedId(path), () => {});
			}, []);

			/**
			 * 调整参考图顺序。
			 *
			 * 上游按部件顺序收图，用户口中的「图一/图二」也只按这个顺序成立 ——
			 * 所以顺序必须可改、可见，不能靠「我先拖了哪张」的记忆。
			 */
			const moveRef = React.useCallback((key, delta) => {
				setRefs((prev) => {
					const from = prev.findIndex((entry) => entry.key === key);
					const to = from + delta;
					if (from < 0 || to < 0 || to >= prev.length) return prev;
					const next = prev.slice();
					const [moved] = next.splice(from, 1);
					next.splice(to, 0, moved);
					return next;
				});
			}, []);

			/**
			 * 点「生成」：只把任务交给 store，然后立刻返回。
			 *
			 * 请求生命周期在 store 里，所以切换页面、切回对话、再回来，
			 * 这次生成照样在跑；完成时成品直接进成图墙。
			 */
			const run = React.useCallback(() => {
				const text = prompt.trim();
				if (busy) return;
				if (text.length === 0) {
					setNotice({ kind: "error", text: t("studio.needPrompt") });
					return;
				}
				setNotice(undefined);
				// 参考图走请求体（base64）：粘贴/拖入的文件本来只有字节，
				// 「参考」也是把盘上成图经宿主文件路由读回字节 —— 同一形状。
				const references = refs
					.filter((entry) => typeof entry.data === "string")
					.map((entry) => ({
						mediaType: entry.mediaType,
						data: entry.data,
						...(entry.name === undefined ? {} : { name: entry.name }),
					}));
				void studioStore.startJob({
					prompt: text,
					model: effectiveModel,
					size: effectiveSize,
					n: count,
					references,
				});
			}, [busy, prompt, refs, count, effectiveModel, effectiveSize, t]);

			const onKeyDown = (event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					setPrompt("");
					return;
				}
				if (event.key !== "Enter" || event.shiftKey) return;
				if (event.nativeEvent?.isComposing === true || event.isComposing === true) return;
				event.preventDefault();
				run();
			};

			const clearGallery = () => {
				if (!clearArmed) {
					setClearArmed(true);
					setTimeout(() => setClearArmed(false), 2600);
					return;
				}
				setClearArmed(false);
				studioStore.clearItems();
			};

			const modeLabel = refs.length > 0 ? t("studio.editMode") : t("studio.generateMode");

			return h(
				"section",
				{
					className: dragging ? "ig2 ig2-drop" : "ig2",
					"aria-label": t("studio.panel"),
					onDragOver: (event) => {
						if (event.dataTransfer?.types?.includes?.("Files")) {
							event.preventDefault();
							setDragging(true);
						}
					},
					onDragLeave: () => setDragging(false),
					onDrop: (event) => {
						setDragging(false);
						const files = event.dataTransfer?.files;
						if (files === undefined || files === null) return;
						event.preventDefault();
						addFiles(files);
					},
				},

				// ── 输入区（sticky 在底部：图在上面翻，输入永远在手边）──────
				h(
					"div",
					{ className: "ig2-dock" },
					h(
					"div",
					{ className: "ig2-bar", "data-busy": busy ? true : undefined },
					h("textarea", {
						className: "ig2-prompt",
						value: prompt,
						placeholder: t("studio.placeholder"),
						disabled: busy,
						rows: 3,
						onChange: (event) => setPrompt(event.target.value),
						onKeyDown,
						onPaste: (event) => {
							const items2 = event.clipboardData?.items;
							if (items2 === undefined || items2 === null) return;
							const files = [];
							for (let index = 0; index < items2.length; index += 1) {
								const entry = items2[index];
								if (entry?.kind !== "file") continue;
								const file = entry.getAsFile?.();
								if (file !== null && file !== undefined) files.push(file);
							}
							if (files.length > 0) {
								event.preventDefault();
								addFiles(files);
							}
						},
					}),
					h(
						"div",
						{ className: "ig2-row" },
						h(
							"select",
							{
								className: "ig2-select",
								value: effectiveModel ?? "",
								disabled: busy,
								title: t("studio.model"),
								"aria-label": t("studio.model"),
								onChange: (event) => setModel(event.target.value),
							},
							snapshot.models.map((id) => h("option", { key: id, value: id }, id)),
						),
						h(
							"div",
							{ className: "ig2-stepper", title: t("studio.count") },
							h(
								"button",
								{
									type: "button",
									disabled: busy || count <= 1,
									"aria-label": "-1",
									onClick: () => setCount((prev) => Math.max(1, prev - 1)),
								},
								"−",
							),
							h("span", null, String(count)),
							h(
								"button",
								{
									type: "button",
									disabled: busy || count >= maxCount,
									"aria-label": "+1",
									onClick: () => setCount((prev) => Math.min(maxCount, prev + 1)),
								},
								"+",
							),
						),
						h(
							"button",
							{
								type: "button",
								className: "ig2-pill",
								disabled: busy || refs.length >= MAX_REFS,
								title: t("studio.referenceHint"),
								onClick: () => fileInput.current?.click?.(),
							},
							`＋ ${t("studio.addReference")}`,
							refs.length > 0 ? ` ${refs.length}/${MAX_REFS}` : "",
						),
						h("span", { className: "ig2-grow" }),
						h(
							"button",
							{ type: "button", className: "ig2-send", disabled: busy, onClick: run },
							busy ? `${t("studio.generating")} ${elapsed}s` : t("studio.generate"),
						),
					),
					h(
						"div",
						{ className: "ig2-row" },
						// 尺寸：说人话的标签，比 1024x1536 好记。
						h(
							"div",
							{ className: "ig2-row", role: "group", "aria-label": t("studio.size") },
							(SIZE_OPTIONS.some((option) => option.value === effectiveSize)
								? SIZE_OPTIONS
								: [...SIZE_OPTIONS, { value: effectiveSize, zh: String(effectiveSize), en: String(effectiveSize) }]
							).map((option) =>
								h(
									"button",
									{
										key: option.value,
										type: "button",
										className: "ig2-pill",
										"data-on": option.value === effectiveSize ? true : undefined,
										disabled: busy,
										onClick: () => setSize(option.value),
									},
									locale === "en" ? option.en : option.zh,
								),
							),
						),
						h("span", { className: "ig2-grow" }),
						h("span", { className: "ig2-hint" }, modeLabel),
					),
				),

				// ── 状态条 ──────────────────────────────────────────────
				status === undefined
					? null
					: h(
							"div",
							{
								className: "ig2-status",
								"data-error": status.kind === "error" ? true : undefined,
								"aria-live": "polite",
							},
							h(
								"span",
								{
									className: "ig2-statusText",
									"data-long": status.kind === "error" && expanded ? true : undefined,
								},
								status.kind === "busy"
									? `${status.text}（${t("studio.elapsed")} ${elapsed}s）`
									: expanded || String(status.text).length <= 160
										? status.text
										: `${String(status.text).slice(0, 160)}…`,
							),
							status.kind === "busy"
								? null
								: String(status.text).length > 160
									? h(
											"button",
											{ type: "button", className: "ig2-linkBtn", onClick: () => setExpanded((prev) => !prev) },
											expanded ? t("studio.hideDetails") : t("studio.details"),
										)
									: null,
							status.kind === "error"
								? h(
										"button",
										{ type: "button", className: "ig2-linkBtn", disabled: busy, onClick: run },
										t("studio.retry"),
									)
								: null,
						),

				// ── 参考图托盘 ──────────────────────────────────────────
				refs.length === 0
					? null
					: h(
							"div",
							{ className: "ig2-refs" },
							refs.map((entry, index) =>
								h(
									"div",
									{ key: entry.key, className: "ig2-ref", title: entry.path ?? entry.name ?? "" },
									h("img", { src: `data:${entry.mediaType};base64,${entry.data}`, alt: "", draggable: false }),
									// 角标：这张是「图几」。用户写提示词时照着念就行。
									h(
										"span",
										{ className: "ig2-refNo" },
										t(index < 4 ? `studio.ref${index + 1}` : "studio.ref4"),
									),
									refs.length > 1
										? h(
												"div",
												{ className: "ig2-refMove" },
												h(
													"button",
													{
														type: "button",
														disabled: index === 0,
														title: t("studio.moveLeft"),
														"aria-label": t("studio.moveLeft"),
														onClick: () => moveRef(entry.key, -1),
													},
													"‹",
												),
												h(
													"button",
													{
														type: "button",
														disabled: index === refs.length - 1,
														title: t("studio.moveRight"),
														"aria-label": t("studio.moveRight"),
														onClick: () => moveRef(entry.key, 1),
													},
													"›",
												),
											)
										: null,
									h(
										"button",
										{
											type: "button",
											className: "ig2-refX",
											title: t("studio.remove"),
											"aria-label": t("studio.remove"),
											onClick: () => setRefs((prev) => prev.filter((candidate) => candidate.key !== entry.key)),
										},
										"×",
									),
								),
							),
							refs.length >= MAX_REFS
								? null
								: h(
										"button",
										{
											type: "button",
											className: "ig2-refAdd",
											disabled: busy,
											onClick: () => fileInput.current?.click?.(),
										},
										`＋`,
									),
							refs.length > 1
								? h("span", { className: "ig2-hint", style: { flexBasis: "100%", margin: 0 } }, t("studio.orderHint"))
								: null,
						),
				h("input", {
					ref: fileInput,
					type: "file",
					accept: "image/png,image/jpeg,image/webp,image/gif",
					multiple: true,
					style: { display: "none" },
					onChange: (event) => {
						addFiles(event.target.files);
						event.target.value = "";
					},
				}),

				),

				// ── 成图墙（跟着页面滚；输入区 sticky 在底部）──────────────
				h(
					"div",
					{ className: "ig2-stream" },
					h(
					"div",
					{ className: "ig2-secHead" },
					`${t("studio.results")}${items.length > 0 ? ` · ${items.length}` : ""}`,
					h("span", { className: "ig2-grow" }),
					items.length > 0
						? h(
								"button",
								{ type: "button", className: "ig2-linkBtn", onClick: clearGallery },
								clearArmed ? t("studio.clearConfirm") : t("studio.clear"),
							)
						: null,
				),
				items.length === 0
					? h(
							"div",
							{ className: "ig2-empty" },
							h("p", { className: "ig2-hint", style: { margin: 0 } }, t("studio.resultsEmpty")),
							h(
								"div",
								{ className: "ig2-examples" },
								[1, 2, 3].map((index) =>
									h(
										"button",
										{
											key: index,
											type: "button",
											className: "ig2-example",
											onClick: () => setPrompt(t(`studio.example${index}`)),
										},
										t(`studio.example${index}`),
									),
								),
							),
						)
					: h(
							"div",
							{ className: "ig2-grid" },
							items.map((item, index) =>
								h(ResultTile, {
									key: item.id,
									item,
									t,
									locale,
									copied: copiedId === item?.data?.files?.[0]?.path,
									onUseAsRef: useAsRef,
									onCopy: copyPath,
									onOpen: () => setLightbox(index),
								}),
							),
						),
				),

				h(
					"p",
					{ className: "ig2-hint ig2-foot", style: { margin: "2px 0 0" } },
					items.length > 0 ? `${t("studio.hint")} · ${t("studio.browseHint")}` : t("studio.hint"),
				),
				lightbox === undefined || items[lightbox] === undefined
					? null
					: h(Lightbox, {
							item: items[lightbox],
							index: lightbox,
							total: items.length,
							t,
							onClose: () => setLightbox(undefined),
							onStep: (delta) =>
								setLightbox((prev) =>
									prev === undefined ? prev : (prev + delta + items.length) % items.length,
								),
							onUseAsRef: (target) => {
								addPathRef(target);
								setLightbox(undefined);
							},
						}),
			);
		}

		/**
		 * 灯箱：就地放大 + 翻页。
		 *
		 * 「生成的图直接在那边翻阅查看」靠它 —— 不去右栏、不切视图：点一张放大，
		 * ←/→ 翻，Esc 关；顺手能「参考」这张继续改。
		 */
		function Lightbox({ item, index, total, t, onClose, onStep, onUseAsRef }) {
			const files = Array.isArray(item?.data?.files) ? item.data.files : [];
			const filePath = files[0]?.path;
			const url = studioImageUrl(filePath);
			const meta = [String(item?.data?.model ?? ""), sizeLabel(item?.data?.size, "zh"), clockOf(item?.at)]
				.filter((part) => part.length > 0)
				.join(" · ");
			return h(
				"div",
				{
					className: "ig2-lightbox",
					role: "dialog",
					"aria-modal": "true",
					onClick: (event) => {
						if (event.target === event.currentTarget) onClose();
					},
				},
				h(
					"button",
					{ type: "button", className: "ig2-lbNav", "aria-label": t("studio.prev"), onClick: () => onStep(-1) },
					"‹",
				),
				h(
					"figure",
					{ className: "ig2-lbFigure", onClick: (event) => event.stopPropagation() },
					url === undefined
						? h("div", { className: "ig2-empty" }, "…")
						: h("img", { className: "ig2-lbImage", src: url, alt: "" }),
					h(
						"figcaption",
						{ className: "ig2-lbMeta" },
						meta,
						h("span", { className: "ig2-grow" }),
						h(
							"button",
							{ type: "button", className: "ig2-pill", onClick: () => onUseAsRef(filePath) },
							t("studio.useAsRef"),
						),
					),
					h("pre", { className: "ig2-lbPrompt" }, String(item?.data?.prompt ?? "")),
				),
				h(
					"button",
					{ type: "button", className: "ig2-lbNav", "aria-label": t("studio.next"), onClick: () => onStep(1) },
					"›",
				),
				h(
					"button",
					{ type: "button", className: "ig2-lbClose", "aria-label": t("studio.close"), onClick: onClose },
					"×",
				),
				h("div", { className: "ig2-lbCount" }, `${index + 1} / ${total}`),
			);
		}

		/* ─────────────────────── `/image` 结果卡片 ─────────────────────── */

		function parseImageOutcome(node) {
			return parseSentinelText(typeof node?.outcome?.text === "string" ? node.outcome.text : "");
		}

		function installImageCommandCard(ctx, t) {
			/** 缩略图：探一次 `api/file`，拿不到就什么都不画（绝不留破图标）。 */
			function Thumbnail({ file }) {
				const [url, setUrl] = React.useState(undefined);
				React.useEffect(() => {
					const target = previewUrl(file?.path);
					if (target === undefined || typeof Image !== "function") return undefined;
					let cancelled = false;
					const probe = new Image();
					probe.onload = () => {
						if (!cancelled) setUrl(target);
					};
					probe.src = target;
					return () => {
						cancelled = true;
						probe.onload = null;
					};
				}, [file?.path]);
				if (url === undefined) return null;
				return h("img", { className: "igThumb", src: url, alt: "", loading: "lazy" });
			}

			function ImageCommandCard(props) {
				const node = props.node;
				const tr = typeof props.t === "function" ? props.t : t;
				const sessionId = typeof props.sessionId === "string" ? props.sessionId : undefined;
				const parsed = React.useMemo(() => parseImageOutcome(node), [node]);
				const [copied, setCopied] = React.useState(false);

				const copy = React.useCallback(() => {
					const prompt = typeof parsed.data?.prompt === "string" ? parsed.data.prompt : "";
					const write = navigator.clipboard?.writeText?.(prompt);
					if (write === undefined) return;
					write.then(() => setCopied(true), () => {});
				}, [parsed.data?.prompt]);

				const outcome = node?.outcome ?? null;
				if (outcome === null) {
					return h("div", { className: "igCmd" }, h("span", { className: "igCmdMeta" }, tr("card.running")));
				}

				const data = parsed.data;
				if (data === undefined) {
					const body =
						parsed.text.length > 0
							? parsed.text
							: outcome.kind === "error"
								? tr("card.failed")
								: tr("card.done");
					return h(
						"div",
						{ className: "igCmd" },
						h("pre", { className: "igCmdBody", "data-error": outcome.kind === "error" || undefined }, body),
					);
				}

				const sidebar = serviceOf(ctx, "sidebarRight");
				const canPreview = sessionId !== undefined && typeof sidebar?.openResource === "function";
				const files = Array.isArray(data.files) ? data.files : [];

				return h(
					"div",
					{ className: "igCmd" },
					h(
						"div",
						{ className: "igCmdHead" },
						h("span", { className: "igCmdBadge" }, data.mode === "edit" ? tr("card.edit") : tr("card.generate")),
						h(
							"span",
							{ className: "igCmdMeta" },
							`${String(data.model ?? "")} · ${sizeLabel(data.size, "zh")} · ${files.length} ${tr("card.count")}` +
								(Number(data.references) > 0
									? ` · ${tr("studio.refCount").replace("{n}", String(data.references))}`
									: ""),
						),
						h("span", { className: "igCmdSpacer" }),
						h("button", { type: "button", className: "igBtn", onClick: copy }, copied ? tr("card.copied") : tr("card.copy")),
					),
					h("span", { className: "igCmdLabel" }, tr("card.prompt")),
					h("pre", { className: "igCmdPrompt" }, String(data.prompt ?? "")),
					files.length === 0
						? null
						: h(
								"div",
								{ className: "igCmdFiles" },
								files.map((file, index) =>
									h(
										"div",
										{ key: typeof file?.path === "string" ? file.path : String(index), className: "igCmdFile" },
										h(Thumbnail, { file }),
										h("span", { className: "igCmdPath" }, String(file?.path ?? "")),
										canPreview && typeof file?.rel === "string"
											? h(
													"button",
													{
														type: "button",
														className: "igBtn",
														onClick: () => sidebar.openResource(fileAddress(sessionId, file.rel)),
													},
													tr("card.preview"),
												)
											: null,
									),
								),
							),
				);
			}

			ctx.effect(() => {
				const off = ctx.slots.inject("conversation.chat.commandview", () =>
					ctx.slots.register(
						{ name: "conversation.chat.commandview", key: "image", locale: LOCALE_NS },
						ImageCommandCard,
					),
				);
				return typeof off === "function" ? off : () => {};
			}, "image-gen: /image card");
		}

		/* ─────────────────────── 生图台装配 ─────────────────────── */

		/** 左栏的「生图」入口：图标（panellist 只给 size / active）。 */
		function StudioRailIcon(props) {
			return h(StudioGlyph, { size: props?.size ?? 16 });
		}

		/**
		 * 「生图」页面：**全局一个共用的工作台**，不按会话隔离。
		 *
		 * 页面本身没有会话参数，成图与任务都在模块级 `studioStore` 里，
		 * 所以从任何入口进来看到的都是同一份东西，切走再回来也不会丢。
		 */
		function StudioPage(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const locale =
				typeof props.localeOf === "function"
					? props.localeOf()
					: typeof props.locale === "string"
						? props.locale
						: undefined;
			const pageRef = React.useRef(null);

			// 生图页里不需要聊天输入框（它自己有 dock）：只顶掉默认输入条，
			// 审批 / 提问是同一 chain 上的「当选」内容，不受影响。
			React.useEffect(() => {
				const element = pageRef.current;
				if (element === null || element === undefined || typeof element.closest !== "function") {
					return undefined;
				}
				const container = element.closest("[data-conversation-content]");
				if (container === null || container === undefined) return undefined;
				container.setAttribute("data-image-studio", "on");
				return () => container.removeAttribute("data-image-studio");
			}, []);

			return h(
				"div",
				{ className: "ig2-page", ref: pageRef },
				h(
					"div",
					{ className: "ig2-pageInner" },
					h(
						"header",
						{ className: "ig2-head" },
						h("h1", { className: "ig2-headTitle" }, t("studio.viewTitle")),
						h("p", { className: "ig2-headDesc" }, t("studio.viewDesc")),
					),
					h(StudioBody, {
						options: props.options,
						t,
						locale,
					}),
				),
			);
		}

		/** 打开生图页：切到 main 面板。装不上就退回右栏 tab。 */
		function openStudioPage(ctx) {
			try {
				const layout = serviceOf(ctx, "layout");
				if (typeof layout?.selectPanel === "function") {
					layout.selectPanel(PAGE_ID);
					return;
				}
			} catch {
				/* 落到右栏退路。 */
			}
			openStudioDock(ctx);
		}

		/** 右栏退路：只在 main 面板装配不可用时用（同一份 store）。 */
		function openStudioDock(ctx) {
			const service = serviceOf(ctx, "sidebarRight");
			if (typeof service?.openTab !== "function") return;
			try {
				service.openTab(STUDIO_KIND);
				return;
			} catch {
				/* 右栏还没为这个会话建过面板：先展开，再试一次。 */
			}
			try {
				serviceOf(ctx, "layout")?.openRightbar?.(true, false);
				service.openTab(STUDIO_KIND);
			} catch {
				/* 仍然打不开就算了 —— 输入框里的 /image 永远是退路。 */
			}
		}

		/**
		 * 装「生图」主面板：左栏一个入口 + main 槽位一页。
		 *
		 * 状态在模块级 store 里（见 createStudioStore），所以这里不传会话，
		 * 也不做会话选择 —— 所有会话共用同一个生图工作台。
		 */
		function installStudioPage(ctx, t) {
			if (typeof ctx.slots?.inject !== "function") return false;
			const options = createStudioOptions(ctx);
			const localeOf = () => serviceOf(ctx, "locale")?.getSnapshot?.()?.active;

			ctx.effect(
				() =>
					ctx.slots.inject("main", () =>
						ctx.slots.register(
							{
								name: "main",
								key: PAGE_ID,
								locale: LOCALE_NS,
								inject: () => ({ options, localeOf }),
							},
							StudioPage,
						),
					),
				"image-gen: studio page",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.panellist", () =>
						ctx.slots.register(
							{ name: "sidebar.panellist", id: PAGE_ID, order: 12, locale: LOCALE_NS, label: () => t("studio.panel") },
							StudioRailIcon,
						),
					),
				"image-gen: studio rail entry",
			);
			return true;
		}

		/** 右栏 tab 版：只在 `main` 页面装不上时兜底。 */
		function installStudioDock(ctx, t) {
			if (typeof ctx.sidebarRightTabs?.register !== "function") return;
			const options = createStudioOptions(ctx);
			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: STUDIO_ID,
						kind: STUDIO_KIND,
						priority: "extension",
						keepMounted: true,
						title: () => t("studio.panel"),
						guide: [
							{
								id: "studio",
								order: 40,
								title: () => t("studio.guideTitle"),
								description: () => t("studio.guideDescription"),
								icon: StudioGlyph,
							},
						],
					}),
				"image-gen: studio tab type",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab", () =>
						ctx.slots.register(
							{ name: "sidebar.right.pane.tab", key: STUDIO_ID, locale: LOCALE_NS, inject: () => ({ options, localeOf }) },
							StudioBody,
						),
					),
				"image-gen: studio body",
			);
		}

		function installComposerButton(ctx, t) {
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.input.left", () =>
						ctx.slots.register({ name: "conversation.input.left", id: "image-studio", order: 60, locale: LOCALE_NS }, (props) =>
							h(
								"button",
								{
									type: "button",
									className: "igComposerBtn",
									title: t("studio.openTooltip"),
									"aria-label": t("studio.openTooltip"),
									onClick: (event) => {
										event.preventDefault();
										openStudioPage(ctx);
									},
								},
								h(StudioGlyph, { size: 15 }),
							),
						),
					),
				"image-gen: studio button",
			);
		}

		/* ─────────────────────── 设置页 ─────────────────────── */

		function ImageGenSection(props) {
			const controller = props.controller;
			if (controller === undefined || controller === null) return null;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			return h(SettingsBody, { controller, t });
		}

		function SettingsBody({ controller, t }) {
			const snapshot = React.useSyncExternalStore(
				(listener) => controller.subscribe(listener),
				() => controller.getSnapshot(),
			);
			const [draft, setDraft] = React.useState("");
			const [pending, setPending] = React.useState(false);
			const [failure, setFailure] = React.useState(undefined);

			const value = snapshot.value ?? {};
			const writable = snapshot.writable !== false && snapshot.status === "ready";
			const models = Array.isArray(value.models) ? value.models.map((entry) => String(entry)) : [];
			const defaultModel = typeof value.model === "string" ? value.model : "";
			const orphan = defaultModel.length > 0 && !models.includes(defaultModel);

			const write = (ops) => {
				setPending(true);
				setFailure(undefined);
				return controller
					.mutate(ops)
					.then((ok) => {
						setPending(false);
						if (ok !== true) setFailure(t("writeFailed"));
						return ok === true;
					})
					.catch(() => {
						setPending(false);
						setFailure(t("writeFailed"));
						return false;
					});
			};

			const setField = (field, next) => write([{ op: "set", path: [field], value: next }]);

			if (snapshot.status === "loading") {
				return h("div", { className: "igWrap" }, h("p", { className: "igHint" }, t("loading")));
			}
			if (snapshot.status === "unavailable" || snapshot.mode === "memory") {
				return h(
					"div",
					{ className: "igWrap" },
					h("div", { className: "igHead" }, h("h3", { className: "igTitle" }, t("title"))),
					h("p", { className: "igWarn" }, t("unavailable")),
				);
			}

			const addModel = () => {
				const id = draft.trim();
				if (id.length === 0 || pending || models.includes(id)) return;
				setDraft("");
				write([{ op: "set", path: ["models"], value: [...models, id] }]);
			};

			const removeModel = (id) => {
				if (pending) return;
				const next = models.filter((entry) => entry !== id);
				const ops = [{ op: "set", path: ["models"], value: next }];
				if (id === defaultModel) {
					ops.push(next.length > 0 ? { op: "set", path: ["model"], value: next[0] } : { op: "unset", path: ["model"] });
				}
				write(ops);
			};

			const textField = (field, label, hint) =>
				h(
					"div",
					{ className: "igField" },
					h("label", { className: "igLabel" }, label),
					h("input", {
						className: "igInput",
						type: "text",
						defaultValue: typeof value[field] === "string" ? value[field] : "",
						disabled: pending || !writable,
						onBlur: (event) => {
							const next = event.target.value.trim();
							if (next !== value[field]) setField(field, next);
						},
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						},
					}),
					hint ? h("span", { className: "igHint" }, hint) : null,
				);

			return h(
				"div",
				{ className: "igWrap" },

				h(
					"div",
					{ className: "igHead" },
					h("h3", { className: "igTitle" }, t("title")),
					h("p", { className: "igDesc" }, t("desc")),
				),

				// 模型清单
				h(
					"div",
					{ className: "igBlock" },
					h(
						"h4",
						{ className: "igBlockTitle" },
						t("models"),
						h("span", { className: "igCount" }, String(models.length)),
					),
					h("p", { className: "igHint" }, t("modelsHint")),
					models.length === 0
						? h("p", { className: "igEmpty" }, t("modelsEmpty"))
						: h(
								"div",
								{ className: "igList" },
								models.map((id) =>
									h(
										"div",
										{ key: id, className: id === defaultModel ? "igRow igRowDefault" : "igRow" },
										h("span", { className: "igName" }, id),
										id === defaultModel
											? h("span", { className: "igBadge" }, t("isDefault"))
											: h(
													"button",
													{
														type: "button",
														className: "igBtn",
														disabled: pending || !writable,
														onClick: () => setField("model", id),
													},
													t("setDefault"),
												),
										h(
											"button",
											{ type: "button", className: "igBtn", disabled: pending || !writable, onClick: () => removeModel(id) },
											t("remove"),
										),
									),
								),
							),
					h(
						"div",
						{ className: "igRow" },
						h("input", {
							className: "igInput",
							type: "text",
							value: draft,
							placeholder: t("addPlaceholder"),
							disabled: pending || !writable,
							onChange: (event) => setDraft(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									addModel();
								}
							},
						}),
						h(
							"button",
							{ type: "button", className: "igBtn", disabled: pending || !writable || draft.trim().length === 0, onClick: addModel },
							t("add"),
						),
					),
					orphan ? h("p", { className: "igWarn" }, t("defaultModelOrphan")) : null,
					failure === undefined ? null : h("p", { className: "igWarn" }, failure),
				),

				// 端点 / 默认尺寸 / 张数
				h(
					"div",
					{ className: "igBlock" },
					h("h4", { className: "igBlockTitle" }, t("endpoint")),
					h("p", { className: "igHint" }, t("defaultModelHint")),
					h(
						"div",
						{ className: "igGrid" },
						textField("baseURL", t("baseUrl"), t("baseUrlHint")),
						textField("apiKeyEnv", t("apiKeyEnv"), t("apiKeyEnvHint")),
					),
					h(
						"div",
						{ className: "igField" },
						h("label", { className: "igLabel" }, t("defaultSize")),
						h(
							"div",
							{ style: { display: "flex", gap: 6, flexWrap: "wrap" } },
							SIZE_OPTIONS.map((option) =>
								h(
									"button",
									{
										key: option.value,
										type: "button",
										className: "igBtn",
										disabled: pending || !writable,
										style:
											value.defaultSize === option.value
												? { borderColor: "currentColor", fontWeight: 600 }
												: undefined,
										onClick: () => setField("defaultSize", option.value),
									},
									`${option.value} · ${option.ratio}`,
								),
							),
						),
					),
					h(
						"div",
						{ className: "igGrid" },
						textField("outputDir", t("outputDir"), t("outputDirHint")),
						textField("studioDir", t("studioDir"), t("studioDirHint")),
						h(
							"div",
							{ className: "igField" },
							h("label", { className: "igLabel" }, t("maxImages")),
							h("input", {
								className: "igInput",
								type: "number",
								min: 1,
								max: 8,
								defaultValue: String(Number.isFinite(value.maxImages) ? value.maxImages : 4),
								disabled: pending || !writable,
								onBlur: (event) => {
									const next = Number.parseInt(event.target.value, 10);
									if (Number.isInteger(next) && next >= 1 && next !== value.maxImages) setField("maxImages", next);
								},
							}),
						),
					),
				),
			);
		}

		/* ─────────────────────── 装配 ─────────────────────── */

		function installStyles(ctx) {
			if (typeof document === "undefined") return;
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-image-gen";
				tag.dataset.pluginCss = "dsh-image-gen/client.css";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "image-gen: stylesheet");
		}

		/**
		 * 必需服务：设置区与命令卡片只要这三样。
		 *
		 * 生图台要的右栏与命令通道单独用 `ctx.inject` 可选注入 —— 老组装里没有右栏时，
		 * 生图台不出现，但 `/image`、设置页和结果卡片照常工作。
		 */
		const inject = ["slots", "locale", "configForms"];

		function apply(ctx) {
			installStyles(ctx);
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "image-gen: dictionaries");
			const t = ctx.locale.bind(LOCALE_NS);

			installImageCommandCard(ctx, t);

			// 生图台是**会话作用域**的视图（`conversation.view`），和「对话」并列；
			// 只要命令通道在就能用。老组装里没有视图槽位时，右栏 tab 兜底。
			// 生图台走宿主的同源路由（见 Host 的 /image-gen/studio），
			// 不再依赖命令通道 —— 所以它不会往会话日志里写任何东西。
			const pageReady = installStudioPage(ctx, t);
			if (!pageReady) installStudioDock(ctx, t);
			installComposerButton(ctx, t);

			// 用 whileServed 而不是直接注册：Host 侧没挂 image-gen 条目时，
			// 设置文档里根本没有这个命名空间，此时页面不该出现。
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () => {
						const controller = ctx.configForms.get(NS);
						const off = ctx.slots.inject("settings.section", () =>
							ctx.slots.register(
								{ name: "settings.section", id: SECTION_ID, order: 20, label: () => t("nav"), inject: () => ({ controller, t }) },
								ImageGenSection,
							),
						);
						return typeof off === "function" ? off : () => {};
					}),
				"image-gen: settings section",
			);
		}

		exports.apply = apply;
		exports.inject = inject;

		/**
		 * 给离线自检用的纯函数出口（在 DSH 里不注册任何东西）。
		 *
		 * 客户端拼的命令行必须和 Host 的解析器逐字节对齐；`tools/verify.mjs`
		 * 拿这里拼出来的线去跑真实的命令处理器。
		 */
		exports.__test = {
			buildImageCommandLine,
			parseSentinelText,
			studioStore,
			STUDIO_KIND,
			STUDIO_ID,
			MAX_REFS,
		};
		return module.exports;
	},
});
