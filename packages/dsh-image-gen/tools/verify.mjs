/**
 * dsh-image-gen 自检：离线跑一遍真实代码路径。
 *
 * 不联网、不碰会话、不写用户目录：把 `lib/*.js` 复制进临时目录，旁边放三个桩件
 * （cosmokit / schemastery / dsh-tools），再用假 ctx、假 fetch、假 React、
 * 假 localStorage 把它们真正跑起来。
 *
 * 用法（在插件目录下）：
 *
 *     node tools/verify.mjs            # 跑完删除临时目录
 *     node tools/verify.mjs --keep     # 保留临时目录，便于翻现场
 *
 * 两段重点：
 *   1. Host 的「原话转发」约定 —— 用户主动要图时，发上游的必须是用户原话。
 *   2. 生图台的端到端回环 —— 面板里敲的字，拼成的命令行，Host 解出的提示词，
 *      以及成图怎么回到成图墙、怎么再当参考图送回去。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const keep = process.argv.includes("--keep");
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(tmpdir(), "dsh-image-gen-verify");
const workspace = join(root, "work");

/* ── 1. 临时目录：桩件 + 插件源码副本 ──────────────────────────────── */

function writeStub(name, source) {
  const dir = join(root, "node_modules", "@deepseek-ai", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `@deepseek-ai/${name}`, version: "0.0.0", type: "module", main: "index.js" }),
    "utf8",
  );
  writeFileSync(join(dir, "index.js"), source, "utf8");
}

rmSync(root, { recursive: true, force: true });
mkdirSync(join(workspace, "dsh-images"), { recursive: true });

writeStub("cosmokit", "export const isVolatile = () => false;\n");
writeStub(
  "schemastery",
  `const builder = () => {
  const api = {};
  for (const method of ["default", "volatile", "role", "description"]) api[method] = () => api;
  return api;
};
const z = { string: builder, number: builder, boolean: builder, array: builder, object: builder };
export default z;
`,
);
writeStub("dsh-tools", "export const defineTool = (definition) => definition;\n");

for (const [from, to] of [
  [join(pluginRoot, "lib", "index.js"), join(root, "plugin.mjs")],
  [join(pluginRoot, "lib", "client.js"), join(root, "client.mjs")],
]) {
  if (!existsSync(from)) throw new Error(`missing source: ${from}`);
  writeFileSync(to, readFileSync(from, "utf8"), "utf8");
}

/* ── 2. 断言小工具 ─────────────────────────────────────────────────── */

let pass = 0;
const failures = [];
const ok = (condition, label) => {
  if (condition) pass += 1;
  else failures.push(label);
};
const eq = (actual, expected, label) =>
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

/* ── 3. 假 fetch ───────────────────────────────────────────────────── */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const requests = [];

function requestedCount(init) {
  const body = init?.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (Number.isInteger(parsed?.n)) return parsed.n;
    } catch {
      /* multipart 走下面一条 */
    }
  }
  if (Buffer.isBuffer(body)) {
    const match = /name="n"\r\n\r\n(\d+)/.exec(body.toString("latin1"));
    if (match !== null) return Number.parseInt(match[1], 10);
  }
  return 1;
}

const studioRequests = [];
const studioResults = [];
/** 设成一个 Promise 时，生图路由会等它 resolve 再返回（用来模拟“正在生成”）。 */
let holdStudio;
/** 模拟「中转站把 n 当空气」：无论请求几张都只回一张。 */
let upstreamIgnoresN = false;
/** 模拟上游 500。 */
let upstreamFails = false;

/** 把面板请求喂给真实的宿主路由处理器（request/response 用最小替身）。 */
function invokeStudioRoute(payload) {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(payload);
    const request = {
      method: "POST",
      headers: { host: "127.0.0.1:1", origin: "http://127.0.0.1:1", "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(bodyText, "utf8");
      },
    };
    const response = {
      writeHead() {},
      end(text) {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(studioRoute.handler(request, response)).catch(reject);
  });
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  // 生图台直连路由：记录负载，交给真实的宿主处理器跑。
  if (target.includes("image-gen/studio")) {
    const payload = JSON.parse(init.body);
    studioRequests.push(payload);
    if (holdStudio !== undefined) await holdStudio;
    const result = await invokeStudioRoute(payload);
    studioResults.push(result);
    return { ok: true, status: 200, json: async () => result };
  }
  // 成图读图：生图台自己的文件路由。
  if (target.includes("image-gen/file?path=")) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    };
  }
  // 生图台「参考」走宿主文件路由把盘上图片读回字节。
  if (target.includes("/api/file?path=")) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    };
  }
  requests.push({ url: target, init });
  if (upstreamFails) {
    return {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: "upstream boom" } }),
    };
  }
  const count = upstreamIgnoresN ? 1 : requestedCount(init);
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ data: Array.from({ length: count }, () => ({ b64_json: PNG.toString("base64") })) }),
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
  };
};
const goodFetch = globalThis.fetch;
process.env.TEST_IMAGE_KEY = "test-key";

/* ── 4. 假 Host ctx，挂插件 ────────────────────────────────────────── */

const { apply } = await import(pathToFileURL(join(root, "plugin.mjs")).href);

let tool;
let command;
let studioRoute;
let studioFileRoute;
let turnStartSeq = 0;
const listeners = [];
/** dsh-task-notify 暴露的 taskNotify 服务收到的通知。 */
const notifications = [];
const session = { header: { id: "s1", cwd: workspace }, append() {} };
const agent = { session };
const signal = new AbortController().signal;

