/**
 * dsh-session-cost — 构建：`src/client.template.js` + `assets/art.json` → `lib/client.js`。
 *
 * DSH 的客户端插件只加载一个文件（`dsh.client` 指向 `./client`），而图片必须内联
 * （插件拿不到自己的静态资源路由），所以素材以 data URL 的形式注入模板里的
 * `__ART_JSON__` 占位符。构建完立刻做一次语法检查 —— 语法错会让整格 UI 空掉，
 * 宁可在这一步就拦住。
 *
 * 用法：node tools/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TEMPLATE = path.join(ROOT, 'src', 'client.template.js');
const ART_JSON = path.join(ROOT, 'assets', 'art.json');
const OUT = path.join(ROOT, 'lib', 'client.js');
const PLACEHOLDER = '__ART_JSON__';

function readArt() {
  if (!fs.existsSync(ART_JSON)) return { mascot: '' };
  const payload = JSON.parse(fs.readFileSync(ART_JSON, 'utf8'));
  const art = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('_')) continue;
    if (typeof value === 'string' && value.length > 0) art[key] = value;
  }
  return art;
}

const template = fs.readFileSync(TEMPLATE, 'utf8');
if (!template.includes(PLACEHOLDER)) {
  console.error(`模板里找不到占位符 ${PLACEHOLDER}，构建中止（防止把空素材静默产物发出去）`);
  process.exit(1);
}
const art = readArt();
const bundle = template.split(PLACEHOLDER).join(JSON.stringify(art));

// 语法检查：包在一个函数里编译，不执行（模板里有 window.__ModuleLoader__ 这类宿主对象）。
try {
  new vm.Script(bundle, { filename: 'lib/client.js' });
} catch (error) {
  console.error('构建产物语法错误：' + error.message);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bundle, 'utf8');

const keys = Object.keys(art);
console.log(
  `构建完成：lib/client.js ${(bundle.length / 1024).toFixed(1)} KB` +
    (keys.length > 0 ? `（内联素材：${keys.join(', ')}）` : '（无内联素材）'),
);
