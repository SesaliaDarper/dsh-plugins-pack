/**
 * dsh-session-cost — 接进 DSH 的 desktop profile。
 *
 * 做四件事（全部幂等，重复运行只刷新）：
 *   1. 在 `node_modules/dsh-session-cost` 建一个指向本目录的 **junction**；
 *   2. profile 的 `package.json` dependencies 里加上本插件（`file:`）；
 *   3. `cordis.patch.yml` 末尾追加一条 `insert`（已存在则跳过）；
 *   4. 把本插件加进 `hmr` 的监听根，这样改宿主源码不用重启 DSH。
 *
 * ── 为什么必须用 junction 而不是让 pnpm 物化 ─────────────────────────────
 *
 * cordis 的 hmr 只监听**源码目录**，而 app 真正 import 的是 `node_modules` 下的路径。
 * `file:` 依赖被 pnpm 物化成真实副本后，改源码就再也不会生效（只能重启 DSH）。
 * 本 profile 里其它插件（token-widget / model-verify / …）都是这个约定。
 *
 * ── 为什么不用 pnpm ──────────────────────────────────────────────────────
 *
 * 在这个目录里跑 pnpm 会把上面那些 junction 换成真实副本，副作用比收益大。
 * DSH 官方的 `plugin_manager install_bundle` 走的是另一套（bundle + 依赖解析），
 * 本插件按这个 profile 既有习惯以「插件包 + patch 行」的方式接入。
 *
 * 用法：node tools/install-profile.mjs [profileDir]
 *       默认 profileDir = %USERPROFILE%\.dsh\profiles\desktop
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-session-cost';
const ROW_ID = 'session-cost';
const HMR_PLUGINS = ['dsh-model-verify', 'dsh-model-refresh', PLUGIN_NAME];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const profileDir = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop');

if (!fs.existsSync(profileDir)) {
  console.error(`profile 目录不存在：${profileDir}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const log = (label, message) => console.log(`[${label}] ${message}`);

/** 带时间戳备份。 */
function backup(file) {
  if (!fs.existsSync(file)) return;
  const target = `${file}.bak-${ROW_ID}-${stamp}`;
  fs.copyFileSync(file, target);
  log('备份', path.basename(target));
}

/* ── 1. node_modules 里的 junction ── */
const linkPath = path.join(profileDir, 'node_modules', PLUGIN_NAME);
const isLinkToRoot = (() => {
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(ROOT);
  } catch {
    return false;
  }
})();

if (isLinkToRoot) {
  log('junction', '已指向本目录，跳过');
} else {
  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink() && !stat.isDirectory()) {
      console.error(`node_modules/${PLUGIN_NAME} 已存在且不是链接/目录，先手工确认再删：${linkPath}`);
      process.exit(1);
    }
    // 已存在但指向别处（或是个真实副本）：删掉重建。真实副本里的内容不会丢，
    // 因为它就是本目录的一份拷贝，本目录才是源头。
    fs.rmSync(linkPath, { recursive: true, force: true });
    log('junction', '旧的链接/副本已移除');
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(ROOT, linkPath, 'junction');
  log('junction', `node_modules/${PLUGIN_NAME} → ${ROOT}`);
}

/* ── 2. profile package.json 的依赖 ── */
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = pkg.dependencies ?? {};
if (pkg.dependencies[PLUGIN_NAME] === `file:./${PLUGIN_NAME}`) {
  log('package.json', '依赖已存在，跳过');
} else {
  backup(pkgPath);
  pkg.dependencies[PLUGIN_NAME] = `file:./${PLUGIN_NAME}`;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log('package.json', `已加入 ${PLUGIN_NAME}: file:./${PLUGIN_NAME}`);
}

/* ── 3. cordis.patch.yml 的 insert 行 ── */
const patchPath = path.join(profileDir, 'cordis.patch.yml');
/** 每次改动都从磁盘重新读 —— 早先的写法用同一个内存副本连续写两次，后一次把前一次盖掉了。 */
const readPatch = () => (fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '');
const block = `
# 会话费用徽章：会话标题栏右侧工具区里一枚小徽章，显示本会话在 **DeepSeek 官方
# API / 账号模型**上花掉的钱（官方价目表，USD / 百万 token，区分峰时与谷时）。
#   • 金额来自宿主投影 \`sessionCost\`（lib/fold.js 按事件流折叠用量，view 里用当前
#     价目表算钱 —— 所以改价目表会立刻反映到已存在的会话上）。
#   • 只有官方路由（deepseek-official / deepseek-account）才计价；其它路由只计数，
#     徽章直接不显示 —— 这正是「只算官方」这条要求的落点。
#   • 压缩调用计入本会话；子代理是独立会话，单独计价。
#   • 颜色全部走主题 token（--dsw-alias-*），所以深浅色与主题插件都会跟着变。
#   • 自检：GET /api/dsh-session-cost/status
#     （报装载状态、当前价目表、折叠计数器，以及每个会话的 sessionCost 视图与内置
#       tokenUsage 视图，用于对账）
# 源码：${ROOT}
# 卸载：删掉这一段，并用同目录下的 *.bak-${ROW_ID}-* 还原 package.json 与
#       cordis.patch.yml（hmr 的 root 列表里也要去掉 ${PLUGIN_NAME}），
#       再删掉 node_modules\\${PLUGIN_NAME} 这个 junction。
- insert:
    - id: ${ROW_ID}
      name: '${PLUGIN_NAME}'
`;

const patched = readPatch();
if (new RegExp(`name:\\s*'${PLUGIN_NAME}'`).test(patched)) {
  log('cordis.patch.yml', '已存在本插件条目，跳过');
} else {
  backup(patchPath);
  fs.writeFileSync(patchPath, patched.replace(/\s*$/, '\n') + block, 'utf8');
  log('cordis.patch.yml', `已追加 ${ROW_ID} 段`);
}

/* ── 4. hmr 监听根（让宿主源码改动热重载）── */
const beforeHmr = readPatch();
if (/^- id: hmr\r?$/m.test(beforeHmr)) {
  // 这个 profile 的 patch 文件是 CRLF 的，所以匹配与替换都要认 \r?\n。
  const eol = beforeHmr.includes('\r\n') ? '\r\n' : '\n';
  const hmrBlock = [
    '- id: hmr',
    "  name: '@deepseek-ai/dsh-hmr'",
    '  config:',
    `    root: [ ${HMR_PLUGINS.map((item) => `'${item}'`).join(', ')} ]`,
  ].join(eol) + eol;
  const updated = beforeHmr.replace(/- id: hmr\r?\n(?:.*\r?\n)*?    root: \[[^\]]*\]\r?\n/, hmrBlock);
  if (updated === beforeHmr) {
    log('hmr', '没匹配到 hmr 的 root 行，保持原样（不影响功能，只是改源码不热重载）');
  } else if (beforeHmr.includes(hmrBlock)) {
    log('hmr', '已包含本插件，跳过');
  } else {
    backup(patchPath);
    fs.writeFileSync(patchPath, updated, 'utf8');
    log('hmr', `监听根更新为 ${HMR_PLUGINS.join(', ')}`);
  }
} else {
  log('hmr', 'profile 里没有 hmr 行，跳过');
}

log('done', 'profile 已接入；页面刷新后徽章生效（宿主插件由配置热重载装载）');
