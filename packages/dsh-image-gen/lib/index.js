/**
 * dsh-image-gen — Host 侧入口。
 *
 * 这个包给 DSH 加两样东西：
 *
 *   1. `image_generate` 工具 —— 对话模型用它生图 / 改图。
 *   2. `/image` 斜杠命令 —— **用户自己发起**，提示词连对话模型都不经过。
 *
 * 两条路都支持两种模式：文生图 POST {baseURL}/images/generations（JSON）、
 * 图生图 POST {baseURL}/images/edits（multipart，带参考图文件）。
 *
 * ── 提示词到底发的是什么（本插件的核心约定）────────────────────────────────
 *
 * 用户主动发起生图时，**用户的原话就是提示词**，宿主直接把它发给生图模型 ——
 * 不翻译、不改写、不替他补风格词和镜头术语。原话取自会话的 `user/message`
 * 事件（`source.kind === "user"`），由本插件订阅 `session/event` 记住，所以这条
 * 保证是**宿主级的**：不依赖对话模型是否老实照做。
 *
 * 但「原话就是提示词」有一个真实的缺口，历史上两次栽的都是它：用户的话里常常
 * 带**生图模型自己解不开的指代** —— 最典型的是「把图二的角色换成图一（ZL）」，
 * 而 `/images/edits` 一次只收**一张**参考图。这种情况下只发原话必然出废图，而
 * 允许模型整段改写又等于把用户的话换掉。所以给模型留一条**只能追加、不能替换**
 * 的路：`prompt_source: "user-append"`。最终发出去的是
 *
 *     用户原话 + 空行 + 模型追加的约束
 *
 * 用户原话永远是前缀、永远在，模型没有任何办法删掉或替换它。
 *
 * 三态一览（`prompt_source`）：
 *
 *   - `"user"`（默认）—— 用户开口要的图。发用户原话，模型的 `prompt` 直接丢弃
 *     （丢弃会在结果里回显出来，提示模型该改用 `user-append`）。
 *   - `"user-append"` —— 用户开口要的图，但原话需要补充说明。发原话 + 追加。
 *   - `"self"` —— **AI 发起**：本轮用户说的是别的事（写网页、做主题），图是模型
 *     自己决定加的配图。这条路会把用户原话整段丢掉，所以本轮**有**用户文字时，
 *     额外要求模型写 `initiative_note`（一句话说清「用户这条消息实际要的是什么」）。
 *     被要求给出理由的那一刻，正是模型该发现「用户其实要的就是图」的时刻。
 *
 * 工具结果的 `prompt` 字段回显**实际发给上游的那段文字**，`source` 标记它出自
 * 上面哪一种，`appended` 单独拎出模型追加的那段。用户随时能核对。
 *
 * `/image` 命令则是更强的一路：命令行走 `dsh-commands` 的执行器，`rawInput`
 * 就是用户敲进去的字节，根本没有任何模型参与，天然原封不动。
 *
 * ── 其它约定 ────────────────────────────────────────────────────────────
 *
 * 参考图可以是三种来源：会话里刚附的图片（内容寻址、无扩展名，按魔数认类型）、
 * 任意本地图片路径、或 `"latest"`（取会话里最近附的那张）。
 * 模型在消息里看到的附件路径由 dsh-llm 的 normalizedAccessText 生成。
 *
 * **一次可以传多张**（`reference_image` 里一行一个路径，顺序即用户说的「图一/图二」）。
 * 2026-10-10 实测：两张图分别放进重复的 `image[]` 部件，上游 HTTP 200 且输出图两侧
 * 各对应一张，说明多图被完整接收、顺序保留。所以「用户附了两张图」**不需要**先拼成
 * 一张拼接图（那段历史做法现在只是上游万一不认 `image[]` 时的退路）。
 * 单张仍走 `image` 字段——那是长期验证过的形状，不赌上游把 `image[]` 当 `image` 读。
 *
 * 用哪个生图模型由 `model` 参数决定，缺省取配置里的 `model`。
 * 可用模型清单在配置的 `models` 里 —— 打开「设置 → 生图」就能增删，
 * 不用改代码，也不用改 YAML。**不要**去 llm-pi-ai 建路由，那是给对话模型用的。
 *
 * 生成结果下载下来写进会话工作目录，再把路径交还给模型 —— 模型随后可以
 * 调用内置的 `present` 把图片作为交付物展示给用户。
 *
 * 密钥不落在配置里：config 只写 `apiKeyEnv`（引用名），值从 harness 凭据
 * 存储按请求解析（见 @deepseek-ai/dsh-credentials）。
 */

import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { isVolatile } from "@deepseek-ai/cosmokit";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "image-gen";

/** `fs` 用来解析输出/参考图路径；`credentials` 用来按名解析密钥。 */
export const inject = ["tools", "fs", "credentials"];

/** 中转站前面挂着 Cloudflare，默认的 urllib/undici UA 会被拦掉，必须伪装。 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 中转站接受的尺寸；`auto` 由上游自己决定。 */
const SIZES = ["auto", "1024x1024", "1024x1536", "1536x1024"];

/**
 * `user-append` 追加段的下限额度（字数）。实际额度取 `max(这个值, 原话字数 × 2)`。
 *
 * 追加段只该回答「生图模型自己看不出来的事」：参考图哪边是哪张、这次往哪个方向改。
 * 角色长什么样、画风是什么，拼接图里已经看得见。历史故障正是模型把追加段写成了
 * 一份完整的新规格 —— 方向、发色、兽耳、配色全在里面定了，用户原话只剩开头一成
 * （实测原话 75 字 / 追加 357～491 字）。所以给它一个随原话长度伸缩的天花板。
 */
const APPENDIX_MIN_CHARS = 300;

/**
 * 这个网关当前能用的生图模型（用生图 key 查 `/v1/models` 得到）。
 *
 * 这只是 `Config.models` 的**默认值** —— 真正的清单以配置为准，可以在
 * 「设置 → 生图」里增删，改完立刻生效，不用动代码也不用重启。
 * 工具描述里的可选模型列表就是照着配置里的清单生成的。
 *
 * 生图模型**不要**挂进 llm-pi-ai 的 providers（那会把生图模型当对话模型，
 * 走 `/chat/completions`，必然报错或得到「当前模型不支持图片」）。
 */
const DEFAULT_MODELS = [
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "grok-imagine-image-2.0",
];

/** 参考图扩展名 → MIME。上游按 MIME 解码，写错会 502。 */
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** `/image` 命令名（裸名，不带斜杠）。 */
const IMAGE_COMMAND = "image";

