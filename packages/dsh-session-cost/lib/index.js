/**
 * dsh-session-cost — Host 侧装配：把「本会话在 DeepSeek 官方模型上花了多少钱」做成
 * 一个会话投影（`sessionCost`），客户端只负责显示。
 *
 * 折叠与计费在 `./fold.js` 与 `./pricing.js`（都不依赖 DSH 包，可纯 node 单测），
 * 这个文件只负责：配置 schema、投影 schema、注册投影、挂自检接口。
 *
 * ── 为什么是投影，而不是客户端自己算 ─────────────────────────────────────
 *
 * 金额要从**会话日志**里推：每条 `assistant/message` 带提供商上报的用量
 * （`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`），
 * 而「这条请求走的是哪条路由」写在之前的 `request/header` 里（同一序列内后续步骤
 * 继承它，所以必须按事件顺序折叠，只看当前模型选择是不够的）。压缩调用另走
 * `compaction/summary`，自带 provider/model 与 usage。
 *
 * 这些正是 `ctx.sessionProjections` 的用途：宿主按事件顺序折叠，客户端拿到已经
 * 算好、且通过 schema 校验的 JSON；「只有官方路由才计价」这条规则也只需要在一端实现。
 *
 * ── 自检口 ───────────────────────────────────────────────────────────────
 *
 * 宿主 Web 服务在时，注册 `GET /api/dsh-session-cost/status`：报装载状态、当前价目表、
 * 折叠计数器，以及每个会话的 `sessionCost` 视图与内置 `tokenUsage` 视图 —— 两边的
 * token 总数必须一致，否则就是本插件的折叠错了。只读，不改任何状态。
 *
 * @module dsh-session-cost
 */

import s from '@deepseek-ai/schemastery';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { CURRENCIES, DEFAULT_DISPLAY_CURRENCY, DEFAULT_PROVIDERS, PRICING_SOURCE, buildPriceTables } from './pricing.js';
import { KEY, STATE_VERSION, createFold, createView, initState } from './fold.js';
import { stateSchema, viewSchema } from './schemas.js';

/** Cordis 插件名（与 cordis.patch.yml 里的行 name 一致）。 */
export const name = 'session-cost';

/** 没有投影注册表就没有这个插件 —— 它整个能力都长在投影上。 */
export const inject = ['sessionProjections'];

/** 插件配置（写在 cordis.patch.yml 里，patch 层在升级后仍然存在）。 */
export const Config = s.object({
  enabled: s.boolean().default(true).description('关掉后不注册投影，界面上的费用徽章随之消失。'),
  providers: s
    .array(s.string())
    .default(DEFAULT_PROVIDERS)
    .description('算作「DeepSeek 官方」的路由 id；其它路由只计数、不计价。'),
  holidays: s
    .array(s.string())
    .default([])
    .description('中国法定节假日（沪时 YYYY-MM-DD）；这些日期按空闲时段计价。调休表算不出来，只能用户给。'),
  offPeakFactor: s.number().default(0.5).description('空闲时段价相对高峰时段价的系数，官方口径是 0.5。'),
  pricing: s
    .array(
      s.object({
        model: s.string().required().description('模型 id（或别名）。'),
        currency: s.string().description('这条覆盖项作用于哪个币种的价目表：CNY（默认）或 USD。'),
        cacheHit: s.number().description('缓存命中输入单价（该币种 / 1M tokens，高峰价）。'),
        cacheMiss: s.number().description('缓存未命中输入单价（该币种 / 1M tokens，高峰价）。'),
        output: s.number().description('输出单价（该币种 / 1M tokens，高峰价）。'),
        offPeakFactor: s.number().description('该模型单独的空闲时段系数，缺省沿用全局。'),
      }),
    )
    .default([])
    .description('价目表覆盖项：只写需要改的模型/字段。'),
  displayCurrency: s
    .string()
    .default(DEFAULT_DISPLAY_CURRENCY)
    .description('徽章与面板默认展示的币种：CNY（人民币，大陆账号实际扣费币种）或 USD。两个币种各自按官方价目表算，不做汇率折算。'),
  bills: s.number().default(24).description('状态里保留最近多少笔调用（1–200）。'),
  viewBills: s.number().default(12).description('视图里最多带几笔最近调用给面板看（1–50）。'),
  statusRoute: s.boolean().default(true).description('是否注册 /api/dsh-session-cost/status 自检接口。'),
});


