/**
 * dsh-session-cost — 价目表与计费。
 *
 * ── 官方有两份价目表，按币种分开，不能互相折算 ───────────────────────────
 *
 * 中文页（人民币，**中国大陆账号实际扣费的依据**）：
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 英文页（美元）：
 *   https://api-docs.deepseek.com/quick_start/pricing/
 *
 *   model            缓存命中(高峰/空闲)   缓存未命中(高峰/空闲)   输出(高峰/空闲)
 *   —— 人民币，元 / 百万 token ——
 *   deepseek-flash       0.04 / 0.02          2   / 1            8   / 4
 *   deepseek-v4-pro      0.30 / 0.15          9   / 4.5          27  / 13.5
 *   —— 美元，USD / 百万 token ——
 *   deepseek-flash       0.006 / 0.003        0.3 / 0.15         1.2 / 0.6
 *   deepseek-v4-pro      0.044 / 0.022        1.32 / 0.66        3.96 / 1.98
 *
 * 两份表**不是**严格按某个汇率换算出来的（flash 隐含 6.667，pro 隐含 6.818），
 * 所以**不要**拿美元价乘汇率去凑人民币金额 —— 那会差几个百分点，而平台是按人民币
 * 那份表扣费的。本插件两张表都原样内置、各自计费，展示哪个币种由配置决定。
 *
 * ── 峰谷 ────────────────────────────────────────────────────────────────
 *
 * 高峰 = **北京时间（UTC+8）周一至周五 09:00–12:00、14:00–18:00**，不含中国法定节假日；
 * 其余时段（含周末与法定节假日全天）为空闲时段，空闲价 = 高峰价的一半。
 * 中文页写的是北京时间，英文页写的是等价的 UTC 01:00–04:00、06:00–10:00 —— 同一件事，
 * 这里统一按 UTC 判定（节假日表仍按沪时日期匹配）。
 *
 * ── 计费口径 ────────────────────────────────────────────────────────────
 *
 *   费用 = 未命中输入 × cacheMiss
 *        + 缓存命中输入 × cacheHit
 *        + 缓存写入输入 × cacheMiss   ← DeepSeek 不为缓存写入单独计价，宁可算贵不算便宜
 *        + 输出 × output              ← 思维链 token 已含在 outputTokens 里
 *
 * 缓存省下的钱（各币种的 `cacheSaved`）= 命中 token ×（cacheMiss − cacheHit）。
 *
 * ── 为什么价格在 view 里算、而不是在 fold 里 ─────────────────────────────
 *
 * 投影的 fold 只累计「按模型 × 峰谷 × token 桶」的**用量**；金额在 `wire.view`
 * 里用**当前**价目表算。这样改价目表会立刻反映到已存在的会话上，也不会因为改价
 * 而让已落盘的投影检查点失效。峰谷是时间相关的，只能在 fold 时判定，故随用量一起存。
 *
 * @module dsh-session-cost/pricing
 */

/** 价目表出处（中文页是人民币权威价；美元价见英文页）。 */
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/** 美元价目表出处（面板里在美元金额旁给出）。 */
export const PRICING_SOURCE_USD = 'https://api-docs.deepseek.com/quick_start/pricing/';

/** 币种元数据。 */
export const CURRENCIES = {
  CNY: { code: 'CNY', symbol: '¥', name: '人民币' },
  USD: { code: 'USD', symbol: '$', name: '美元' },
};

/** 默认展示币种：中国大陆账号按人民币扣费，所以默认人民币。 */
export const DEFAULT_DISPLAY_CURRENCY = 'CNY';

/**
 * 默认计入「DeepSeek 官方」的路由。
 *
 * `deepseek-official` 是 API Key 路由（@deepseek-ai/dsh-llm-deepseek-api-key），
 * `deepseek-account` 是账号路由（@deepseek-ai/dsh-llm-deepseek-account）。
 * 中转站哪怕套着 DeepSeek 模型名也是另一条路由，不在这里，也就不计价 ——
 * 这正是「只算官方」这条要求落地的地方。
 */