const ctx = {
  on: (name, handler) => listeners.push({ name, handler }),
  effect: (fn) => {
    const off = fn();
    return typeof off === "function" ? off : () => {};
  },
  get: (name) => {
    if (name === "agents") return { get: (id) => (id === "s1" ? agent : undefined) };
    if (name === "credentials") return { resolve: async () => ({ value: "test-key" }) };
    if (name === "sessionProjections") return { stateOf: () => ({ openTurnStartSeq: turnStartSeq }) };
    if (name === "attachments") return { readImage: async () => ({ data: PNG }) };
    if (name === "taskNotify") return { notify: (spec) => notifications.push(spec) };
    return undefined;
  },
  inject: (_names, cb) =>
    cb({
      effect: (fn) => {
        fn();
        return () => {};
      },
      commands: {
        register: (definition) => {
          command = definition;
          return () => {};
        },
      },
      settings: { configure: () => {} },
      webServer: {
        register: (route) => {
          if (route.path === "/image-gen/studio") studioRoute = route;
          if (route.path === "/image-gen/file") studioFileRoute = route;
          return () => {};
        },
      },
    }),
  tools: {
    register: (definition) => {
      tool = definition;
    },
  },
  fs: {
    resolve: async (path, options) => ({
      displayPath: /^[A-Za-z]:[\\/]/.test(path) ? path : join(options?.cwd ?? workspace, path),
    }),
  },
  fiber: undefined,
};

apply(ctx, {
  baseURL: "https://example.invalid/v1",
  apiKeyEnv: "TEST_IMAGE_KEY",
  models: ["gpt-image-2.5"],
  model: "gpt-image-2.5",
  defaultSize: "1024x1024",
  outputDir: "dsh-images",
  studioDir: join(workspace, "studio"),
  maxImages: 4,
  timeoutMs: 60000,
});

ok(tool !== undefined, "image_generate 工具已注册");
ok(command !== undefined, "/image 命令已注册");
eq(command?.name, "image", "命令名");
eq(command?.input?.attachments, true, "命令声明接受附件");
ok(String(command?.input?.hint).includes("--ref"), "命令提示里写了 --ref");

const emitUser = (text, seq, extraContent = []) => {
  for (const { name, handler } of listeners) {
    if (name !== "session/event") continue;
    handler(session, {
      type: "user/message",
      seq,
      data: {
        role: "user",
        content: [...(text.length === 0 ? [] : [{ type: "text", text }]), ...extraContent],
        source: { kind: "user" },
      },
    });
  }
};

const bodyOf = (index) => JSON.parse(requests[index].init.body);

let turnSeqCounter = 3;
const newTurn = (text = "一只猫在窗台上，水彩风格") => {
  turnSeqCounter += 1;
  turnStartSeq = 0;
  emitUser(text, turnSeqCounter);
};

/* ── 5. 工具的提示词政策 ───────────────────────────────────────────── */

newTurn();
requests.length = 0;
const out1 = await tool.execute(
  { prompt_source: "user", prompt: "an elaborate english prompt" },
  { agent, signal },
);
eq(bodyOf(0).prompt, "一只猫在窗台上，水彩风格", "用户模式下发上游的是用户原话");
eq(out1.source, "user", "结果标记来源");
eq(out1.ignoredPrompt, true, "模型写的 prompt 被丢弃并回显");
ok(existsSync(out1.files[0].path), "图片已落盘");
eq(requests[0].url, "https://example.invalid/v1/images/generations", "文生图端点");

newTurn();
requests.length = 0;
const out3 = await tool.execute(
  { prompt_source: "user-append", prompt: "图一 = 左，图二 = 右" },
  { agent, signal },
);
ok(bodyOf(0).prompt.startsWith("一只猫在窗台上，水彩风格"), "user-append 时原话是前缀");
eq(out3.appended, "图一 = 左，图二 = 右", "追加段单独回显");

newTurn();
let appendTooLong = "";
try {
  await tool.execute({ prompt_source: "user-append", prompt: "长".repeat(400) }, { agent, signal });
} catch (error) {
  appendTooLong = error.message;
}
ok(appendTooLong.includes("limit"), "超长追加段被拒绝");

newTurn();
let selfNoNote = "";
try {
  await tool.execute({ prompt_source: "self", prompt: "a red cube" }, { agent, signal });
} catch (error) {
  selfNoNote = error.message;
}
ok(selfNoNote.includes("initiative_note"), "有用户文字时 self 必须交代理由");

newTurn("再画一只狗");
requests.length = 0;
await tool.execute({ prompt: "any" }, { agent, signal });
let blocked = "";
try {
  await tool.execute({ prompt: "any" }, { agent, signal });
} catch (error) {
  blocked = error.message;
}
ok(blocked.includes("already produced 1"), "同一轮第二次生图要理由");
requests.length = 0;
const unlocked = await tool.execute({ prompt: "any", extra_image_reason: "用户要了第二张" }, { agent, signal });
ok(unlocked.files.length === 1, "给了理由后放行");
const third = await tool.execute({ prompt: "any" }, { agent, signal });
ok(third.files.length === 1, "理由只问一次，之后解锁");

/* 多参考图：一张走 image，多张走 image[] 且保序。 */
const refA = join(workspace, "ref-a.png");
const refB = join(workspace, "ref-b.png");
writeFileSync(refA, PNG);
writeFileSync(refB, PNG);

