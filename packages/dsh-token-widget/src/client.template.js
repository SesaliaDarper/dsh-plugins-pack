/**
 * dsh-token-widget — 客户端源码模板。
 *
 * 这是给人读的源码；`tools/build.mjs` 会把 ART 的占位符换成
 * assets/art.json 里的 base64 data URL，产出真正被 DSH 加载的 lib/client.js。
 * 手写的模块壳（window.__ModuleLoader__.load）与 dsh-theme-gemini-cat 保持一致：
 * 不依赖打包器，require 由 DSH 客户端模块加载器提供。
 */
window.__ModuleLoader__.load({
	id: "dsh-token-widget",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const store = require("@deepseek-ai/dsh-client-store");

		/** 立绘数据：{ id: { url, bubble } }，由构建脚本注入。 */
		const ART = __ART_DATA__;

		const PLUGIN_ID = "dsh-token-widget";
		const NS = "settings.token-widget";
		const STORAGE_KEY = "dsh-token-widget.v1";
		const OVERLAY_ID = "token-widget";
		const SETTINGS_ROW_ID = "token-widget";

		/**
		 * 调用 account Remote 时上报的「客户端版本」。
		 *
		 * 它只是平台用来判断「是哪个界面在问」的元信息，不参与任何校验，
		 * 所以按下 DSH 的版本填即可（与 dsh-client-ui-settings-account 内联的值一致，
		 * 那个值就是 DSH 自身的版本 0.2.0-rc.2）。DSH 升级后这里跟着改。
		 */
		const CLIENT_VERSION = "0.2.0-rc.2";

		/**
		 * 余额自动刷新间隔。
		 *
		 * 余额是**账号级**数据，读取要真的打到 Platform，所以刻意不频繁轮询：
		 * 十分钟一次足够看出钱在减少，也不会把用户的账号接口刷出一堆请求。
		 * 打开面板和点刷新按钮时另有即时读取。
		 */
		const BALANCE_REFRESH_MS = 10 * 60 * 1000;

		/**
		 * 气泡翻页间隔（`bubblePage === "auto"` 时生效）。
		 *
		 * 气泡只有那么大，塞不下「token 用量」和「账户余额」两件事，
		 * 所以它是一块**翻页的牌子**：一页用量、一页余额，到点自动翻。
		 * 点一下气泡就能翻到下一页并固定住（面板里也能直接选）。
		 * 六秒是「来得及看清」和「不用等太久」之间的折中。
		 */
		const BUBBLE_ROTATE_MS = 6000;

		/**
		 * 角色表 —— 唯一扩展点：加一套立绘就往这里 push 一项。
		 *   art        立绘（构建脚本注入的 data URL）
		 *   bubble     气泡内文字框（立绘宽高的百分比；构建时自动测出）
		 *   ink/fill   气泡文字色 / 气泡填充（颜色风格跟角色走）
		 *   tokens     覆盖到整个界面的 --dsw-* 字体与强调色 token
		 */
		const CHARACTERS = [
			{
				id: "grok",
				name: "Grok娘",
				hint: "金发哥特萝莉 · 黑金 / 酒红",
				art: ART.grok && ART.grok.url,
				bubble: (ART.grok && ART.grok.bubble) || { left: 10, top: 11, width: 40, height: 20 },
				ink: "#6E1F2C",
				inkSoft: "#9A5A5F",
				fill: "rgba(255, 240, 238, 0.82)",
				accent: "#B8912F",
				tokens: {
					light: { ink: "#3A2418", soft: "#7C6242", tertiary: "#A98F6C", brand: "#9A7A1E", link: "#8A6A14" },
					dark: { ink: "#F6E6C4", soft: "#CDB183", tertiary: "#9C8355", brand: "#E3C173", link: "#EBD08A" }
				}
			},
			{
				id: "claude",
				name: "Claude娘",
				hint: "橙发少女 · 暖橙",
				art: ART.claude && ART.claude.url,
				bubble: (ART.claude && ART.claude.bubble) || { left: 9, top: 9, width: 47, height: 23 },
				ink: "#A8451A",
				inkSoft: "#C97A4E",
				fill: "rgba(255, 243, 231, 0.82)",
				accent: "#E07A3C",
				tokens: {
					light: { ink: "#4A2410", soft: "#8C5A38", tertiary: "#B08464", brand: "#C25A1E", link: "#B85410" },
					dark: { ink: "#FFE2CD", soft: "#E5AF88", tertiary: "#B98A63", brand: "#FF9C5C", link: "#FFAE73" }
				}
			},
			{
				id: "gemini",
				name: "Gemini猫猫",
				hint: "紫发猫耳 · 星屑",
				art: ART.gemini && ART.gemini.url,
				bubble: (ART.gemini && ART.gemini.bubble) || { left: 8, top: 9, width: 42, height: 23 },
				ink: "#3B34A0",
				inkSoft: "#6E68C4",
				fill: "rgba(240, 240, 255, 0.82)",
				accent: "#6C5CE7",
				tokens: {
					light: { ink: "#221E45", soft: "#6A6390", tertiary: "#948DB8", brand: "#5B4FD6", link: "#5348CE" },
					dark: { ink: "#E9E5FF", soft: "#B4AADF", tertiary: "#8B82B8", brand: "#A695FF", link: "#B4A6FF" }
				}
			},
			{
				id: "glm",
				name: "GLM",
				hint: "黑白狐耳 · 冰蓝宝石",
				art: ART.glm && ART.glm.url,
				bubble: (ART.glm && ART.glm.bubble) || { left: 8, top: 9, width: 42, height: 23 },
				thumbPos: "66% 60%",
				ink: "#141821",
				inkSoft: "#4E5766",
				fill: "rgba(248, 250, 253, 0.86)",
				accent: "#6384C4",
				tokens: {
					light: { ink: "#15181F", soft: "#4A5261", tertiary: "#868D9B", brand: "#2E4A7C", link: "#2A5AA6" },
					dark: { ink: "#F1F4F9", soft: "#A6AEBD", tertiary: "#6E7686", brand: "#9FB8E8", link: "#A9C2EC" }
				}
			},
			{
				id: "gpt",
				name: "GPT娘",
				hint: "银白龙角 · 青碧",
				art: ART.gpt && ART.gpt.url,
				bubble: (ART.gpt && ART.gpt.bubble) || { left: 8, top: 9, width: 44, height: 23 },
				thumbPos: "62% 66%",
				ink: "#2A2444",
				inkSoft: "#6B6590",
				fill: "rgba(246, 245, 255, 0.86)",
				accent: "#0F9C7C",
				tokens: {
					light: { ink: "#1F2130", soft: "#5A5E75", tertiary: "#9498AB", brand: "#0F7F68", link: "#0E7A64" },
					dark: { ink: "#F2F3F8", soft: "#A9ADC0", tertiary: "#7A7E92", brand: "#5FD3B4", link: "#6FDCC0" }
				}
			}
		];

		const DEFAULT_CHARACTER = CHARACTERS[0].id;

		const zh = {
			"widget.title": "会话挂件",
			"widget.hint": "拖动立绘可移动 · 单击立绘开合面板",
			"widget.close": "收起面板",
			"widget.reset": "复位位置",
			"widget.rescue": "找回挂件",
			"widget.follow": "界面字体跟随角色",
			"widget.followHint": "开启后，全局文字与强调色随所选立绘变化。",
			"widget.visible": "显示挂件",
			"widget.scale": "缩放大小",
			"widget.bubble.idle": "等待会话…",
			"widget.bubble.tokens": "tokens",
			"widget.bubble.context": "上下文 {percent}%",
			"widget.bubble.session": "本会话",
			"widget.bubble.flip": "点击气泡可切换「用量 / 余额」",
			"widget.bubble.page": "气泡显示",
			"widget.bubble.pageAuto": "自动",
			"widget.bubble.pageTokens": "用量",
			"widget.bubble.pageBalance": "余额",
			"widget.balance": "账户余额",
			"widget.balance.label": "余额",
			"widget.balance.withBonus": "余额 · 赠金 {bonus}",
			"widget.balance.recharge": "充值余额",
			"widget.balance.bonus": "赠金",
			"widget.balance.loading": "读取中…",
			"widget.balance.signedOut": "未登录账号",
			"widget.balance.failed": "余额读取失败",
			"widget.balance.empty": "账号下没有钱包",
			"widget.balance.refresh": "刷新余额",
			"widget.balance.hint": "余额来自 DeepSeek 账号，每 10 分钟自动刷新；点 ⟳ 立即读取。",
			"row.title": "会话挂件",
			"row.hint": "在窗口右下角挂一只角色立绘：气泡在「token 用量」与「账户余额」两页间切换（默认自动翻页，点气泡可手动切）。点击面板可切换立绘，字体配色随角色主题。",
			"row.rescueHint": "挂件被拖到看不见的地方时，点左边的「找回挂件」让它回到右下角；也可以随时按 Ctrl+Alt+H。窗口尺寸变化把它挤出可视区时会自动回来。"
		};
		const en = {
			"widget.title": "Session pet",
			"widget.hint": "Drag to move · click the art to toggle the panel",
			"widget.close": "Close panel",
			"widget.reset": "Reset position",
			"widget.rescue": "Bring it back",
			"widget.follow": "Follow character theme",
			"widget.followHint": "When on, interface text and accent colors follow the selected character.",
			"widget.visible": "Show widget",
			"widget.scale": "Scale size",
			"widget.bubble.idle": "waiting…",
			"widget.bubble.tokens": "tokens",
			"widget.bubble.context": "context {percent}%",
			"widget.bubble.session": "session",
			"widget.bubble.flip": "Click the bubble to switch between usage and balance",
			"widget.bubble.page": "Bubble shows",
			"widget.bubble.pageAuto": "Auto",
			"widget.bubble.pageTokens": "Usage",
			"widget.bubble.pageBalance": "Balance",
			"widget.balance": "Account balance",
			"widget.balance.label": "balance",
			"widget.balance.withBonus": "balance · bonus {bonus}",
			"widget.balance.recharge": "Credit",
			"widget.balance.bonus": "Bonus",
			"widget.balance.loading": "loading…",
			"widget.balance.signedOut": "not signed in",
			"widget.balance.failed": "balance read failed",
			"widget.balance.empty": "no wallet on this account",
			"widget.balance.refresh": "Refresh balance",
			"widget.balance.hint": "Balance comes from your DeepSeek account; it refreshes every 10 minutes. Click ⟳ to read it now.",
			"row.title": "Session pet",
			"row.hint": "A character widget in the bottom-right corner. Its bubble flips between token usage and account balance (auto by default; click the bubble to switch by hand). Open the panel to change art; text colors follow the character theme.",
			"row.rescueHint": "If the widget ends up out of sight, click “Bring it back” to send it to the bottom-right corner, or press Ctrl+Alt+H at any time. Shrinking the window brings it back automatically."
		};

		/* ─────────────────────────── 持久化 ─────────────────────────── */

		function findCharacter(id) {
			return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
		}

		/** 气泡的三种显示方式。`auto` 表示两页自动轮播。 */
		const BUBBLE_PAGES = ["auto", "tokens", "balance"];

		function readSaved() {
			const fallback = {
				characterId: DEFAULT_CHARACTER,
				follow: true,
				visible: true,
				pos: null,
				scale: 1,
				bubblePage: "auto"
			};
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (raw === null) return fallback;
				const parsed = JSON.parse(raw);
				// 早期版本把这个角色名写成了 ZLM（笔误），旧存档里存的就是那个值。
				// 读到旧值就迁移过来，否则用户的选择会悄悄掉回第一个角色。
				if (parsed.characterId === "zlm") parsed.characterId = "glm";
				const characterId = CHARACTERS.some((c) => c.id === parsed.characterId)
					? parsed.characterId
					: DEFAULT_CHARACTER;
				const pos =
					parsed.pos && typeof parsed.pos.x === "number" && typeof parsed.pos.y === "number"
						? { x: parsed.pos.x, y: parsed.pos.y }
						: null;
				const scale = typeof parsed.scale === "number" ? Math.max(0.5, Math.min(2, parsed.scale)) : 1;
				const bubblePage = BUBBLE_PAGES.includes(parsed.bubblePage) ? parsed.bubblePage : "auto";
				return {
					characterId,
					follow: parsed.follow !== false,
					visible: parsed.visible !== false,
					pos,
					scale,
					bubblePage
				};
			} catch {
				return fallback;
			}
		}

		function writeSaved(state) {
			try {
				window.localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({
						characterId: state.characterId,
						follow: state.follow,
						visible: state.visible,
						pos: state.pos,
						scale: state.scale,
						bubblePage: state.bubblePage
					})
				);
			} catch {
				/* 隐私模式：忽略 */
			}
		}

		/* ─────────────────────── 界面字体 / 强调色 ─────────────────────── */

		/** 只覆盖「字体 + 强调色」相关的 token，背景与材质保持原生。 */
		function tokensOf(character) {
			const { light, dark } = character.tokens;
			const pair = (l, d) => ({ light: l, dark: d });
			return {
				"--dsw-alias-label-primary": pair(light.ink, dark.ink),
				"--dsw-alias-label-secondary": pair(light.soft, dark.soft),
				"--dsw-alias-label-tertiary": pair(light.tertiary, dark.tertiary),
				"--dsw-alias-brand-primary": pair(light.brand, dark.brand),
				"--dsw-alias-brand-text": pair(light.link, dark.link),
				"--dsw-alias-link": pair(light.link, dark.link),
				"--dsw-alias-state-business-primary": pair(light.brand, dark.brand),
				"--dsw-focus-ring-color": pair(light.brand, dark.brand)
			};
		}

		function applyThemeLayer(ctx, characterId, follow) {
			const character = findCharacter(characterId);
			ctx.theme.overrideTokens(PLUGIN_ID, follow ? tokensOf(character) : {});
		}

		/* ─────────────────────── 会话 token 用量 ─────────────────────── */

		function projectionSource(binding, key) {
			const projections = binding && binding.session && binding.session.projections;
			if (!projections || typeof projections.faceOf !== "function") return null;
			let source = null;
			try {
				source = projections.faceOf(key);
			} catch {
				return null;
			}
			return source && typeof source.getSnapshot === "function" ? source : null;
		}

		function subscribeSource(source, listener) {
			if (!source || typeof source.subscribe !== "function") return () => {};
			const dispose = source.subscribe(listener);
			return typeof dispose === "function" ? dispose : () => {};
		}

		function formatCount(value) {
			if (typeof value !== "number" || !isFinite(value) || value <= 0) return "0";
			if (value >= 1000000) return (value / 1000000).toFixed(2) + "M";
			if (value >= 10000) return (value / 1000).toFixed(1) + "k";
			return Math.round(value).toLocaleString("en-US");
		}

		/* ─────────────────────── 账户余额 ─────────────────────── */

		/** 货币符号；遇到没见过的币种就把代码原样带上，别假装它是美元。 */
		function currencySymbol(currency) {
			if (currency === "CNY") return "¥";
			if (currency === "USD") return "$";
			return typeof currency === "string" && currency.length > 0 ? currency + " " : "";
		}

		/** 千分位分组：只作用于整数部分，小数点后不动。 */
		function groupDigits(text) {
			const dot = text.indexOf(".");
			const head = dot === -1 ? text : text.slice(0, dot);
			const tail = dot === -1 ? "" : text.slice(dot);
			return head.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + tail;
		}

		/**
		 * 按 Platform Web 的金额规则渲染。
		 *
		 * 规则照抄 DSH 账号设置页的约定（`dsh-client-ui-settings-account`）：
		 *   - 正金额**截断**到分（不是四舍五入）—— 实测账号余额是
		 *     `5.7753636800000000`，显示成 `¥5.77`；
		 *   - 正金额小于一分显示 `<0.01`；
		 *   - 负金额四舍五入，且显示的绝对值至少 0.01。
		 *
		 * 余额字符串可能带科学计数法（平台会给出 `0E-16` 这种），所以先过 Number。
		 */
		function formatMoney(raw, currency) {
			const symbol = currencySymbol(currency);
			const text = String(raw ?? "").trim();
			if (text.length === 0) return symbol + "0.00";
			const value = Number(text);
			// 上游给了怪东西（NaN/Infinity/非数字）就原样显示，不要伪造一个金额出来。
			if (!isFinite(value)) return symbol + text;
			const abs = Math.abs(value);
			if (abs === 0) return symbol + "0.00";
			if (abs < 0.01) return (value < 0 ? "-" : "") + symbol + "<0.01";
			if (value > 0) return symbol + groupDigits((Math.floor(value * 100) / 100).toFixed(2));
			const rounded = Math.round(value * 100) / 100;
			const magnitude = Math.abs(rounded) < 0.01 ? 0.01 : Math.abs(rounded);
			return "-" + symbol + groupDigits(magnitude.toFixed(2));
		}

		/** 气泡「用量」页：本会话 token 总量 + 上下文占用。 */
		function tokensPage(snapshot, t) {
			const sample = snapshot.usage;
			if (!sample) return { big: "—", small: t("widget.bubble.idle") };
			const billed =
				(sample.uncachedInputTokens || 0) + (sample.cacheReadTokens || 0) + (sample.cacheWriteTokens || 0);
			const total = billed + (sample.outputTokens || 0);
			const pressure = snapshot.pressure || {};
			const window_ = pressure.contextWindow;
			const used = typeof pressure.projectedTokens === "number" ? pressure.projectedTokens : pressure.pressureTokens;
			let small = t("widget.bubble.tokens");
			if (typeof used === "number" && typeof window_ === "number" && window_ > 0) {
				const percent = Math.max(0, Math.min(999, Math.round((used / window_) * 100)));
				small = t("widget.bubble.tokens") + " · " + t("widget.bubble.context", { percent });
			}
			return { big: formatCount(total), small };
		}

		/**
		 * 气泡「余额」页：账号的充值余额（多币种时只放得下第一笔，其余在 title 里）。
		 *
		 * 「没登录」和「读不出来」都**不**画成 ¥0.00 —— 大号位置放 `—`、
		 * 小号位置说明原因，和面板里的措辞一致。
		 */
		function balancePage(snapshot, t) {
			const balance = snapshot.balance;
			if (balance === null || balance === undefined || balance.status === "loading") {
				return { big: "…", small: t("widget.balance.loading") };
			}
			if (balance.status === "signedOut") return { big: "—", small: t("widget.balance.signedOut") };
			if (balance.status === "failed") return { big: "—", small: t("widget.balance.failed") };
			const wallets = balance.wallets && balance.wallets.length > 0 ? balance.wallets : balance.bonusWallets || [];
			if (wallets.length === 0) return { big: "—", small: t("widget.balance.empty") };
			const bonus = (balance.bonusWallets || []).filter((wallet) => Number(wallet.balance) > 0);
			const small =
				bonus.length > 0
					? t("widget.balance.withBonus", {
							bonus: bonus.map((wallet) => formatMoney(wallet.balance, wallet.currency)).join(" · ")
						})
					: t("widget.balance.label");
			return {
				big: formatMoney(wallets[0].balance, wallets[0].currency),
				small,
				// 多币种时把其余的放进 tooltip，气泡本身只放得下两行。
				extra: wallets
					.slice(1)
					.map((wallet) => formatMoney(wallet.balance, wallet.currency))
					.join(" · ")
			};
		}

		/** 余额页是否有真内容 —— 决定自动翻页要不要真的翻过去。 */
		function balanceReady(snapshot) {
			return Boolean(snapshot.balance && snapshot.balance.status === "ready");
		}

		/**
		 * 当前该显示哪一页。
		 *
		 * 自动模式下**只有余额真的可用时**才可能翻到余额页：没有账号还翻过去，
		 * 用户只会看到一块写着「未登录」的空牌子在闪。用户手动选了某一页就尊重他的选择
		 * （哪怕选的是余额而余额读不出来 —— 那时显示原因才对）。
		 */
		function activePage(snapshot) {
			const chosen = BUBBLE_PAGES.includes(snapshot.bubblePage) ? snapshot.bubblePage : "auto";
			if (chosen === "auto") {
				return snapshot.autoPage === "balance" && balanceReady(snapshot) ? "balance" : "tokens";
			}
			return chosen;
		}

		/** 按当前页折出气泡要显示的内容。 */
		function deriveBubble(snapshot, t) {
			return activePage(snapshot) === "balance"
				? balancePage(snapshot, t)
				: tokensPage(snapshot, t);
		}

		/** 气泡显示方式的三选一（自动 / 用量 / 余额）。 */
		function BubblePagePicker(props) {
			const { value, onChange, t } = props;
			const options = [
				["auto", t("widget.bubble.pageAuto")],
				["tokens", t("widget.bubble.pageTokens")],
				["balance", t("widget.bubble.pageBalance")]
			];
			return h(
				"div",
				{ className: "tw-seg", role: "group", "aria-label": t("widget.bubble.page") },
				options.map(([id, label]) =>
					h(
						"button",
						{
							key: id,
							type: "button",
							"data-on": value === id ? "1" : "0",
							onClick: () => onChange(id)
						},
						label
					)
				)
			);
		}

		/**
		 * 面板和设置行共用的「气泡显示」一行。
		 *
		 * 类名刻意**不叫** `tw-bubble-page`：那会包含 `tw-bubble` 子串，
		 * 让任何按类名找气泡的代码（比如冒烟测试）找错元素。踩过一次。
		 */
		function BubblePageRow(props) {
			const { value, onChange, t, hint } = props;
			return h(
				"div",
				{ className: "tw-page-row" },
				h("div", { className: "tw-page-head" }, t("widget.bubble.page")),
				h(BubblePagePicker, { value, onChange, t }),
				hint ? h("div", { className: "tw-balance-hint" }, hint) : null
			);
		}

		/** 面板里的余额明细（充值 / 赠金分行）。 */
		function BalanceRows(props) {
			const { balance, t } = props;
			if (!balance || balance.status === "loading") {
				return h("div", { className: "tw-balance-empty" }, t("widget.balance.loading"));
			}
			if (balance.status === "signedOut") {
				return h("div", { className: "tw-balance-empty" }, t("widget.balance.signedOut"));
			}
			if (balance.status === "failed") {
				return h("div", { className: "tw-balance-empty" }, t("widget.balance.failed"));
			}
			const rows = [];
			for (const wallet of balance.wallets || []) {
				rows.push(
					h(
						"div",
						{ className: "tw-balance-row", key: "credit-" + wallet.currency },
						h("span", { className: "tw-balance-label" }, t("widget.balance.recharge")),
						h("span", { className: "tw-balance-amount" }, formatMoney(wallet.balance, wallet.currency))
					)
				);
			}
			// 赠金为 0 就不占一行 —— 账号设置页也是这个规矩（正额才显示赠金行）。
			for (const wallet of balance.bonusWallets || []) {
				if (!(Number(wallet.balance) > 0)) continue;
				rows.push(
					h(
						"div",
						{ className: "tw-balance-row", key: "bonus-" + wallet.currency },
						h("span", { className: "tw-balance-label" }, t("widget.balance.bonus")),
						h("span", { className: "tw-balance-amount" }, formatMoney(wallet.balance, wallet.currency))
					)
				);
			}
			if (rows.length === 0) {
				return h("div", { className: "tw-balance-empty" }, t("widget.balance.empty"));
			}
			return rows;
		}

		/* ─────────────────────────── 样式 ─────────────────────────── */

		const CSS = `
.tw-root {
  --tw-w: 264px;
  /* 面板宽度单独抽出来：拖动过位置时要靠它把面板挂到 root 的**左**边缘上
     （见下面 [data-tw-pos="free"] 那条规则）。 */
  --tw-panel-w: calc(var(--tw-w) * 0.94);
  --tw-scale: 1;
  position: absolute;
  z-index: 40;
  width: calc(var(--tw-w) * var(--tw-scale));
  font-size: calc(var(--tw-w) * var(--tw-scale) * 0.045);
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  transform-origin: top right;
}
.tw-root[data-tw-pos="bl"] { right: 18px; bottom: 96px; }
.tw-stage {
  position: relative;
  width: 100%;
  cursor: grab;
  pointer-events: auto;
  filter: drop-shadow(0 10px 22px rgba(20, 16, 40, 0.28));
  transition: transform 0.16s var(--ds-ease-in-out, ease);
}
.tw-stage:active { cursor: grabbing; }
.tw-stage.tw-dragging { transition: none !important; }
body[data-ds-dark-theme] .tw-stage { filter: drop-shadow(0 10px 22px rgba(0, 0, 0, 0.5)); }
.tw-art { display: block; width: 100%; height: auto; -webkit-user-drag: none; }
.tw-bubble {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.1em;
  border-radius: 50%;
  background: var(--tw-fill);
  text-align: center;
  /* 气泡现在是个可点的「翻页牌」：点它切换「用量 / 余额」。
     因此必须自己吃掉指针事件，否则点击会穿透到立绘上触发拖动 / 开合面板。 */
  pointer-events: auto;
  cursor: pointer;
  /* 两页文字长度不同，翻页时高度可能微变；裁剪一下免得糊到立绘脸上。 */
  overflow: hidden;
  transition: background 0.15s var(--ds-ease-in-out, ease);
}
.tw-bubble:hover { background: var(--tw-fill-strong, var(--tw-fill)); }
/* 翻页小圆点：让「这块牌子有两页」这件事看得见。 */
.tw-dots {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0.35em;
  display: flex;
  gap: 0.22em;
  pointer-events: none;
}
.tw-dot {
  width: 0.28em;
  height: 0.28em;
  border-radius: 50%;
  background: var(--tw-ink-soft);
  opacity: 0.3;
}
.tw-dot[data-on="1"] { opacity: 0.85; }
.tw-big {
  font-size: 1.25em;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--tw-ink);
  font-variant-numeric: tabular-nums;
}
.tw-small {
  font-size: 0.78em;
  font-weight: 600;
  color: var(--tw-ink-soft);
  white-space: nowrap;
}
.tw-collapse {
  position: absolute;
  top: 0.35em;
  right: 0.35em;
  width: 1.5em;
  height: 1.5em;
  border: none;
  border-radius: 999px;
  background: var(--dsw-specific-menu, rgba(255, 255, 255, 0.86));
  color: var(--dsw-alias-label-secondary);
  font-size: 0.85em;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s var(--ds-ease-in-out, ease);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}
.tw-root:hover .tw-collapse { opacity: 1; }
.tw-collapse:hover { color: var(--dsw-alias-label-primary); }

.tw-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% - 1.2em);
  width: var(--tw-panel-w);
  box-sizing: border-box;
  /*
   * 面板字号**必须固定**，绝不能继承 .tw-root 那个跟着 --tw-scale 走的字号。
   *
   * 这里修的是一个「拖动大小滑块会抽搐」的 bug，成因值得写下来：
   *   .tw-root 的 font-size = --tw-w × --tw-scale × 0.045，而面板的内边距、间距、
   *   标签全是 em —— 面板宽度却是固定的。于是拖动滑块时：
   *     缩放↑ → 面板字号↑ → em 内边距↑ → **滑块的可用轨道变窄** →
   *     浏览器按新的轨道重新换算光标处的取值 → 值↑ → 缩放再↑ ……
   *   一圈下来就是自激振荡，看起来就是抽搐。
   * （".tw-scale-value" 里的 "100%"→"200%" 文字变宽会再挤一次轨道，雪上加霜。）
   *
   * 面板是「界面」，不是立绘的一部分，本来就不该跟着立绘缩放。钉死字号之后，
   * 拖动滑块只改变立绘，面板的几何完全不动，反馈环就断了。
   */
  font-size: 12.5px;
  padding: 0.75em 0.85em 0.8em;
  border-radius: var(--dsw-radius-lg, 16px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  background: var(--dsw-specific-menu, rgba(255, 255, 255, 0.92));
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 14px 34px rgba(18, 14, 40, 0.24);
  pointer-events: auto;
  animation: tw-pop 0.14s var(--ds-ease-in-out, ease);
  /* 冻结解除时让面板**滑**回新位置而不是瞬移（拖动结束后的那一下归位）。 */
  transition: bottom 0.18s var(--ds-ease-in-out, ease);
}
/*
 * 挂件被拖动过之后，.tw-root 是**左**锚定的（left: pos.x），宽度却随 --tw-scale 变 ——
 * 也就是说它的**右边缘会横向平移**。面板要是继续挂 right: 0，就会跟着右边缘横移，
 * 缩放到 200% 时能漂出几百像素：滑块的整条轨道跟着跑，指针在屏幕上的位置映射到轨道上的
 * 相对位置就变了 → 取值变 → 缩放变 → 又漂…… 这是和字号那条同源的第二条自激回路。
 *
 * 所以按锚定方式选边：默认（右锚定）挂右边缘，拖动过（左锚定）挂左边缘。
 * 左右都用 --tw-panel-w / --tw-w 表达，与 --tw-scale 无关，于是两个方向都稳定。
 */
.tw-root[data-tw-pos="free"] .tw-panel {
  right: auto;
  left: calc(var(--tw-panel-w) * -1);
}
@keyframes tw-pop {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.tw-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.55em;
  font-size: 0.95em;
  font-weight: 700;
  color: var(--dsw-alias-label-primary);
}
.tw-panel-head button {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font-size: 1.05em;
  line-height: 1;
  padding: 0.1em 0.25em;
  border-radius: var(--dsw-radius-sm, 8px);
}
.tw-panel-head button:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }

.tw-chips { display: flex; flex-direction: column; gap: 0.3em; }
.tw-chip {
  display: flex;
  align-items: center;
  gap: 0.55em;
  width: 100%;
  box-sizing: border-box;
  padding: 0.32em 0.42em;
  border-radius: var(--dsw-radius-md, 12px);
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  text-align: left;
  font-size: 0.86em;
}
.tw-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.tw-chip[aria-pressed="true"] {
  border-color: var(--tw-accent);
  background: color-mix(in srgb, var(--tw-accent) 14%, transparent);
  color: var(--dsw-alias-label-primary);
}
.tw-thumb {
  width: 2.1em;
  height: 2.1em;
  flex: none;
  border-radius: 999px;
  object-fit: cover;
  object-position: 50% 20%;
  background: var(--dsw-alias-bg-skeleton, rgba(127,127,127,.16));
}
.tw-chip-text { min-width: 0; display: flex; flex-direction: column; }
.tw-chip-name { font-weight: 600; color: inherit; }
.tw-chip-hint { font-size: 0.78em; opacity: 0.72; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.tw-toggle {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin-top: 0.5em;
  font-size: 0.84em;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.tw-toggle input { accent-color: var(--tw-accent); cursor: pointer; }
.tw-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 0.6em; gap: 0.4em; }
.tw-reset {
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: var(--dsw-radius-md, 12px);
  padding: 0.3em 0.6em;
  font-size: 0.82em;
  cursor: pointer;
}
.tw-reset:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.tw-tip { font-size: 0.74em; color: var(--dsw-alias-label-tertiary); margin-top: 0.45em; }

.tw-row { display: flex; flex-direction: column; gap: 0.55em; }
.tw-row .tw-chips { flex-direction: row; flex-wrap: wrap; }
.tw-row .tw-chip { width: auto; padding: 0.28em 0.6em; font-size: 0.86em; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24)); }
.tw-row-title { font-size: 0.95em; font-weight: 600; color: var(--dsw-alias-label-primary); }
.tw-row-hint { font-size: 0.82em; color: var(--dsw-alias-label-tertiary); }

/* 缩放控制样式 */
.tw-scale-control {
  display: flex;
  align-items: center;
  gap: 0.4em;
  margin-top: 0.5em;
  font-size: 0.84em;
  color: var(--dsw-alias-label-secondary);
}
.tw-scale-control label { cursor: pointer; }
/*
 * 滑块必须是**弹性项**并且能收缩：轨道宽度只由面板宽度决定，
 * 绝不能再受 label / 数值文字的宽度影响 —— 那正是抽搐 bug 的第二条反馈路径。
 */
.tw-scale-control input[type="range"] {
  flex: 1 1 auto;
  min-width: 0;
  height: 4px;
  margin: 0;
  accent-color: var(--tw-accent);
  cursor: pointer;
}
/*
 * 数值读数用**固定宽度** + 等宽数字：否则 "50%" 到 "200%" 文字变宽会把滑块挤窄，
 * 拖动过程中轨道宽度跟着变，取值就会跟着跳。
 */
.tw-scale-value {
  flex: none;
  width: 3.4em;
  text-align: right;
  font-size: 0.9em;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

/* 三选一的分段选择器（气泡显示：自动 / 用量 / 余额） */
.tw-page-row { margin-top: 0.6em; }
.tw-page-head { margin-bottom: 0.1em; color: var(--dsw-alias-label-secondary); font-size: 0.84em; }
.tw-seg {
  display: inline-flex;
  margin-top: 0.35em;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  overflow: hidden;
}
.tw-seg button {
  font: inherit;
  font-size: 0.95em;
  padding: 0.2em 0.6em;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.tw-seg button + button { border-left: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22)); }
.tw-seg button[data-on="1"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14));
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

/* 账户余额区 */
.tw-balance {
  margin-top: 0.6em;
  padding-top: 0.55em;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18));
  font-size: 0.84em;
  color: var(--dsw-alias-label-secondary);
}
.tw-balance-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.3em;
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.tw-balance-refresh {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font-size: 1.05em;
  line-height: 1;
  padding: 0.1em 0.3em;
  border-radius: var(--dsw-radius-sm, 8px);
}
.tw-balance-refresh:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.tw-balance-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5em;
  padding: 0.12em 0;
}
.tw-balance-label { color: var(--dsw-alias-label-secondary); }
.tw-balance-amount {
  color: var(--dsw-alias-label-primary);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.tw-balance-empty { color: var(--dsw-alias-label-tertiary); padding: 0.1em 0; }
.tw-balance-hint {
  margin-top: 0.3em;
  font-size: 0.9em;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.4;
}
`;

		/* ─────────────────────────── 组件 ─────────────────────────── */

		const h = React.createElement;

		/* ───────────────────── 把挂件找回来 ───────────────────── */

		/**
		 * 挂件至少要有这么多像素留在可视区里；少于此数就算「跑到页面外了」。
		 * 48 ≈ 立绘宽度的六分之一，既看得见也点得中。
		 */
		const KEEP_VISIBLE = 48;

		/** 视口尺寸；宿主还没量出窗口（0 或缺失）时返回 `null`，调用方一律放行。 */
		function viewportOf() {
			if (typeof window === "undefined") return null;
			const width = typeof window.innerWidth === "number" ? window.innerWidth : 0;
			const height = typeof window.innerHeight === "number" ? window.innerHeight : 0;
			return width > 0 && height > 0 ? { width, height } : null;
		}

		/** 盒子在某一轴上与可视区重叠的长度（完全在外侧时为负数）。 */
		function visibleSpan(start, size, limit) {
			return Math.min(start + size, limit) - Math.max(start, 0);
		}

		/**
		 * 盒子是不是基本跑出可视区了。
		 *
		 * 某一轴的尺寸量不到时（立绘还没解码、挂件随着路由卸载后盒子是 0×0）那一轴放行：
		 * 否则刚挂载的那一瞬间会被误判成「丢了」，用户摆好的位置会被莫名其妙复位。
		 */
		function isBoxLost(box, viewport) {
			if (!box || !viewport) return false;
			if (box.width > 0 && visibleSpan(box.left, box.width, viewport.width) < Math.min(KEEP_VISIBLE, box.width)) {
				return true;
			}
			if (box.height > 0 && visibleSpan(box.top, box.height, viewport.height) < Math.min(KEEP_VISIBLE, box.height)) {
				return true;
			}
			return false;
		}

		/** 拖动时把坐标钳在可视区边缘之内 —— 直接拖不丢，比拖丢之后再找回体面。 */
		function clampToViewport(x, y, size, viewport) {
			if (!size || !viewport) return { x, y };
			const axis = (value, boxSize, limit) => {
				// 量不到尺寸（宿主没 DOM）就别乱钳，保持原来的自由拖动。
				if (!(boxSize > 0)) return Math.round(value);
				const keep = Math.min(KEEP_VISIBLE, boxSize);
				const low = keep - boxSize;
				const high = limit - keep;
				// 窗口比挂件还窄：居中摆，两边一样多，至少不会整块消失。
				if (low > high) return Math.round((limit - boxSize) / 2);
				return Math.round(Math.min(Math.max(value, low), high));
			};
			return { x: axis(x, size.width, viewport.width), y: axis(y, size.height, viewport.height) };
		}

		/**
		 * 量挂件当前的实际盒子（视口坐标）。
		 *
		 * `shown` 为假时量的是那个圆钮 `.tw-collapse` —— 隐藏状态下 `.tw-root` 的高度是 0，量了没用。
		 * 宿主没有 DOM（冒烟测试）时返回 `null`，调用方一律放行。
		 */
		function measureWidgetBox(shown) {
			if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
			const node = document.querySelector(shown ? ".tw-root" : ".tw-collapse");
			if (!node || typeof node.getBoundingClientRect !== "function") return null;
			const rect = node.getBoundingClientRect();
			if (!rect) return null;
			return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
		}

		/**
		 * 从指针事件里量出 `.tw-root` 的高度。
		 *
		 * 用 `closest` 而不是 ref：拖动立绘的代码本来就是这个写法（`event.currentTarget.closest`），
		 * 而且这样测试可以用一个假事件驱动它，不需要真 DOM。
		 */
		function measureRootHeight(event) {
			const root =
				event && event.currentTarget && typeof event.currentTarget.closest === "function"
					? event.currentTarget.closest(".tw-root")
					: null;
			if (root === null || root === undefined || typeof root.getBoundingClientRect !== "function") return null;
			const rect = root.getBoundingClientRect();
			return rect && rect.height > 0 ? rect.height : null;
		}

		function rootStyle(character, pos, scale) {
			const style = {
				"--tw-fill": character.fill,
				"--tw-ink": character.ink,
				"--tw-ink-soft": character.inkSoft,
				"--tw-accent": character.accent,
				"--tw-scale": scale
			};
			if (pos) {
				style.left = pos.x + "px";
				style.top = pos.y + "px";
				style.right = "auto";
				style.bottom = "auto";
			}
			return style;
		}

		function CharacterChips(props) {
			const { current, choose, t, variant } = props;
			return h(
				"div",
				{ className: "tw-chips" },
				CHARACTERS.map((character) =>
					h(
						"button",
						{
							key: character.id,
							type: "button",
							className: "tw-chip",
							"aria-pressed": current === character.id,
							title: character.hint,
							style: { "--tw-accent": character.accent },
							onClick: () => choose(character.id)
						},
						h("img", {
							className: "tw-thumb",
							src: character.art,
							alt: "",
							style: character.thumbPos ? { objectPosition: character.thumbPos } : undefined
						}),
						variant === "row"
							? h("span", { className: "tw-chip-name" }, character.name)
							: h(
									"span",
									{ className: "tw-chip-text" },
									h("span", { className: "tw-chip-name" }, character.name),
									h("span", { className: "tw-chip-hint" }, character.hint)
								)
					)
				)
			);
		}

		/**
		 * 悬浮挂件本体：挂在 shell.overlay（root scope）里，铺在整窗浮层上。
		 * 拖动移动，单击开合面板；气泡里的两行数字来自本会话的 token 投影。
		 */
		function TokenWidget(props) {
			const { useWidget, choose, setFollow, setVisible, togglePanel, setPos, resetPos, rescue, setScale, setBubblePage, flipBubblePage, freezePanel, releasePanel, refreshBalance, t } = props;
			const state = useWidget((value) => value);
			const [, setDragging] = React.useState(false);
			const [isDraggingClass, setIsDraggingClass] = React.useState('');
			const dragRef = React.useRef(null);
			const movedRef = React.useRef(false);

			const character = findCharacter(state.characterId);
			const bubble = deriveBubble(state, t);
			const page = activePage(state);
			const showDots = balanceReady(state);

			// 冻结期间面板用实测的像素高度定位（等价于原来的 `bottom: calc(100% - 1.2em)`，
			// 只是把那个会随缩放变化的 100% 换成一个定值）。
			const panelStyle =
				state.frozenRootHeight === null ? undefined : { bottom: `calc(${state.frozenRootHeight}px - 1.2em)` };

			// 打开面板就顺手读一次余额：用户点开多半就是想看它，不该等下一个十分钟。
			const panelOpen = state.panelOpen;
			React.useEffect(() => {
				if (panelOpen) refreshBalance();
			}, [panelOpen]);

			// 冻结的兜底释放：指针在别处抬起（拖出滑块、切窗口……）也要恢复，
			// 否则面板会永远停在旧高度上。
			const frozen = state.frozenRootHeight;
			React.useEffect(() => {
				if (frozen === null) return undefined;
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const release = () => releasePanel();
				window.addEventListener("pointerup", release);
				window.addEventListener("pointercancel", release);
				return () => {
					window.removeEventListener("pointerup", release);
					window.removeEventListener("pointercancel", release);
				};
			}, [frozen]);

			/**
			 * 挂件跑出可视区了吗？是就把它叫回右下角。
			 *
			 * 只在「量得到、且确实丢了」时动手：宿主没 DOM、盒子是 0×0（还没布局 / 被路由卸载）
			 * 都直接放行 —— 绝不因为量不准而复位用户摆好的位置。
			 */
			const rescueIfLost = React.useCallback(() => {
				const viewport = viewportOf();
				if (!viewport) return;
				if (!isBoxLost(measureWidgetBox(state.visible), viewport)) return;
				rescue();
			}, [rescue, state.visible]);

			// 窗口尺寸 / 朝向变化把挂件挤出可视区时自动找回，用户什么都不用做。
			// 顺带覆盖「上次留下的坐标已经不在屏幕里」这种存档残留（挂载时先查一次）。
			React.useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				let frame = null;
				const check = () => {
					frame = null;
					rescueIfLost();
				};
				const schedule = () => {
					// 量盒子要等布局落定：在 resize 回调里立刻量，拿到的还是旧尺寸。
					if (typeof requestAnimationFrame === "function") {
						if (frame === null) frame = requestAnimationFrame(check);
						return;
					}
					check();
				};
				schedule();
				window.addEventListener("resize", schedule);
				window.addEventListener("orientationchange", schedule);
				return () => {
					if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
					window.removeEventListener("resize", schedule);
					window.removeEventListener("orientationchange", schedule);
				};
			}, [rescueIfLost]);

			const onPointerDown = React.useCallback((event) => {
				if (event.button !== 0) return;
				const root = event.currentTarget.closest(".tw-root");
				const rect = root ? root.getBoundingClientRect() : { left: 0, top: 0 };
				dragRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					baseX: rect.left,
					baseY: rect.top,
					size: { width: rect.width, height: rect.height }
				};
				movedRef.current = false;
				setDragging(true);
				setIsDraggingClass(' tw-dragging');
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					/* 老浏览器忽略 */
				}
			}, []);

			const onPointerMove = React.useCallback(
				(event) => {
					const drag = dragRef.current;
					if (!drag) return;
					const dx = event.clientX - drag.startX;
					const dy = event.clientY - drag.startY;
					if (!movedRef.current && Math.abs(dx) + Math.abs(dy) < 4) return;
					movedRef.current = true;
					// 拖动时就钳住：至少留 KEEP_VISIBLE 像素在窗口里，不用等松手再找回。
					setPos(clampToViewport(drag.baseX + dx, drag.baseY + dy, drag.size, viewportOf()));
				},
				[setPos]
			);

			const onPointerUp = React.useCallback(
				(event) => {
					const drag = dragRef.current;
					dragRef.current = null;
					setDragging(false);
					setIsDraggingClass('');
					try {
						event.currentTarget.releasePointerCapture(event.pointerId);
					} catch {
						/* 忽略 */
					}
					// 没拖动 = 单击立绘 → 开合面板
					if (!movedRef.current && drag) togglePanel();
				},
				[togglePanel]
			);

			if (!state.visible) {
				return h(
					"div",
					{
						className: "tw-root",
						"data-tw-pos": state.pos ? "free" : "bl",
						style: rootStyle(character, state.pos, state.scale)
					},
					h(
						"button",
						{
							type: "button",
							className: "tw-collapse",
							style: {
								opacity: 1,
								position: "absolute",
								top: "auto",
								bottom: "1.6em",
								right: "1.6em",
								width: "2.4em",
								height: "2.4em",
								fontSize: "1em",
								pointerEvents: "auto"
							},
							title: t("widget.visible"),
							onClick: () => setVisible(true)
						},
						"◍"
					)
				);
			}

			const bubbleStyle = {
				left: character.bubble.left + "%",
				top: character.bubble.top + "%",
				width: character.bubble.width + "%",
				height: character.bubble.height + "%"
			};

			/**
			 * 气泡自己吃掉指针事件。
			 *
			 * 气泡是 `.tw-stage` 的子节点，而拖动与「点立绘开合面板」都挂在 stage 上。
			 * 不阻断的话，点气泡会同时触发 stage 的 pointerdown → 拖动 / 开合面板。
			 */
			const bubblePointer = {
				onPointerDown: (event) => event.stopPropagation(),
				onPointerMove: (event) => event.stopPropagation(),
				onPointerUp: (event) => event.stopPropagation(),
				onPointerCancel: (event) => event.stopPropagation(),
				onClick: (event) => {
					event.stopPropagation();
					flipBubblePage();
				}
			};
			const bubbleTitle =
				(page === "balance" ? t("widget.bubble.pageBalance") : t("widget.bubble.pageTokens")) +
				(bubble.extra ? " · " + bubble.extra : "") +
				" — " +
				t("widget.bubble.flip");

			return h(
				"div",
				{
					className: "tw-root",
					"data-tw-pos": state.pos ? "free" : "bl",
					style: rootStyle(character, state.pos, state.scale)
				},
				state.panelOpen
					? h(
							"div",
							{ className: "tw-panel", style: panelStyle },
							h(
								"div",
								{ className: "tw-panel-head" },
								h("span", null, t("widget.title")),
								h(
									"button",
									{ type: "button", title: t("widget.close"), onClick: () => togglePanel() },
									"✕"
								)
							),
							h(CharacterChips, { current: state.characterId, choose, t }),
							h(
								"label",
								{ className: "tw-toggle" },
								h("input", {
									type: "checkbox",
									checked: state.follow,
									onChange: (event) => setFollow(event.target.checked)
								}),
								t("widget.follow")
							),
							h(
								"label",
								{ className: "tw-toggle" },
								h("input", {
									type: "checkbox",
									checked: state.visible,
									onChange: (event) => setVisible(event.target.checked)
								}),
								t("widget.visible")
							),
							h(
								"div",
								{ className: "tw-scale-control" },
								h("label", null, t("widget.scale")),
								h("input", {
									type: "range",
									min: "0.5",
									max: "2",
									step: "0.1",
									value: state.scale,
									// 按下滑块先量一次立绘高度把面板钉住：拖动过程中面板不再移动，
									// 滑块始终待在光标下面。松开 / 取消 / 失焦都恢复。
									onPointerDown: (event) => {
										const height = measureRootHeight(event);
										if (height !== null) freezePanel(height);
									},
									onPointerUp: () => releasePanel(),
									onPointerCancel: () => releasePanel(),
									onBlur: () => releasePanel(),
									onChange: (event) => setScale(parseFloat(event.target.value))
								}),
								h("span", { className: "tw-scale-value" }, Math.round(state.scale * 100) + "%")
							),
							h(
								"div",
								{ className: "tw-balance" },
								h(
									"div",
									{ className: "tw-balance-head" },
									h("span", null, t("widget.balance")),
									h(
										"button",
										{
											type: "button",
											className: "tw-balance-refresh",
											title: t("widget.balance.refresh"),
											onClick: () => refreshBalance()
										},
										"⟳"
									)
								),
								h(BalanceRows, { balance: state.balance, t }),
								h("div", { className: "tw-balance-hint" }, t("widget.balance.hint"))
							),
							h(BubblePageRow, {
								value: state.bubblePage,
								onChange: (next) => setBubblePage(next),
								t
							}),
							h(
								"div",
								{ className: "tw-actions" },
								h("button", { type: "button", className: "tw-reset", onClick: () => resetPos() }, t("widget.reset")),
								h("span", { className: "tw-tip" }, t("widget.hint"))
							)
						)
					: null,
				h(
					"div",
					{
						className: "tw-stage" + isDraggingClass,
						onPointerDown,
						onPointerMove,
						onPointerUp,
						onPointerCancel: onPointerUp,
						title: t("widget.hint")
					},
					// 立绘解码完才量得准高度（在那之前盒子高 0，`isBoxLost` 会放行 Y 轴），
					// 所以图一就位就补查一次：这正是「存档里的坐标已经不在屏幕里」的兜底时机。
					h("img", {
						className: "tw-art",
						src: character.art,
						alt: character.name,
						draggable: false,
						onLoad: () => rescueIfLost()
					}),
					h(
						"div",
						{
							className: "tw-bubble",
							style: bubbleStyle,
							title: bubbleTitle,
							role: "button",
							tabIndex: 0,
							"aria-label": bubbleTitle,
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									flipBubblePage();
								}
							},
							...bubblePointer
						},
						h("div", { className: "tw-big" }, bubble.big),
						h("div", { className: "tw-small" }, bubble.small),
						// 有两个可看的页面时才画小圆点；只有用量页时画了反而像故障。
						showDots
							? h(
									"div",
									{ className: "tw-dots" },
									h("span", { className: "tw-dot", "data-on": page === "tokens" ? "1" : "0" }),
									h("span", { className: "tw-dot", "data-on": page === "balance" ? "1" : "0" })
								)
							: null
					)
				)
			);
		}

		/** 「设置 → 通用」里的一行：同一套状态，供挂件找不到时也能切换。 */
		function WidgetSettingsRow(props) {
			const { useWidget, choose, setFollow, setVisible, setScale, setBubblePage, rescue, t } = props;
			const state = useWidget((value) => value);
			return h(
				"div",
				{ className: "tw-row" },
				h("div", { className: "tw-row-title" }, t("row.title")),
				h(CharacterChips, { current: state.characterId, choose, t, variant: "row" }),
				h(
					"label",
					{ className: "tw-toggle" },
					h("input", {
						type: "checkbox",
						checked: state.follow,
						onChange: (event) => setFollow(event.target.checked)
					}),
					t("widget.follow")
				),
				h(
					"label",
					{ className: "tw-toggle" },
					h("input", {
						type: "checkbox",
						checked: state.visible,
						onChange: (event) => setVisible(event.target.checked)
					}),
					t("widget.visible")
				),
				h(BubblePageRow, {
					value: state.bubblePage,
					onChange: (next) => setBubblePage(next),
					t
				}),
				h(
					"div",
					{ className: "tw-scale-control" },
					h("label", null, t("widget.scale")),
					h("input", {
						type: "range",
						min: "0.5",
						max: "2",
						step: "0.1",
						value: state.scale,
						onChange: (event) => setScale(parseFloat(event.target.value))
					}),
					h("span", { className: "tw-scale-value" }, Math.round(state.scale * 100) + "%")
				),
				// 挂件跑出可视区时的救命按钮：设置页永远进得来，所以这一个入口必须在。
				h(
					"div",
					{ className: "tw-actions" },
					h("button", { type: "button", className: "tw-reset", onClick: () => rescue() }, t("widget.rescue")),
					h("span", { className: "tw-tip" }, t("row.rescueHint"))
				),
				h("div", { className: "tw-row-hint" }, t("row.hint"))
			);
		}

		/* ─────────────────────────── 安装 ─────────────────────────── */

		/** 注入本插件持有的全局样式表，随插件生命周期装卸。 */
		function installStyles(ctx) {
			if (typeof document === "undefined") return;
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.dataset.pluginCss = PLUGIN_ID + "/token-widget.css";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "token-widget: stylesheet");
		}

		function createWidgetStore() {
			const saved = readSaved();
			return store.defineStore({
				init: () => ({
					characterId: saved.characterId,
					follow: saved.follow,
					visible: saved.visible,
					pos: saved.pos,
					scale: saved.scale,
					/** 气泡显示哪一页：`auto`（轮播）/ `tokens` / `balance`。 */
					bubblePage: saved.bubblePage,
					/** 轮播游标，只在 `bubblePage === "auto"` 时有意义。 */
					autoPage: "tokens",
					/**
					 * 拖动大小滑块期间冻结的面板高度（px）；`null` = 跟着立绘实时变化。
					 *
					 * 面板是「浮在立绘头顶」的，而立绘高度随缩放变 —— 拖动滑块时面板会一路往上滑，
					 * 滑块从光标底下跑掉，看起来就是整个界面在抽搐。
					 * 所以在按下滑块的那一刻量一次高度、把面板钉住，松手再平滑归位。
					 * 这是**瞬时**状态，不写进 localStorage。
					 */
					frozenRootHeight: null,
					panelOpen: false,
					sessionId: null,
					usage: null,
					pressure: null,
					/**
					 * 账户余额快照：
					 *   { status: "loading" | "ready" | "signedOut" | "failed",
					 *     wallets: Wallet[], bonusWallets: Wallet[], at: number }
					 * Wallet = { currency: "CNY" | "USD", balance: "12.34" }
					 */
					balance: null
				}),
				actions: {
					choose: (d, id) => {
						if (!CHARACTERS.some((c) => c.id === id)) return;
						if (d.characterId === id) return;
						d.characterId = id;
						writeSaved(d);
					},
					setFollow: (d, value) => {
						const next = value !== false;
						if (d.follow === next) return;
						d.follow = next;
						writeSaved(d);
					},
					setVisible: (d, value) => {
						const next = value !== false;
						if (d.visible === next) return;
						d.visible = next;
						writeSaved(d);
					},
					setScale: (d, value) => {
						// 量化到 0.1（滑块自己的步进）：避免浮点噪声让受控 input 的
						// value 和浏览器里那个值对不上，那样 React 每次都会回写一次，
						// 拇指会跟着轻微跳动。
						const parsed = parseFloat(value);
						const next = Math.max(0.5, Math.min(2, Math.round((Number.isFinite(parsed) ? parsed : 1) * 10) / 10));
						if (d.scale === next) return;
						d.scale = next;
						writeSaved(d);
					},
					togglePanel: (d) => {
						d.panelOpen = !d.panelOpen;
					},
					/** 按下滑块时把面板钉在当前高度上（`height` 为实测 px）。 */
					freezePanel: (d, height) => {
						const next = typeof height === "number" && height > 0 ? Math.round(height) : null;
						if (next === null || d.frozenRootHeight === next) return;
						d.frozenRootHeight = next;
					},
					/** 松手：面板恢复跟随立绘（CSS 上带过渡，所以是滑回去而不是跳回去）。 */
					releasePanel: (d) => {
						if (d.frozenRootHeight === null) return;
						d.frozenRootHeight = null;
					},
					setPos: (d, pos) => {
						const next =
							pos && typeof pos.x === "number" && typeof pos.y === "number"
								? { x: Math.round(pos.x), y: Math.round(pos.y) }
								: null;
						if (d.pos && next && d.pos.x === next.x && d.pos.y === next.y) return;
						if (!d.pos && !next) return;
						d.pos = next;
						writeSaved(d);
					},
					resetPos: (d) => {
						if (!d.pos) return;
						d.pos = null;
						writeSaved(d);
					},
					/**
					 * 找回挂件：显示出来 + 回到右下角那个锚点。
					 *
					 * 不复用 `resetPos`，因为「跑丢了」时用户首先需要它**出现**：
					 * 可能是被关掉了（`visible === false`），也可能只是被拖到了窗口外面。
					 * 幂等：已经在家（显示中且没有自由坐标）就直接返回。
					 */
					rescue: (d) => {
						if (d.visible && !d.pos) return;
						d.visible = true;
						d.pos = null;
						writeSaved(d);
					},
					feed: (d, payload) => {
						if (d.sessionId === payload.sessionId && d.usage === payload.usage && d.pressure === payload.pressure) return;
						d.sessionId = payload.sessionId;
						d.usage = payload.usage;
						d.pressure = payload.pressure;
					},
					setBubblePage: (d, value) => {
						const next = BUBBLE_PAGES.includes(value) ? value : "auto";
						if (d.bubblePage === next) return;
						d.bubblePage = next;
						// 手动选到某一页时，轮播游标也跟着对齐 ——
						// 这样之后切回「自动」不会先跳一下再翻。
						if (next !== "auto") d.autoPage = next;
						writeSaved(d);
					},
					/**
					 * 点气泡：翻到下一页并**固定住**。
					 *
					 * 处在自动轮播时，「下一页」以当前显示的那页为基准。
					 * 固定而不是继续轮播，是因为用户点了就说明他想停在这一页看。
					 */
					flipBubblePage: (d) => {
						const shown = activePage(d);
						const next = shown === "balance" ? "tokens" : "balance";
						d.bubblePage = next;
						d.autoPage = next;
						writeSaved(d);
					},
					/** 轮播游标前进一格（由 apply 里的定时器驱动）。 */
					flipAutoPage: (d) => {
						if (d.bubblePage !== "auto") return;
						d.autoPage = d.autoPage === "balance" ? "tokens" : "balance";
					},
					feedBalance: (d, payload) => {
						// 这里**不能**按 `at`（Date.now()）去重：先喂 loading、再喂结果，
						// 两次很可能落在同一毫秒里，去重会把真正的结果丢掉，
						// 气泡就永远停在「读取中…」。（冒烟测试实测撞到过。）
						// 读取本身已经足够稀疏（10 分钟一次 + 手动），重复写入不值得优化。
						d.balance = payload;
					}
				}
			});
		}

		const inject = ["slots", "locale", "theme", "sessions", "uiWorkspace"];

		/**
		 * 账户余额读取。
		 *
		 * 刻意 **不** 把 `remote` / `remote.account` 加进上面那个插件级 `inject`：
		 * 插件级 inject 缺一个服务就整个插件不加载 —— 那会让「账户服务不在的部署里
		 * 连挂件都没了」。余额是增值信息，放在可选子作用域里，没有就安静地不做。
		 *
		 * @param onReady 把「立即读取」的回调交回给 apply，供面板上的刷新按钮用。
		 */
		function installBalance(ctx, instance, actions, onReady) {
			// 双保险：余额是增值功能，它出的任何问题都不该冒泡成「挂件加载失败」。
			// （冒烟测试里就撞到过一次：宿主环境缺 setInterval 时，异常从 apply 逃了出去，
			//   结果连立绘和面板都没注册上。）
			try {
				ctx.inject(["remote", "remote.account"], (scope) => {
					let inFlight = null;

					/** 调用 account Remote 时随身携带的界面身份。 */
					const clientMetadata = () => {
						let locale = "zh";
						try {
							const active = ctx.locale.getSnapshot().active;
							if (typeof active === "string" && active.length > 0) locale = active;
						} catch {
							/* 拿不到就用默认语言，这只是上报给平台的元信息 */
						}
						return {
							version: CLIENT_VERSION,
							locale,
							timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
						};
					};

					const read = () => {
						if (inFlight !== null) return inFlight;
						// 只有「还没有可用余额」时才切到「读取中…」。
						//
						// 定时刷新时如果无条件重置成 loading，已经显示出来的余额会先变成
						// 「读取中…」再变回来 —— 每十分钟闪一次；自动轮播也会跟着闪回用量页。
						// 拿旧值撑到新值回来才是对的做法（读失败时会明确变成「读取失败」）。
						const previous = instance.getSnapshot().balance;
						if (!(previous && previous.status === "ready")) {
							actions.feedBalance({ status: "loading", wallets: [], bonusWallets: [], at: Date.now() });
						}
						inFlight = (async () => {
							const settle = (status, wallets, bonusWallets) => {
								actions.feedBalance({
									status,
									wallets: wallets || [],
									bonusWallets: bonusWallets || [],
									at: Date.now()
								});
							};
							try {
								const raw = await scope.remote.account.getBalance(clientMetadata());
								// Remote 的返回可能是 `{ ok, value }` 信封，也可能直接是值 —— 两种都认，
								// 免得把一次协议细节变化变成「余额永远读不出来」。
								const envelope =
									raw !== null && typeof raw === "object" && "ok" in raw
										? { ok: raw.ok !== false, value: raw.value }
										: { ok: true, value: raw };
								if (!envelope.ok) throw new Error("account host refused the balance request");
								const value = envelope.value;
								// 没有账号：getBalance 的 schema 用 `null` 表示。
								if (value === null || value === undefined) {
									settle("signedOut");
									return;
								}
								if (value.status === "ready") {
									settle(
										"ready",
										Array.isArray(value.value) ? value.value : [],
										Array.isArray(value.bonusWallets) ? value.bonusWallets : []
									);
									return;
								}
								// status === "failed"：查询失败**不等于**零余额，所以单独一档。
								settle("failed");
							} catch (error) {
								console.info("[token-widget] 账户余额读取失败：", error);
								try {
									settle("failed");
								} catch {
									/* 连写状态都失败就彻底放弃这一轮 */
								}
							} finally {
								inFlight = null;
							}
						})();
						return inFlight;
					};

					if (typeof onReady === "function") onReady(read);

					scope.effect(() => {
						try {
							read();
							const timer = setInterval(read, BALANCE_REFRESH_MS);
							return () => clearInterval(timer);
						} catch (error) {
							console.info("[token-widget] 余额自动刷新没能启动（不影响其它功能）：", error);
							return () => {};
						}
					}, "token-widget: account balance");
				});
			} catch (error) {
				console.info("[token-widget] 账户余额不可用，挂件其余功能照常：", error);
			}
		}

		function apply(ctx) {
			installStyles(ctx);

			const handle = createWidgetStore();
			const instance = handle.create();
			const snapshotSource = {
				getSnapshot: () => instance.getSnapshot(),
				subscribe: (listener) => instance.subscribe(listener)
			};
			const actions = instance.actions;

			// 面板上的「刷新余额」按钮与「打开面板即读一次」都走这个引用；
			// 账户服务不在时它保持空实现，按钮点了什么也不会发生（面板里也不会画按钮以外的假数据）。
			let refreshBalance = () => {};

			// 账户余额：进可选子作用域，账户服务不在的部署里挂件照常工作
			installBalance(ctx, instance, actions, (read) => {
				refreshBalance = read;
			});

			// 气泡自动翻页。
			//
			// 只在「自动」模式**且余额真的可用**时才推进游标：没有账号时还翻到余额页，
			// 用户会看到一块空牌子在那里闪。定时器放在 apply 而不是组件里，
			// 这样它是插件级生命周期，也和 store 的状态一致（组件只负责读）。
			ctx.effect(() => {
				const timer = setInterval(() => {
					const state = instance.getSnapshot();
					if (state.bubblePage !== "auto") return;
					if (!balanceReady(state)) {
						// 余额不可用就停在用量页，顺便把游标归位，
						// 免得余额恢复后先闪一下余额页。
						if (state.autoPage !== "tokens") actions.flipAutoPage();
						return;
					}
					actions.flipAutoPage();
				}, BUBBLE_ROTATE_MS);
				return () => clearInterval(timer);
			}, "token-widget: bubble page rotation");

			// 全局找回快捷键 Ctrl+Alt+H（H = Home / 找回）。
			//
			// 装在插件级而不是组件里：挂件随路由卸载（用户正停在设置页）时，
			// 组件里那套监听也跟着没了，而这条快捷键恰恰是「挂件不见了」时的入口。
			ctx.effect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
				const onKeyDown = (event) => {
					if (event.repeat) return;
					if (!event.ctrlKey || !event.altKey || event.metaKey) return;
					const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
					if (key !== "h" && event.code !== "KeyH") return;
					event.preventDefault();
					actions.rescue();
				};
				window.addEventListener("keydown", onKeyDown, true);
				return () => window.removeEventListener("keydown", onKeyDown, true);
			}, "token-widget: rescue shortcut");

			// 字体 / 强调色跟随角色：状态一变就重算覆盖层
			ctx.effect(
				() => {
					const applyNow = () => {
						const state = instance.getSnapshot();
						applyThemeLayer(ctx, state.characterId, state.follow);
					};
					applyNow();
					const dispose = instance.subscribe(applyNow);
					return () => {
						if (typeof dispose === "function") dispose();
						ctx.theme.overrideTokens(PLUGIN_ID, {});
					};
				},
				"token-widget: theme layer"
			);

			// 本会话 token 用量：跟着「当前会话」走，并订阅两个投影单元
			ctx.effect(() => {
				const sessions = ctx.sessions;
				const workspace = ctx.get("uiWorkspace");
				if (!sessions || !workspace || !workspace.selection) return () => {};
				let disposeProjections = () => {};
				let lastSessionId = null;

				const rebind = () => {
					const selection = workspace.selection.getSnapshot() || {};
					const sessionId = selection.sessionId || null;
					if (sessionId === lastSessionId) return;
					lastSessionId = sessionId;
					disposeProjections();
					disposeProjections = () => {};
					if (sessionId === null) {
						actions.feed({ sessionId: null, usage: null, pressure: null });
						return;
					}
					let binding = null;
					try {
						binding = sessions.binding(sessionId);
					} catch {
						binding = null;
					}
					if (!binding) {
						actions.feed({ sessionId, usage: null, pressure: null });
						return;
					}
					const usageSource = projectionSource(binding, "tokenUsage");
					const pressureSource = projectionSource(binding, "contextPressure");
					const read = () => {
						actions.feed({
							sessionId,
							usage: usageSource ? usageSource.getSnapshot() || null : null,
							pressure: pressureSource ? pressureSource.getSnapshot() || null : null
						});
					};
					read();
					const disposers = [subscribeSource(usageSource, read), subscribeSource(pressureSource, read)];
					disposeProjections = () => {
						for (const dispose of disposers) dispose();
					};
				};

				rebind();
				const disposeSelection = subscribeSource(workspace.selection, rebind);
				const disposeList = subscribeSource(sessions.list, () => {
					lastSessionId = null;
					rebind();
				});
				return () => {
					disposeSelection();
					disposeList();
					disposeProjections();
				};
			}, "token-widget: live token usage");

			ctx.inject(["slots", "locale", "theme"], (scope) => {
				scope.effect(() => scope.locale.register(NS, { zh, en }), "token-widget: dictionaries");
				const widgetProps = () => ({
					hooks: { widget: snapshotSource },
					choose: (id) => actions.choose(id),
					setFollow: (value) => actions.setFollow(value),
					setVisible: (value) => actions.setVisible(value),
					setScale: (value) => actions.setScale(value),
					freezePanel: (height) => actions.freezePanel(height),
					releasePanel: () => actions.releasePanel(),
					setBubblePage: (value) => actions.setBubblePage(value),
					flipBubblePage: () => actions.flipBubblePage(),
					refreshBalance: () => refreshBalance(),
					togglePanel: () => actions.togglePanel(),
					setPos: (pos) => actions.setPos(pos),
					resetPos: () => actions.resetPos(),
					rescue: () => actions.rescue()
				});

				scope.slots.inject("shell.overlay", () =>
					scope.slots.register(
						{
							name: "shell.overlay",
							id: OVERLAY_ID,
							order: 5,
							locale: NS,
							inject: widgetProps
						},
						TokenWidget
					)
				);

				scope.slots.inject("settings.general.item", () =>
					scope.slots.register(
						{
							name: "settings.general.item",
							id: SETTINGS_ROW_ID,
							order: 42,
							locale: NS,
							inject: widgetProps
						},
						WidgetSettingsRow
					)
				);
			});
		}

		exports.CHARACTERS = CHARACTERS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