/**
 * Host 插件入口。
 *
 * @param ctx - profile 作用域。
 * @param config - 已经过 {@link Config} 校验的配置。
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  /** 读一个配置项；`!!js` 表达式给的是 volatile 引用，取它的当前值。 */
  const live = (field, fallback) => {
    const raw = config?.[field];
    const value = isVolatile(raw) ? raw.get() : raw;
    return value === undefined || value === null ? fallback : value;
  };
  const enabled = () => live('enabled', true) === true;
  const providers = () => {
    const value = live('providers', DEFAULT_PROVIDERS);
    return Array.isArray(value) && value.length > 0 ? value : DEFAULT_PROVIDERS;
  };
  const holidays = () => {
    const value = live('holidays', []);
    return Array.isArray(value) ? value : [];
  };
  const priceTables = () => buildPriceTables(live('pricing', []), live('offPeakFactor', 0.5));
  const displayCurrency = () => {
    const value = String(live('displayCurrency', DEFAULT_DISPLAY_CURRENCY)).toUpperCase();
    return CURRENCIES[value] === undefined ? DEFAULT_DISPLAY_CURRENCY : value;
  };

  /** 折叠计数器：只给自检接口看，用来回答「到底有没有在算」。 */
  const stats = { events: 0, billed: 0, foreign: 0, usageMissing: 0, failedAttempts: 0, lastAt: null };

  const fold = createFold({
    providers,
    holidays,
    billCap: () => live('bills', 24),
    stats,
  });
  const view = createView({
    priceTables,
    currencies: Object.keys(CURRENCIES),
    displayCurrency,
    pricingSource: PRICING_SOURCE,
    billLimit: () => live('viewBills', 12),
  });

  if (enabled()) {
    ctx.sessionProjections.register({
      key: KEY,
      stateVersion: STATE_VERSION,
      stateSchema,
      init: initState,
      apply: fold,
      wire: { viewSchema, view },
    });
    logger.info?.(`session-cost: 已注册 ${KEY} 投影（stateVersion=${STATE_VERSION}）`);
  } else {
    logger.info?.('session-cost: 配置里 enabled=false，未注册 sessionCost 投影');
  }

  // ── 自检接口（可选：没有 webServer 就不挂，插件照常工作）──
  //
  // 会话清单只用于「把本插件折叠出的 token 与内置 tokenUsage 对账」，所以走**可选**注入：
  // cordis 里 `ctx.sessions` 不 inject 就取不到（会明确报 "without inject"），
  // 而这条依赖不该影响插件本体加载。
  const handles = { sessions: null };
  ctx.inject(['sessions'], (scope) => {
    ctx.effect(() => {
      handles.sessions = scope.sessions;
      return () => {
        handles.sessions = null;
      };
    }, 'session-cost: sessions handle');
  });

  ctx.inject(['webServer'], (webCtx) => {
    if (live('statusRoute', true) !== true) return;
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/api/dsh-session-cost/status',
          handler: (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405).end();
              return;
            }
            const payload = {
              ok: true,
              plugin: name,
              projectionKey: KEY,
              stateVersion: STATE_VERSION,
              enabled: enabled(),
              providers: providers(),
              holidays: holidays(),
              offPeakFactor: live('offPeakFactor', 0.5),
              displayCurrency: displayCurrency(),
              pricing: priceTables(),
              pricingSource: PRICING_SOURCE,
              fold: { ...stats },
              sessions: [],
            };
            try {
              const sessions = handles.sessions?.list?.() ?? [];
              payload.sessionCount = sessions.length;
              for (const session of sessions.slice(0, 8)) {
                try {
                  const snapshot = ctx.sessionProjections.snapshot(session, [KEY, 'tokenUsage']);
                  payload.sessions.push({
                    id: session.id,
                    asOfSeq: snapshot.asOfSeq,
                    cost: snapshot.values[KEY] ?? null,
                    tokenUsage: snapshot.values.tokenUsage ?? null,
                  });
                } catch (error) {
                  payload.sessions.push({ id: session.id, error: String(error) });
                }
              }
            } catch (error) {
              payload.error = String(error);
            }
            const body = JSON.stringify(payload, null, 1);
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
          },
        }),
      'session-cost: status route',
    );
  });
}
