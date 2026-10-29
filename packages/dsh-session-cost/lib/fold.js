/**
 * dsh-session-cost — 投影的折叠与视图（**不依赖任何 DSH 包**，因此可以在纯 node 下测）。
 *
 * 分成两个纯函数：
 *
 *   fold(state, event)  按会话事件流累计「用量」（路由 × 峰谷 × 四个 token 桶 + 最近调用清单）
 *   view(state)         用**当前**价目表把用量算成钱，产出客户端要的 JSON 视图
 *
 * 这么切的意义：
 *   • 金额在 view 里算 → 改价目表立刻反映到所有已存在的会话，且已落盘的检查点不失效；
 *   • 峰谷与路由是时间序列相关的、推不回来的，所以只能在 fold 时判定并随用量存下；
 *   • 两者都不碰 DSH API，可以脱离宿主直接单测（见 tools/smoke-test.mjs）。
 *
 * ── 两个容易错的时间/口径细节（都修过）──────────────────────────────────
 *
 * 1. **峰谷按「请求发出时间」判，不是按消息落地时间判。** 高峰/空闲是按请求发生时刻
 *    定价的。消息落地可能晚几十秒甚至几分钟 —— 一笔 11:59 发出、12:00:30 落地的调用，
 *    按落地时间会被错算成空闲价（便宜一半）。所以这里记住 `step/start` 与
 *    `llm/retry-started` 的时刻作为请求发出时间。
 *
 * 2. **失败尝试（`assistant/attempt`）不计入金额，但会被计数。** 这类事件是尝试失败
 *    （或被打断）时落的，带的用量是**流式片段**、不是一次完整结算；把它当一笔完整调用
 *    计价会偏高。但它确实存在，所以单独记 `failedAttempts` / `failedAttemptTokens`
 *    暴露给面板，别让「少算了」变成悄悄发生的事。
 *
 * @module dsh-session-cost/fold
 */

import {
  addTokens,
  canonicalModel,
  costOfTokens,
  emptyMoney,
  emptyTokens,
  isOfficialProvider,
  isPeakHour,
  modelLabel,
  normalizeTokens,
  priceAt,
  totalTokens,
} from './pricing.js';

/** 投影 key。客户端用 `useProjection('sessionCost')` 读它。 */
export const KEY = 'sessionCost';

/**
 * 状态字段或折叠语义变化时 +1（会让旧的投影检查点作废、重放日志）。
 * v2：新增请求发出时间与失败尝试计数（峰谷改按请求发出时间判定）。
 */
export const STATE_VERSION = 2;

/** 视图里金额保留的小数位：够小、又不至于把 JSON 撑大。 */
const MONEY_DIGITS = 10;

/** 抹掉浮点尾巴。 */
function round(value) {
  return Number(value.toFixed(MONEY_DIGITS));
}

/** 桶的键：路由 + 模型。用 `\u0001` 分隔，免得模型名里的字符撞上分隔符。 */
export function bucketKey(provider, model) {
  return `${provider}\u0001${model}`;
}

/** 初始状态（纯 JSON，可 checkpoint）。 */
export function initState() {
  return {
    route: null,
    buckets: {},
    foreign: {},
    bills: [],
    usageMissing: 0,
    lastAt: null,
    requestStartAt: null,
    compactionStartAt: null,
    failedAttempts: 0,
    failedAttemptTokens: 0,
  };
}

/**
 * 从事件里取提供商上报的用量。
 *
 * 首选事件上的 `usage`；没有就回退到流式记录里最后一个 `usage` chunk ——
 * 与 `@deepseek-ai/dsh-token-meter` 的 `deriveTurnTokenUsage` 同一套口径
 * （`lastAssistantStreamChunk(stream, 'usage')`），这样两边的用量能对得上。
 */
export function usageOf(data) {
  const direct = data?.usage;
  if (direct !== undefined && direct !== null && typeof direct === 'object') return direct;
  const stream = data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage) return record.chunk.usage;
  }
  return undefined;
}

