/**
 * dsh-task-notify — Host 侧。
 *
 * 做三件事：
 *   1. 监听会话的 `turn/end`（DSH 里**唯一durable**的「这一轮结束了」信号，
 *      带 `reason.kind`：completed / aborted / blocked / error / …），
 *      据此弹一条右下角通知。刻意不用 `agent/status` 轮询 —— 官方
 *      `cordis-plugin-development` 的 practices 明确禁止，而且多个输入
 *      会共享同一段 running 区间。
 *   2. 在 `/api/dsh-task-notify/theme` 收客户端上报的当前主题实测值
 *      （`--dsw-*` 解析后的颜色），落盘给渲染进程用 —— 这样弹窗配色
 *      跟着运行中的主题走，第三方主题覆盖 token 也能跟上。
 *   3. 常驻一个 Python 渲染进程负责真正画窗口（见 lib/popup.py 里的说明：
 *      本机 Windows 11 对未打包进程禁用了 WinRT Toast，自绘是唯一能做到
 *      「真右下角 + 完全跟随主题 + 带美术」的路）。
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "task-notify";

/** 需要的服务；缺一个就不激活，避免半残状态。 */
export const inject = ["agents"];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ASSETS = join(ROOT, "assets");
const STATE_DIR = join(ROOT, "state");
const THEME_FILE = join(STATE_DIR, "theme.json");
const POPUP_SCRIPT = join(HERE, "popup.py");
const THEME_ROUTE = "/api/dsh-task-notify/theme";

/** 一轮结束原因 → 通知语气。未知原因按「完成」处理。 */
const TONE = {
  completed: { status: "done", title: "任务完成" },
  aborted: { status: "cancelled", title: "任务已中止" },
  interrupted: { status: "cancelled", title: "任务已中断" },
  blocked: { status: "cancelled", title: "任务被阻塞" },
  error: { status: "failed", title: "任务失败" },
  "max-tokens": { status: "cancelled", title: "上下文用尽" },
  forked: { status: "done", title: "任务已完成" },
};

/**
 * 找渲染器要用的 Python。
 *
 * 必须带 Pillow + numpy，所以优先用 DSH 自己那份随发行版打包的运行时
 * （`$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/python`），
 * 它一定附带这两个库；系统 python 只在兜底时使用。
 * @returns 可执行的 Python 路径。
 */
function resolvePython() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
  const candidates = [
    process.env.DSH_TASK_NOTIFY_PYTHON,
    join(home, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe"),
    join(home, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "bin", "python3"),
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "python";
}

/** 读客户端上报的主题；没有就走 DSH 深色默认值。 */
function readTheme() {
  try {
    const parsed = JSON.parse(readFileSync(THEME_FILE, "utf8"));
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    /* 首次运行还没有这个文件 */
  }
  return { dark: true, tokens: {} };
}

function writeTheme(payload) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(THEME_FILE, JSON.stringify(payload, null, 2), "utf8");
}