newTurn("把图二的角色换成图一");
requests.length = 0;
const twoRefs = await tool.execute(
  { prompt_source: "user-append", prompt: "第 1 张 = 图一，第 2 张 = 图二", reference_image: `${refA}\n${refB}` },
  { agent, signal },
);
eq(twoRefs.references, 2, "两张参考图都送上去");
eq(twoRefs.mode, "edit", "有参考图即图生图");
const multi = requests[0].init.body.toString("latin1");
eq((multi.match(/name="image\[\]"/g) || []).length, 2, "多张用两个 image[] 部件");
ok(multi.indexOf("reference1") < multi.indexOf("reference2"), "部件顺序 = 传入顺序");

/* 批量产图：上游不认 n 时必须自己补齐，不能只回一张。 */
newTurn("来三张不同姿势的猫");
requests.length = 0;
upstreamIgnoresN = true;
const batch = await tool.execute({ prompt: "any", n: 3 }, { agent, signal });
upstreamIgnoresN = false;
eq(batch.files.length, 3, "上游忽略 n 时补齐到 3 张");
eq(requests.length, 3, "先打一次批量请求，再补 2 次单张");
ok(
  batch.files.every((file) => existsSync(file.path)),
  "补齐的每一张都真的落盘了",
);

/* ── 6. `/image`：命令行字节即提示词 ───────────────────────────────── */

requests.length = 0;
const cmd1 = await command.handler({
  commandId: "c1",
  agent,
  rawInput: " --n 2 一只戴帽子的猫，水墨",
  attachments: Object.freeze([]),
  signal,
});
eq(cmd1.kind, "success", "/image 成功");
const sentinel1 = JSON.parse(cmd1.text.split("@@image-gen ")[1]);
eq(sentinel1.prompt, "一只戴帽子的猫，水墨", "/image 提示词原样");
eq(bodyOf(0).n, 2, "/image --n 生效");
eq(sentinel1.files.length, 2, "/image 产出 2 个文件");

const cmd2 = await command.handler({
  commandId: "c2",
  agent,
  rawInput: " 一只 --n 2 猫",
  attachments: Object.freeze([]),
  signal,
});
eq(JSON.parse(cmd2.text.split("@@image-gen ")[1]).prompt, "一只 --n 2 猫", "非开头的旗标留在提示词里");

const empty = await command.handler({ commandId: "c3", agent, rawInput: "   ", attachments: Object.freeze([]), signal });
eq(empty.kind, "error", "空提示词报错");
ok(empty.text.startsWith("用法：/image"), "空提示词回用法");

/* `--ref`：宿主自己读路径参考图。 */
requests.length = 0;
const cmdRef = await command.handler({
  commandId: "r1",
  agent,
  rawInput: ` --ref ${refA} 改成水彩`,
  attachments: Object.freeze([]),
  signal,
});
eq(cmdRef.kind, "success", "--ref 成功");
eq(requests[0].url, "https://example.invalid/v1/images/edits", "--ref 走图生图端点");
ok(requests[0].init.body.toString("latin1").includes('name="image"; filename="reference1.png"'), "--ref 被读成参考图");
eq(JSON.parse(cmdRef.text.split("@@image-gen ")[1]).prompt, "改成水彩", "--ref 不进提示词");

const spaced = join(workspace, "ref with space.png");
writeFileSync(spaced, PNG);
requests.length = 0;
const cmdSpaced = await command.handler({
  commandId: "r2",
  agent,
  rawInput: ` --ref "${spaced}" 换成水彩`,
  attachments: Object.freeze([]),
  signal,
});
eq(cmdSpaced.kind, "success", "带空格的 --ref 路径可用");

const tooManyRefs = await command.handler({
  commandId: "r3",
  agent,
  rawInput: ` --ref ${refA} --ref ${refB} --ref ${refA} --ref ${refB} --ref ${refA} 五张`,
  attachments: Object.freeze([]),
  signal,
});
eq(tooManyRefs.kind, "error", "超过 4 个 --ref 报错");
ok(tooManyRefs.text.includes("最多一次传 4 张"), "报错说明上限");

/* 两张附件：结果里必须写明「参考图 2 张」—— 用户只能靠这个核对图一/图二。 */
requests.length = 0;
const cmdTwo = await command.handler({
  commandId: "c6",
  agent,
  rawInput: "把图二的角色换成图一",
  attachments: Object.freeze([
    { type: "image", attachment: { mediaType: "image/png" } },
    { type: "image", attachment: { mediaType: "image/jpeg" } },
  ]),
  signal,
});
eq(cmdTwo.kind, "success", "两张附件的 /image 成功");
const sentinelTwo = JSON.parse(cmdTwo.text.split("@@image-gen ")[1]);
eq(sentinelTwo.references, 2, "哨兵里写明参考图张数");
ok(cmdTwo.text.includes("参考图 2 张"), "人类可读部分也写出参考图张数");
const bodyTwo = requests[0].init.body.toString("latin1");
eq((bodyTwo.match(/name="image\[\]"/g) || []).length, 2, "两张附件 → 两个 image[] 部件");

