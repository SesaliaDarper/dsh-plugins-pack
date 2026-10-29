/**
 * 把 dsh-token-widget 接进 DSH 的 desktop profile：
 *   1. 备份 package.json / cordis.patch.yml（带时间戳）；
 *   2. package.json 的 dependencies 里加上本插件（file: 指向 profile 下的 junction）；
 *   3. cordis.patch.yml 末尾追加一条 insert（已存在则跳过）。
 *
 * 用法：node tools/install-profile.mjs <profileDir>
 * 幂等：重复运行只会刷新，不会重复写条目。
 */
import fs from 'node:fs'
import path from 'node:path'

const PLUGIN_NAME = 'dsh-token-widget'
const MARK = `name: '${PLUGIN_NAME}'`

const profileDir = process.argv[2]
if (!profileDir || !fs.existsSync(profileDir)) {
  console.error('用法: node tools/install-profile.mjs <profileDir>')
  process.exit(1)
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14)

function backup(file) {
  if (!fs.existsSync(file)) return
  const target = `${file}.bak-token-widget-${stamp}`
  fs.copyFileSync(file, target)
  console.log(`[备份] ${path.basename(target)}`)
}

/* ── package.json ── */
const pkgPath = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
if (pkg.dependencies[PLUGIN_NAME] === `file:./${PLUGIN_NAME}`) {
  console.log('[package.json] 依赖已存在，跳过')
} else {
  backup(pkgPath)
  pkg.dependencies[PLUGIN_NAME] = `file:./${PLUGIN_NAME}`
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log(`[package.json] 已加入 ${PLUGIN_NAME}: file:./${PLUGIN_NAME}`)
}

/* ── cordis.patch.yml ── */
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const block = `
# DSH 会话挂件：窗口右下角的角色立绘 + 气泡显示本会话 token 用量与上下文占用。
# 立绘可点开面板切换，界面字体 / 强调色随所选角色的主题走。
# 源码与素材：D:\\SAVE\\WORK\\AI-work\\AI\\Token\\Work\\dsh-token-widget
# 卸载：删掉这一段，并用同目录下的 *.bak-token-widget-* 还原即可。
- insert:
    - id: token-widget
      name: '${PLUGIN_NAME}'
`
const current = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
if (current.includes(MARK)) {
  console.log('[cordis.patch.yml] 已存在本插件条目，跳过')
} else {
  backup(patchPath)
  const next = current.replace(/\s*$/, '\n') + block
  fs.writeFileSync(patchPath, next, 'utf8')
  console.log('[cordis.patch.yml] 已追加 token-widget 段')
}

console.log('[done] profile 已接入')
