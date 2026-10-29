/**
 * dsh-session-cost — 冒烟测试。
 *
 * 两段，各管一半：
 *
 *   A. **Host 侧**（真实 import `lib/pricing.js`、`lib/fold.js`、`lib/schemas.js`）：
 *      峰谷判定（按请求发出时间）、两种币种的价目与计费、事件折叠（路由继承 / 用量兜底 /
 *      别名归并 / 非官方只计数 / 压缩计入 / 失败尝试只计数 / 不关心的事件返回同一引用）、
 *      视图（两种币种金额、缓存节省、峰谷拆分、同一状态复用同一对象）、schema 校验。
 *   B. **Client 侧**（在 vm 里按 DSH 的模块加载器格式跑 `lib/client.js`）：模块能加载、
 *      `apply` 不抛错、样式与字典与插槽注册都发生、组件在有投影时渲染出金额（含币种符号）、
 *      没有官方计价时返回 null、点击徽章后面板里出现明细。
 *
 * 这一段**不是**视觉验收：DOM 是假的最小实现，只看「结构对不对、数字对不对、会不会炸」。
 * 真正的配色与排版要在页面里看（见 README 的「验证边界」一节）。
 *
 * 用法：node tools/smoke-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  buildPriceTables,
  costOfTokens,
  isPeakHour,
  normalizeTokens,
  OFFICIAL_PEAK_PRICES,
} from '../lib/pricing.js';
import { createFold, createView, initState } from '../lib/fold.js';
import { stateSchema, viewSchema } from '../lib/schemas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BUNDLE = path.join(ROOT, 'lib', 'client.js');

let failures = 0;
let checks = 0;

/** 断言 + 计数。 */
function check(label, condition, extra = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`);
}

/** 断言两数接近（浮点比较）。 */
function near(label, actual, expected, epsilon = 1e-9) {
  check(label, Math.abs(actual - expected) < epsilon, `实际=${actual} 期望=${expected}`);
}

/* ══════════════════ A. Host 侧 ══════════════════ */

console.log('\n── A. 峰谷判定（北京时间工作日 09–12、14–18 = UTC 01–04、06–10）──');

// 2026-10-16 是周五。UTC 02:00 = 北京 10:00。
const FRI_0200_UTC = Date.UTC(2026, 9, 16, 2, 0, 0);
const FRI_0500_UTC = Date.UTC(2026, 9, 16, 5, 0, 0);
const FRI_0900_UTC = Date.UTC(2026, 9, 16, 9, 0, 0);
const SAT_0200_UTC = Date.UTC(2026, 9, 17, 2, 0, 0);

check('周五北京 10:00 是高峰', isPeakHour(FRI_0200_UTC) === true);
check('周五北京 13:00 是空闲（两个高峰窗之间）', isPeakHour(FRI_0500_UTC) === false);
check('周五北京 17:00 是高峰（第二个窗口）', isPeakHour(FRI_0900_UTC) === true);
check('周六北京 10:00 是空闲（周末全空闲）', isPeakHour(SAT_0200_UTC) === false);
check('北京 18:00 整点已经出峰', isPeakHour(Date.UTC(2026, 9, 16, 10, 0, 0)) === false);
check('北京 12:00 整点已经出峰', isPeakHour(Date.UTC(2026, 9, 16, 4, 0, 0)) === false);
check('节假日表能压掉工作日高峰', isPeakHour(FRI_0200_UTC, ['2026-10-16']) === false);
check('节假日表不误伤其它日期', isPeakHour(FRI_0200_UTC, ['2026-10-15']) === true);

console.log('\n── A. 两种币种的价目表 ──');

const tables = buildPriceTables();
check('有 CNY 与 USD 两张表', tables.CNY !== undefined && tables.USD !== undefined);
near('人民币 flash 高峰命中 0.04 元', tables.CNY['deepseek-flash'].peak.cacheHit, 0.04);
near('人民币 flash 高峰未命中 2 元', tables.CNY['deepseek-flash'].peak.cacheMiss, 2);
near('人民币 flash 高峰输出 8 元', tables.CNY['deepseek-flash'].peak.output, 8);
near('人民币 v4-pro 高峰输出 27 元', tables.CNY['deepseek-v4-pro'].peak.output, 27);
near('美元 flash 高峰输出 $1.2', tables.USD['deepseek-flash'].peak.output, 1.2);
near('人民币空闲价 = 高峰价一半', tables.CNY['deepseek-flash'].offPeak.output, 4);
near('美元空闲价 = 高峰价一半', tables.USD['deepseek-flash'].offPeak.output, 0.6);
// 官方两份表不是同一个汇率：flash 恰好 ×20/3，pro 是 ×75/11。
near('flash 官方隐含汇率 20/3', OFFICIAL_PEAK_PRICES.CNY['deepseek-flash'].output / OFFICIAL_PEAK_PRICES.USD['deepseek-flash'].output, 20 / 3);
near('pro 官方隐含汇率 75/11', OFFICIAL_PEAK_PRICES.CNY['deepseek-v4-pro'].output / OFFICIAL_PEAK_PRICES.USD['deepseek-v4-pro'].output, 75 / 11);

const aliasTables = buildPriceTables([{ model: 'deepseek-v4-flash', output: 99 }]);
near('别名覆盖落到规范 id（默认人民币表）', aliasTables.CNY['deepseek-flash'].peak.output, 99);
near('别名覆盖不影响美元表', aliasTables.USD['deepseek-flash'].peak.output, 1.2);
const usdOnly = buildPriceTables([{ model: 'deepseek-flash', currency: 'USD', output: 5 }]);
near('覆盖项可指定币种', usdOnly.USD['deepseek-flash'].peak.output, 5);
near('指定币种时不改人民币表', usdOnly.CNY['deepseek-flash'].peak.output, 8);

console.log('\n── A. 计费算术 ──');

// 用量刻意取整数：1M 未命中输入 + 1M 命中输入 + 0.5M 输出
const sample = normalizeTokens({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 500_000 });
const cnyCost = costOfTokens(sample, tables.CNY['deepseek-flash'].peak);
near('人民币：未命中 1M = 2 元', cnyCost.input, 2);
near('人民币：命中 1M = 0.04 元', cnyCost.cache, 0.04);
near('人民币：输出 0.5M = 4 元', cnyCost.output, 4);
near('人民币：合计 6.04 元', cnyCost.total, 6.04);
near('人民币：缓存省下 (2−0.04)×1M = 1.96 元', cnyCost.cacheSaved, 1.96);
const usdCost = costOfTokens(sample, tables.USD['deepseek-flash'].peak);
near('美元：合计 $0.906', usdCost.total, 0.906);
near('美元：缓存省下 $0.294', usdCost.cacheSaved, 0.294);

console.log('\n── A. 事件折叠 ──');

const official = ['deepseek-official', 'deepseek-account'];
const fold = createFold({ providers: () => official, holidays: () => [], billCap: () => 5 });

let state = initState();
const ignored = fold(state, { type: 'tool/call', time: FRI_0200_UTC, data: { name: 'bash' } });
check('不关心的事件返回同一引用', ignored === state);

state = fold(state, {
  type: 'request/header',
  time: FRI_0200_UTC,
  data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
});
check('request/header 记下路由', state.route?.provider === 'deepseek-official');

// 关键回归：请求在高价时段发出、消息落地时已出峰 → 必须按「发出时间」算高峰。
state = fold(state, { type: 'step/start', time: Date.UTC(2026, 9, 16, 3, 59, 0), data: { turn: 1, step: 1 } });
state = fold(state, {
  type: 'assistant/message',
  time: Date.UTC(2026, 9, 16, 4, 0, 30), // 落地时已出峰
  data: {
    turn: 1,
    step: 1,
    message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
});
const chatBucket = 'deepseek-official\u0001deepseek-flash';
check('用量进了桶', state.buckets[chatBucket]?.calls === 1);
check('跨峰边界的调用按「请求发出时间」记高峰', state.buckets[chatBucket]?.peak.input === 1_000_000, JSON.stringify(state.buckets[chatBucket]));
check('账单清单长度 1', state.bills.length === 1);
state = fold(state, { type: 'step/end', time: Date.UTC(2026, 9, 16, 4, 0, 31), data: { turn: 1, step: 1 } });
check('step/end 清掉请求发出时间（避免下一步误用）', state.requestStartAt === null);

// 同一序列的后续步骤：没有新的 request/header，靠 message.source / 上次路由继承
state = fold(state, {
  type: 'assistant/message',
  time: FRI_0500_UTC, // 空闲
  data: {
    turn: 1,
    step: 2,
    message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 } } }],
  },
});
check('没有 data.usage 时从流式记录里取用量', state.buckets[chatBucket]?.offPeak.cacheRead === 1_000_000);
check('空闲用量记在 offPeak 桶', state.buckets[chatBucket]?.offPeakCalls === 1);

// 失败尝试：只计数，不算钱
state = fold(state, {
  type: 'assistant/attempt',
  time: FRI_0200_UTC,
  data: { turn: 2, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }] },
});
check('失败尝试被计数', state.failedAttempts === 1);
check('失败尝试的 token 被单独记录', state.failedAttemptTokens === 5000);
check('失败尝试不进用量桶', state.buckets[chatBucket].calls === 2);

// 退役别名：应归并到同一个桶
state = fold(state, { type: 'request/header', time: FRI_0200_UTC, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-v4-flash' } } } });
state = fold(state, {
  type: 'assistant/message',
  time: FRI_0200_UTC,
  data: { turn: 3, step: 1, usage: { inputTokens: 100, outputTokens: 50 } },
});
check('别名归并到规范 id 的桶', state.buckets['deepseek-account\u0001deepseek-flash']?.calls === 1);

// 非官方路由：只计数
state = fold(state, { type: 'request/header', time: FRI_0200_UTC, data: { header: { config: { provider: 'yitaizhongji-chat', model: 'gpt-6.1-sol' } } } });
state = fold(state, {
  type: 'assistant/message',
  time: FRI_0200_UTC,
  data: { turn: 4, step: 1, usage: { inputTokens: 999_999, outputTokens: 999_999 } },
});
check('非官方路由不计入用量桶', Object.keys(state.buckets).length === 2);
check('非官方路由只被计数', state.foreign['yitaizhongji-chat\u0001gpt-6.1-sol'] === 1);

// 压缩调用：计入本会话，且按 compaction/start 的时间判峰谷
state = fold(state, { type: 'compaction/start', time: FRI_0500_UTC, data: { compactionId: 'c1', turn: 5 } });
state = fold(state, {
  type: 'compaction/summary',
  time: FRI_0900_UTC, // 落地在高峰，但发起时空闲
  data: { provider: 'deepseek-official', model: 'deepseek-flash', usage: { inputTokens: 0, outputTokens: 1_000_000 } },
});
check('压缩调用计入同一路由的桶', state.buckets[chatBucket]?.calls === 3);
check('压缩那一笔标记为 compaction', state.bills[state.bills.length - 1].kind === 'compaction');
check('压缩按发起时间判为空闲', state.bills[state.bills.length - 1].peak === false);
state = fold(state, { type: 'compaction/end', time: FRI_0900_UTC, data: { compactionId: 'c1' } });

// 没有用量：记一笔 usageMissing，不改用量
const beforeMissing = state.buckets[chatBucket].calls;
state = fold(state, {
  type: 'assistant/message',
  time: FRI_0200_UTC,
  data: { turn: 6, step: 1, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, stream: [] },
});
check('没有上报用量时只记 usageMissing', state.usageMissing === 1 && state.buckets[chatBucket].calls === beforeMissing);

console.log('\n── A. 视图 ──');

const view = createView({
  priceTables: () => tables,
  currencies: ['CNY', 'USD'],
  displayCurrency: () => 'CNY',
  pricingSource: 'https://example.invalid/pricing',
  billLimit: () => 12,
});
const rendered = view(state);
check('priced=true（有官方计价）', rendered.priced === true);
check('displayCurrency=CNY', rendered.displayCurrency === 'CNY');
check('两种币种都有金额', typeof rendered.money.CNY.total === 'number' && typeof rendered.money.USD.total === 'number');
check('calls = 4（3 笔 flash + 1 笔账号路由的别名调用）', rendered.calls === 4, `实际=${rendered.calls}`);
check('foreignCalls = 1', rendered.foreignCalls === 1, `实际=${rendered.foreignCalls}`);
check('foreignModels 里有中转站', rendered.foreignModels.includes('gpt-6.1-sol'));
check('峰谷调用数之和等于总调用数', rendered.peakCalls + rendered.offPeakCalls === rendered.calls);
check('高峰金额 > 0', rendered.money.CNY.peak > 0);
check('空闲金额 > 0', rendered.money.CNY.offPeak > 0);
check('缓存节省 > 0', rendered.money.CNY.cacheSaved > 0);
check('人民币金额 ≈ 美元金额 × 6.67（flash 官方比价）', rendered.money.CNY.total > rendered.money.USD.total * 6);
check('模型按金额降序', rendered.models.length === 2 && rendered.models[0].money.CNY.total >= rendered.models[1].money.CNY.total);
check('每个模型都带两种币种金额', rendered.models.every((item) => typeof item.money.CNY.total === 'number' && typeof item.money.USD.total === 'number'));
check('最近调用最多 12 笔', rendered.bills.length <= 12);
check('bills 里最新一笔在最前', rendered.bills[0].at >= rendered.bills[rendered.bills.length - 1].at);
check('每笔调用都带两种币种金额', rendered.bills.every((bill) => typeof bill.money.CNY === 'number' && typeof bill.money.USD === 'number'));
check('失败尝试计数进了视图', rendered.failedAttempts === 1 && rendered.failedAttemptTokens === 5000);
check('同一状态复用同一视图对象', view(state) === rendered);

const usdView = createView({ priceTables: () => tables, currencies: ['CNY', 'USD'], displayCurrency: () => 'USD', pricingSource: 'x' })(state);
check('displayCurrency 可切到 USD', usdView.displayCurrency === 'USD');
const badView = createView({ priceTables: () => tables, currencies: ['CNY', 'USD'], displayCurrency: () => 'EUR', pricingSource: 'x' })(state);
check('不认识的展示币种回落到第一个', badView.displayCurrency === 'CNY');

const emptyView = view(initState());
check('空会话 priced=false', emptyView.priced === false);
check('空会话两种币种总额都为 0', emptyView.money.CNY.total === 0 && emptyView.money.USD.total === 0);

const unknownModel = createView({ priceTables: () => tables, currencies: ['CNY', 'USD'], displayCurrency: () => 'CNY', pricingSource: 'x' })(
  createFold({ providers: () => official, holidays: () => [], billCap: () => 4 })(
    fold(initState(), { type: 'request/header', time: FRI_0200_UTC, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v9-unknown' } } } }),
    { type: 'assistant/message', time: FRI_0200_UTC, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 10 } } },
  ),
);
check('没价目的模型被单独列出', unknownModel.unpricedModels.length === 1);
check('没价目的模型仍有 priced=true（好让面板说明原因）', unknownModel.priced === true && unknownModel.calls === 0);

console.log('\n── A. schema 校验 ──');

let stateParsed = null;
try {
  stateParsed = stateSchema.parse(state);
} catch (error) {
  check('状态能通过 stateSchema', false, String(error));
}
check('状态能通过 stateSchema', stateParsed !== null);
check('状态经 schema 后仍是 JSON', JSON.stringify(stateParsed) === JSON.stringify(state));

let viewParsed = null;
try {
  viewParsed = viewSchema.parse(rendered);
} catch (error) {
  check('视图能通过 viewSchema', false, String(error));
}
check('视图能通过 viewSchema', viewParsed !== null);
check('视图经 schema 后字段不变', JSON.stringify(viewParsed) === JSON.stringify(rendered));

let missingCaught = false;
try {
  viewSchema.parse({ ...rendered, money: { ...rendered.money, CNY: { ...rendered.money.CNY, total: undefined } } });
} catch {
  missingCaught = true;
}
check('视图少字段会被 schema 拦下', missingCaught === true);

let typeCaught = false;
try {
  viewSchema.parse({ ...rendered, calls: -1 });
} catch {
  typeCaught = true;
}
check('视图类型不对会被 schema 拦下', typeCaught === true);

let stateOldCaught = false;
try {
  const { requestStartAt: _dropped, ...oldState } = state;
  stateSchema.parse(oldState);
} catch {
  stateOldCaught = true;
}
check('旧版状态（缺 requestStartAt）会被拦下 → 触发重放', stateOldCaught === true);

/* ══════════════════ B. Client 侧 ══════════════════ */

console.log('\n── B. 客户端模块 ──');

/** 极简 React shim：够用即止。 */
function makeReact(host) {
  let current = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    createElement(type, props, ...children) {
      const flat = children.flat().filter((child) => child !== null && child !== undefined && child !== false);
      return { type, props: { ...(props ?? {}), children: flat } };
    },
    useState(initial) {
      const slot = (current.hooks[current.index] ??= { value: typeof initial === 'function' ? initial() : initial });
      current.index += 1;
      const set = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
        host.dirty = true;
      };
      return [slot.value, set];
    },
    useRef(initial) {
      const slot = (current.hooks[current.index] ??= { current: initial });
      current.index += 1;
      return slot;
    },
    useCallback(fn, deps) {
      const slot = (current.hooks[current.index] ??= { fn, deps });
      current.index += 1;
      if (!sameDeps(slot.deps, deps)) {
        slot.fn = fn;
        slot.deps = deps;
      }
      return slot.fn;
    },
    useEffect(fn, deps) {
      const slot = (current.hooks[current.index] ??= { deps: undefined, cleanup: undefined });
      current.index += 1;
      current.pending.push({ slot, fn, deps });
    },
    useLayoutEffect(fn, deps) {
      const slot = (current.hooks[current.index] ??= { deps: undefined, cleanup: undefined });
      current.index += 1;
      current.pending.push({ slot, fn, deps, layout: true });
    },
    __setCurrent(instance) {
      current = instance;
    },
    __sameDeps: sameDeps
  };
}

/** 造一个「能反复渲染一个函数组件」的最小宿主。 */
function makeHost(React) {
  return {
    dirty: false,
    React,
    render(Component, props) {
      this.Component = Component;
      this.props = props;
      this.hooks = this.hooks ?? [];
      let guard = 0;
      let tree = null;
      do {
        this.dirty = false;
        const instance = { hooks: this.hooks, index: 0, pending: [] };
        React.__setCurrent(instance);
        tree = Component(props);
        React.__setCurrent(null);
        for (const item of instance.pending) {
          const changed = item.deps === undefined || !React.__sameDeps(item.slot.deps, item.deps);
          if (!changed) continue;
          if (typeof item.slot.cleanup === 'function') item.slot.cleanup();
          item.slot.deps = item.deps;
          item.slot.cleanup = item.fn() ?? undefined;
        }
        guard += 1;
      } while (this.dirty && guard < 20);
      this.tree = tree;
      return tree;
    },
    text(node = this.tree) {
      if (node === null || node === undefined || node === false) return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map((child) => this.text(child)).join('');
      if (typeof node === 'object' && node.props) return this.text(node.props.children);
      return '';
    },
    findByClass(name, node = this.tree, found = []) {
      if (node === null || node === undefined || typeof node !== 'object') return found;
      if (Array.isArray(node)) {
        for (const child of node) this.findByClass(name, child, found);
        return found;
      }
      const className = node.props?.className;
      if (typeof className === 'string' && className.split(/\s+/).includes(name)) found.push(node);
      if (node.props?.children !== undefined) this.findByClass(name, node.props.children, found);
      return found;
    },
    click(element) {
      element.props.onClick?.({ target: element });
      return this.render(this.Component, this.props);
    }
  };
}

const bundleSource = fs.readFileSync(BUNDLE, 'utf8');
const listeners = { document: {}, window: {} };
const fakeDocument = {
  head: { appendChild() {} },
  createElement() {
    return { dataset: {}, textContent: '', remove() {} };
  },
  addEventListener(type, fn) {
    (listeners.document[type] ??= []).push(fn);
  },
  removeEventListener(type, fn) {
    listeners.document[type] = (listeners.document[type] ?? []).filter((item) => item !== fn);
  }
};
const fakeWindow = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener(type, fn) {
    (listeners.window[type] ??= []).push(fn);
  },
  removeEventListener(type, fn) {
    listeners.window[type] = (listeners.window[type] ?? []).filter((item) => item !== fn);
  }
};

let loaded = null;
let requireError = null;
const sandbox = {
  window: fakeWindow,
  document: fakeDocument,
  console,
  setTimeout,
  clearTimeout,
  Symbol,
  Object,
  Array,
  JSON,
  Math,
  Number,
  String,
  Boolean,
  Date,
  isFinite,
  isNaN,
  Intl
};
sandbox.globalThis = sandbox;
fakeWindow.__ModuleLoader__ = {
  load(definition) {
    try {
      loaded = definition.factory((name) => {
        if (name === 'react') return sandbox.__reactShim;
        throw new Error('未知模块：' + name);
      });
      loaded.__id = definition.id;
    } catch (error) {
      requireError = error;
    }
  }
};

const React = makeReact({ dirty: false });
sandbox.__reactShim = React;
vm.createContext(sandbox);
try {
  vm.runInContext(bundleSource, sandbox, { filename: 'lib/client.js' });
} catch (error) {
  check('客户端 bundle 能在模块加载器里执行', false, String(error));
}

check('模块 id 是 dsh-session-cost', loaded?.__id === 'dsh-session-cost', String(loaded?.__id));
check('模块加载没有抛错', requireError === null, requireError ? String(requireError) : '');

if (loaded !== null) {
  const registrations = [];
  const dictionaries = [];
  const effects = [];
  const locale = {
    register(namespace, dict) {
      dictionaries.push({ namespace, dict });
      return () => {};
    },
    bind(namespace) {
      const dict = dictionaries.find((item) => item.namespace === namespace)?.dict?.zh ?? {};
      return (key, params) =>
        (dict[key] ?? key).replace(/\{(\w+)\}/g, (all, name) => (name in (params ?? {}) ? String(params[name]) : all));
    }
  };
  const slots = {
    inject(owner, callback) {
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    }
  };
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose ?? (() => {});
    },
    inject(services, callback) {
      callback({ ...ctx, locale, slots });
    },
    get() {
      return undefined;
    }
  };

  let applyError = null;
  try {
    loaded.apply(ctx);
  } catch (error) {
    applyError = error;
  }
  check('apply 不抛错', applyError === null, applyError ? String(applyError) : '');
  check('注册了样式表', effects.some((item) => String(item.label).includes('stylesheet')));
  check('注册了字典', dictionaries.some((item) => item.namespace === 'session-cost'));
  check('注册进会话标题栏工具区', registrations[0]?.options?.name === 'conversation.session.header.utilities', String(registrations[0]?.options?.name));
  check('用了自己的格子 id', registrations[0]?.options?.id === 'session-cost-row', String(registrations[0]?.options?.id));
  check('声明了 locale 命名空间', registrations[0]?.options?.locale === 'session-cost');

  const t = locale.bind('session-cost');
  const component = registrations[0]?.component;

  // 有官方计价 → 渲染出人民币金额（默认展示币种）
  const host = makeHost(React);
  const view = {
    priced: true,
    displayCurrency: 'CNY',
    currencies: ['CNY', 'USD'],
    calls: 7,
    foreignCalls: 2,
    unpricedCalls: 0,
    usageMissing: 1,
    failedAttempts: 2,
    failedAttemptTokens: 1234,
    peakCalls: 4,
    offPeakCalls: 3,
    tokens: { input: 1_000_000, cacheRead: 500_000, cacheWrite: 0, output: 125_000 },
    money: {
      CNY: { total: 4.531, input: 2, cache: 0.02, cacheWrite: 0, output: 1, cacheSaved: 1.97, peak: 3.1, offPeak: 1.43 },
      USD: { total: 0.6797, input: 0.3, cache: 0.003, cacheWrite: 0, output: 0.15, cacheSaved: 0.297, peak: 0.465, offPeak: 0.215 },
    },
    models: [
      {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        label: 'DeepSeek-V4.1-Flash',
        calls: 7,
        tokens: { input: 1_000_000, cacheRead: 500_000, cacheWrite: 0, output: 125_000 },
        money: { CNY: { total: 4.531, cacheSaved: 1.97, peak: 3.1, offPeak: 1.43 }, USD: { total: 0.6797, cacheSaved: 0.297, peak: 0.465, offPeak: 0.215 } },
      },
    ],
    bills: [
      { at: Date.UTC(2026, 9, 16, 2, 30), model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', kind: 'chat', peak: true, usd: 0.12, money: { CNY: 0.8, USD: 0.12 }, tokens: { input: 400_000, cacheRead: 0, cacheWrite: 0, output: 0 } },
      { at: Date.UTC(2026, 9, 16, 6, 10), model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', kind: 'compaction', peak: false, usd: 0.01, money: { CNY: 0.07, USD: 0.01 }, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 8_000 } },
    ],
    unpricedModels: [],
    foreignModels: ['gpt-6.1-sol'],
    pricingSource: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  };
  const tree = host.render(component, { useProjection: () => view, useSessions: () => undefined, t });
  const text = host.text(tree);
  check('徽章渲染出人民币金额', text.includes('¥4.53'), text.slice(0, 80));
  check('徽章上有无障碍标签', host.findByClass('dsc-chip')[0]?.props['aria-label']?.includes('¥4.53'));
  check('默认不显示面板', host.findByClass('dsc-panel').length === 0);
  check('没有 require 任何 Harness 客户端包', requireError === null);

  const chip = host.findByClass('dsc-chip')[0];
  const opened = host.click(chip);
  const panelText = host.text(opened);
  check('点击后面板出现', host.findByClass('dsc-panel').length === 1);
  check('面板里有「本会话费用」', panelText.includes('本会话费用'));
  check('面板里四个 token 桶里出现三个（缓存写入为 0 不显示）', ['输入 · 未命中缓存', '输入 · 命中缓存', '输出'].every((label) => panelText.includes(label)));
  check('面板里没有「缓存写入」行（该桶为 0）', panelText.includes('缓存写入') === false);
  check('面板里有缓存节省', panelText.includes('缓存命中省下'));
  check('面板里有高峰/空闲拆分', panelText.includes('峰时') && panelText.includes('谷时'));
  check('面板里有最近调用（压缩那笔）', panelText.includes('压缩'));
  check('面板里有未计入的警告', panelText.includes('非官方路由'));
  check('面板里有失败尝试的提示', panelText.includes('失败/中断的尝试'));
  check('面板里给出美元对照', panelText.includes('另按美元价'), panelText.slice(0, 0));
  check('面板里有美元金额', panelText.includes('$0.67'), panelText.slice(0, 0));

  const closed = host.click(host.findByClass('dsc-chip')[0]);
  check('再点一次面板收起', host.findByClass('dsc-panel').length === 0);

  // 切到美元展示
  const usdHost = makeHost(React);
  const usdTree = usdHost.render(component, { useProjection: () => ({ ...view, displayCurrency: 'USD' }), t });
  check('displayCurrency=USD 时徽章显示美元', usdHost.text(usdTree).includes('$0.68') || usdHost.text(usdTree).includes('$0.6797'), usdHost.text(usdTree).slice(0, 60));

  // 非官方会话 → 整个组件返回 null
  const otherHost = makeHost(React);
  check('非官方会话不渲染任何东西', otherHost.render(component, { useProjection: () => ({ ...view, priced: false }), t }) === null);

  const loadingHost = makeHost(React);
  check('投影未到达时不渲染', loadingHost.render(component, { useProjection: () => undefined, t }) === null);

  // 缺 t（老宿主）也不该炸
  const noHost = makeHost(React);
  const fallbackTree = noHost.render(component, { useProjection: () => view });
  check('没有 t 时退化成内置中文文案', noHost.text(fallbackTree).includes('¥4.53'));

  // Esc 关闭
  const escHost = makeHost(React);
  escHost.render(component, { useProjection: () => view, t });
  escHost.click(escHost.findByClass('dsc-chip')[0]);
  const keydown = listeners.document.keydown ?? [];
  check('打开时挂了键盘监听', keydown.length > 0);
  for (const handler of keydown) handler({ key: 'Escape' });
  escHost.render(component, { useProjection: () => view, t });
  check('按 Esc 关掉面板', escHost.findByClass('dsc-panel').length === 0);
}

/* ══════════════════ 收尾 ══════════════════ */

console.log(`\n共 ${checks} 项检查，失败 ${failures} 项。`);
if (failures > 0) process.exit(1);
console.log('冒烟测试通过（注意：这里只验证结构与数字，视觉验收要在页面里做）。');