/* 上游错误收口。 */
globalThis.fetch = async () => ({
  ok: false,
  status: 400,
  text: async () => JSON.stringify({ error: { message: "model_not_found" } }),
});
const failed = await command.handler({ commandId: "c4", agent, rawInput: " 一只猫", attachments: Object.freeze([]), signal });
eq(failed.kind, "error", "上游报错时命令回错误结果");
ok(failed.text.includes("model_not_found"), "错误文案带上游信息");
globalThis.fetch = goodFetch;

/* ── 7. 客户端：假 React / 假 localStorage / 假 document ───────────── */

/** 够用的 React：useState 真会重渲染，useEffect/useMemo/useRef 按依赖缓存。 */
function createHookRuntime() {
  const stores = new Map();
  let currentKey = "root";
  let cursor = 0;
  let positions = new Map();
  let pending = [];
  let pendingSubs = [];
  let dirty = false;
  let handle;

  const store = () => {
    let found = stores.get(currentKey);
    if (found === undefined) {
      found = { slots: [] };
      stores.set(currentKey, found);
    }
    return found;
  };
  const slot = () => {
    const owner = store();
    return { owner, at: cursor++ };
  };
  const depsChanged = (before, after) =>
    before === undefined ||
    after === undefined ||
    before.length !== after.length ||
    before.some((value, index) => !Object.is(value, after[index]));
  const schedule = () => {
    if (dirty) return;
    dirty = true;
    queueMicrotask(() => {
      dirty = false;
      handle?.render();
    });
  };

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const { owner, at } = slot();
      if (!(at in owner.slots)) owner.slots[at] = typeof initial === "function" ? initial() : initial;
      const set = (value) => {
        const before = owner.slots[at];
        const resolved = typeof value === "function" ? value(before) : value;
        if (Object.is(resolved, before)) return;
        owner.slots[at] = resolved;
        schedule();
      };
      return [owner.slots[at], set];
    },
    useRef(initial) {
      const { owner, at } = slot();
      if (!(at in owner.slots)) owner.slots[at] = { current: initial };
      return owner.slots[at];
    },
    useMemo(fn, deps) {
      const { owner, at } = slot();
      const before = owner.slots[at];
      if (before === undefined || depsChanged(before.deps, deps)) owner.slots[at] = { deps, value: fn() };
      return owner.slots[at].value;
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const { owner, at } = slot();
      const before = owner.slots[at];
      if (before !== undefined && !depsChanged(before.deps, deps)) return;
      pending.push({ owner, at, fn, deps });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const { owner, at } = slot();
      let entry = owner.slots[at];
      if (entry === undefined) {
        entry = { unsubscribe: undefined };
        owner.slots[at] = entry;
        pendingSubs.push({ entry, subscribe });
      }
      return getSnapshot();
    },
  };

  const renderNode = (node, occurrences) => {
    if (node === null || node === undefined || typeof node === "boolean") return node;
    if (typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) return node.map((child) => renderNode(child, occurrences));
    if (typeof node.type === "function") {
      const name = node.type.name || "anonymous";
      const index = (occurrences.get(name) ?? 0) + 1;
      occurrences.set(name, index);
      const childKey = `${name}#${index}`;
      positions.set(currentKey, cursor);
      const parentKey = currentKey;
      currentKey = childKey;
      cursor = positions.get(childKey) ?? 0;
      let rendered;
      try {
        rendered = node.type({ ...node.props, children: node.children });
      } finally {
        positions.set(currentKey, cursor);
        currentKey = parentKey;
        cursor = positions.get(parentKey) ?? 0;
      }
      return { ...node, rendered: renderNode(rendered, occurrences) };
    }
    return { ...node, children: node.children.map((child) => renderNode(child, occurrences)) };
  };

  const pass = (type, props) => {
    positions = new Map();
    pending = [];
    currentKey = "root";
    cursor = 0;
    const tree = renderNode({ type, props: props ?? {}, children: [] }, new Map());
    for (const entry of pending) {
      const before = entry.owner.slots[entry.at];
      if (typeof before?.cleanup === "function") before.cleanup();
      const cleanup = entry.fn();
      entry.owner.slots[entry.at] = {
        deps: entry.deps,
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
      };
    }
    for (const item of pendingSubs) {
      if (typeof item.entry.unsubscribe === "function") continue;
      const off = item.subscribe(() => schedule());
      item.entry.unsubscribe = typeof off === "function" ? off : () => {};
    }
    pendingSubs = [];
    return tree;
  };

  const mount = (type, props) => {
    stores.clear();
    handle = {
      tree: undefined,
      render: () => {
        handle.tree = pass(type, props);
      },
    };
    handle.render();
    return handle;
  };

  const flush = async (ticks = 16) => {
    for (let index = 0; index < ticks; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const findAll = (node, predicate, found = []) => {
    if (node === null || node === undefined || typeof node === "boolean") return found;
    if (typeof node === "string" || typeof node === "number") return found;
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, predicate, found);
      return found;
    }
    if (predicate(node)) found.push(node);
    if (Array.isArray(node.children)) findAll(node.children, predicate, found);
    if (node.rendered !== undefined) findAll(node.rendered, predicate, found);
    return found;
  };

  const textsOf = (node, out = []) => {
    if (node === null || node === undefined || typeof node === "boolean") return out;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      for (const child of node) textsOf(child, out);
      return out;
    }
    textsOf(node.children, out);
    if (node.rendered !== undefined) textsOf(node.rendered, out);
    return out;
  };

  return { React, mount, flush, findAll, textsOf };
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
/** 极简 FileReader：把 `file.data`（Buffer）读成 data URL，够 `readImageFile` 用。 */
globalThis.FileReader = class {
  readAsDataURL(file) {
    this.result = `data:${file.type};base64,${file.data.toString("base64")}`;
    queueMicrotask(() => this.onload?.());
  }
};
globalThis.document = {
  baseURI: "http://127.0.0.1:1/",
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
  head: { appendChild() {} },
};
/**
 * 极简 Image：路径里带 `missing-history` 就当作加载失败，
 * 其余一律成功 —— 用来验证「历史记录只在原路径还有效时打开原图」。
 */