/** `reason` 归一成一个短标签，落在通知的 meta 行上。 */
function reasonLabel(reason) {
  if (reason === null || typeof reason !== "object") return "";
  const kind = typeof reason.kind === "string" ? reason.kind : "";
  const detail = reason.reason ?? reason.error?.message;
  const text = typeof detail === "string" && detail.length > 0 ? `${kind}: ${detail}` : kind;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function elapsedLabel(startedAt) {
  if (typeof startedAt !== "number") return "";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function apply(ctx) {
  const python = resolvePython();

  let child = null;
  let childBroken = false;
  const pending = [];
  /** 每个会话的当前轮开始时间，用来算耗时。 */
  const turnStartedAt = new Map();
  const logger = ctx.logger("task-notify");

  function ensureChild() {
    if (child !== null && child.exitCode === null) return child;
    if (childBroken) return null;
    try {
      child = spawn(python, ["-u", POPUP_SCRIPT], {
        cwd: HERE,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch (error) {
      childBroken = true;
      logger.warn(`无法启动弹窗渲染进程：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    child.stdout?.resume();
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text.length > 0) logger.debug(text);
    });
    child.on("exit", (code) => {
      logger.debug(`弹窗渲染进程退出 code=${String(code)}`);
      child = null;
    });
    child.on("error", (error) => {
      childBroken = true;
      logger.warn(`弹窗渲染进程出错：${error.message}`);
    });
    // 先前积压的通知现在补发
    while (pending.length > 0) send(pending.shift());
    return child;
  }

  function send(spec) {
    const target = child;
    if (target === null || target.exitCode !== null || target.stdin === null) {
      pending.push(spec);
      return false;
    }
    try {
      target.stdin.write(`${JSON.stringify({ cmd: "show", ...spec })}\n`);
      return true;
    } catch {
      pending.push(spec);
      return false;
    }
  }

  /** 组装并投递一条通知。 */
  function notify({ status, title, body, meta }) {
    const theme = readTheme();
    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status,
      title,
      body,
      meta,
      dark: theme.dark !== false,
      duration_ms: 6500,
    };
    if (theme.tokens !== undefined) payload.tokens = theme.tokens;
    const themeId = typeof theme.themeId === "string" ? theme.themeId : "";
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(join(ASSETS, "themes", "manifest.json"), "utf8")); } catch {}
    const identity = manifest[themeId];
    if (identity) {
      payload.theme_id = themeId;
      payload.theme_accents = identity.accents;
      payload.brand = `DeepSeek Harness · ${identity.name}`;
      const character = join(ASSETS, "themes", identity.art);
      if (existsSync(character)) payload.art_path = character;
    }
    // An unrecognised/native theme has no invented character.

    if (!send(payload)) ensureChild();
  }

  // ── 1. 主题上报路由 ────────────────────────────────────────────────────
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: THEME_ROUTE,
          handler: (req, res) => {
            if (req.method !== "POST") {
              res.writeHead(405).end();
              return;
            }
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
              if (body.length > 64 * 1024) req.destroy();
            });
            req.on("end", () => {
              try {
                const parsed = JSON.parse(body);
                if (parsed === null || typeof parsed !== "object") throw new Error("bad payload");
                writeTheme({
                  dark: parsed.dark !== false,
                  themeId: typeof parsed.themeId === "string" && /^[a-z0-9-]{1,40}$/.test(parsed.themeId) ? parsed.themeId : "",
                  tokens: typeof parsed.tokens === "object" && parsed.tokens !== null ? parsed.tokens : {},
                  updatedAt: Date.now(),
                });
                res.writeHead(204).end();
              } catch (error) {
                logger.debug(`主题上报被拒：${error instanceof Error ? error.message : String(error)}`);
                res.writeHead(400).end();
              }
            });
          },
        }),
      "task-notify: theme route",
    );
  });

  // ── 2. 轮次开始（记时间） / 3. 轮次结束（弹通知） ────────────────────
  //
  // 会话事件统一走 `session/event`：`(session, event)` 两个参数，
  // `session.id` 是会话 id，`event.type` 是 `turn/start` / `turn/end` 之类。
  // 这是 dsh-session 的 `Session.append()` 对外发布事件的方式，也是
  // api-session-controller、agent-loop 自己用的写法。
  ctx.on("session/event", (session, event) => {
    try {
      const id = session?.id;
      if (typeof id !== "string") return;

      if (event?.type === "turn/start") {
        turnStartedAt.set(id, Date.now());
        return;
      }
      if (event?.type !== "turn/end") return;

      const reason = event?.data?.reason ?? event?.reason ?? null;
      const kind = typeof reason?.kind === "string" ? reason.kind : "completed";
      const tone = TONE[kind] ?? TONE.completed;

      // 标题：优先用会话标题，退回到语气文案
      let title = tone.title;
      let body = "";
      try {
        const agent = ctx.get("agents")?.get?.(id);
        const sessionTitle = agent?.session?.title ?? agent?.options?.title;
        if (typeof sessionTitle === "string" && sessionTitle.length > 0) title = sessionTitle;
      } catch {
        /* 拿不到标题就用兜底文案 */
      }
      if (tone.status !== "done") body = reasonLabel(reason);

      const started = turnStartedAt.get(id);
      turnStartedAt.delete(id);
      const elapsed = elapsedLabel(started);
      const meta = elapsed.length > 0 ? `${tone.title} · 用时 ${elapsed}` : tone.title;

      notify({ status: tone.status, title, body, meta });
    } catch (error) {
      logger.warn(`turn 通知失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // ── 4. 生命周期 ──────────────────────────────────────────────────────
  ctx.effect(() => {
    ensureChild();
    return () => {
      const target = child;
      child = null;
      if (target !== null && target.exitCode === null) {
        try {
          target.stdin?.write(`${JSON.stringify({ cmd: "dismiss-all" })}\n`);
          target.stdin?.end();
        } catch {
          /* 忽略 */
        }
        setTimeout(() => {
          try {
            target.kill();
          } catch {
            /* 忽略 */
          }
        }, 400);
      }
    };
  }, "task-notify: popup process");
}
