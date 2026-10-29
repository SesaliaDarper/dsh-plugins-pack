/**
 * dsh-task-notify — Client 侧。
 *
 * 只有一件事：把 DSH **当前实际渲染出来的**主题色上报给 Host，
 * 好让右下角弹窗跟着主题走。
 *
 * 为什么要在浏览器里读：DSH 的颜色真值全在 `--dsw-*` 自定义属性上，
 * 而且像 gemini-cat 这类第三方主题是在运行时用
 * `ctx.theme.overrideTokens()` 覆盖 token 的 —— 磁盘上读不到，只有
 * `getComputedStyle` 拿到的才是用户眼前那一套。连「当前是哪个子主题」
 * 都存在 localStorage 里，所以从 DOM 实测是唯一可靠的做法。
 *
 * 上报时机：插件启动、`theme/change`、以及 body 上 `data-ds-dark-theme`
 * 变化（MutationObserver）。上报量很小，且只在变化时发生。
 */

window.__ModuleLoader__.load({
  id: "dsh-task-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const PLUGIN_ID = "dsh-task-notify";
    const ENDPOINT = "/api/dsh-task-notify/theme";

    /**
     * 要上报的 token：正好是弹窗卡片用得到的那几个语义槽位
     * （面板底色两层、三级文字色、强调色、描边）。
     */
    const TOKENS = [
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-secondary",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-border-l3",
      "--dsw-alias-bg-base",
      "--dsw-alias-brand-primary",
      "--dsw-alias-link",
    ];

    /** 只接受看起来像颜色的值，别把 `var(...)` 或空串送出去。 */
    function looksLikeColor(value) {
      if (typeof value !== "string") return false;
      const text = value.trim();
      if (text.length === 0) return true; // 空串 = 未定义，跳过
      if (text.startsWith("var(")) return false;
      return /^#|^rgb|^hsl|^color\(/.test(text);
    }

    function readTokens() {
      const style = getComputedStyle(document.body);
      const tokens = {};
      for (const name of TOKENS) {
        const value = style.getPropertyValue(name).trim();
        if (looksLikeColor(value) && value.length > 0) tokens[name] = value;
      }
      return tokens;
    }

    function isDark() {
      return document.body.hasAttribute("data-ds-dark-theme");
    }

    /** 把当前主题快照 POST 给 Host。失败静默 —— 这只是个修饰性能力。 */
    function report() {
      let payload;
      try {
        payload = {
          dark: isDark(), tokens: readTokens(),
          themeId: document.body.getAttribute("data-gc-theme") || "",
        };
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 读取主题 token 失败：`, error);
        return;
      }
      try {
        void fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "same-origin",
        }).catch(() => {});
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 上报主题失败：`, error);
      }
    }

    const inject = ["theme"];

    function apply(ctx) {
      // 首次 + 每次主题切换（字号变化也会走到这里，无所谓，上报是幂等的）
      ctx.effect(() => {
        report();
        return ctx.on("theme/change", () => report());
      }, `${PLUGIN_ID}: theme report`);

      // Also observe the root: theme artwork variables are installed on html.
      ctx.effect(() => {
        let frame = 0;
        const observer = new MutationObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(report);
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
        return () => { observer.disconnect(); cancelAnimationFrame(frame); };
      });

      // 第三方主题直接用 CSS 改 body 属性时，theme/change 不一定发出来，
      // 所以再盯一眼那个属性本身。
      ctx.effect(() => {
        const observer = new MutationObserver(() => report());
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ["data-ds-dark-theme", "data-gc-theme", "style"],
        });
        return () => observer.disconnect();
      }, `${PLUGIN_ID}: dark-attribute observer`);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