/**
 * 生图台的直连路由（同源 HTTP）。
 *
 * 面板**不能**走 `/image` 命令：命令会把 `command/run` / `command/done` 写进会话，
 * 对话里就多出一张卡 —— 用户要的恰恰相反：「生图的东西只在生图栏里」。
 * 这条路由直接复用 `generateImage`，提示词照样原样发上游，但结果只回给面板。
 */
const STUDIO_ROUTE = "/image-gen/studio";

/** 成图读图路由（只允许生图目录内的文件）。 */
const STUDIO_FILE_ROUTE = "/image-gen/file";

/** 面板请求体上限（四张 4MB 参考图 base64 之后再留余量）。 */
const STUDIO_BODY_LIMIT = 48 * 1024 * 1024;

/** 上游接受的参考图 MIME。 */
const REFERENCE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);


/** `/image` 的用法提示。 */
const IMAGE_USAGE =
  "用法：/image [--n 2] [--model <id>] [--size 1024x1536] [--name <文件名>] " +
  "[--ref <参考图路径>]... <提示词>（可附参考图做图生图；`--ref latest` 取会话里最近附的图）";

/**
 * `/image` 结果文本里给**客户端卡片**解析的哨兵行前缀。
 *
 * 命令行结果只有一段纯文本能带到界面上（`command/done` 的 `text`），没有结构化
 * 载荷通道；卡片要画「提示词 + 文件列表 + 缩略图」就得知道这些字段，所以在
 * 人类可读文本后面追加一行 JSON。卡片读不出来时会退化成普通卡（那行就显式露着，
 * 不影响功能）。
 */
const RESULT_SENTINEL = "@@image-gen";

/**
 * 按魔数嗅探图片类型。
 *
 * 必需：会话附件的落盘路径是**内容寻址**的 ——
 * `$DSH_HOME/attachments/v1/objects/<sha256前2位>/<sha256>`，**没有扩展名**。
 * 只看扩展名会把用户刚附的图判成「不支持的类型」。
 */
function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: ".png", mime: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" &&
      bytes.toString("latin1", 8, 12) === "WEBP") {
    return { ext: ".webp", mime: "image/webp" };
  }
  if (bytes.length >= 6 && bytes.toString("latin1", 0, 3) === "GIF") {
    return { ext: ".gif", mime: "image/gif" };
  }
  return undefined;
}

/** 只读文件头，用来嗅探类型而不必把整个大文件读进内存。 */
async function readHead(path, length = 32) {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 配置 schema。
 *
 * 带 `.volatile()` 的字段会出现在「设置 → 生图」专区里，可以随时改，
 * 改完直接落到当前 profile 的 `cordis.patch.yml`（不需要手改 YAML）。
 * 不带 volatile 的（`timeoutMs`）属于「普通配置」，只能在配置文件里改 ——
 * 这是 DSH 设置表单的约定：**只有 volatile 字段会被投影成表单**。
 *
 * 增删生图模型就改 `models` 这一项，不用动代码。
 */
export const Config = z.object({
  baseURL: z.string().default("https://api.yitaizhongji.com/v1").volatile(),
  apiKeyEnv: z.string().role("credential-ref").default("YITAIZHONGJI_IMAGE_API_KEY").volatile(),
  /** 可用生图模型清单 —— 设置页里可增可删，工具描述会照着它写。 */
  models: z.array(z.string()).default(DEFAULT_MODELS).volatile(),
  /** 不指定 `model` 参数时用哪个。 */
  model: z.string().default("gpt-image-2.5").volatile(),
  defaultSize: z.string().default("1024x1024").volatile(),
  /** 相对路径按会话工作目录解析；绝对路径原样使用。 */
  outputDir: z.string().default("dsh-images").volatile(),
  /** 生图台的输出目录（全局一个工作台，不跟着会话走）；留空即 $DSH_HOME/image-studio。 */
  studioDir: z.string().default("").volatile(),
  maxImages: z.number().default(4).volatile(),
  /** 单次请求上限（毫秒）。生图很慢，别调太小。 */
  timeoutMs: z.number().default(600000),
});

/** 把上游的报错信封压成一行可读文本。 */
function describeHttpError(status, text) {
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message ?? parsed?.message ?? text;
  } catch {
    /* 上游不总是回 JSON（Cloudflare 502 会回 HTML），原样用。 */
  }
  return `image request failed (HTTP ${status}): ${String(detail).slice(0, 500)}`;
}

/** `20261004-0723-15` —— 文件名里带时间戳，同一目录多次生成不会互相覆盖。 */
function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * 解析参考图路径到宿主可读路径。
 *
 * 模型在消息里看到的附件路径是**只读进程路径**（`dsh-llm` 的
 * `normalizedAccessText` 写进消息的就是它），所以先交给 `fs` seam 做映射；
 * 映射不到（附件对象不在工作区映射范围内时）就按宿主绝对路径直接用。
 */
async function toHostPath(ctx, context, path) {
  const cwd = context.agent?.session?.header?.cwd;
  try {
    const target = await ctx.fs.resolve(path, {
      ...(cwd === undefined ? {} : { cwd }),
      signal: context.signal,
    });
    if (typeof target?.displayPath === "string" && target.displayPath.length > 0) {
      return target.displayPath;
    }
  } catch (error) {
    if (!isAbsolute(path)) throw error;
  }
  return path;
}

/** 会话附件对象的根：`$DSH_HOME/attachments/v1/objects`。 */
async function attachmentsObjectRoot() {
  let home = process.env.DSH_HOME;
  if (home === undefined || home.length === 0) {
    try {
      const mod = await import("@deepseek-ai/dsh-home-paths");
      home = mod.resolveDshHome();
    } catch {
      return undefined;
    }
  }
  return home === undefined || home.length === 0
    ? undefined
    : join(home, "attachments", "v1", "objects");
}

/**
 * 兜底：找会话里最近上传的图片附件。
 *
 * 正常路径是模型直接把消息里的附件路径交给 `reference_image`。但当模型
 * 没能把路径带进工具调用时（它可能只描述「用户附的那张图」），这个兜底
 * 能让图生图照样跑起来。
 *
 * 附件是内容寻址存储且**永不删除**，所以目录只增不减：只能按 mtime 取最新，
 * 再用魔数确认它真的是图片（同目录也存通用文件）。
 */
async function latestAttachmentPath() {
  const root = await attachmentsObjectRoot();
  if (root === undefined) {
    throw new Error(
      "image_generate: cannot locate the attachment store (DSH_HOME is unset and " +
        "@deepseek-ai/dsh-home-paths is unavailable). Pass an explicit `reference_image` path.",
    );
  }

  const candidates = [];
  for (const shard of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!shard.isDirectory()) continue;
    const dir = join(root, shard.name);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined) candidates.push({ path, mtimeMs: info.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const head = await readHead(candidate.path);
    if (head !== undefined && sniffImageType(head) !== undefined) return candidate.path;
  }

  throw new Error(
    "image_generate: no image attachment was found in the session attachment store. " +
      "Ask the user to attach the image again, or pass an explicit `reference_image` path.",
  );
}

