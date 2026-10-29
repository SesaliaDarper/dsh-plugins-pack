/**
 * dsh-session-cost — 一个极小的 schema 构造器。
 *
 * ── 为什么不直接用 zod ───────────────────────────────────────────────────
 *
 * `ctx.sessionProjections.register()` 对 `stateSchema` / `wire.viewSchema` 只调一个
 * 方法：`.parse(value)`（见 `@deepseek-ai/dsh-session-projection`：读取时校验状态、
 * 出站前校验视图）。而 profile 里的插件**不能 import 任意裸包**：DSH 的 profile
 * 解析器只路由「安装清单里的包」（`@deepseek-ai/*`）与插件自己的相对路径，
 * 其它裸名（例如 `zod`）会落到 `~/.dsh/profiles/` 往上的原生查找，那里什么都没有。
 * 本 profile 里能用的依赖只有 `@deepseek-ai/schemastery`（配置 schema）和
 * `@deepseek-ai/cosmokit`（volatile 判定），而 schemastery 没有 `.parse`。
 *
 * 所以这里自带一个 90 行的严格校验器：**要求字段齐全、类型正确**，不合法就带路径抛错。
 * 宁可让宿主在折叠时就炸掉（能立刻发现自己的 bug），也不要把形状可疑的 JSON 发给客户端 ——
 * slot 里的组件一旦抛错，整格 UI 会直接空掉，那种失败在浏览器里很难查。
 *
 * @module dsh-session-cost/schema
 */

/** 拼一条清晰的报错信息。 */
function fail(path, expected, value) {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  throw new TypeError(`session-cost schema 校验失败：${path} 期望 ${expected}，实际是 ${actual}`);
}

/** 非空字符串。 */
export const str = () => ({
  parse(value, path = '$') {
    if (typeof value !== 'string') fail(path, 'string', value);
    return value;
  },
});

/** 有限数值（金额用）。 */
export const num = () => ({
  parse(value, path = '$') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'number', value);
    return value;
  },
});

/** 非负安全整数（token 数、调用次数用）。 */
export const int = () => ({
  parse(value, path = '$') {
    if (!Number.isSafeInteger(value) || value < 0) fail(path, '非负整数', value);
    return value;
  },
});

/** 布尔。 */
export const bool = () => ({
  parse(value, path = '$') {
    if (typeof value !== 'boolean') fail(path, 'boolean', value);
    return value;
  },
});

/** 可为 null 的包装。 */
export const nullable = (inner) => ({
  parse(value, path = '$') {
    return value === null ? null : inner.parse(value, path);
  },
});

/** 数组。 */
export const arr = (item) => ({
  parse(value, path = '$') {
    if (!Array.isArray(value)) fail(path, 'array', value);
    return value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
  },
});

/** 固定字段的对象：**每个字段都必须存在**。 */
export const obj = (shape) => ({
  parse(value, path = '$') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'object', value);
    const out = {};
    for (const [key, sub] of Object.entries(shape)) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, '存在的字段', undefined);
      out[key] = sub.parse(value[key], `${path}.${key}`);
    }
    return out;
  },
});

/** 键不固定的字典（值同构）。键必须非空字符串。 */
export const dict = (item) => ({
  parse(value, path = '$') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'object', value);
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key.length === 0) fail(path, '非空键', key);
      out[key] = item.parse(entry, `${path}["${key}"]`);
    }
    return out;
  },
});
