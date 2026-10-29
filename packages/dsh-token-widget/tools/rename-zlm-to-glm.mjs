/**
 * 一次性迁移：把桌宠角色名里的笔误 ZLM 改成 GLM。
 *
 * 改四处：
 *   1. assets/art.json 里的键 `zlm` → `glm`（这个文件是几 MB 的单行 JSON，手改不现实）；
 *   2. assets/art/zlm.webp → glm.webp；
 *   3. preview/zlm-{dark,light}.png → glm-*.png；
 *   4. 源素材目录 D:\...\AI\dsh主题\ZLM\ → GLM\，里面的 ZLM-1.png / ZLM.png → GLM-*。
 *
 * 幂等：已经是 glm 的项跳过。
 *
 * 用法：node tools/rename-zlm-to-glm.mjs
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_THEME_DIR = "D:\\SAVE\\WORK\\AI-work\\AI\\dsh主题";

let changes = 0;
const log = (message) => {
  changes += 1;
  console.log(`  · ${message}`);
};

/* ── 1. assets/art.json 的键 ── */
const artJsonPath = join(root, "assets", "art.json");
const art = JSON.parse(readFileSync(artJsonPath, "utf8"));
if (Object.hasOwn(art, "zlm")) {
  // 保持键的顺序：重建对象，把 zlm 换成 glm 在原来的位置。
  const next = {};
  for (const [key, value] of Object.entries(art)) next[key === "zlm" ? "glm" : key] = value;
  writeFileSync(artJsonPath, JSON.stringify(next), "utf8");
  log("assets/art.json：键 zlm → glm");
} else {
  console.log("  · assets/art.json：已经是 glm，跳过");
}

/* ── 2/3. 资源文件改名 ── */
for (const [from, to] of [
  [join(root, "assets", "art", "zlm.webp"), join(root, "assets", "art", "glm.webp")],
  [join(root, "preview", "zlm-dark.png"), join(root, "preview", "glm-dark.png")],
  [join(root, "preview", "zlm-light.png"), join(root, "preview", "glm-light.png")],
]) {
  if (existsSync(from)) {
    renameSync(from, to);
    log(`${from.slice(root.length + 1)} → ${to.slice(root.length + 1)}`);
  } else {
    console.log(`  · ${from.slice(root.length + 1)}：不存在，跳过`);
  }
}

/* ── 4. 源素材目录 ── */
const sourceDir = join(SOURCE_THEME_DIR, "ZLM");
const targetDir = join(SOURCE_THEME_DIR, "GLM");
if (existsSync(sourceDir) && !existsSync(targetDir)) {
  renameSync(sourceDir, targetDir);
  log(`${sourceDir} → ${targetDir}`);
  for (const [from, to] of [["ZLM-1.png", "GLM-1.png"], ["ZLM.png", "GLM.png"]]) {
    if (existsSync(join(targetDir, from))) {
      renameSync(join(targetDir, from), join(targetDir, to));
      log(`  ${from} → ${to}`);
    }
  }
} else if (existsSync(targetDir)) {
  console.log(`  · ${targetDir}：已存在，跳过源素材改名`);
} else {
  console.log(`  · ${sourceDir}：不存在，跳过`);
}

console.log(`\n共 ${changes} 处改动。`);
