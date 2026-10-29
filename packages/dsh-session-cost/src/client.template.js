/**
 * dsh-session-cost — 客户端源码模板（**给人读的**）。
 *
 * `tools/build.mjs` 会把 `__ART_JSON__` 换成 `assets/art.json` 里的素材 data URL，
 * 产出 DSH 真正加载的 `lib/client.js`。模块壳（`window.__ModuleLoader__.load`）与
 * 本 profile 里其它插件一致：不依赖打包器，`require` 由 DSH 客户端模块加载器提供。
 *
 * ── 它显示什么 ───────────────────────────────────────────────────────────
 *
 * 会话标题栏右侧工具区里一枚小徽章：`¥ 图标 + 金额`。金额来自宿主投影
 * `sessionCost`（见 lib/fold.js）——**只有 DeepSeek 官方路由**的调用才会被计价，
 * 所以非官方模型跑出来的会话根本不显示这枚徽章（`view.priced === false` → return null）。
 *
 * 点开是一块固定定位的明细面板：token 四个桶各自的量/钱、缓存命中省下的钱、
 * 峰时/谷时拆分、按模型拆分、最近几笔调用、计价依据与口径说明。
 *
 * ── 两条刻意的约定 ───────────────────────────────────────────────────────
 *
 * 1. **颜色全部走主题 token**（`--dsw-alias-*` / `--dsw-elevation-*` / `--dsw-radius-*`），
 *    一个写死的颜色都没有 —— 于是浅色/深色、以及像 dsh-theme-gemini-cat 那样覆盖
 *    `--dsw-alias-*` 的主题插件，徽章与面板都会跟着变。孤立的只有立绘素材本身
 *    （美术允许有自己的颜色）。
 * 2. **不 require 任何 Harness 客户端包**（不碰 `dsh-client-ui-primitives`）：
 *    这类包随时可能变，而 slot 里的组件一旦抛错，整格 UI 会直接空掉。
 *    所以气泡、面板、定位、关闭行为都是这里自己写的最小实现。
 */

