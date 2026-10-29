/**
 * dsh-session-cost — 投影的状态 schema 与视图 schema。
 *
 * 单独一个文件的原因很实际：它只依赖 `./schema.js`（零外部依赖），所以
 * `tools/smoke-test.mjs` 能在纯 node 下把真实的 fold/view 结果喂进这两个 schema 跑一遍 ——
 * 视图少一个字段、状态多一个 undefined，都会在那一步被抓住，而不是等到宿主注册投影时
 * 或在浏览器里才炸。校验器为什么不用 zod，见 `./schema.js` 顶部说明。
 *
 * @module dsh-session-cost/schemas
 */

import { arr, bool, dict, int, nullable, num, obj, str } from './schema.js';

/** 一个 token 桶。 */
export const tokensSchema = obj({
  input: int(),
  cacheRead: int(),
  cacheWrite: int(),
  output: int(),
});

/** 一条路由的累计用量（峰谷分开存，因为两者单价不同）。 */
export const bucketSchema = obj({
  provider: str(),
  model: str(),
  calls: int(),
  peakCalls: int(),
  offPeakCalls: int(),
  peak: tokensSchema,
  offPeak: tokensSchema,
});

/** 一笔调用（面板明细用）。`at` 是**请求发出时间**（峰谷按它判）。 */
export const billSchema = obj({
  at: num(),
  provider: str(),
  model: str(),
  kind: str(),
  peak: bool(),
  tokens: tokensSchema,
});

/** 投影状态：纯 JSON，可 checkpoint。字段必须齐全。 */
export const stateSchema = obj({
  route: nullable(obj({ provider: str(), model: str() })),
  buckets: dict(bucketSchema),
  foreign: dict(int()),
  bills: arr(billSchema),
  usageMissing: int(),
  lastAt: nullable(num()),
  requestStartAt: nullable(num()),
  compactionStartAt: nullable(num()),
  failedAttempts: int(),
  failedAttemptTokens: int(),
});

/** 一个币种的金额账。 */
const moneySchema = obj({
  total: num(),
  input: num(),
  cache: num(),
  cacheWrite: num(),
  output: num(),
  cacheSaved: num(),
  peak: num(),
  offPeak: num(),
});

/** 按模型拆的金额（币种 → 四个数）。 */
const modelMoneySchema = obj({
  total: num(),
  cacheSaved: num(),
  peak: num(),
  offPeak: num(),
});

/** 传给客户端的视图：每一项都显式出现，不留 undefined。 */
export const viewSchema = obj({
  priced: bool(),
  displayCurrency: str(),
  currencies: arr(str()),
  calls: int(),
  foreignCalls: int(),
  unpricedCalls: int(),
  usageMissing: int(),
  failedAttempts: int(),
  failedAttemptTokens: int(),
  peakCalls: int(),
  offPeakCalls: int(),
  tokens: tokensSchema,
  money: dict(moneySchema),
  models: arr(
    obj({
      provider: str(),
      model: str(),
      label: str(),
      calls: int(),
      tokens: tokensSchema,
      money: dict(modelMoneySchema),
    }),
  ),
  bills: arr(
    obj({
      at: num(),
      model: str(),
      label: str(),
      kind: str(),
      peak: bool(),
      tokens: tokensSchema,
      money: dict(num()),
    }),
  ),
  unpricedModels: arr(str()),
  foreignModels: arr(str()),
  pricingSource: str(),
});
