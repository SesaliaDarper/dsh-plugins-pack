/**
 * dsh-session-cost — 会话记账审计（离线读 JSONL，不碰运行中的 DSH）。
 *
 * 为什么需要它：徽章只报一个数，而「这个数对不对」必须能逐笔核对。这个脚本把一份会话日志
 * 按事件顺序重放，同时算两套口径并指出差异来源：
 *
 *   · 本插件口径（lib/fold.js）：`assistant/message` 的用量 + `compaction/summary`，
 *     且**只计官方路由**；
 *   · 内置 `tokenUsage` 口径（@deepseek-ai/dsh-token-meter）：`assistant/message` 与
 *     `assistant/attempt` 的用量都算，同一 (turn, step) 内后一条替换前一条，
 *     `llm/retry-started` 清空替换槽（所以重试的那次尝试会**再加一笔**），
 *     不区分路由、也不计压缩。
 *
 * 两边对不上时，脚本会逐条列出「内置算了、本插件没算」的调用，以及它的路由/原因。
 *
 * 用法：
 *   node tools/audit-session.mjs <sessionId> [sessionsRoot]
 *   node tools/audit-session.mjs --list
 *
 * 日志格式：JSONL + 多个独立 zstd frame 顺序追加（见 dsh-session-persistence-jsonl
 * 的 scanZstdFrames）；所以不能一次性 zstdDecompressSync 整个文件 —— 那只会解出第一帧。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { DEFAULT_PROVIDERS, buildPriceTables, costOfTokens, isPeakHour, modelLabel, normalizeTokens, priceAt } from '../lib/pricing.js';
import { createFold, createView, initState, usageOf } from '../lib/fold.js';

const ZSTD_MAGIC = 4247762216;
const sessionsRoot = process.argv[3] ?? path.join(os.homedir(), '.dsh', 'sessions');

/* ───────────── zstd 多帧扫描（与 dsh-session-persistence-jsonl 同算法） ───────────── */

/** 返回完整帧的 [start, end) 区间；末帧不完整时忽略。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`frame magic 不对，偏移 ${offset}`);
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push([start, offset]);
  }
  return frames;
}

/** 解出整份日志的所有事件。 */
function readEvents(file) {
  const bytes = fs.readFileSync(file);
  const events = [];
  for (const [start, end] of scanZstdFrames(bytes)) {
    let text;
    try {
      text = zlib.zstdDecompressSync(bytes.subarray(start, end)).toString('utf8');
    } catch (error) {
      throw new Error(`第 ${start} 字节处的 frame 解压失败：${error.message}`);
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* 跳过撕裂的尾部片段 */
      }
    }
  }
  return events;
}