window.__ModuleLoader__.load({
	id: "dsh-session-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** 面板头部的立绘 `{ mascot: dataURL }`；构建时注入，缺失就退化成纯文字头部。 */
		const ART = __ART_JSON__;

		/** 投影 key（与 lib/fold.js 的 KEY 一致）。 */
		const KEY = "sessionCost";
		/** 文案命名空间。 */
		const NS = "session-cost";
		/** 落点：会话标题栏右侧的工具区（与「在应用中打开」「导出会话」并排）。 */
		const SLOT = "conversation.session.header.utilities";
		/** 本格 id：自己起一个，别去占别人的格子。 */
		const ENTRY_ID = "session-cost-row";
		/** 排序：正数排在自带工具之前/之后由宿主决定，这里只要稳定。 */
		const ORDER = 30;

		/* ─────────────────────────── 文案 ─────────────────────────── */

		const zh = {
			"title": "本会话费用",
			"chip.title": "本会话 DeepSeek 官方模型费用 {amount}，点开看明细",
			"chip.pending": "有待计价的调用",
			"calls": "{count} 次调用",
			"total": "合计",
			"tokens.input": "输入 · 未命中缓存",
			"tokens.cacheRead": "输入 · 命中缓存",
			"tokens.cacheWrite": "输入 · 缓存写入",
			"tokens.output": "输出",
			"cacheSaved": "缓存命中省下 {amount}",
			"cacheHitRate": "命中率 {percent}%",
			"peak": "峰时",
			"offPeak": "谷时",
			"byModel": "按模型",
			"recent": "最近调用",
			"kind.chat": "对话",
			"kind.compaction": "压缩",
			"pricingSource": "计价依据：DeepSeek 官方人民币价目表",
			"pricingSourceUsd": "美元价目表",
			"pricingNote": "元 / 百万 token；空闲时段价为高峰时段价的一半（高峰 = 北京时间工作日 09:00–12:00、14:00–18:00）。人民币与美元各自按官方那份表计费，不做汇率折算。",
			"scopeNote": "只统计 DeepSeek 官方 API / 账号路由。压缩调用计入本会话；子代理是独立会话，单独计价。",
			"warning.foreign": "另有 {count} 次调用走非官方路由（{models}），未计入。",
			"warning.unpriced": "有 {count} 次调用所用模型不在价目表里（{models}），未计价。",
			"warning.usageMissing": "有 {count} 次调用没有上报用量，无法计价。",
			"warning.failedAttempts": "另有 {count} 次失败/中断的尝试（共 {tokens} token）未计入金额。",
			"alt": "另按美元价：{amount}",
			"close": "关闭",
			"cost.aria": "{amount}，{count} 次调用"
		};

		const en = {
			"title": "Session cost",
			"chip.title": "DeepSeek official-model cost for this session: {amount}. Click for details.",
			"chip.pending": "pending pricing",
			"calls": "{count} calls",
			"total": "Total",
			"tokens.input": "Input · cache miss",
			"tokens.cacheRead": "Input · cache hit",
			"tokens.cacheWrite": "Input · cache write",
			"tokens.output": "Output",
			"cacheSaved": "Saved by cache hits {amount}",
			"cacheHitRate": "{percent}% hit rate",
			"peak": "Peak",
			"offPeak": "Off-peak",
			"byModel": "By model",
			"recent": "Recent calls",
			"kind.chat": "chat",
			"kind.compaction": "compaction",
			"pricingSource": "Pricing: DeepSeek official price list (CNY)",
			"pricingSourceUsd": "USD price list",
			"pricingNote": "CNY per 1M tokens; off-peak is half of peak (peak = weekdays 09:00–12:00 and 14:00–18:00 Beijing time). CNY and USD follow their own official tables; no exchange-rate conversion.",
			"scopeNote": "Counts DeepSeek official API / account routes only. Compaction calls are included; subagents are separate sessions and are billed separately.",
			"warning.foreign": "{count} calls used a non-official route ({models}) and are excluded.",
			"warning.unpriced": "{count} calls used a model missing from the price list ({models}).",
			"warning.usageMissing": "{count} calls reported no usage and cannot be priced.",
			"warning.failedAttempts": "{count} failed/interrupted attempts ({tokens} tokens) are not priced.",
			"alt": "in USD: {amount}",
			"close": "Close",
			"cost.aria": "{amount}, {count} calls"
		};

		/** 没有 locale 服务时的兜底：直接用中文串，不炸。 */
		function fallbackT(key, params) {
			const template = zh[key] ?? key;
			return params === undefined ? template : template.replace(/\{(\w+)\}/g, (all, name) => (name in params ? String(params[name]) : all));
		}

		/* ─────────────────────────── 样式 ─────────────────────────── */

		/*
		 * 颜色一律用主题 token：
		 *   --dsw-alias-border-l2 / bg-layer-2 / label-* / interactive-bg-hover
		 *   --dsw-alias-button-ghost-active-*   （选中态，与宿主工具按钮一致）
		 *   --dsw-alias-state-business-primary  （金额，业务色）
		 *   --dsw-alias-state-success-primary   （省下的钱）
		 *   --dsw-elevation-panel / --dsw-radius-panel / --dsw-radius-sm
		 * 尺寸与间距是本插件自己的几何，不依赖任何宿主 class。
		 */
		const CSS = `
.dsc-root { position: relative; display: inline-flex; align-items: center; }
.dsc-chip {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1;
  font-variant-numeric: tabular-nums; cursor: pointer;
}
.dsc-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsc-chip[data-open="true"] {
  background: var(--dsw-alias-button-ghost-active-fill);
  border-color: var(--dsw-alias-button-ghost-active-border);
  color: var(--dsw-alias-label-primary);
}
.dsc-chip:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.dsc-icon { flex: none; color: var(--dsw-alias-label-tertiary); }
.dsc-chip:hover .dsc-icon, .dsc-chip[data-open="true"] .dsc-icon { color: var(--dsw-alias-label-secondary); }
.dsc-amount { color: var(--dsw-alias-state-business-primary); font-weight: 500; }

.dsc-panel {
  position: fixed; z-index: 2147483000; width: 322px;
  max-height: min(72vh, 560px); overflow: auto; overscroll-behavior: contain;
  padding: 12px 14px 10px; border-radius: var(--dsw-radius-panel);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-panel);
  font-size: 12px; line-height: 1.5;
}
.dsc-head { display: flex; align-items: center; gap: 10px; }
.dsc-art { width: 44px; height: 44px; flex: none; object-fit: contain; user-select: none; -webkit-user-drag: none; }
.dsc-headText { min-width: 0; flex: 1; }
.dsc-title { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsc-total { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dsc-totalCny { font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsc-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsc-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsc-sectionTitle { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-bottom: 4px; }
.dsc-row { display: flex; align-items: baseline; gap: 8px; padding: 1px 0; }
.dsc-rowLabel { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-rowValue { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dsc-rowSub { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); min-width: 54px; text-align: right; }
.dsc-rowUsd { font-variant-numeric: tabular-nums; min-width: 68px; text-align: right; color: var(--dsw-alias-label-primary); }
.dsc-good { color: var(--dsw-alias-state-success-primary); }
.dsc-warn { color: var(--dsw-alias-state-warn-primary); }
.dsc-split { display: flex; gap: 12px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsc-bill { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
.dsc-billTime { color: var(--dsw-alias-label-tertiary); min-width: 38px; }
.dsc-badge {
  display: inline-flex; align-items: center; height: 16px; padding: 0 5px; border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); font-size: 10px;
}
.dsc-foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsc-foot a { color: var(--dsw-alias-link); text-decoration: none; }
.dsc-foot a:hover { text-decoration: underline; }
.dsc-note { margin-top: 3px; }
`;

		/* ─────────────────────────── 数字格式化 ─────────────────────────── */

		/** 千分位分组：只动整数部分。 */
		function groupDigits(text) {
			const dot = text.indexOf(".");
			const head = dot === -1 ? text : text.slice(0, dot);
			const tail = dot === -1 ? "" : text.slice(dot);
			return head.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + tail;
		}

		/** 币种符号。两个官方价目表就这么两种，写死即可。 */
		const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$" };

		/**
		 * 金额：小于 1 给 4 位小数（会话级费用常常是几分几厘），大于等于 1 给 2 位。
		 * 极小但非零显示 `<0.0001`，免得画成 `0.0000` 让人以为没花钱。
		 */
		function formatAmount(value) {
			const number = Number(value);
			if (!isFinite(number) || number === 0) return "0.00";
			const abs = Math.abs(number);
			if (abs < 0.0001) return (number < 0 ? "-" : "") + "<0.0001";
			if (abs < 1) return number.toFixed(4);
			return groupDigits(number.toFixed(2));
		}

		/** 带货币符号的金额。 */
		function money(value, currency) {
			const symbol = CURRENCY_SYMBOLS[currency] ?? "";
			return symbol + formatAmount(value);
		}

		/** token 数：大到一定程度换 k / M，避免面板里塞一串数字。 */
		function formatTokens(value) {
			const number = Number(value);
			if (!isFinite(number) || number <= 0) return "0";
			if (number >= 1e6) return (number / 1e6).toFixed(2) + "M";
			if (number >= 1e4) return (number / 1e3).toFixed(1) + "k";
			return groupDigits(String(Math.round(number)));
		}

		/** 精确 token 数（面板里 tooltip 用）。 */
		function exactTokens(value) {
			return groupDigits(String(Math.round(Number(value) || 0)));
		}

		/** 时刻：只显示 HH:MM，够认出「哪几笔」。 */
		function formatClock(ms) {
			const at = new Date(Number(ms));
			if (isNaN(at.getTime())) return "--:--";
			const pad = (n) => String(n).padStart(2, "0");
			return pad(at.getHours()) + ":" + pad(at.getMinutes());
		}

		/** 缓存命中率（按输入侧三个桶算）。 */
		function cacheHitRate(tokens) {
			const prompt = (tokens?.input ?? 0) + (tokens?.cacheRead ?? 0) + (tokens?.cacheWrite ?? 0);
			if (prompt <= 0) return null;
			return Math.round(((tokens.cacheRead ?? 0) / prompt) * 100);
		}

		/** 一条 `标签 …… 数值 金额` 的行。 */
		function row(key, label, value, amount, options) {
			const children = [
				h("span", { className: "dsc-rowLabel", key: "l" }, label),
				h("span", { className: "dsc-rowSub", key: "v", title: options?.exact }, value)
			];
			if (amount !== undefined) children.push(h("span", { className: "dsc-rowUsd", key: "u" }, amount));
			return h("div", { className: "dsc-row", key }, children);
		}

		/* ─────────────────────────── 组件 ─────────────────────────── */

		/**
		 * 会话标题栏里的费用徽章 + 明细面板。
		 *
		 * 标准 props 里用到的：`useProjection`（读宿主投影）、`t`（本格字典，来自
		 * register 的 `locale`）。拿不到投影、或本会话没有任何官方路由的计价，
		 * 整个组件返回 `null` —— 这就是「只显示官方模型费用」的落点。
		 */
		function SessionCostChip(props) {
			const useProjection = props.useProjection;
			const t = typeof props.t === "function" ? props.t : fallbackT;
			const readProjection = typeof useProjection === "function" ? useProjection : () => undefined;
			const view = readProjection(KEY);

			const [open, setOpen] = React.useState(false);
			const [placement, setPlacement] = React.useState(null);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);

			const available = view !== undefined && view !== null && view.priced === true;

			/** 固定定位：默认挂在徽章下方右对齐，下面放不下就翻到上方。 */
			const place = React.useCallback(() => {
				const anchor = rootRef.current;
				if (!anchor) return;
				const rect = anchor.getBoundingClientRect();
				const height = panelRef.current?.offsetHeight ?? 320;
				const roomBelow = window.innerHeight - rect.bottom - 8;
				const top = roomBelow >= height || roomBelow >= rect.top - 8 ? rect.bottom + 8 : Math.max(8, rect.top - height - 8);
				const right = Math.max(8, window.innerWidth - rect.right);
				setPlacement({ top: Math.max(8, top), right });
			}, []);

			React.useLayoutEffect(() => {
				if (!open) {
					setPlacement(null);
					return undefined;
				}
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open, place, view]);

			// 点外面 / Esc 关闭（自己写，不 require 宿主的 useDismissOnOutsidePointer）
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current?.contains(target) === true) return;
					if (panelRef.current?.contains(target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			if (!available) return null;

			// 两个币种的钱各算各的（官方有两份价目表），默认展示哪个由宿主配置决定。
			const currencies = Array.isArray(view.currencies) && view.currencies.length > 0 ? view.currencies : ["CNY", "USD"];
			const mainCurrency = currencies.indexOf(view.displayCurrency) >= 0 ? view.displayCurrency : currencies[0];
			const altCurrency = currencies.find((code) => code !== mainCurrency) ?? null;
			const main = (view.money ?? {})[mainCurrency] ?? { total: 0, input: 0, cache: 0, cacheWrite: 0, output: 0, cacheSaved: 0, peak: 0, offPeak: 0 };
			const alt = altCurrency === null ? null : (view.money ?? {})[altCurrency] ?? null;

			const tokens = view.tokens ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			const rate = cacheHitRate(tokens);
			const total = money(main.total, mainCurrency);
			const aria = t("cost.aria", { amount: total, count: view.calls });

			const chip = h(
				"button",
				{
					type: "button",
					className: "dsc-chip",
					"data-open": open ? "true" : "false",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": aria,
					title: t("chip.title", { amount: total }),
					onClick: () => setOpen((value) => !value),
					key: "chip"
				},
				h(
					"svg",
					{ className: "dsc-icon", viewBox: "0 0 16 16", width: 13, height: 13, "aria-hidden": true, key: "icon" },
					h("circle", { cx: 8, cy: 8, r: 6.4, fill: "none", stroke: "currentColor", strokeWidth: 1.3 }),
					h("path", {
						d: "M8 4.4v7.2M5.8 6.3h4.4M5.8 8.3h4.4M6.3 12.6 8 9.9l1.7 2.7",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.2,
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				),
				h("span", { className: "dsc-amount", key: "amount" }, total)
			);

			if (!open) return h("span", { className: "dsc-root", ref: rootRef }, chip);

			const panelChildren = [];

			// ── 头部：立绘 + 合计 ──
			const head = [];
			if (typeof ART.mascot === "string" && ART.mascot.length > 0) {
				head.push(h("img", { className: "dsc-art", src: ART.mascot, alt: "", key: "art", draggable: false }));
			}
			const headText = [h("div", { className: "dsc-title", key: "t" }, t("title"))];
			headText.push(
				h(
					"div",
					{ key: "total" },
					h("span", { className: "dsc-total" }, total),
					alt === null
						? null
						: h("span", { className: "dsc-totalCny" }, " " + t("alt", { amount: money(alt.total, altCurrency) }))
				)
			);
			const modelsLabel = (view.models ?? []).map((item) => item.label).join(" · ");
			headText.push(
				h(
					"div",
					{ className: "dsc-meta", key: "meta" },
					t("calls", { count: view.calls }) + (modelsLabel.length > 0 ? " · " + modelsLabel : "")
				)
			);
			head.push(h("div", { className: "dsc-headText", key: "text" }, headText));
			panelChildren.push(h("div", { className: "dsc-head", key: "head" }, head));

			// ── token 四桶 ──
			const breakdown = h("div", { className: "dsc-section", key: "tokens" }, [
				h("div", { className: "dsc-sectionTitle", key: "st" }, t("total")),
				row("input", t("tokens.input"), formatTokens(tokens.input), money(main.input, mainCurrency), { exact: exactTokens(tokens.input) }),
				row("cacheRead", t("tokens.cacheRead"), formatTokens(tokens.cacheRead), money(main.cache, mainCurrency), { exact: exactTokens(tokens.cacheRead) }),
				tokens.cacheWrite > 0
					? row("cacheWrite", t("tokens.cacheWrite"), formatTokens(tokens.cacheWrite), money(main.cacheWrite, mainCurrency), { exact: exactTokens(tokens.cacheWrite) })
					: null,
				row("output", t("tokens.output"), formatTokens(tokens.output), money(main.output, mainCurrency), { exact: exactTokens(tokens.output) })
			]);
			panelChildren.push(breakdown);

			// ── 缓存省下的钱 + 命中率 ──
			if (main.cacheSaved > 0 || rate !== null) {
				const parts = [];
				if (main.cacheSaved > 0) parts.push(t("cacheSaved", { amount: money(main.cacheSaved, mainCurrency) }));
				if (rate !== null) parts.push(t("cacheHitRate", { percent: rate }));
				panelChildren.push(
					h("div", { className: "dsc-section", key: "saved" }, h("div", { className: "dsc-good" }, parts.join(" · ")))
				);
			}

			// ── 高峰 / 空闲时段 ──
			panelChildren.push(
				h("div", { className: "dsc-section", key: "peak" }, [
					h("div", { className: "dsc-split", key: "rows" }, [
						h("span", { key: "p" }, t("peak") + " " + t("calls", { count: view.peakCalls }) + " · " + money(main.peak, mainCurrency)),
						h("span", { key: "o" }, t("offPeak") + " " + t("calls", { count: view.offPeakCalls }) + " · " + money(main.offPeak, mainCurrency))
					])
				])
			);

			// ── 按模型 ──
			if ((view.models ?? []).length > 1) {
				panelChildren.push(
					h(
						"div",
						{ className: "dsc-section", key: "models" },
						[h("div", { className: "dsc-sectionTitle", key: "st" }, t("byModel"))].concat(
							view.models.map((item) =>
								row(
									item.model,
									item.label,
									formatTokens((item.tokens.input ?? 0) + (item.tokens.cacheRead ?? 0) + (item.tokens.cacheWrite ?? 0) + (item.tokens.output ?? 0)),
									money((item.money ?? {})[mainCurrency]?.total ?? 0, mainCurrency)
								)
							)
						)
					)
				);
			}

			// ── 最近调用 ──
			if ((view.bills ?? []).length > 0) {
				panelChildren.push(
					h(
						"div",
						{ className: "dsc-section", key: "bills" },
						[h("div", { className: "dsc-sectionTitle", key: "st" }, t("recent"))].concat(
							view.bills.slice(0, 8).map((bill, index) =>
								h("div", { className: "dsc-bill", key: String(bill.at) + "-" + index }, [
									h("span", { className: "dsc-billTime", key: "t" }, formatClock(bill.at)),
									h("span", { className: "dsc-badge", key: "k" }, t("kind." + bill.kind)),
									h("span", { className: "dsc-rowLabel", key: "l" }, (bill.peak ? t("peak") : t("offPeak")) + " · " + bill.label),
									h("span", { className: "dsc-rowUsd", key: "u" }, money((bill.money ?? {})[mainCurrency] ?? 0, mainCurrency))
								])
							)
						)
					)
				);
			}

			// ── 页脚：口径 + 价目表出处 + 未计入的警告 ──
			const sources = [t("pricingSource")];
			if (altCurrency !== null) sources.push(t("pricingSourceUsd"));
			const foot = [
				h(
					"div",
					{ className: "dsc-note", key: "src" },
					h("a", { href: view.pricingSource, target: "_blank", rel: "noreferrer" }, sources.join(" · "))
				),
				h("div", { className: "dsc-note", key: "pn" }, t("pricingNote")),
				h("div", { className: "dsc-note", key: "sn" }, t("scopeNote"))
			];
			if (view.unpricedCalls > 0) {
				foot.push(
					h(
						"div",
						{ className: "dsc-note dsc-warn", key: "unpriced" },
						t("warning.unpriced", { count: view.unpricedCalls, models: (view.unpricedModels ?? []).join("、") })
					)
				);
			}
			if (view.foreignCalls > 0) {
				foot.push(
					h(
						"div",
						{ className: "dsc-note dsc-warn", key: "foreign" },
						t("warning.foreign", { count: view.foreignCalls, models: (view.foreignModels ?? []).join("、") })
					)
				);
			}
			if (view.usageMissing > 0) {
				foot.push(
					h("div", { className: "dsc-note dsc-warn", key: "missing" }, t("warning.usageMissing", { count: view.usageMissing }))
				);
			}
			if (view.failedAttempts > 0) {
				foot.push(
					h(
						"div",
						{ className: "dsc-note dsc-warn", key: "failed" },
						t("warning.failedAttempts", { count: view.failedAttempts, tokens: exactTokens(view.failedAttemptTokens) })
					)
				);
			}
			panelChildren.push(h("div", { className: "dsc-foot", key: "foot" }, foot));

			const panel = h(
				"div",
				{
					className: "dsc-panel",
					ref: panelRef,
					role: "dialog",
					"aria-label": t("title"),
					style: placement === null ? { top: 0, right: 0, visibility: "hidden" } : { top: placement.top + "px", right: placement.right + "px" },
					key: "panel"
				},
				panelChildren
			);

			return h("span", { className: "dsc-root", ref: rootRef }, [chip, panel]);
		}

		/* ─────────────────────────── 插件 ─────────────────────────── */

		/**
		 * 客户端插件体：注入样式表、注册字典、把徽章挂进会话标题栏右侧工具区。
		 *
		 * 样式与注册都走 `ctx.effect` / `ctx.slots.inject`，插件卸载时自动回收。
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.dshPlugin = NS;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "session-cost: stylesheet");

			ctx.inject(["slots", "locale"], (scope) => {
				scope.effect(() => scope.locale.register(NS, { zh, en }), "session-cost: dictionaries");
				const scopedT = scope.locale.bind(NS);
				scope.slots.inject(SLOT, () =>
					scope.slots.register(
						{
							name: SLOT,
							id: ENTRY_ID,
							order: ORDER,
							locale: NS,
							label: () => scopedT("title")
						},
						SessionCostChip
					)
				);
			});
		}

		exports.SessionCostChip = SessionCostChip;
		exports.KEY = KEY;
		exports.SLOT = SLOT;
		exports.ENTRY_ID = ENTRY_ID;
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