/** 解析出参考图的字节、真实类型与上传用的文件名后缀。 */
async function loadReferenceImage(ctx, context, reference) {
  const path = reference === "latest"
    ? await latestAttachmentPath()
    : await toHostPath(ctx, context, reference);

  const data = await readFile(path, { signal: context.signal });

  const sniffed = sniffImageType(data);
  const dot = path.lastIndexOf(".");
  const byExtension = dot === -1 ? undefined : IMAGE_TYPES[path.slice(dot).toLowerCase()];
  const contentType = sniffed?.mime ?? byExtension;
  if (contentType === undefined) {
    throw new Error(
      `image_generate: cannot determine the image type of "${path}". ` +
        `Supported formats: PNG, JPEG, WebP, GIF.`,
    );
  }

  return { path, data, ext: sniffed?.ext ?? path.slice(dot), contentType };
}

/**
 * 把 `reference_image` 解析成一组路径。
 *
 * 模型可以写一个路径、也可以写多个（换行或逗号分隔）；写成数组也认。
 * 「图一 / 图二」的顺序就是这里的顺序 —— 上游按部件顺序读，2026-10-10 实测过。
 */
function parseReferencePaths(value) {
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    for (const piece of entry.split(/[\r\n,;]+/)) {
      const path = piece.trim().replace(/^["']|["']$/g, "");
      if (path.length > 0) out.push(path);
    }
  }
  return out;
}

/** 多于这个数就报错：一次编辑塞太多图，上游多半会崩，用户也不会这么用。 */
const MAX_REFERENCE_IMAGES = 4;

/** 按名解析密钥：先问凭据 seam，再退回进程环境。 */
async function resolveApiKey(ctx, refName) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    const hit = await credentials.resolve(refName);
    if (hit?.value) return hit.value;
  }
  const fromEnv = process.env[refName];
  if (fromEnv) return fromEnv;
  throw new Error(
    `image_generate: credential "${refName}" is not configured. ` +
      `Add it to $DSH_HOME/.credentials.yaml under "refs:", or export it.`,
  );
}

function abortFor(context, config) {
  return AbortSignal.any([context.signal, AbortSignal.timeout(config.timeoutMs)]);
}

/**
 * 图生图走 multipart：中转站的 `/images/edits` 只从表单里读图片字节。
 * 把文件塞进 JSON 字段是不行的（会被当成 URL 去抓）。
 *
 * 多张参考图用重复的 `image[]` 部件 —— 2026-10-10 实测过：两张图分别放在
 * `image[]` 里，HTTP 200，输出图两侧颜色各自对应，说明**两张都被收到且顺序保留**。
 * 单张仍用 `image`（那是长期验证过的形状），不赌「上游把 `image[]` 当 `image` 读」。
 */
function buildMultipart(boundary, fields, files) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; ` +
          `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

/** 发请求并解析出 `data[]`。 */
async function requestImages(context, config, apiKey, endpoint, init) {
  const res = await fetch(endpoint, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": UA,
      ...init.headers,
    },
    signal: abortFor(context, config),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(describeHttpError(res.status, text));

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`image request returned non-JSON: ${text.slice(0, 300)}`);
  }
  const items = Array.isArray(parsed?.data) ? parsed.data : [];
  if (items.length === 0) throw new Error("image request returned no image data");
  return items;
}