globalThis.Image = class {
  set src(value) {
    const target = String(value ?? "");
    queueMicrotask(() => {
      if (target.includes("missing-history")) this.onerror?.();
      else this.onload?.();
    });
  }
};

let captured;
globalThis.window = { __ModuleLoader__: { load: (spec) => (captured = spec) } };
await import(pathToFileURL(join(root, "client.mjs")).href);

const runtime = createHookRuntime();
const clientModule = captured.factory((name) => {
  if (name === "react") return runtime.React;
  throw new Error(`unexpected require(${name})`);
});

const registrations = [];
const openedKinds = [];
const openedPanels = [];
const activated = [];
let studioTabType;
let card;
let settingsSection;

const clientCtx = {
  effect: (fn) => {
    const off = fn();
    return typeof off === "function" ? off : () => {};
  },
  get: (name) => {
    if (name === "sidebarRight") {
      return { openTab: (kind) => openedKinds.push(kind), openResource: (address) => openedKinds.push(address) };
    }
    if (name === "layout") {
      return {
        openRightbar: () => {},
        selectPanel: (id) => openedPanels.push(id),
      };
    }
    // 会话视图的激活面：binding(sessionId).activate(viewId)
    if (name === "uiConversation") {
      return {
        binding: (sessionId) => ({
          activate: (viewId) => activated.push(`${sessionId}:${viewId}`),
        }),
      };
    }
    // 会话清单：store 形态（getSnapshot / subscribe），渲染层会把它包成 useSessions。
    if (name === "sessions") {
      return {
        list: {
          getSnapshot: () => ({
            byId: {
              s1: { id: "s1", title: "演示会话", retainedBy: { mainView: 1 } },
            },
          }),
          subscribe: () => () => {},
        },
      };
    }
    if (name === "uiWorkspace") return { startSession: () => {} };
    return undefined;
  },
  locale: { register: () => {}, bind: () => (key) => key, getSnapshot: () => ({ active: "zh" }) },
  slots: {
    inject: (_name, cb) => cb(),
    register: (definition, component) => {
      registrations.push({ definition, component });
      if (definition.name === "conversation.chat.commandview") card = { definition, component };
      if (definition.name === "settings.section") settingsSection = { definition, component };
      return () => {};
    },
  },
  configForms: {
    whileServed: (_ns, cb) => cb(),
    get: () => ({
      getSnapshot: () => ({
        status: "ready",
        value: {
          models: ["gpt-image-2.5", "gpt-image-2.5-flare"],
          model: "gpt-image-2.5",
          defaultSize: "1024x1024",
          maxImages: 3,
        },
      }),
      subscribe: () => () => {},
      mutate: async () => true,
    }),
  },
  sidebarRightTabs: {
    register: (definition) => {
      studioTabType = definition;
      return () => {};
    },
  },
};
clientCtx.inject = (_names, cb) => cb(clientCtx);
clientModule.apply(clientCtx);

const pageReg = registrations.find(
  (entry) => entry.definition.name === "main" && entry.definition.key === "image-studio-page",
);
ok(pageReg !== undefined, "生图台注册为 main 面板（全局一个工作台）");
const railReg = registrations.find(
  (entry) => entry.definition.name === "sidebar.panellist" && entry.definition.id === "image-studio-page",
);
ok(railReg !== undefined, "左栏有「生图」入口");
eq(railReg?.definition.order, 12, "左栏入口排序");
ok(
  registrations.every((entry) => entry.definition.name !== "conversation.view"),
  "不再按会话注册视图（会话之间共用同一个工作台）",
);
eq(studioTabType, undefined, "不需要右栏 tab 兜底");
const composerReg = registrations.find((entry) => entry.definition.name === "conversation.input.left");
ok(composerReg !== undefined, "输入框旁有生图台按钮");
const composerButton = composerReg.component({ sessionId: "s1", t: (key) => key });
runtime.findAll(composerButton, (node) => node.type === "button")[0]?.props?.onClick?.({ preventDefault() {} });
eq(openedPanels[0], "image-studio-page", "点按钮 = 切到生图面板");
ok(card !== undefined, "/image 结果卡片已注册");
ok(settingsSection !== undefined, "设置分区仍能注册");

/* ── 8. 生图台：输入 → 生成 → 成图墙 → 参考 → 再生成 ───────────────── */

clientModule.__test.studioStore.reset();
const injectFace = pageReg.definition.inject();
const pageProps = { t: (key) => key, ...injectFace };
const view = runtime.mount(pageReg.component, pageProps);

const textarea = runtime.findAll(view.tree, (node) => node.type === "textarea")[0];
ok(textarea !== undefined, "生图台有提示词输入框");
textarea.props.onChange({ target: { value: "一只戴帽子的猫，水墨" } });
await runtime.flush(2);

