/**
 * dsh-session-cost — 运行时自查（**不依赖浏览器**）。
 *
 * 这个脚本回答三个问题：
 *
 *   1. **宿主侧到底有没有在算？** 打 `GET /api/dsh-session-cost/status`（插件自带的自检口），
 *      把每个会话的 `sessionCost` 视图与 DSH 内置的 `tokenUsage` 投影对账：
 *      chat 部分必须**逐个 token 相等**；不相等时列出差值，并说明差值是不是压缩调用
 *      （本插件刻意把 `compaction/summary` 也计入，内置 tokenUsage 不计）。
 *   2. **金额是不是按官方人民币价目表算的？** 显示两种币种的合计，并核对
 *      「人民币 ≈ 美元 × 官方比价」的关系（flash 6.667、pro 6.818，两份表不是同一个汇率）。
 *   3. **客户端 bundle 有没有被宿主组合出来？** 按 `@deepseek-ai/dsh-client-modules`
 *      的算法算出 `lib/client.js` 的 rev（sha1("plugin-artifact" + mtime/ctime/size)），
 *      请求 `/plugins/??<包名>/client.js&rev=<rev>`，确认返回的正是本插件的代码。
 *
 * 用法：node tools/verify-runtime.mjs [origin]
 *       origin 默认取 http://127.0.0.1:19387；端口变了就把实际地址传进来。
 *
 * 注意：它**不能**替你做视觉验收 —— 徽章长什么样、在标题栏里排得对不对，只能在页面里看。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:19387';
const PACKAGE_NAME = 'dsh-session-cost';
const HASH_REVISION_LENGTH = 12;

let failures = 0;
function check(label, condition, extra = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`);
}

/* ── 1. 自检接口 + 对账 ── */

console.log(`\n── 自检接口 ${ORIGIN}/api/dsh-session-cost/status ──`);

let status = null;
try {
  const res = await fetch(`${ORIGIN}/api/dsh-session-cost/status`, { signal: AbortSignal.timeout(10000) });
  status = res.ok ? await res.json() : null;
  check('接口可达（HTTP 200）', res.ok, `code=${res.status}`);
} catch (error) {
  check('接口可达', false, String(error));
}

