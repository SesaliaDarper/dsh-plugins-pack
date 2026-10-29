/**
 * 把 src/client.template.js + assets/art.json 组装成 DSH 真正加载的 lib/client.js。
 *
 * 用法：node tools/build.mjs
 * 产出：lib/client.js（自带立绘 data URL 的单文件客户端 bundle，无需打包器）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const TEMPLATE = path.join(ROOT, 'src', 'client.template.js')
const ART = path.join(ROOT, 'assets', 'art.json')
const OUT = path.join(ROOT, 'lib', 'client.js')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const art = readJson(ART)
const template = fs.readFileSync(TEMPLATE, 'utf8')

const PLACEHOLDER = '__ART_DATA__'
const hits = template.split(PLACEHOLDER).length - 1
if (hits !== 1) {
  console.error(`模板里 ${PLACEHOLDER} 应恰好出现 1 次，实际 ${hits} 次，构建中止`)
  process.exit(1)
}

const code = template.replace(PLACEHOLDER, JSON.stringify(art))

// 先编译一遍：语法错误在构建期就暴露，别等到 DSH 加载时才炸
try {
  new vm.Script(code, { filename: 'lib/client.js' })
} catch (error) {
  console.error('lib/client.js 语法检查失败：')
  console.error(error)
  process.exit(1)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, code, 'utf8')

const used = Object.keys(art)
  .map((id) => `${id}(${Math.round(art[id].url.length / 1024)}KB)`)
  .join(' ')
console.log(`[build] 写出 ${path.relative(ROOT, OUT)}  ${Math.round(code.length / 1024)}KB  立绘: ${used}`)