export const DEFAULT_PROVIDERS = ['deepseek-official', 'deepseek-account'];

/** 峰时窗口（UTC 小时，左闭右开）。等价于北京时间 09:00–12:00、14:00–18:00。 */
export const PEAK_WINDOWS = [
  [1, 4],
  [6, 10],
];

/**
 * 模型别名 → 计价用的规范 id。
 *
 * 官方文档写明退役名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍被接受，
 * 请求由 V4.1-Flash 服务并按 Flash 价计费，所以这里一并归并。
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v41-flash': 'deepseek-flash',
};

/** 展示名（面板里显示得比 id 好看一点）。 */
export const MODEL_LABELS = {
  'deepseek-flash': 'DeepSeek-V4.1-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
};

/**
 * 内置价目表：**高峰时段**单价，按币种分开。谷时价不写死，由 `offPeakFactor`（默认 0.5）推出。
 */
export const OFFICIAL_PEAK_PRICES = {
  CNY: {
    'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
  USD: {
    'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
};

/** 1M tokens 的除数：价目表的单位是「每百万 token」。 */
const PER_MILLION = 1_000_000;

/** 中国标准时相对 UTC 的偏移（毫秒）。峰时窗口落在 09:00–18:00 沪时，日期与 UTC 同日。 */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把模型 id 归一到计价用的规范 id。 */
export function canonicalModel(model) {
  if (typeof model !== 'string') return '';
  const trimmed = model.trim();
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

/** 该模型在面板里的显示名。 */
export function modelLabel(model) {
  const id = canonicalModel(model);
  return MODEL_LABELS[id] ?? (id.length > 0 ? id : '未知模型');
}

/** 这条路由算不算「DeepSeek 官方」（按 Config 的 providers 列表）。 */
export function isOfficialProvider(provider, providers = DEFAULT_PROVIDERS) {
  return typeof provider === 'string' && providers.includes(provider);
}

/** 沪时日期串 `YYYY-MM-DD`，用于匹配节假日表。 */
export function chinaDateKey(timeMs) {
  const shifted = new Date(timeMs + CHINA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 这笔调用是不是按高峰价计价。
 *
 * 规则来自官方价目表：高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00，
 * 中国法定节假日全天为空闲时段。节假日需要用户给（Config `holidays`），因为中国的
 * 调休表不是能算出来的东西；没给的时候工作日高峰会照常按高峰算（略偏贵）。
 *
 * @param timeMs - 请求发出时间（epoch 毫秒）。**应当用请求开始时间**，不是消息落地时间。
 * @param holidays - `YYYY-MM-DD`（沪时）列表。
 */
export function isPeakHour(timeMs, holidays = []) {
  const at = new Date(timeMs);
  if (Number.isNaN(at.getTime())) return false;
  const weekday = at.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (holidays.length > 0 && holidays.includes(chinaDateKey(timeMs))) return false;
  const hour = at.getUTCHours();
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to);
}

/** 取第一个可用的数值（`value` 优先，否则 `fallback`）。 */
function pickNumber(value, fallback) {
  return Number.isFinite(value) ? value : Number.isFinite(fallback) ? fallback : undefined;
}

/**
 * 构造**每个币种一张**价目表。
 *
 * @param overrides - `[{ model, currency?, cacheHit?, cacheMiss?, output?, offPeakFactor? }]`，
 *   单价为高峰价；`currency` 缺省时按人民币（官方扣费币种）理解。
 * @param offPeakFactor - 全局谷时系数（默认 0.5），可被单个覆盖项的 `offPeakFactor` 盖掉。
 * @returns `{ CNY: { [canonicalModel]: { cacheHit, cacheMiss, output, offPeakFactor, peak, offPeak } }, USD: {...} }`
 */
export function buildPriceTables(overrides = [], offPeakFactor = 0.5) {
  const list = Array.isArray(overrides) ? overrides : [];
  const tables = {};
  const put = (currency, model, peak, factor) => {
    const id = canonicalModel(model);
    if (id.length === 0) return;
    const ratio = Number.isFinite(factor) && factor > 0 ? factor : 0.5;
    const offPeak = {};
    for (const key of ['cacheHit', 'cacheMiss', 'output']) offPeak[key] = peak[key] * ratio;
    tables[currency][id] = {
      cacheHit: peak.cacheHit,
      cacheMiss: peak.cacheMiss,
      output: peak.output,
      offPeakFactor: ratio,
      peak,
      offPeak,
    };
  };
  for (const currency of Object.keys(CURRENCIES)) {
    tables[currency] = {};
    for (const [model, peak] of Object.entries(OFFICIAL_PEAK_PRICES[currency] ?? {})) {
      put(currency, model, peak, offPeakFactor);
    }
  }
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const currency = CURRENCIES[entry.currency] === undefined ? DEFAULT_DISPLAY_CURRENCY : entry.currency;
    const id = canonicalModel(entry.model ?? '');
    if (id.length === 0) continue;
    const base = tables[currency]?.[id]?.peak ?? {};
    const peak = {
      cacheHit: pickNumber(entry.cacheHit, base.cacheHit),
      cacheMiss: pickNumber(entry.cacheMiss, base.cacheMiss),
      output: pickNumber(entry.output, base.output),
    };
    if (peak.cacheHit === undefined || peak.cacheMiss === undefined || peak.output === undefined) continue;
    put(currency, id, peak, entry.offPeakFactor ?? tables[currency]?.[id]?.offPeakFactor ?? offPeakFactor);
  }
  return tables;
}

/** 取某模型在峰/谷时的单价；没有价目就返回 `undefined`（调用方据此标记「未计价」）。 */
export function priceAt(table, model, peak) {
  const entry = table?.[canonicalModel(model)];
  if (entry === undefined) return undefined;
  return peak ? entry.peak : entry.offPeak;
}

/** 把 token 桶归一成四个非负整数（脏数据只影响一笔，不该让整条投影炸掉）。 */
export function normalizeTokens(tokens) {
  const count = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
  return {
    input: count(tokens?.input),
    cacheRead: count(tokens?.cacheRead),
    cacheWrite: count(tokens?.cacheWrite),
    output: count(tokens?.output),
  };
}

/** 四个桶相加。 */
export function totalTokens(tokens) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/**
 * 算一笔用量的钱。
 *
 * @param tokens - `normalizeTokens` 过的四桶。
 * @param price - `priceAt` 给出的单价（该币种 / 1M tokens）。
 * @returns 各分项与合计（未做四舍五入，展示时再处理）。
 */
export function costOfTokens(tokens, price) {
  const input = (tokens.input / PER_MILLION) * price.cacheMiss;
  const cacheRead = (tokens.cacheRead / PER_MILLION) * price.cacheHit;
  const cacheWrite = (tokens.cacheWrite / PER_MILLION) * price.cacheMiss;
  const output = (tokens.output / PER_MILLION) * price.output;
  const cacheSaved = (tokens.cacheRead / PER_MILLION) * Math.max(0, price.cacheMiss - price.cacheHit);
  return {
    input: input,
    cache: cacheRead,
    cacheWrite: cacheWrite,
    output: output,
    total: input + cacheRead + cacheWrite + output,
    cacheSaved,
  };
}

/** 空 token 桶。 */
export function emptyTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** 两个 token 桶相加（返回新对象）。 */
export function addTokens(a, b) {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/** 空金额账（每个币种一份）。 */
export function emptyMoney() {
  return { total: 0, input: 0, cache: 0, cacheWrite: 0, output: 0, cacheSaved: 0, peak: 0, offPeak: 0 };
}

/** 两种币种的空金额账。 */
export function emptyMoneyByCurrency() {
  const money = {};
  for (const code of Object.keys(CURRENCIES)) money[code] = emptyMoney();
  return money;
}