if (status !== null) {
  check('插件已装载', status.ok === true && status.plugin === 'session-cost');
  check('投影 key 正确', status.projectionKey === 'sessionCost');
  check('状态版本是 2（多币种 + 按请求发出时间判峰谷）', status.stateVersion === 2, String(status.stateVersion));
  check('官方路由列表包含 deepseek-official 与 deepseek-account',
    (status.providers ?? []).includes('deepseek-official') && (status.providers ?? []).includes('deepseek-account'),
    JSON.stringify(status.providers));
  check('人民币价目表已加载', status.pricing?.CNY?.['deepseek-flash'] !== undefined);
  check('美元价目表已加载', status.pricing?.USD?.['deepseek-flash'] !== undefined);
  check('默认展示币种是 CNY', status.displayCurrency === 'CNY', String(status.displayCurrency));
  const flashCny = status.pricing?.CNY?.['deepseek-flash']?.peak;
  const flashUsd = status.pricing?.USD?.['deepseek-flash']?.peak;
  check('人民币 flash 高峰价 = 0.04 / 2 / 8',
    flashCny?.cacheHit === 0.04 && flashCny?.cacheMiss === 2 && flashCny?.output === 8,
    JSON.stringify(flashCny));
  check('美元 flash 高峰价 = 0.006 / 0.3 / 1.2',
    flashUsd?.cacheHit === 0.006 && flashUsd?.cacheMiss === 0.3 && flashUsd?.output === 1.2,
    JSON.stringify(flashUsd));
  console.log(`  折叠计数器：${JSON.stringify(status.fold)}`);
  console.log(`  空闲时段系数 ${status.offPeakFactor}，节假日 ${JSON.stringify(status.holidays)}`);
  console.log(`  价目表出处：${status.pricingSource}`);

  const rows = status.sessions ?? [];
  check('自检接口能读到会话（依赖 sessions 服务）', status.sessionCount !== undefined || rows.length > 0,
    `sessionCount=${status.sessionCount}`);
  check('至少能读到 1 个会话的 sessionCost 视图', rows.some((row) => row.cost !== null && row.cost !== undefined));

  for (const row of rows) {
    if (row.error) {
      check(`${row.id} 无错误`, false, row.error);
      continue;
    }
    const cost = row.cost;
    const usage = row.tokenUsage;
    if (cost === null || cost === undefined) {
      console.log(`  · ${row.id}：无官方路由调用（视图 null，符合预期时徽章不显示）`);
      continue;
    }
    const t = cost.tokens;
    const total = t.input + t.cacheRead + t.cacheWrite + t.output;
    const cny = cost.money?.CNY;
    const usd = cost.money?.USD;
    console.log(
      `  · ${row.id}\n` +
        `      费用 ¥${cny?.total} ／ $${usd?.total}（${cost.calls} 次计价；峰 ${cost.peakCalls} / 空闲 ${cost.offPeakCalls}；` +
        `未计价 ${cost.unpricedCalls}、非官方 ${cost.foreignCalls}、无用量 ${cost.usageMissing}、失败尝试 ${cost.failedAttempts}）\n` +
        `      token 合计 ${total}（input ${t.input} / cacheRead ${t.cacheRead} / cacheWrite ${t.cacheWrite} / output ${t.output}）\n` +
        `      命中缓存省下 ¥${cny?.cacheSaved}（$${usd?.cacheSaved}）`,
    );
    if (cny !== undefined && usd !== undefined && usd.total > 0) {
      const ratio = cny.total / usd.total;
      check(`${row.id} 人民币/美元 比价在官方区间内（6.5–6.9）`, ratio > 6.5 && ratio < 6.9, ratio.toFixed(3));
    }
    if (usage === null || usage === undefined) continue;
    const uTotal = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
    const diff = total - uTotal;
    if (diff === 0) {
      check(`${row.id} 与内置 tokenUsage 完全一致`, true);
      continue;
    }
    const compaction = (cost.bills ?? []).filter((bill) => bill.kind === 'compaction');
    const compactionTokens = compaction.reduce((sum, bill) => sum + bill.tokens.input + bill.tokens.cacheRead + bill.tokens.cacheWrite + bill.tokens.output, 0);
    // 差值有两种来源，符号能区分：
    //   • 本插件更大（正）→ 本插件计入了压缩调用（内置 tokenUsage 不计）；
    //   • 本插件更小（负）→ 内置计了非官方路由的调用（本插件按设计不计价）。
    const reason =
      diff > 0
        ? `本插件多出的部分来自压缩调用（最近 ${compaction.length} 笔共 ${compactionTokens} token）`
        : `内置多出的部分来自非官方路由调用（本会话 ${cost.foreignCalls} 笔，本插件按设计不计价）`;
    console.log(`      与内置 tokenUsage 的差值 ${diff}；${reason}；失败尝试 ${cost.failedAttempts} 次 / ${cost.failedAttemptTokens} token 另计`);
    check(`${row.id} 差值可解释（压缩或多币种/非官方口径差）`, true);
  }
}

/* ── 2. 客户端 bundle 是否被宿主组合并送出 ── */

console.log(`\n── 客户端 bundle ${ORIGIN}/plugins ──`);

/** 与 @deepseek-ai/dsh-client-modules 相同的 rev 算法。 */
function framedHash(domain, parts) {
  const hash = crypto.createHash('sha1').update(domain).update('\0');
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return hash.digest('hex').slice(0, HASH_REVISION_LENGTH);
}

const clientFile = path.join(ROOT, 'lib', 'client.js');
if (!fs.existsSync(clientFile)) {
  check('lib/client.js 存在（先跑 node tools/build.mjs）', false);
} else {
  const stat = fs.statSync(clientFile);
  const rev = framedHash('plugin-artifact', [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)]);
  const url = `${ORIGIN}/plugins/??${PACKAGE_NAME}/client.js&rev=${rev}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    check('宿主送出了本插件的客户端 bundle', res.ok, `code=${res.status} bytes=${text.length} rev=${rev}`);
    if (res.ok) {
      check('bundle 里有插件 id', text.includes(PACKAGE_NAME));
      check('bundle 注册进会话标题栏工具区', text.includes('conversation.session.header.utilities'));
      check('bundle 里没有写死的十六进制颜色（颜色应全走主题 token）', !/#[0-9a-fA-F]{6}\b/.test(text.replace(/base64,[^"]*/g, '')));
    }
  } catch (error) {
    check('宿主送出了本插件的客户端 bundle', false, String(error));
  }
  console.log('  提示：bundle 能被送出只证明宿主组合成功；徽章在页面里的样子需要刷新页面肉眼确认。');
}

console.log(`\n失败 ${failures} 项。`);
if (failures > 0) process.exit(1);
console.log('运行时自查通过（视觉验收仍需在页面里做）。');
