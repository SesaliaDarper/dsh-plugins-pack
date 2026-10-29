#!/usr/bin/env bash
# 把 dsh-plugins-pack 里的插件装进指定的 DSH profile（macOS / Linux）。
# 用法：bash scripts/install.sh [包名 ...]
#       DSH_HOME=/path DSH_PROFILE=desktop bash scripts/install.sh
set -euo pipefail

ALL_PACKAGES=(dsh-token-widget dsh-session-cost dsh-task-notify dsh-theme-gemini-cat)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!!! %s\033[0m\n' "$*"; }

[ -f "$MANIFEST" ] || { echo "找不到 profile：$PROFILE_DIR（先启动一次 DSH Desktop 让它初始化，然后退出 DSH 再装）" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${ALL_PACKAGES[@]}")
fi

for name in "${TARGETS[@]}"; do
  case " ${ALL_PACKAGES[*]} " in
    *" $name "*) ;;
    *) echo "未知包名：$name（可选：${ALL_PACKAGES[*]}）" >&2; exit 1 ;;
  esac
  [ -f "$REPO_ROOT/packages/$name/package.json" ] || { echo "仓库里没有 packages/$name" >&2; exit 1; }
done

STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$MANIFEST" "$MANIFEST.bak-plugins-$STAMP"
step "已备份 manifest → package.json.bak-plugins-$STAMP"

for name in "${TARGETS[@]}"; do
  dst="$PROFILE_DIR/$name"
  if [ -e "$dst" ]; then
    mv "$dst" "$dst.bak-$STAMP"
    warn "$name 已存在，旧目录改名为 $(basename "$dst").bak-$STAMP"
  fi
  cp -R "$REPO_ROOT/packages/$name" "$dst"
  step "已拷入 $name"
done

# 找 node：PATH → DSH 自带运行时
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
manifest.dependencies = manifest.dependencies || {};
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || [];
for (const name of targets) {
  manifest.dependencies[name] = `file:./${name}`;
  if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('bundles = ' + manifest.dsh.profile.bundles.join(' → '));
NODE_EDIT

step "已更新 package.json：${TARGETS[*]}"

# pnpm：PATH → DSH 自带运行时
PNPM_CMD=()
if command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD=(pnpm)
else
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

step "pnpm install"
(cd "$PROFILE_DIR" && "${PNPM_CMD[@]}" install --reporter=append-only)

step "装好了，启动 DSH Desktop 即可。回滚：把 package.json.bak-plugins-$STAMP 覆盖回去并删掉插件目录"