/** 列出所有会话目录。 */
function listSessions() {
  const out = [];
  for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(sessionsRoot, group.name);
    for (const session of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = path.join(groupDir, session.name);
      const file = fs.readdirSync(dir).find((name) => name.startsWith('session.') && name.endsWith('.jsonl.zstd'));
      if (file === undefined) continue;
      const stat = fs.statSync(path.join(dir, file));
      out.push({ id: session.name, group: group.name, file: path.join(dir, file), mtime: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/* ───────────── 内置 tokenUsage 口径（照抄 usage-projection.js） ───────────── */

function builtinTokenUsage(events) {
  const bucketsFrom = (usage) => ({
    uncachedInputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  });
  const equal = (left, right) =>
    left.uncachedInputTokens === right.uncachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens;
  let totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let last = null;
  for (const event of events) {
    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === event.data.turn && last.step === event.data.step) last = null;
      continue;
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const sample = event.type === 'assistant/message' && event.data.usage !== undefined ? event.data.usage : usageOf(event.data);
    if (sample === undefined) continue;
    const { turn, step } = event.data;
    const buckets = bucketsFrom(sample);
    const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined;
    if (previous !== undefined && equal(previous, buckets)) continue;
    totals = {
      uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + buckets.uncachedInputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + buckets.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + buckets.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + buckets.cacheWriteTokens,
    };
    last = { turn, step, buckets };
  }
  return totals;
}

/* ───────────── 主流程 ───────────── */

if (process.argv[2] === '--list') {
  for (const item of listSessions().slice(0, 20)) {
    console.log(`${item.id}  ${new Date(item.mtime).toISOString()}  ${item.group}`);
  }
  process.exit(0);
}

const sessionId = process.argv[2];
if (sessionId === undefined) {
  console.error('用法：node tools/audit-session.mjs <sessionId> [sessionsRoot]  或  --list');
  process.exit(1);
}
const found = listSessions().find((item) => item.id === sessionId || item.id.includes(sessionId));
if (found === undefined) {
  console.error(`找不到会话 ${sessionId}（用 --list 看看有什么）`);
  process.exit(1);
}

console.log(`会话：${found.id}`);
console.log(`日志：${found.file}`);
const events = readEvents(found.file);
console.log(`事件：${events.length} 条\n`);

/* 本插件口径：直接跑真实代码 */
const tables = buildPriceTables();
const fold = createFold({
  providers: () => DEFAULT_PROVIDERS,
  holidays: () => [],
  billCap: () => 100000,
});
let state = initState();
for (const event of events) state = fold(state, event);
const view = createView({
  priceTables: () => tables,
  currencies: ['CNY', 'USD'],
  displayCurrency: () => 'CNY',
  pricingSource: 'local',
  billLimit: () => 1000,
})(state);

const builtin = builtinTokenUsage(events);
const mine = view.tokens;
const mineTotal = mine.input + mine.cacheRead + mine.cacheWrite + mine.output;
const builtinTotal = builtin.uncachedInputTokens + builtin.cacheReadTokens + builtin.cacheWriteTokens + builtin.outputTokens;

console.log('① 本插件口径（只有官方路由 + 计入压缩 + 按请求发出时间判峰谷）');
console.log(`   调用 ${view.calls} 次，金额 ¥${view.money.CNY.total} ／ $${view.money.USD.total}`);
console.log(`   token：input=${mine.input} cacheRead=${mine.cacheRead} cacheWrite=${mine.cacheWrite} output=${mine.output} 合计=${mineTotal}`);
console.log(`   峰 ${view.peakCalls} 次 / 空闲 ${view.offPeakCalls} 次；命中缓存省下 ¥${view.money.CNY.cacheSaved}（$${view.money.USD.cacheSaved}）`);
console.log(`   非官方路由 ${view.foreignCalls} 次（${view.foreignModels.join(', ') || '无'}）；无用量 ${view.usageMissing} 次；失败尝试 ${view.failedAttempts} 次（${view.failedAttemptTokens} token，未计入金额）`);
console.log('\n② 内置 tokenUsage 口径（所有路由 + 每次尝试 + 不计压缩）');
console.log(`   token：input=${builtin.uncachedInputTokens} cacheRead=${builtin.cacheReadTokens} cacheWrite=${builtin.cacheWriteTokens} output=${builtin.outputTokens} 合计=${builtinTotal}`);
console.log(`   差值（①−②）：input=${mine.input - builtin.uncachedInputTokens} cacheRead=${mine.cacheRead - builtin.cacheReadTokens} cacheWrite=${mine.cacheWrite - builtin.cacheWriteTokens} output=${mine.output - builtin.outputTokens} 合计=${mineTotal - builtinTotal}`);

/* 逐笔对账：谁算了、谁没算 */
console.log('\n③ 逐条尝试清单（找出内置算了而本插件没算的调用）');
let attemptCount = 0;
let messageCount = 0;
let orphanAttempts = [];
let foreignCalls = [];
let compactionCalls = [];
let route = null;
let pendingAttempt = null;
for (const event of events) {
  if (event.type === 'request/header') {
    const config = event.data?.header?.config;
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') route = { provider: config.provider, model: config.model };
    continue;
  }
  if (event.type === 'assistant/attempt') {
    attemptCount += 1;
    const sample = usageOf(event.data);
    pendingAttempt = sample === undefined ? null : {
      sample,
      tokens: normalizeTokens({ input: sample.inputTokens, cacheRead: sample.cacheReadTokens, cacheWrite: sample.cacheWriteTokens, output: sample.outputTokens }),
      time: event.time,
      turn: event.data.turn,
      step: event.data.step,
      route: route === null ? null : { ...route },
    };
    continue;
  }
  if (event.type === 'assistant/message') {
    messageCount += 1;
    const sample = event.data.usage ?? usageOf(event.data);
    const source = event.data?.message?.source;
    const usedRoute = typeof source?.provider === 'string' && typeof source?.model === 'string' ? { provider: source.provider, model: source.model } : (pendingAttempt?.route ?? route);
    if (sample !== undefined && usedRoute !== null && !DEFAULT_PROVIDERS.includes(usedRoute.provider)) {
      foreignCalls.push({ time: event.time, route: usedRoute, tokens: normalizeTokens({ input: sample.inputTokens, cacheRead: sample.cacheReadTokens, cacheWrite: sample.cacheWriteTokens, output: sample.outputTokens }) });
    }
    if (pendingAttempt !== null && sample === undefined) {
      orphanAttempts.push(pendingAttempt);
    }
    pendingAttempt = null;
    continue;
  }
  if (event.type === 'compaction/summary') {
    const usage = event.data?.usage;
    if (usage !== undefined) {
      compactionCalls.push({
        time: event.time,
        provider: event.data.provider,
        model: event.data.model,
        tokens: normalizeTokens({ input: usage.inputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, output: usage.outputTokens }),
      });
    }
  }
}
if (pendingAttempt !== null) orphanAttempts.push(pendingAttempt);

const sum = (list) => list.reduce((totals, item) => ({
  input: totals.input + item.tokens.input,
  cacheRead: totals.cacheRead + item.tokens.cacheRead,
  cacheWrite: totals.cacheWrite + item.tokens.cacheWrite,
  output: totals.output + item.tokens.output,
}), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

console.log(`   assistant/attempt ${attemptCount} 条，assistant/message ${messageCount} 条`);
if (orphanAttempts.length > 0) {
  const totals = sum(orphanAttempts);
  console.log(`   ⚠ ${orphanAttempts.length} 条尝试没有对应的 assistant/message（重试后失败/取消），token 合计 ${totals.input + totals.cacheRead + totals.cacheWrite + totals.output}`);
  console.log('     内置 tokenUsage 算了它们，本插件没算 —— 这就是欠计的一类。');
  for (const item of orphanAttempts.slice(0, 5)) {
    console.log(`       turn ${item.turn} step ${item.step} @${new Date(item.time).toISOString()} ${item.route?.provider}/${item.route?.model} in=${item.tokens.input}`);
  }
} else {
  console.log('   ✓ 没有「有尝试但没落地消息」的孤儿尝试');
}
if (foreignCalls.length > 0) {
  const totals = sum(foreignCalls);
  console.log(`   · 非官方路由调用 ${foreignCalls.length} 笔，token 合计 ${totals.input + totals.cacheRead + totals.cacheWrite + totals.output}（按设计不计价）`);
  for (const item of foreignCalls.slice(0, 5)) console.log(`       @${new Date(item.time).toISOString()} ${item.route.provider}/${item.route.model} in=${item.tokens.input} out=${item.tokens.output}`);
}
if (compactionCalls.length > 0) {
  console.log(`   · 压缩调用 ${compactionCalls.length} 笔（本插件计入、内置 tokenUsage 不计）`);
  for (const item of compactionCalls) {
    const peak = isPeakHour(item.time, []);
    const cnyPrice = priceAt(tables.CNY, item.model, peak);
    const usdPrice = priceAt(tables.USD, item.model, peak);
    const cny = cnyPrice === undefined ? 0 : costOfTokens(item.tokens, cnyPrice).total;
    const usd = usdPrice === undefined ? 0 : costOfTokens(item.tokens, usdPrice).total;
    console.log(`       @${new Date(item.time).toISOString()} ${item.provider}/${modelLabel(item.model)} in=${item.tokens.input} out=${item.tokens.output} → ¥${cny.toFixed(4)} / $${usd.toFixed(6)}（${peak ? '高峰' : '空闲'}）`);
  }
}

/* 最近几笔的钱 */
console.log('\n④ 本插件最近的 8 笔计费');
for (const bill of view.bills.slice(0, 8)) {
  console.log(`   ${new Date(bill.at).toISOString()} ${bill.kind === 'compaction' ? '压缩' : '对话'} ${bill.peak ? '高峰' : '空闲'} ${bill.label} ` +
    `in=${bill.tokens.input} cacheRead=${bill.tokens.cacheRead} out=${bill.tokens.output} → ¥${bill.money.CNY} / $${bill.money.USD}`);
}
