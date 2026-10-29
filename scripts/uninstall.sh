#!/usr/bin/env bash
# 从 DSH profile 里卸掉 dsh-plugins-pack 的插件（macOS / Linux）。
# 用法：bash scripts/uninstall.sh [包名 ...]
set -euo pipefail

ALL_PACKAGES=(dsh-image-gen dsh-token-widget dsh-session-cost dsh-task-notify dsh-theme-gemini-cat)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!!! %s\033[0m\n' "$*"; }

[ -f "$MANIFEST" ] || { echo "找不到 profile：$PROFILE_DIR" >&2; exit 1; }

if [ "$#" -gt 0 ]; then TARGETS=("$@"); else TARGETS=("${ALL_PACKAGES[@]}"); fi
for name in "${TARGETS[@]}"; do
  case " ${ALL_PACKAGES[*]} " in
    *" $name "*) ;;
    *) echo "未知包名：$name（可选：${ALL_PACKAGES[*]}）" >&2; exit 1 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$MANIFEST" "$MANIFEST.bak-uninstall-$STAMP"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for rt in "$DSH_HOME"/dsh-runtimes/*/; do
    for cand in "$rt/dependencies/node/bin/node" "$rt/dependencies/node/bin/node.exe"; do
      [ -x "$cand" ] && { echo "$cand"; return 0; }
    done
  done
  return 1
}
NODE="$(find_node)" || { echo "找不到 node，无法改 manifest" >&2; exit 1; }

"$NODE" - "$MANIFEST" "${TARGETS[@]}" <<'NODE_EDIT'
const fs = require('fs');
const [manifestPath, ...targets] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.dependencies) for (const name of targets) delete manifest.dependencies[name];
if (manifest.dsh?.profile?.bundles) {
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => !targets.includes(n));
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
NODE_EDIT
step "已从 manifest 摘除：${TARGETS[*]}"

for name in "${TARGETS[@]}"; do
  [ -e "$PROFILE_DIR/$name" ] && { rm -rf "$PROFILE_DIR/$name"; step "已删除目录 $name"; }
done

PNPM_CMD=()
if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=(pnpm); else
  for root in "$DSH_HOME" "$HOME/.dsh"; do
    [ -d "$root/dsh-runtimes" ] || continue
    for rt in "$root"/dsh-runtimes/*/; do
      mjs="$rt/dependencies/pnpm/bin/pnpm.mjs"
      if [ -f "$mjs" ]; then PNPM_CMD=("$NODE" "$mjs"); break 2; fi
    done
  done
fi
if [ "${#PNPM_CMD[@]}" -eq 0 ]; then
  warn "找不到 pnpm。请手动执行：cd \"$PROFILE_DIR\" && pnpm install"
  exit 2
fi

(cd "$PROFILE_DIR" && "${PNPM_CMD[@]}" install --reporter=append-only)
step "卸干净了，重启 DSH Desktop 生效"