const generate = () =>
  runtime.findAll(
    view.tree,
    (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.generate"),
  )[0];
ok(generate() !== undefined, "生图台有生成按钮");

generate().props.onClick();
await runtime.flush(24);

eq(studioRequests.length, 1, "点生成打了一次生图路由");
eq(studioRequests[0]?.prompt, "一只戴帽子的猫，水墨", "提示词原样进了请求体");
eq(typeof studioRequests[0]?.sessionId, "undefined", "请求里不再带会话（全局工作台）");
eq(studioRequests[0]?.references?.length, 0, "第一次没有参考图");
const first = studioResults[0];
eq(first.prompt, "一只戴帽子的猫，水墨", "宿主解析出的提示词逐字节一致");
eq(first.mode, "generate", "无参考图 = 文生图");

const tiles = runtime.findAll(view.tree, (node) => node.type === "article" && node.props?.title === "一只戴帽子的猫，水墨");
eq(tiles.length, 1, "成图墙上出现一张瓦片");
ok(runtime.textsOf(view.tree).includes("studio.results · 1"), "成图计数更新");

const stored = clientModule.__test.studioStore.getSnapshot();
eq(stored.items.length, 1, "成图进了共享 store");
eq(stored.draft.prompt, "一只戴帽子的猫，水墨", "提示词也被记住");

const refButton = runtime.findAll(
  view.tree,
  (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.useAsRef"),
)[0];
ok(refButton !== undefined, "瓦片上有「参考」按钮");
refButton.props.onClick({ stopPropagation() {} });
await runtime.flush(24);

const generateButtons = runtime.findAll(
  view.tree,
  (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.generate"),
);
generateButtons[0].props.onClick();
await runtime.flush(24);
eq(studioRequests.length, 2, "第二次生成");
eq(studioRequests[1]?.references?.length, 1, "「参考」把成图变成一张参考图");
eq(studioRequests[1]?.references?.[0]?.mediaType, "image/png", "参考图按 PNG 发送");
const second = studioResults[1];
eq(second.mode, "edit", "有参考图 = 图生图");

/* 灯箱：点成图就地放大、翻页、关闭；在灯箱里也能「参考」。 */
const tile = runtime.findAll(view.tree, (node) => node.type === "article")[0];
ok(tile !== undefined, "有成图瓦片");
tile.props.onClick();
await runtime.flush(4);
ok(
  runtime.findAll(view.tree, (node) => node.props?.className === "ig2-lightbox").length === 1,
  "点成图打开灯箱（就地翻看）",
);
ok(runtime.textsOf(view.tree).includes("1 / 2"), "灯箱显示当前/总数（此时已出 2 张）");
const lbClose = runtime.findAll(
  view.tree,
  (node) => node.type === "button" && node.props?.["aria-label"] === "studio.close",
)[0];
ok(lbClose !== undefined, "灯箱有关闭按钮");
lbClose.props.onClick();
await runtime.flush(2);
ok(
  runtime.findAll(view.tree, (node) => node.props?.className === "ig2-lightbox").length === 0,
  "关闭后灯箱消失",
);

/* 清空要确认两次（防误触）。 */
const clearButton = () =>
  runtime.findAll(
    view.tree,
    (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.clear"),
  )[0];
clearButton()?.props.onClick();
await runtime.flush(2);
ok(runtime.textsOf(view.tree).includes("studio.clearConfirm"), "第一次点清空只是确认");
clearButton()?.props.onClick();
await runtime.flush(2);
eq(clientModule.__test.studioStore.getSnapshot().items.length, 0, "第二次点清空才真清");

/* 离开生图页再回来：任务照跑、计时照走、成品照样进成图墙。 */
let releaseStudio;
holdStudio = new Promise((resolve) => {
  releaseStudio = resolve;
});
const beforeLeave = studioRequests.length;
runtime
  .findAll(view.tree, (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.generate"))[0]
  .props.onClick();
await runtime.flush(2);
eq(studioRequests.length, beforeLeave + 1, "任务已发出（请求挂起中）");
eq(clientModule.__test.studioStore.getSnapshot().job?.status, "running", "任务在共享 store 里是 running");

// 「离开 → 回来」：全新的组件实例，只认 store。
const viewBack = runtime.mount(pageReg.component, pageProps);
const backTexts = runtime.textsOf(viewBack.tree);
ok(
  backTexts.some((text) => String(text).includes("studio.generating")),
  "回来时按钮仍显示「生成中」（计时/任务没有随页面停掉）",
);

releaseStudio();
holdStudio = undefined;
await runtime.flush(30);
eq(clientModule.__test.studioStore.getSnapshot().job?.status, "done", "任务在后台照常完成");
eq(
  runtime.findAll(viewBack.tree, (node) => node.type === "article").length >= 1,
  true,
  "完成后成图出现在回来后的页面里",
);

/* 一次性选两张参考图：两张都要进托盘，也都要作为附件发出去。 */
clientModule.__test.studioStore.setRefs([]);
const view2 = runtime.mount(pageReg.component, pageProps);
const fileInput = runtime.findAll(
  view2.tree,
  (node) => node.type === "input" && node.props?.type === "file",
)[0];
ok(fileInput !== undefined, "有文件选择输入");
const fileA = { type: "image/png", name: "a.png", data: PNG };
const fileB = { type: "image/jpeg", name: "b.jpg", data: PNG };
fileInput.props.onChange({ target: { files: [fileA, fileB], value: "" } });
await runtime.flush(8);
const trayImages = runtime.findAll(
  view2.tree,
  (node) => node.type === "img" && String(node.props?.src ?? "").startsWith("data:image/"),
);
eq(trayImages.length, 2, "一次选两张图 → 参考托盘里有两张");

/* 图一/图二可以调序：调完顺序，附件顺序要跟着变。 */
const firstRefTile = runtime.findAll(
  view2.tree,
  (node) => node.type === "div" && node.props?.className === "ig2-ref",
)[0];
const moveRight = runtime.findAll(
  firstRefTile ?? { type: "div", props: {}, children: [] },
  (node) => node.type === "button" && node.props?.["aria-label"] === "studio.moveRight",
)[0];
ok(moveRight !== undefined, "参考图有「往后移」按钮");
moveRight?.props.onClick();
await runtime.flush(2);

const prompt2 = runtime.findAll(view2.tree, (node) => node.type === "textarea")[0];
prompt2.props.onChange({ target: { value: "把两张图合成一张" } });
await runtime.flush(2);
const generate2 = runtime.findAll(
  view2.tree,
  (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.generate"),
)[0];
generate2.props.onClick();
await runtime.flush(24);
eq(studioRequests.at(-1)?.references?.length, 2, "两张参考图都进了请求体");
eq(
  studioRequests.at(-1)?.references?.[0]?.name,
  "b.jpg",
  "调序后参考图顺序跟着变（第一张变成 b.jpg）",
);
eq(studioRequests.at(-1)?.references?.[1]?.mediaType, "image/png", "另一张的类型保留");

/* 刷新（重挂载）后成图墙从 localStorage 恢复。 */
const view3 = runtime.mount(pageReg.component, pageProps);
ok(
  runtime.findAll(view3.tree, (node) => node.type === "article").length >= 1,
  "重挂载后成图墙仍在",
);
ok(
  storage.has("dsh-image-gen.studio.v2"),
  "成图存在全局键里（不按会话拆）",
);
ok(
  [...storage.keys()].every((key) => !key.startsWith("dsh-image-gen.gallery.")),
  "不再有按会话的旧键",
);
eq(
  runtime.findAll(
    view3.tree,
    (node) => node.type === "img" && String(node.props?.src ?? "").startsWith("data:image/"),
  ).length,
  2,
  "重挂载后参考图还在托盘里（内存缓存，不用重选）",
);

/* 命令行拼装的独立约定。 */
const test = clientModule.__test;
eq(
  test.buildImageCommandLine({ prompt: "--n 2 一只猫", model: "m", size: "auto" }),
  "/image --model m --size auto -- --n 2 一只猫",
  "提示词以 -- 开头也原样保留",
);
eq(
  test.buildImageCommandLine({ prompt: "x", refs: ["C:\\a b\\c.png"] }),
  '/image --ref "C:\\a b\\c.png" -- x',
  "带空格的参考图路径会被引号括住",
);
eq(
  test.parseSentinelText(`${cmd1.text}`).data?.files?.length,
  2,
  "哨兵解析与 Host 输出对齐",
);

/* ── 9. 命令卡片 ───────────────────────────────────────────────────── */

const tree = card.component({
  node: { kind: "command", name: "image", args: " --n 2 一只戴帽子的猫，水墨", outcome: { kind: "success", text: cmd1.text } },
  sessionId: "s1",
  t: (key) => key,
});
const texts = runtime.textsOf(tree);
ok(texts.includes("一只戴帽子的猫，水墨"), "卡片显示原样提示词");
ok(texts.some((text) => String(text).includes("gpt-image-2.5")), "卡片显示模型");

const runningTree = card.component({
  node: { kind: "command", name: "image", args: " 猫", outcome: null },
  sessionId: "s1",
  t: (key) => key,
});
ok(JSON.stringify(runningTree).includes("card.running"), "运行中显示等待文案");

/* ── 10. 批量产图 / 历史记录 / 消息提醒 ─────────────────────────────── */

/* Host：生图台成功 / 失败都要触发 taskNotify。 */
notifications.length = 0;
const notified = await invokeStudioRoute({
  prompt: "通知测试",
  model: "gpt-image-2.5",
  size: "1024x1024",
  n: 1,
});
eq(notified.ok, true, "生图台直连路由成功");
ok(
  notifications.length === 1 &&
    notifications[0].status === "done" &&
    String(notifications[0].title).includes("生图"),
  "生图完成会激活消息提醒",
);

notifications.length = 0;
upstreamFails = true;
const failedResult = await invokeStudioRoute({ prompt: "必败", n: 1 });
upstreamFails = false;
eq(failedResult.ok, false, "上游失败回 ok:false");
ok(
  notifications.length === 1 && notifications[0].status === "failed",
  "生图失败也会提醒（failed 语气）",
);

/* Host：没有原始路径的参考图（上传/粘贴）要落一份稳定副本，并随结果回传路径。 */
const withRef = await invokeStudioRoute({
  prompt: "参考图落盘测试",
  n: 1,
  references: [{ data: PNG.toString("base64"), mediaType: "image/png" }],
});
eq(withRef.ok, true, "带参考图的生图台请求成功");
eq(
  Array.isArray(withRef.referenceImages) ? withRef.referenceImages.length : -1,
  1,
  "响应带回参考图路径",
);
ok(
  typeof withRef.referenceImages?.[0]?.path === "string" &&
    withRef.referenceImages[0].path.includes(join("studio", "refs")),
  "无路径参考图落到 <studioDir>/refs",
);
ok(existsSync(withRef.referenceImages[0].path), "参考图副本已真实落盘");

/* Client：批量出 3 张 → 成图墙 3 格；历史一条；点历史把**参考图**拉回托盘。 */
clientModule.__test.studioStore.reset();
const batchView = runtime.mount(pageReg.component, pageProps);
const refPath = join(workspace, "studio", "ref-one.png");
writeFileSync(refPath, PNG);
clientModule.__test.studioStore.setRefs([
  {
    key: "r1",
    path: refPath,
    data: PNG.toString("base64"),
    mediaType: "image/png",
    name: "ref-one.png",
  },
]);
runtime.findAll(batchView.tree, (node) => node.type === "textarea")[0].props.onChange({
  target: { value: "三张不同姿势的猫" },
});
await runtime.flush(2);
const plus = () =>
  runtime.findAll(
    batchView.tree,
    (node) => node.type === "button" && node.props?.["aria-label"] === "+1",
  )[0];
plus().props.onClick();
await runtime.flush(2);
plus().props.onClick();
await runtime.flush(2);
eq(clientModule.__test.studioStore.getSnapshot().draft.count, 3, "张数步进到 3");
runtime
  .findAll(
    batchView.tree,
    (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.generate"),
  )[0]
  .props.onClick();
await runtime.flush(40);
eq(
  runtime.findAll(batchView.tree, (node) => node.type === "article").length,
  3,
  "批量出 3 张 → 成图墙 3 格（不再只显示第一张）",
);
const batchSnap = clientModule.__test.studioStore.getSnapshot();
eq(batchSnap.history.length, 1, "一次批量 = 一条历史记录");
eq(batchSnap.history[0].files.length, 3, "历史记录保留 3 张生成结果路径");
eq(batchSnap.history[0].referenceImages.length, 1, "历史记录保留当时用的参考图");
eq(batchSnap.history[0].referenceImages[0].path, refPath, "参考图路径就是原图路径");

// 点历史：提示词 + 参考图一起拉回来（先把托盘清空，证明是历史装回来的）。
clientModule.__test.studioStore.setRefs([]);
runtime.findAll(batchView.tree, (node) => node.type === "textarea")[0].props.onChange({
  target: { value: "临时占位" },
});
await runtime.flush(2);
const histRow = () =>
  runtime.findAll(
    batchView.tree,
    (node) => node.type === "button" && node.props?.className === "ig2-histRow",
  )[0];
ok(histRow() !== undefined, "历史记录有可点击的行");
histRow().props.onClick();
await runtime.flush(30);
eq(clientModule.__test.studioStore.getSnapshot().draft.prompt, "三张不同姿势的猫", "点历史回填提示词");
eq(
  clientModule.__test.studioStore.getSnapshot().refs.length,
  1,
  "点历史把参考图重新装回托盘",
);
eq(
  clientModule.__test.studioStore.getSnapshot().refs[0]?.path,
  refPath,
  "拉回的参考图路径正确",
);
ok(
  runtime.textsOf(batchView.tree).includes("studio.historyRefsRestored"),
  "提示已拉回参考图",
);
eq(
  runtime.findAll(batchView.tree, (node) => node.props?.className === "ig2-lightbox").length,
  0,
  "点历史不再把生成结果当主图打开",
);

// 参考图路径失效：只回填提示词，不把坏图塞回托盘。
batchSnap.history[0].referenceImages[0].path = "D:/missing-history/ref.png";
clientModule.__test.studioStore.setRefs([]);
histRow().props.onClick();
await runtime.flush(30);
ok(
  runtime.textsOf(batchView.tree).includes("studio.historyRefsGone"),
  "参考图路径失效：说明只回填了提示词",
);
eq(
  clientModule.__test.studioStore.getSnapshot().refs.length,
  0,
  "失效的参考图不会被塞回托盘",
);

/* 文生图历史：没有参考图，只回填提示词。 */
clientModule.__test.studioStore.reset();
const plainView = runtime.mount(pageReg.component, pageProps);
runtime.findAll(plainView.tree, (node) => node.type === "textarea")[0].props.onChange({
  target: { value: "纯文生图" },
});
await runtime.flush(2);
runtime
  .findAll(
    plainView.tree,
    (node) => node.type === "button" && JSON.stringify(node.children ?? []).includes("studio.generate"),
  )[0]
  .props.onClick();
await runtime.flush(30);
const plainSnap = clientModule.__test.studioStore.getSnapshot();
eq(plainSnap.history[0].referenceImages.length, 0, "文生图历史没有参考图");
runtime
  .findAll(
    plainView.tree,
    (node) => node.type === "button" && node.props?.className === "ig2-histRow",
  )[0]
  .props.onClick();
await runtime.flush(16);
ok(
  runtime.textsOf(plainView.tree).includes("studio.historyNoRefs"),
  "文生图历史：提示没有参考图",
);

/* ── 11. 收尾 ──────────────────────────────────────────────────────── */

if (!keep) rmSync(root, { recursive: true, force: true });
else console.log(`临时目录保留在 ${root}`);

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
for (const failure of failures) console.log("  ✗ " + failure);
// 假组件会留下计时器（busy 状态的 500ms tick），显式退出，别让脚本吊住。
process.exit(failures.length > 0 ? 1 : 0);