/**
 * 取这条 assistant 消息真实走的路由。
 *
 * `message.source` 是那次调用的权威记录（`{ provider, model }`）；取不到就退回
 * 「最近一次 `request/header` 记下的路由」—— 同一序列内后续步骤继承 header，
 * 所以这是正确回退，不是猜。
 */
export function routeOfMessage(message, fallback) {
  const provider = message?.source?.provider;
  const model = message?.source?.model;
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
    return { provider, model };
  }
  return fallback;
}

/** 把一条用量归一成四桶。 */
export function tokensOf(usage) {
  return normalizeTokens({
    input: usage?.inputTokens,
    cacheRead: usage?.cacheReadTokens,
    cacheWrite: usage?.cacheWriteTokens,
    output: usage?.outputTokens,
  });
}

/**
 * 造一个 fold。
 *
 * @param options.providers - `() => string[]`，算作官方的路由 id。
 * @param options.holidays - `() => string[]`，沪时 `YYYY-MM-DD` 的节假日表。
 * @param options.billCap - `() => number`，明细清单保留多少笔。
 * @param options.stats - 可选计数器对象（自检接口用），会被就地累加。
 * @returns `(state, event) => state`，对不关心的事件返回**同一个引用**。
 */
export function createFold(options) {
  const providers = options?.providers ?? (() => []);
  const holidays = options?.holidays ?? (() => []);
  const billCap = options?.billCap ?? (() => 24);
  const stats = options?.stats ?? { events: 0, billed: 0, foreign: 0, usageMissing: 0, failedAttempts: 0, lastAt: null };

  /** 记一笔官方路由的用量。`timeMs` 必须是**请求发出时间**。 */
  const bill = (state, input) => {
    stats.lastAt = input.timeMs;
    const key = bucketKey(input.provider, input.model);
    const previous = state.buckets[key] ?? {
      provider: input.provider,
      model: input.model,
      calls: 0,
      peakCalls: 0,
      offPeakCalls: 0,
      peak: emptyTokens(),
      offPeak: emptyTokens(),
    };
    const peak = isPeakHour(input.timeMs, holidays());
    const bucket = {
      ...previous,
      calls: previous.calls + 1,
      peakCalls: previous.peakCalls + (peak ? 1 : 0),
      offPeakCalls: previous.offPeakCalls + (peak ? 0 : 1),
      peak: peak ? addTokens(previous.peak, input.tokens) : previous.peak,
      offPeak: peak ? previous.offPeak : addTokens(previous.offPeak, input.tokens),
    };
    const cap = Math.max(1, Math.min(200, Math.round(Number(billCap()) || 24)));
    return {
      ...state,
      buckets: { ...state.buckets, [key]: bucket },
      bills: [
        ...state.bills,
        { at: input.timeMs, provider: input.provider, model: input.model, kind: input.kind, peak, tokens: input.tokens },
      ].slice(-cap),
      lastAt: input.timeMs,
    };
  };

  /** 记一笔「不是官方路由」的调用：只计数，不累计 token、不计价。 */
  const noteForeign = (state, provider, model) => {
    const key = bucketKey(provider, model);
    return { ...state, foreign: { ...state.foreign, [key]: (state.foreign[key] ?? 0) + 1 } };
  };

  return (state, event) => {
    const time = Number.isFinite(event?.time) ? event.time : null;

    if (event?.type === 'step/start' || event?.type === 'llm/retry-started') {
      // 请求发出时间：峰谷按它判（不是等消息落地再判）。
      if (time === null || state.requestStartAt === time) return state;
      return { ...state, requestStartAt: time };
    }

    if (event?.type === 'step/end') {
      return state.requestStartAt === null ? state : { ...state, requestStartAt: null };
    }

    if (event?.type === 'compaction/start') {
      if (time === null || state.compactionStartAt === time) return state;
      return { ...state, compactionStartAt: time };
    }

    if (event?.type === 'compaction/end') {
      return state.compactionStartAt === null ? state : { ...state, compactionStartAt: null };
    }

    if (event?.type === 'request/header') {
      const headerConfig = event.data?.header?.config;
      const provider = headerConfig?.provider;
      const model = headerConfig?.model;
      if (typeof provider !== 'string' || typeof model !== 'string') return state;
      if (state.route !== null && state.route.provider === provider && state.route.model === model) return state;
      return { ...state, route: { provider, model } };
    }

    // 失败/被打断的尝试：不算钱，但记账（见文件头第 2 点）。
    if (event?.type === 'assistant/attempt') {
      const usage = usageOf(event.data);
      if (usage === undefined) return state;
      stats.failedAttempts = (stats.failedAttempts ?? 0) + 1;
      return {
        ...state,
        failedAttempts: state.failedAttempts + 1,
        failedAttemptTokens: state.failedAttemptTokens + totalTokens(tokensOf(usage)),
      };
    }

    if (event?.type === 'assistant/message') {
      stats.events += 1;
      const route = routeOfMessage(event.data?.message, state.route);
      if (route === null) return state;
      const usage = usageOf(event.data);
      if (usage === undefined) {
        stats.usageMissing += 1;
        return { ...state, usageMissing: state.usageMissing + 1, lastAt: time ?? state.lastAt };
      }
      if (!isOfficialProvider(route.provider, providers())) {
        stats.foreign += 1;
        return noteForeign(state, route.provider, route.model);
      }
      const tokens = tokensOf(usage);
      if (totalTokens(tokens) === 0) return state;
      stats.billed += 1;
      return bill(state, {
        provider: route.provider,
        model: canonicalModel(route.model),
        tokens,
        timeMs: state.requestStartAt ?? time ?? Date.now(),
        kind: 'chat',
      });
    }

    if (event?.type === 'compaction/summary') {
      const provider = event.data?.provider;
      const model = event.data?.model;
      const usage = event.data?.usage;
      if (typeof provider !== 'string' || typeof model !== 'string') return state;
      if (usage === undefined || usage === null || typeof usage !== 'object') return state;
      if (!isOfficialProvider(provider, providers())) {
        stats.foreign += 1;
        return noteForeign(state, provider, model);
      }
      const tokens = tokensOf(usage);
      if (totalTokens(tokens) === 0) return state;
      stats.billed += 1;
      return bill(state, {
        provider,
        model: canonicalModel(model),
        tokens,
        timeMs: state.compactionStartAt ?? time ?? Date.now(),
        kind: 'compaction',
      });
    }

    return state;
  };
}