/** 上游给 `url` 或 `b64_json`，两条路都认。 */
async function fetchImageBytes(context, config, item) {
  if (typeof item?.b64_json === "string" && item.b64_json.length > 0) {
    return Buffer.from(item.b64_json, "base64");
  }
  const src = item?.url;
  if (typeof src !== "string" || src.length === 0) {
    throw new Error("image response carried neither `url` nor `b64_json`");
  }
  const res = await fetch(src, {
    headers: { "user-agent": UA, accept: "image/*" },
    signal: abortFor(context, config),
  });
  if (!res.ok) {
    throw new Error(`downloading the generated image failed (HTTP ${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 从一条 `user/message` 载荷里取出纯文本。
 *
 * 只认 `type === "text"` 的块：图片块在这里没有意义（参考图走
 * `reference_image` / 命令附件），而且「原封不动」只对文字成立。
 */
function messageText(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/** 路径相对化，用于给客户端算「侧边栏可预览」的地址；不在工作目录里返回 undefined。 */
function relativeWithin(cwd, path) {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  try {
    const rel = relative(cwd, path);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return rel;
  } catch {
    return undefined;
  }
}

/**
 * 解析 `/image` 的命令行。
 *
 * 只有本文档列出的五个旗标会被吃掉，其余字节（包括 `--foo` 这种不认识的）
 * 原样留在提示词里 —— 提示词的「原封不动」不能因为顺手解析个参数就破掉。
 * 提示词只做首尾空白裁剪：`/image 一只猫` 里那个分隔空格不是提示词的一部分。
 *
 * `--ref` 可以重复出现，命中路径的参考图由宿主自己读文件（见 `loadReferenceImage`）——
 * 「生图台」用它把**上一张成图**直接当参考图再改，不必把图片字节绕回浏览器一圈。
 * 路径含空格时用引号括起来；`--ref latest` 沿用工具侧「取会话里最近附的那张图」。
 */
function parseImageCommand(rawInput) {
  const options = {};
  let rest = String(rawInput ?? "");
  for (;;) {
    const match =
      /^\s*--(n|model|size|name|ref)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))\s*/.exec(rest);
    if (match === null) break;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (match[1] === "n") {
      const count = Number.parseInt(value, 10);
      if (Number.isInteger(count)) options.n = count;
    } else if (match[1] === "name") {
      options.fileName = value;
    } else if (match[1] === "ref") {
      if (value.length > 0) {
        if (options.references === undefined) options.references = [];
        options.references.push(value);
      }
    } else {
      options[match[1]] = value;
    }
    rest = rest.slice(match[0].length);
  }
  // `--` 单独出现表示「后面全是提示词」，用于提示词本身以 `--` 开头的情形。
  rest = rest.replace(/^\s*--\s+/, "");
  return { ...options, prompt: rest.trim() };
}

/** `/image` 的失败文案统一收口，别把栈丢给用户。 */
function failureText(error, prefix = "生图失败") {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}：${detail}`;
}

export function apply(ctx, config) {
  /**
   * 读一个配置字段的**当前值**。
   *
   * 带 `.volatile()` 的字段在 `config` 里不是原始值，而是 cosmokit 的
   * `Volatile` 稳定引用 —— 必须 `.get()` 解包（直接 `config.baseURL.replace(...)`
   * 会得到 `TypeError: config.baseURL.replace is not a function`）。
   *
   * 而且**每次都要现读**，不能缓存进闭包：volatile 的全部意义就是
   * 「不重新挂载插件也能改」，缓存会让设置页里的修改永远不生效。
   */
  const live = (field) => {
    const raw = config[field];
    return isVolatile(raw) ? raw.get() : raw;
  };

  // 设置页把输入框清空时字段会被 unset，解析回落 schema 默认值 —— 但用户也可能
  // 真的写入空串，所以这里逐项兜一次底，别让一次误删把工具搞坏。
  const text = (value, fallback) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

  // 模型清单以配置为准（「设置 → 生图」里可增删）。空清单回落到内置默认值，
  // 免得工具描述里出现「可用模型：（空）」这种没法用的提示。
  const modelList = () => {
    const declared = live("models");
    const entries = Array.isArray(declared)
      ? declared.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
      : [];
    return entries.length > 0 ? [...new Set(entries)] : [...DEFAULT_MODELS];
  };
  const baseURL = () =>
    text(live("baseURL"), "https://api.yitaizhongji.com/v1").replace(/\/+$/, "");
  const maxImages = () => {
    const value = Number(live("maxImages"));
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 4;
  };
  const defaultSize = () => text(live("defaultSize"), "1024x1024");
  const defaultModel = () => {
    const list = modelList();
    return text(live("model"), list[0]);
  };

  /* ─────────────────── 本轮用户原话：verbatim 的燃料 ─────────────────── */

  /**
   * 会话 → 最近一条用户自己发的消息。
   *
   * 为什么订阅事件流而不是每次去翻会话日志：`Session` 的同步读取
   * （`eventAt` / `snapshotEvents` / `ownEvents`）在 dsh-session 里已经**废弃**，
   * 明确「禁止新增生产调用」；而 `session/event` 是稳定的观察通道
   * （`dsh-agent-instructions` 等核心插件都这么做）。
   *
   * 只认 `source.kind === "user"`：压缩检查点、注入的上下文、工具结果
   * 都可能以 user 角色出现在日志里，但它们不是「用户说的话」。
   */
  const userPrompts = new WeakMap();
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "user/message") return;
    const data = event.data;
    if (data?.source?.kind !== "user") return;
    userPrompts.set(session, { seq: event.seq, text: messageText(data) });
  });

  /**
   * 取「本轮」用户消息的记录（`{ seq, text }`）。
   *
   * 用 `turnBoundary` 投影确认这条消息属于当前打开的轮次：否则上一轮说的
   * 「画只猫」会在若干轮之后被 AI 发起的生图误用。投影服务缺席（非 web 组装）
   * 时退化为「最近一条即本轮」。
   */
  const currentUserRecord = (session) => {
    if (session === undefined || session === null) return undefined;
    const record = userPrompts.get(session);
    if (record === undefined || record.text.length === 0) return undefined;
    const projections = ctx.get("sessionProjections");
    if (projections !== undefined) {
      try {
        const boundary = projections.stateOf(session, "turnBoundary");
        const start = boundary?.openTurnStartSeq;
        if (typeof start === "number" && record.seq < start) return undefined;
      } catch {
        /* 没有这个投影单元就当它不存在，不因为兜底逻辑把生图搞挂。 */
      }
    }
    return record;
  };

  /**
   * 本轮的生图计数与「已解锁」标记。
   *
   * 键是「会话 + 本轮用户消息的 seq」。同一轮里第二次调用生图会被要求给出
   * `extra_image_reason`，否则拒发 —— 治的是「模型自查后自己加戏」（2026-10-10
   * 会话「生图2」里它一口气出了两版，用户从没要过多版本）。
   *
   * 但**只问一次**：本轮给过理由就解锁，后面几张不再问。因为「用户让我自己备齐
   * 素材」这类项目天然要好几张（背景 + 图标 + 头像……），每张都问一遍就成绊脚石了。
   * 那一次问话的作用是逼模型停下来确认「这真是用户要的吗」，问过一次就够了。
   */
  const turnCalls = new WeakMap();
  const turnState = (session, seq) => {
    if (session === undefined || session === null || seq === undefined) return undefined;
    const state = turnCalls.get(session);
    return state !== undefined && state.seq === seq ? state : undefined;
  };
  const turnCallCount = (session, seq) => turnState(session, seq)?.count ?? 0;
  const turnUnlocked = (session, seq) => turnState(session, seq)?.unlocked === true;
  const noteTurnCall = (session, seq, unlocked) => {
    if (session === undefined || session === null || seq === undefined) return;
    const state = turnState(session, seq);
    turnCalls.set(session, {
      seq,
      count: (state?.count ?? 0) + 1,
      unlocked: state?.unlocked === true || unlocked,
    });
  };

  /** 报错信息里引用用户原话时用的短预览，避免把整段长文塞进错误里。 */
  const preview = (value, limit = 60) => {
    const flat = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
  };

  /** 按码点数，避免代理对被算成两个字。 */
  const charCount = (value) => [...String(value ?? "")].length;

  /** `user-append` 这次允许的追加段字数上限。 */
  const appendixLimit = (raw) => Math.max(APPENDIX_MIN_CHARS, charCount(raw) * 2);

  /* ─────────────────────── 真正打上游的那一段 ─────────────────────── */

  /**
   * 生成/编辑图片并把结果落盘。
   *
   * 工具和 `/image` 命令共用这一份实现，所以参数里不出现 `exec` ——
   * 两边都只提供 `{ agent, signal }`。提示词由调用方决定：
   * 工具走 verbatim 判定，命令直接用 `rawInput`。
   *
   * @param references 图生图的参考图（`{ data, ext, contentType }` 数组，顺序即「图一/图二」），
   *                   空数组即文生图。多于一张时上游收到的是重复的 `image[]` 部件。
   */
  const generateImage = async ({
    context,
    prompt,
    model,
    size,
    n,
    fileName,
    references = [],
    outputDir,
  }) => {
    const resolvedN = Math.min(Math.max(Number.isInteger(n) ? n : 1, 1), maxImages());
    const resolvedSize =
      typeof size === "string" && size.trim().length > 0 ? size.trim() : defaultSize();
    const resolvedModel =
      typeof model === "string" && model.trim().length > 0 ? model.trim() : defaultModel();
    const mode = references.length === 0 ? "generate" : "edit";

    const apiKey = await resolveApiKey(
      ctx,
      text(live("apiKeyEnv"), "YITAIZHONGJI_IMAGE_API_KEY"),
    );

    let items;
    if (mode === "edit") {
      const boundary = `----dshImageGen${stamp()}${Math.random().toString(36).slice(2)}`;
      // 一张用 `image`（长期验证过的形状），多张用重复的 `image[]`（实测可用且保序）。
      const fieldName = references.length === 1 ? "image" : "image[]";
      const body = buildMultipart(
        boundary,
        { model: resolvedModel, prompt, n: resolvedN, size: resolvedSize },
        references.map((reference, index) => ({
          name: fieldName,
          filename: `reference${index + 1}${reference.ext}`,
          contentType: reference.contentType,
          data: reference.data,
        })),
      );
      items = await requestImages(context, config, apiKey, `${baseURL()}/images/edits`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
      });
    } else {
      items = await requestImages(context, config, apiKey, `${baseURL()}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: resolvedModel, prompt, n: resolvedN, size: resolvedSize }),
      });
    }

    const dir = await toHostPath(
      ctx,
      context,
      typeof outputDir === "string" && outputDir.length > 0
        ? outputDir
        : text(live("outputDir"), "dsh-images"),
    );
    await mkdir(dir, { recursive: true });

    const baseName =
      typeof fileName === "string" && fileName.trim().length > 0
        ? fileName.trim().replace(/[^\w.-]+/g, "_")
        : `${mode === "edit" ? "edit" : "img"}-${stamp()}`;

    const files = [];
    for (const [index, item] of items.entries()) {
      const bytes = await fetchImageBytes(context, config, item);
      const suffix = items.length > 1 ? `-${index + 1}` : "";
      const path = join(dir, `${baseName}${suffix}.png`);
      await writeFile(path, bytes);
      files.push({ path, bytes: bytes.length });
    }

    return {
      files,
      model: resolvedModel,
      mode,
      size: resolvedSize,
      n: items.length,
      prompt,
      references: references.length,
    };
  };

  /* ────────────────────────── `/image` 命令 ────────────────────────── */

  /** 命令附件里的**所有**图片 → 参考图字节（顺序即附件顺序）。附件走持久化引用，按 seam 读。 */
  const referenceFromAttachments = async (attachments, signal) => {
    const blocks = (Array.isArray(attachments) ? attachments : []).filter(
      (entry) => entry?.type === "image",
    );
    if (blocks.length === 0) return [];
    if (blocks.length > MAX_REFERENCE_IMAGES) {
      throw new Error(
        `/image 最多一次传 ${MAX_REFERENCE_IMAGES} 张参考图，这次附了 ${blocks.length} 张。`,
      );
    }

    const store = ctx.get("attachments");
    if (store === undefined || typeof store.readImage !== "function") {
      throw new Error("附件存储不可用，读不到参考图");
    }

    const references = [];
    for (const block of blocks) {
      const read = await store.readImage(block.attachment, signal);
      const data = Buffer.from(read?.data ?? read);
      const sniffed = sniffImageType(data);
      const contentType =
        sniffed?.mime ??
        (typeof block.attachment?.mediaType === "string"
          ? block.attachment.mediaType
          : "image/png");
      references.push({ data, ext: sniffed?.ext ?? ".png", contentType });
    }
    return references;
  };

  /**
   * `/image` 的结果文本：给人看的部分 + 给客户端卡片的哨兵行。
   *
   * 卡片要的字段（提示词、模型、尺寸、文件、工作目录）都塞进哨兵 JSON，
   * 人类可读部分保持自解释 —— 卡片没挂上时这就是一条普通命令结果。
   */
  const formatCommandResult = (result, agent) => {
    const cwd = agent?.session?.header?.cwd;
    // 参考图张数要写出来：用户口中的「图一/图二」只按**送入顺序**成立，
    // 他必须能当场核对这次到底送了几张、顺序对不对。
    const references = Number.isInteger(result.references) ? result.references : 0;
    const lines = [
      `${result.mode === "edit" ? "改图" : "生图"}完成：${result.files.length} 张 · ` +
        `${result.model} · ${result.size}` +
        (references > 0 ? ` · 参考图 ${references} 张` : ""),
      "提示词（原样发给生图模型，未经过对话模型）：",
      result.prompt,
      ...result.files.map((file) => `- ${file.path}`),
    ];
    lines.push(
      RESULT_SENTINEL +
        " " +
        JSON.stringify({
          v: 1,
          prompt: result.prompt,
          model: result.model,
          size: result.size,
          mode: result.mode,
          references,
          cwd: typeof cwd === "string" ? cwd : undefined,
          files: result.files.map((file) => ({
            path: file.path,
            rel: relativeWithin(cwd, file.path),
            bytes: file.bytes,
          })),
        }),
    );
    return lines.join("\n");
  };

  // `commands` 只在带交互式 UI 的组装里存在（headless / ACP 没有命令面），
  // 所以用可选注入：没有命令服务时工具照常可用，插件不因此挂载失败。
  ctx.inject(["commands"], (child) => {
    child.effect(
      () =>
        child.commands.register({
          name: IMAGE_COMMAND,
          description:
            "生图 / 改图：提示词原样发给生图模型，不经过对话模型理解；可附多张参考图",
          input: {
            hint:
              "<提示词>（可附参考图，多张按附件顺序；可选 --n / --model / --size / --name / --ref <路径>）",
            attachments: true,
          },
          handler: async (invocation) => {
            const parsed = parseImageCommand(invocation.rawInput);
            if (parsed.prompt.length === 0) return { kind: "error", text: IMAGE_USAGE };
            try {
              const context = { agent: invocation.agent, signal: invocation.signal };
              // 附件在前（用户说的「图一/图二」就是附件顺序），`--ref` 路径按出现顺序接在后面。
              const references = await referenceFromAttachments(
                invocation.attachments,
                invocation.signal,
              );
              const pathRefs = Array.isArray(parsed.references) ? parsed.references : [];
              if (references.length + pathRefs.length > MAX_REFERENCE_IMAGES) {
                return {
                  kind: "error",
                  text:
                    `/image 最多一次传 ${MAX_REFERENCE_IMAGES} 张参考图：附件 ${references.length} 张 + ` +
                    `--ref ${pathRefs.length} 个。`,
                };
              }
              for (const path of pathRefs) {
                references.push(await loadReferenceImage(ctx, context, path));
              }
              const result = await generateImage({
                context,
                prompt: parsed.prompt,
                model: parsed.model,
                size: parsed.size,
                n: parsed.n,
                fileName: parsed.fileName,
                references,
              });
              return { kind: "success", text: formatCommandResult(result, invocation.agent) };
            } catch (error) {
              return { kind: "error", text: failureText(error) };
            }
          },
        }),
      "image-gen: /image command",
    );
  });

  // 设置页由本包自己的 client 半边提供（`lib/client.js`），所以关掉自动生成表单，
  // 避免将来有客户端按 schema 自动渲染时出现两份。
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });

  // 工具描述在注册那一刻定稿，所以下面这两个是快照 —— 设置页改完清单后描述
  // 不会自己跟着变（volatile 是「不重挂载改值」，不是「重跑 apply」）。
  // 执行路径则一律实时读，见 generateImage 里的 live(...)。
  const available = modelList();
  const defaultModelAtRegister = defaultModel();
  const defaultSizeAtRegister = defaultSize();
  const maxImagesAtRegister = maxImages();

  ctx.tools.register(
    defineTool({
      name: "image_generate",
      description:
        "Generate or edit an image and save it into the session working directory. " +
        "Without `reference_image` it is text-to-image; with `reference_image` it is " +
        "image-to-image (the reference is sent as an actual image file, so the model can " +
        "restyle, recolour, or extend it). This is the ONLY way to produce or modify a " +
        "picture: the chat model cannot do it. " +
        "PROMPT POLICY — when the user's own message asked for the picture (the normal case), " +
        "the host sends their exact words to the image model and they cannot be replaced by " +
        "you. Three modes: (1) `prompt_source: \"user\"` (the default) — leave `prompt` empty; " +
        "the user's words go out verbatim and `prompt` is discarded. (2) `prompt_source: " +
        "\"user-append\"` — the user asked, but their words point at something the image model " +
        "cannot resolve on its own (typically 图一/图二 while the edit endpoint carries a single " +
        "reference image). The host still sends the user's words FIRST and appends your " +
        "`prompt` after them, so write ONLY the extra constraints — never a restatement, " +
        "translation, or replacement of their request. Keep that to one or two sentences: a " +
        "length cap is enforced, and what the characters look like is already visible in the " +
        "reference image. (3) `prompt_source: \"self\"` — the " +
        "user's message was about something else (a web page, a theme) and YOU decided to add " +
        "a picture; then `prompt` is the whole prompt and `initiative_note` is required. Never " +
        "translate, summarize, or embellish the user's own wording. " +
        "When the user attached images earlier in the conversation, that message carries " +
        "a \"Normalized copy (read-only…)\" path per image — pass them as `reference_image` " +
        "verbatim, one path per line, in the user's own order; multiple references ARE " +
        "supported, so never stitch two images into one. " +
        "After it succeeds, call `present` with the returned paths so the user can see " +
        "the images as deliverables.",
      timeoutMs: config.timeoutMs,
      parameters: {
        prompt_source: {
          type: "string",
          enum: ["user", "user-append", "self"],
          description:
            "Which of these is true for THIS turn? \"user\" (default): the user's message asked " +
            "for the picture — the host sends their exact words and ignores `prompt`. " +
            "\"user-append\": the user asked, but their words need constraints appended because " +
            "they reference images by position (图一/图二) that the image model cannot resolve — " +
            "the host keeps their words first and appends your `prompt` after them. \"self\": " +
            "the user's message was about something else and you decided to add a picture — " +
            "`prompt` is sent instead of their words (requires `initiative_note`).",
        },
        prompt: {
          type: "string",
          description:
            "With `prompt_source: \"user-append\"`: ONLY the constraints to append AFTER the " +
            "user's verbatim words (which side of the reference composite is 图一 / 图二, and the " +
            "direction of the edit) — one or two sentences. Never a restatement or translation of " +
            "their request, and never design decisions they did not ask for (hair colour, eye " +
            "colour, animal ears, palette, tail): those are visible in the reference image, and a " +
            "length cap is enforced. With `prompt_source: \"self\"`: the whole prompt, sent as " +
            "written. Ignored with `prompt_source: \"user\"`.",
        },
        initiative_note: {
          type: "string",
          description:
            "Required with `prompt_source: \"self\"` when this turn carries user text: one " +
            "sentence saying what the user actually asked for in this message. If that message " +
            "was itself asking for a picture, you are in the wrong mode — use `user` or " +
            "`user-append` instead.",
        },
        model: {
          type: "string",
          description:
            `Which image model to use; defaults to "${defaultModelAtRegister}". Only set this when ` +
            `the user explicitly names one. Configured on this gateway: ` +
            `${available.join(", ")}.`,
        },
        reference_image: {
          type: "string",
          description:
            "The image(s) to edit — **one or more paths, separated by newlines**, in the order " +
            "the user refers to them (first path = 图一). The upstream accepts multiple " +
            "references and preserves that order, so when the user attached two images do NOT " +
            "stitch them together: pass both paths, newest-relevant first, and say which is " +
            "which in `prompt`. Each path may be: (a) the \"Normalized copy (read-only…)\" path " +
            "shown in a user-attachment message — pass it verbatim, an extensionless path is " +
            "fine; (b) any local image path (relative paths resolve against the session working " +
            `directory); (c) the literal string "latest". At most ${MAX_REFERENCE_IMAGES} paths. ` +
            "Omit entirely for text-to-image.",
        },
        extra_image_reason: {
          type: "string",
          description:
            "Only needed for the SECOND image generation of a turn, and only once: quote what " +
            "the user asked for that requires more than one picture (for a 'generate whatever " +
            "assets you need' task, say so). Without it that second call is rejected; after it " +
            "is accepted the rest of the turn is unlocked. Regenerating because you were not " +
            "happy with the result is not a reason — show it to the user and let them decide, " +
            "or make the versions in a single call with `n: 2..4`.",
        },
        size: {
          type: "string",
          enum: [...SIZES],
          description: `Output size; defaults to ${defaultSizeAtRegister}.`,
        },
        n: {
          type: "integer",
          description: `How many images, 1-${maxImagesAtRegister}; defaults to 1.`,
        },
        file_name: {
          type: "string",
          description:
            "Optional base name without extension; defaults to a timestamped name. " +
            "A numeric suffix is added when n > 1.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            files: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", required: true },
                  bytes: { type: "integer", required: true },
                },
              },
            },
            model: { type: "string", required: true },
            mode: {
              type: "string",
              required: true,
              enum: ["generate", "edit"],
            },
            /** 实际发给生图模型的那段文字 —— 用户用它核对「有没有被改过」。 */
            prompt: { type: "string", required: true },
            /**
             * `user` = 原封不动的用户原话；
             * `user-append` = 用户原话 + 模型追加的约束（见 `appended`）；
             * `self` = 本轮用户说的是别的事，整段都是模型写的。
             */
            source: {
              type: "string",
              required: true,
              enum: ["user", "user-append", "self"],
            },
            /** `user-append` 时模型追加的那一段，单独回显便于核对两段的分界。 */
            appended: { type: "string" },
            /** 用户发起、模型却写了 `prompt`：已被丢弃。回显出来提醒它改用 user-append。 */
            ignoredPrompt: { type: "boolean" },
            /** 这次实际送上去的参考图张数（顺序即「图一/图二」）。 */
            references: { type: "integer", required: true },
          },
        },
        render: (args, value) => [
          {
            type: "text",
            text:
              `${value.mode === "edit" ? "Edited" : "Generated"} ` +
              `${value.files.length} image(s) with ${value.model}` +
              (value.references > 0 ? ` from ${value.references} reference image(s)` : "") +
              ":\n" +
              value.files.map((f) => `- ${f.path} (${f.bytes} bytes)`).join("\n") +
              (typeof args?.extra_image_reason === "string" &&
              args.extra_image_reason.trim().length > 0
                ? `\n(This is an extra image in this turn because: ${args.extra_image_reason.trim()})`
                : "") +
              (value.source === "user"
                ? "\nPrompt sent to the image model — the user's own words, verbatim:\n" +
                  value.prompt
                : value.source === "user-append"
                  ? "\nPrompt sent to the image model — the user's own words verbatim, then " +
                    "the constraints you appended. Their part comes first and cannot be " +
                    "replaced:\n" +
                    value.prompt
                  : "\nPrompt sent to the image model — YOUR OWN prompt. You declared this " +
                    "turn's user message was not an image request" +
                    (typeof args?.initiative_note === "string" &&
                    args.initiative_note.trim().length > 0
                      ? ` (${args.initiative_note.trim()})`
                      : "") +
                    ", so their words were NOT forwarded:\n" +
                    value.prompt) +
              (value.ignoredPrompt === true
                ? "\n(`prompt` was ignored: the user asked for this image, so their own words " +
                  "went out verbatim. To add constraints around them, use " +
                  "`prompt_source: \"user-append\"`.)"
                : "") +
              "\nCall `present` with these paths to show them to the user.",
          },
        ],
      },
      async execute(args, exec) {
        const composed = typeof args.prompt === "string" ? args.prompt.trim() : "";
        const note =
          typeof args.initiative_note === "string" ? args.initiative_note.trim() : "";
        const extraReason =
          typeof args.extra_image_reason === "string" ? args.extra_image_reason.trim() : "";
        const requested =
          args.prompt_source === "user-append"
            ? "user-append"
            : args.prompt_source === "self"
              ? "self"
              : "user";

        // 本轮用户原话。「有没有用户文字」是宿主唯一能客观区分的依据，也是 verbatim 的燃料；
        // seq 还兼作「本轮已出几张图」的计数键。
        const turn = currentUserRecord(exec.agent?.session);
        const raw = turn?.text;
        const turnSeq = turn?.seq;

        let prompt;
        let source;
        let appended;
        let ignoredPrompt;

        if (raw === undefined) {
          // 本轮没有用户文字（用户只发了图、或这是子智能体）：没有原话可保，模型写的就是全部。
          if (composed.length === 0) {
            throw new Error(
              "image_generate: this turn carries no user text to forward verbatim, so `prompt` " +
                'must hold the whole prompt. Pass `prompt` together with `prompt_source: "self"`.',
            );
          }
          prompt = composed;
          source = "self";
        } else if (requested === "self") {
          // AI 发起：本轮用户说的是别的事（写网页、做主题），这张图是模型自己加的配图。
          // 这条路会把用户原话整段丢掉，所以要求模型交代「用户这条消息实际要的是什么」——
          // 被迫给理由的那一刻，正是它该发现「用户要的就是图」的时刻。
          if (composed.length === 0) {
            throw new Error(
              'image_generate: `prompt` is required when `prompt_source` is "self".',
            );
          }
          if (note.length === 0) {
            throw new Error(
              'image_generate: `prompt_source: "self"` drops this turn\'s user words from the ' +
                `prompt (${preview(raw)}). Add \`initiative_note\` — one sentence saying what ` +
                "the user actually asked for in this message. If that message was itself asking " +
                'for a picture, use `prompt_source: "user-append"` instead and put only the ' +
                "extra constraints in `prompt`.",
            );
          }
          prompt = composed;
          source = "self";
        } else if (requested === "user-append") {
          // 用户发起 + 原话需要补充说明：原话永远在开头，模型只能往后补。
          if (composed.length === 0) {
            throw new Error(
              'image_generate: `prompt` is required when `prompt_source` is ' +
                '"user-append": write only the constraints to append after the user\'s words.',
            );
          }
          const limit = appendixLimit(raw);
          if (charCount(composed) > limit) {
            throw new Error(
              `image_generate: the appended part is ${charCount(composed)} characters, over this ` +
                `turn's ${limit}-character limit (the user's own words are ${charCount(raw)}; the ` +
                "limit is max(300, twice their length)). `user-append` exists ONLY for what the " +
                "image model cannot see for itself: the reference-image layout (which side is 图一 " +
                "/ 图二) and the direction of the edit. What the characters look like and what the " +
                "art style is are already visible in the reference image — do not restate them, do " +
                "not add design decisions the user never asked for (hair colour, eye colour, animal " +
                "ears, palette, tail), and do not re-decide the task. One or two sentences.",
            );
          }
          prompt = `${raw}\n\n${composed}`;
          source = "user-append";
          appended = composed;
        } else {
          // 默认：用户开口要的图 —— 原封不动。模型写什么都丢弃，且把「丢弃了」回显出去。
          prompt = raw;
          source = "user";
          if (composed.length > 0) ignoredPrompt = true;
        }

        const referencePaths = parseReferencePaths(args.reference_image);
        if (referencePaths.length > MAX_REFERENCE_IMAGES) {
          throw new Error(
            `image_generate: ${referencePaths.length} reference images given, the limit is ` +
              `${MAX_REFERENCE_IMAGES}. If the user attached more, ask which ones to use.`,
          );
        }

        const context = { agent: exec.agent, signal: exec.signal };

        // 本轮已经出过图？那就先确认这是不是用户要的 —— 只问一次，问过就解锁。
        const session = exec.agent?.session;
        const priorCalls = turnCallCount(session, turnSeq);
        if (priorCalls > 0 && !turnUnlocked(session, turnSeq) && extraReason.length === 0) {
          throw new Error(
            `image_generate: this turn has already produced ${priorCalls} image generation(s). ` +
              "Stop and call `present` with what you have — you are not the reviewer, the user " +
              "is, and every generation costs money. If the user DID ask for another distinct " +
              "picture in this same message, pass `extra_image_reason` quoting what they asked " +
              "for; that unlocks the rest of this turn, so you only have to say it once. If they " +
              "wanted several versions of the same one, that is a single call with `n: 2..4`.",
          );
        }

        const references = [];
        for (const path of referencePaths) {
          references.push(await loadReferenceImage(ctx, context, path));
        }

        const result = await generateImage({
          context,
          prompt,
          model: args.model,
          size: args.size,
          n: args.n,
          fileName: args.file_name,
          references,
        });

        if (turnSeq !== undefined) noteTurnCall(session, turnSeq, extraReason.length > 0);

        return {
          files: result.files,
          model: result.model,
          mode: result.mode,
          prompt: result.prompt,
          references: result.references,
          source,
          ...(appended === undefined ? {} : { appended }),
          ...(ignoredPrompt === undefined ? {} : { ignoredPrompt }),
        };
      },
    }),
  );

  /* ───────────────── 生图台直连路由（不写会话日志） ───────────────── */

  /** 老的默认目录：只用于「读」，让升级前的成图还能显示。 */
  const legacyStudioDir = () => {
    const home = process.env.DSH_HOME;
    const base = home !== undefined && home.length > 0 ? home : join(homedir(), ".dsh");
    return join(base, "image-studio");
  };

  /** 生图台的输出目录：配置优先，缺省落在 $DSH_HOME/image-studio（全局一个）。 */
  const resolveStudioDir = () => {
    const configured = text(live("studioDir"), "");
    return configured.length > 0 ? configured : legacyStudioDir();
  };

  /** 这条读图路由允许的根目录（当前目录 + 旧目录）。 */
  const studioReadRoots = () => {
    const primary = resolveStudioDir();
    const legacy = legacyStudioDir();
    return primary === legacy ? [primary] : [primary, legacy];
  };

  /** 读完整个请求体（带硬上限，防止把宿主内存打爆）。 */
  const readStudioBody = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > STUDIO_BODY_LIMIT) throw new Error("request body too large");
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw.length === 0 ? {} : JSON.parse(raw);
  };

  const sendStudioJson = (response, status, value) => {
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(value));
  };

  /** 把面板发来的参考图（base64）变成 generateImage 要的形状。 */
  const referencesFromPayload = (entries) => {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length > MAX_REFERENCE_IMAGES) {
      throw new Error(
        "参考图最多 " + MAX_REFERENCE_IMAGES + " 张，这次带了 " + list.length + " 张。",
      );
    }
    const references = [];
    for (const entry of list) {
      const data = typeof entry?.data === "string" ? Buffer.from(entry.data, "base64") : undefined;
      if (data === undefined || data.length === 0) throw new Error("参考图是空的。");
      const sniffed = sniffImageType(data);
      const declared = typeof entry?.mediaType === "string" ? entry.mediaType : undefined;
      const contentType =
        sniffed?.mime ?? (declared !== undefined && REFERENCE_MIME.has(declared) ? declared : undefined);
      if (contentType === undefined) throw new Error("参考图只支持 PNG / JPEG / WebP / GIF。");
      references.push({ data, ext: sniffed?.ext ?? ".png", contentType });
    }
    return references;
  };

  const handleStudioRequest = async (request, response) => {
    if (request.method !== "POST") {
      sendStudioJson(response, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin.length > 0) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === request.headers.host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        sendStudioJson(response, 403, { ok: false, error: "untrusted origin" });
        return;
      }
    }

    let body;
    try {
      body = await readStudioBody(request);
    } catch (error) {
      sendStudioJson(response, 400, { ok: false, error: failureText(error, "请求无效") });
      return;
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length === 0) {
      sendStudioJson(response, 400, { ok: false, error: "先写提示词。" });
      return;
    }

    const studioDir = resolveStudioDir();
    if (studioDir === undefined) {
      sendStudioJson(response, 500, { ok: false, error: "找不到生图目录（DSH_HOME 未设置）。" });
      return;
    }

    try {
      const references = referencesFromPayload(body.references);
      // 生图台是全局工作台：没有会话，输出目录固定；只借用 generateImage 的上游能力。
      const result = await generateImage({
        context: { signal: AbortSignal.timeout(config.timeoutMs) },
        prompt,
        model: typeof body.model === "string" ? body.model : undefined,
        size: typeof body.size === "string" ? body.size : undefined,
        n: Number.isInteger(body.n) ? body.n : 1,
        fileName: typeof body.name === "string" ? body.name : undefined,
        references,
        outputDir: studioDir,
      });
      sendStudioJson(response, 200, {
        ok: true,
        prompt: result.prompt,
        model: result.model,
        size: result.size,
        mode: result.mode,
        references: result.references,
        dir: studioDir,
        files: result.files.map((file) => ({
          path: file.path,
          rel: relativeWithin(studioDir, file.path),
          bytes: file.bytes,
        })),
      });
    } catch (error) {
      // 上游失败也回 200 + ok:false：面板只关心「成没成、为什么」。
      sendStudioJson(response, 200, { ok: false, error: failureText(error, "生图失败") });
    }
  };

  /** 成图读图：只允许生图目录里的文件，避免这条路由变成任意文件读取。 */
  const handleStudioFileRequest = async (request, response) => {
    if (request.method !== "GET") {
      sendStudioJson(response, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const roots = studioReadRoots();
    let target;
    try {
      const url = new URL(String(request.url ?? "/"), "http://localhost");
      const raw = url.searchParams.get("path");
      if (raw === null || raw.length === 0) throw new Error("path is required");
      target = isAbsolute(raw) ? raw : join(roots[0], raw);
    } catch (error) {
      sendStudioJson(response, 400, { ok: false, error: failureText(error, "路径无效") });
      return;
    }
    const normalized = target.replace(/\\/g, "/");
    const allowed = roots.some((dir) => {
      const root = (dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + "/").replace(/\\/g, "/");
      return normalized.startsWith(root);
    });
    if (!allowed) {
      sendStudioJson(response, 403, { ok: false, error: "forbidden" });
      return;
    }
    try {
      const bytes = await readFile(target);
      const ext = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": IMAGE_TYPES[ext] ?? "application/octet-stream",
        "content-length": String(bytes.length),
      });
      response.end(bytes);
    } catch (error) {
      sendStudioJson(response, 404, { ok: false, error: failureText(error, "读不到这张图") });
    }
  };

  // 只有带 Web 面的组装才有 webServer；纯 headless 里面板本来也不存在。
  ctx.inject(["webServer"], (host) => {
    host.effect(
      () => {
        const offPost = host.webServer.register({
          kind: "exact",
          path: STUDIO_ROUTE,
          handler: (request, response) => handleStudioRequest(request, response),
        });
        const offFile = host.webServer.register({
          kind: "exact",
          path: STUDIO_FILE_ROUTE,
          handler: (request, response) => handleStudioFileRequest(request, response),
        });
        return () => {
          offPost();
          offFile();
        };
      },
      "image-gen: studio routes",
    );
  });
}