/**
 * 造一个 view：把用量算成客户端要的视图（每个币种一份金额），并**记忆上一次结果**。
 *
 * 记忆是投影契约要求的一部分：状态引用没变就复用同一个视图对象，下游才不会因为
 * 「算出来长得一样但是个新对象」而以为发生了变化。
 *
 * @param options.priceTables - `() => { CNY: table, USD: table }`，当前价目表。
 * @param options.currencies - 支持的币种顺序（第一项是主展示币种，决定「有没有价」）。
 * @param options.displayCurrency - `() => string`，面板默认展示的币种（`CNY` / `USD`）。
 * @param options.pricingSource - 价目表出处，原样给客户端展示。
 * @param options.billLimit - `() => number`，视图里最多带几笔最近调用。
 */
export function createView(options) {
  const priceTables = options?.priceTables ?? (() => ({}));
  const currencies = options?.currencies ?? ['CNY', 'USD'];
  const primary = currencies[0];
  const pricingSource = options?.pricingSource ?? '';
  const billLimit = options?.billLimit ?? (() => 12);
  const displayCurrencyOf = options?.displayCurrency ?? (() => primary);
  let lastState = null;
  let lastView = null;

  const emptyMoneyBy = () => {
    const money = {};
    for (const code of currencies) money[code] = emptyMoney();
    return money;
  };

  return (state) => {
    if (state === lastState && lastView !== null) return lastView;
    const tables = priceTables();
    const money = emptyMoneyBy();
    const tokens = emptyTokens();
    let peakCalls = 0;
    let offPeakCalls = 0;
    const models = [];
    const unpriced = new Set();
    let calls = 0;
    let unpricedCalls = 0;

    for (const bucket of Object.values(state.buckets)) {
      const entry = {
        provider: bucket.provider,
        model: bucket.model,
        label: modelLabel(bucket.model),
        calls: bucket.calls,
        tokens: addTokens(bucket.peak, bucket.offPeak),
        money: emptyMoneyBy(),
      };
      for (const [isPeak, bucketTokens, bucketCallCount] of [
        [true, bucket.peak, bucket.peakCalls],
        [false, bucket.offPeak, bucket.offPeakCalls],
      ]) {
        if (bucketCallCount === 0) continue;
        // 「有没有价」以主展示币种为准：面板讲的是这个币种的钱。
        if (priceAt(tables[primary], bucket.model, isPeak) === undefined) {
          unpriced.add(bucket.model);
          unpricedCalls += bucketCallCount;
          continue;
        }
        calls += bucketCallCount;
        for (const code of currencies) {
          const price = priceAt(tables[code], bucket.model, isPeak);
          if (price === undefined) continue;
          const cost = costOfTokens(bucketTokens, price);
          const totals = money[code];
          totals.total += cost.total;
          totals.input += cost.input;
          totals.cache += cost.cache;
          totals.cacheWrite += cost.cacheWrite;
          totals.output += cost.output;
          totals.cacheSaved += cost.cacheSaved;
          if (isPeak) totals.peak += cost.total;
          else totals.offPeak += cost.total;
          const perModel = entry.money[code];
          perModel.total += cost.total;
          perModel.input += cost.input;
          perModel.cache += cost.cache;
          perModel.cacheWrite += cost.cacheWrite;
          perModel.output += cost.output;
          perModel.cacheSaved += cost.cacheSaved;
          if (isPeak) perModel.peak += cost.total;
          else perModel.offPeak += cost.total;
        }
        for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) tokens[key] += bucketTokens[key];
        if (isPeak) peakCalls += bucketCallCount;
        else offPeakCalls += bucketCallCount;
      }
      models.push(entry);
    }

    const bills = [];
    for (const item of state.bills) {
      const perCurrency = {};
      for (const code of currencies) {
        const price = priceAt(tables[code], item.model, item.peak);
        perCurrency[code] = round(price === undefined ? 0 : costOfTokens(item.tokens, price).total);
      }
      bills.push({
        at: item.at,
        model: item.model,
        label: modelLabel(item.model),
        kind: item.kind,
        peak: item.peak,
        tokens: item.tokens,
        money: perCurrency,
      });
    }

    models.sort((a, b) => (b.money[primary]?.total ?? 0) - (a.money[primary]?.total ?? 0));
    const foreignModels = Object.keys(state.foreign)
      .map((key) => key.split('\u0001')[1] ?? key)
      .filter((value, index, all) => all.indexOf(value) === index);
    const limit = Math.max(1, Math.min(50, Math.round(Number(billLimit()) || 12)));
    const rounded = {};
    for (const code of currencies) {
      const source = money[code];
      rounded[code] = {
        total: round(source.total),
        input: round(source.input),
        cache: round(source.cache),
        cacheWrite: round(source.cacheWrite),
        output: round(source.output),
        cacheSaved: round(source.cacheSaved),
        peak: round(source.peak),
        offPeak: round(source.offPeak),
      };
    }

    lastState = state;
    const requested = displayCurrencyOf();
    lastView = {
      priced: calls + unpricedCalls > 0,
      displayCurrency: currencies.includes(requested) ? requested : primary,
      currencies,
      calls,
      foreignCalls: Object.values(state.foreign).reduce((sum, value) => sum + value, 0),
      unpricedCalls,
      usageMissing: state.usageMissing,
      failedAttempts: state.failedAttempts,
      failedAttemptTokens: state.failedAttemptTokens,
      peakCalls,
      offPeakCalls,
      tokens,
      money: rounded,
      models: models.map((entry) => {
        const perCurrency = {};
        for (const code of currencies) {
          const source = entry.money[code];
          perCurrency[code] = {
            total: round(source.total),
            cacheSaved: round(source.cacheSaved),
            peak: round(source.peak),
            offPeak: round(source.offPeak),
          };
        }
        return { ...entry, money: perCurrency };
      }),
      bills: bills.reverse().slice(0, limit),
      unpricedModels: [...unpriced].map((model) => modelLabel(model)),
      foreignModels,
      pricingSource,
    };
    return lastView;
  };
}
