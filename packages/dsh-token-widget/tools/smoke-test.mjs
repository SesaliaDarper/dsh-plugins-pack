/**
 * 冒烟测试：在 Node 里模拟 DSH 客户端模块加载器 + cordis ctx，
 * 把 lib/client.js 真正跑一遍，检查：
 *   1. 模块能被 __ModuleLoader__ 加载、apply 不抛错；
 *   2. 两个插槽都注册上了（shell.overlay / settings.general.item）；
 *   3. 主题覆盖层按所选角色写入 ctx.theme.overrideTokens；
 *   4. 会话投影（tokenUsage / contextPressure）能流进 store，且气泡算得出数字；
 *   5. 两个组件都能用假 props 渲染一遍（不碰真实 React 渲染器）。
 *
 * 用法：node tools/smoke-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const BUNDLE = path.join(ROOT, 'lib', 'client.js')

let failures = 0
function check(label, condition, extra = '') {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
}

/* ── 假 source：getSnapshot / subscribe，可手动推送 ── */
function makeSource(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    push(next) {
      value = next
      for (const fn of [...listeners]) fn()
    }
  }
}

/* ── 假 store：语义对齐 @deepseek-ai/dsh-client-store 的 defineStore ── */
const fakeStoreModule = {
  defineStore(decl) {
    return {
      spec: decl,
      create() {
        const state = decl.init()
        const listeners = new Set()
        const actions = {}
        for (const key of Object.keys(decl.actions)) {
          const mutate = decl.actions[key]
          actions[key] = (...params) => {
            const before = JSON.stringify(state)
            mutate(state, ...params)
            if (JSON.stringify(state) !== before) for (const fn of [...listeners]) fn()
          }
        }
        return {
          actions,
          getSnapshot: () => state,
          subscribe: (fn) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
          }
        }
      }
    }
  }
}

/* ── 极简 React shim ── */
//
// `useEffect` **不能**就地执行：真实 React 在提交之后才跑 effect，而就地执行会让
// effect 里的状态写入发生在渲染中途 —— 同一棵树里靠前的部分读到旧值、靠后的部分
// 读到新值，出现「气泡说读取失败、面板说读取中」这种自相矛盾的渲染。
// 所以这里排队，由测试显式 flush。
const pendingEffects = []
function flushEffects() {
  const queued = pendingEffects.splice(0)
  for (const fn of queued) {
    try {
      fn()
    } catch {
      /* 忽略 effect 里的异常，和之前的 shim 一致 */
    }
  }
}

/**
 * 记录插件里注册的定时器，让测试可以「手动拨表」。
 *
 * 气泡的自动翻页是由 apply 里的 `setInterval` 驱动的，不是 UI 直接改状态。
 * 用拨表来推进它，测到的才是**真实的轮播逻辑**（含「余额不可用就不翻」那条守卫），
 * 而不是绕过去直接改 store。
 */
const intervals = []
function tickIntervals() {
  for (const entry of intervals) {
    if (entry === null) continue
    try {
      entry.fn()
    } catch {
      /* 忽略 */
    }
  }
}
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (fn) => fn,
  useEffect: (fn) => {
    pendingEffects.push(fn)
  }
}

/* ── 假 ctx ── */
const themeCalls = []
const registrations = []
const effects = []
const dictionaries = {}
const balanceCalls = []
/** 假账号服务：默认返回一个真实的充值钱包（数值取自本机实测的账号响应）。 */
let balanceReply = {
  ok: true,
  value: {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '5.7753636800000000' }],
    bonusWallets: [{ currency: 'CNY', balance: '0' }]
  }
}
let exposeAccount = true

const sessionsList = makeSource({ ids: ['s1'], byId: {} })
const usageSource = makeSource(undefined)
const pressureSource = makeSource(undefined)
const selectionSource = makeSource({ sessionId: 's1' })

const sessions = {
  list: sessionsList,
  binding(id) {
    if (id !== 's1') return undefined
    return {
      session: {
        projections: {
          faceOf(key) {
            if (key === 'tokenUsage') return usageSource
            if (key === 'contextPressure') return pressureSource
            return undefined
          }
        }
      }
    }
  }
}

/** 按 cordis 的语义解析 `["remote", "remote.account"]` 这类依赖。 */
function resolveService(scope, dep) {
  let current = scope
  for (const segment of dep.split('.')) {
    if (current === null || current === undefined) return undefined
    current = current[segment]
  }
  return current
}

function makeCtx() {
  return {
    sessions,
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(deps, callback) {
      // 依赖不全就**不**调用回调 —— 真实 cordis 就是这样，也正是这一点
      // 让「账户服务缺席时挂件照常工作」成为可验证的行为。
      const scope = {
        ...this,
        remote: exposeAccount ? { account: { getBalance: async (meta) => {
          balanceCalls.push(meta)
          return balanceReply
        } } } : undefined
      }
      for (const dep of deps) {
        if (resolveService(scope, dep) === undefined) return
      }
      callback(scope)
    },
    get(name) {
      if (name === 'uiWorkspace') return { selection: selectionSource }
      if (name === 'sessions') return sessions
      return undefined
    },
    theme: {
      overrideTokens(id, tokens) {
        themeCalls.push({ id, tokens })
      }
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      }
    },
    locale: {
      getSnapshot() {
        return { active: 'zh' }
      },
      register(ns, dict) {
        dictionaries[ns] = dict
        return () => {}
      },
      bind(ns) {
        return (key, params) => {
          const entry = dictionaries[ns] || {}
          const table = entry.zh || entry
          let text = table[key] || key
          if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v))
          return text
        }
      }
    }
  }
}

const ctx = makeCtx()

/* ── 假浏览器环境 + 模块加载器 ── */
const styleTags = []
let loaded = null
// 「找回挂件」相关的接缝：rAF 排队 + 窗口事件监听 + querySelector 量的假盒子。
const frames = []
const windowListeners = new Map()
let fakeMeasuredNode = null
const sandbox = {
  console,
  requestAnimationFrame: (fn) => {
    frames.push(fn)
    return frames.length - 1
  },
  cancelAnimationFrame: (id) => {
    if (typeof id === 'number') frames[id] = null
  },
  setTimeout,
  // 余额的自动刷新与气泡轮播都靠 setInterval；记录下来供测试拨表。
  setInterval: (fn, ms) => {
    const id = intervals.length
    intervals.push({ fn, ms })
    return id
  },
  clearInterval: (id) => {
    if (typeof id === 'number') intervals[id] = null
  },
  Date,
  isFinite,
  Number,
  JSON,
  Object,
  Array,
  String,
  Math,
  localStorage: {
    store: new Map(),
    getItem(k) {
      return this.store.has(k) ? this.store.get(k) : null
    },
    setItem(k, v) {
      this.store.set(k, String(v))
    },
    removeItem(k) {
      this.store.delete(k)
    }
  },
  document: {
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: {
      appendChild: (tag) => styleTags.push(tag)
    },
    // 挂件自己不去查 DOM，只有「找回」时会量一下盒子；默认量不到（null），
    // 也就是「宿主没 DOM」的等价情形，一切自动找回都放行。
    querySelector: () => fakeMeasuredNode
  },
  addEventListener: (type, fn) => {
    const list = windowListeners.get(type) || []
    list.push(fn)
    windowListeners.set(type, list)
  },
  removeEventListener: (type, fn) => {
    const list = windowListeners.get(type) || []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
    windowListeners.set(type, list)
  }
}
sandbox.window = sandbox
sandbox.window.innerWidth = 1600
sandbox.window.innerHeight = 900

/** 造一个能给出指定视口矩形的假元素，喂给 `document.querySelector`。 */
function fakeBox(left, top, width, height) {
  return { getBoundingClientRect: () => ({ left, top, width, height }) }
}

function fireWindow(type, event = {}) {
  for (const fn of [...(windowListeners.get(type) || [])]) fn(event)
}

function flushFrames() {
  for (let i = 0; i < frames.length; i += 1) {
    const fn = frames[i]
    frames[i] = null
    if (typeof fn === 'function') fn()
  }
  frames.length = 0
}
sandbox.window.__ModuleLoader__ = {
  load(definition) {
    loaded = definition
  }
}
sandbox.require = (id) => {
  if (id === 'react') return fakeReact
  if (id === '@deepseek-ai/dsh-client-store') return fakeStoreModule
  throw new Error('unexpected require: ' + id)
}

console.log('── 加载 bundle ──')
const code = fs.readFileSync(BUNDLE, 'utf8')
const bundleText = code
vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' })
check('__ModuleLoader__.load 被调用', loaded !== null)
check('模块 id 正确', loaded && loaded.id === 'dsh-token-widget', loaded && loaded.id)

const mod = loaded.factory(sandbox.require)
check('导出 apply', typeof mod.apply === 'function')
check('导出 inject 列表', Array.isArray(mod.inject), mod.inject && mod.inject.join(','))
check('导出了角色表', Array.isArray(mod.CHARACTERS) && mod.CHARACTERS.length >= 1)
check('角色名里已没有笔误 ZLM', !mod.CHARACTERS.some((c) => c.id === 'zlm' || c.name === 'ZLM'))
check('GLM 角色存在', mod.CHARACTERS.some((c) => c.id === 'glm' && c.name === 'GLM'))
for (const character of mod.CHARACTERS) {
  check(
    `角色 ${character.id} 立绘已内联`,
    typeof character.art === 'string' && character.art.startsWith('data:image/webp;base64,')
  )
  check(`角色 ${character.id} 气泡框有效`, character.bubble && character.bubble.width > 0 && character.bubble.height > 0,
    JSON.stringify(character.bubble))
}

console.log('\n── 执行 apply(ctx) ──')
try {
  mod.apply(ctx)
  check('apply 未抛错', true)
} catch (error) {
  check('apply 未抛错', false, String(error && error.stack ? error.stack.split('\n')[0] : error))
}

check('安装了样式表', styleTags.length === 1)
check('注册了 shell.overlay', registrations.some((r) => r.options.name === 'shell.overlay'))
check('注册了 settings.general.item', registrations.some((r) => r.options.name === 'settings.general.item'))
check('写入了中英文字典', Boolean(dictionaries['settings.token-widget']))

const firstTheme = themeCalls[0]
check('主题覆盖层已应用', Boolean(firstTheme && firstTheme.id === 'dsh-token-widget'))
check(
  '覆盖的是字体/强调色 token',
  firstTheme && Object.keys(firstTheme.tokens).includes('--dsw-alias-label-primary'),
  firstTheme ? Object.keys(firstTheme.tokens).length + ' 个 token' : ''
)

console.log('\n── 会话用量流入 ──')
usageSource.push({ uncachedInputTokens: 4000, cacheReadTokens: 8000, cacheWriteTokens: 200, outputTokens: 480 })
pressureSource.push({ projectedTokens: 12680, contextWindow: 64000 })

const overlayReg = registrations.find((r) => r.options.name === 'shell.overlay')
const settingsReg = registrations.find((r) => r.options.name === 'settings.general.item')
const overlayProps = overlayReg.options.inject()
const settingsProps = settingsReg.options.inject()

const state = overlayProps.hooks.widget.getSnapshot()
check('store 收到 sessionId', state.sessionId === 's1', String(state.sessionId))
check('store 收到 tokenUsage', Boolean(state.usage) && state.usage.outputTokens === 480)
check('store 收到 contextPressure', Boolean(state.pressure) && state.pressure.contextWindow === 64000)

const t = ctx.locale.bind('settings.token-widget')
const widgetProps = { ...overlayProps, t, useWidget: (selector) => selector(overlayProps.hooks.widget.getSnapshot()) }

console.log('\n── 渲染组件（假 React）──')
let tree = null
try {
  tree = overlayReg.Component(widgetProps)
  check('TokenWidget 渲染未抛错', true)
} catch (error) {
  check('TokenWidget 渲染未抛错', false, String(error && error.message))
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  // 函数组件：直接调用它，展开渲染结果
  if (typeof node.type === 'function') {
    const props = { ...node.props }
    if (props.hooks) {
      for (const [key, source] of Object.entries(props.hooks)) {
        const hookName = 'use' + key.charAt(0).toUpperCase() + key.slice(1)
        props[hookName] = (selector) => (selector ? selector(source.getSnapshot()) : source.getSnapshot())
      }
    }
    collectText(node.type(props), out)
    return out
  }
  if (node.children) for (const child of node.children) collectText(child, out)
  return out
}
const texts = collectText(tree)

/**
 * 只取**气泡**子树里的文字。
 *
 * 断言「气泡里显示/不显示余额」时必须限定范围：面板一直开着的时候，
 * 「账户余额」「气泡显示」这些字也在整棵树里，用整棵树的文本去断言
 * 会得出完全错误的结论（这里踩过一次）。
 */
function findBubble(node) {
  let bubble = null
  const walk = (current) => {
    if (bubble !== null || current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (typeof current.type === 'function') {
      walk(current.type(current.props || {}))
      return
    }
    // 按**类名列表**精确匹配，不用 includes：`tw-bubble-page` 这种名字
    // 会包含 `tw-bubble` 子串，includes 会找错元素（踩过一次，类名已改，这里也收紧）。
    const classes = typeof current.props?.className === 'string' ? current.props.className.split(/\s+/) : []
    if (classes.includes('tw-bubble')) {
      bubble = current
      return
    }
    if (current.children) for (const child of current.children) walk(child)
    if (current.props?.children) walk(current.props.children)
  }
  walk(node)
  return bubble
}

function collectBubble(node) {
  const bubble = findBubble(node)
  return bubble === null ? [] : collectText(bubble)
}

check('气泡显示 token 总量', collectBubble(tree).some((s) => s === '12.7k'), collectBubble(tree).join(' | '))
check(
  '气泡显示上下文占用',
  collectBubble(tree).some((s) => s.includes('上下文') && s.includes('20%')),
  collectBubble(tree).join(' | ')
)

try {
  const rowTree = settingsReg.Component({
    ...settingsProps,
    t,
    useWidget: (selector) => selector(settingsProps.hooks.widget.getSnapshot())
  })
  const rowTexts = collectText(rowTree)
  check('设置行渲染未抛错', true)
  check('设置行列出全部角色', mod.CHARACTERS.every((c) => rowTexts.includes(c.name)), rowTexts.join(' | '))
} catch (error) {
  check('设置行渲染未抛错', false, String(error && error.message))
}

console.log('\n── 账户余额 ──')
// 余额是异步读的：等微任务落地后再取快照。
await new Promise((resolve) => setTimeout(resolve, 20))

check('调用了 account.getBalance', balanceCalls.length >= 1, balanceCalls.length + ' 次')
check(
  '上报了界面身份（version/locale/时区）',
  balanceCalls[0] &&
    typeof balanceCalls[0].version === 'string' &&
    balanceCalls[0].version.length > 0 &&
    typeof balanceCalls[0].locale === 'string' &&
    typeof balanceCalls[0].timezoneOffsetSeconds === 'number',
  JSON.stringify(balanceCalls[0])
)

// 点开面板应当立即再读一次（用户点开多半就是想看余额，不该等下一个十分钟）
const callsBeforeOpen = balanceCalls.length
overlayProps.togglePanel()
collectText(overlayReg.Component({ ...widgetProps, t }))
flushEffects()
await new Promise((resolve) => setTimeout(resolve, 20))
check('打开面板会立即刷新一次余额', balanceCalls.length > callsBeforeOpen, `${callsBeforeOpen} → ${balanceCalls.length}`)

const balanceState = overlayProps.hooks.widget.getSnapshot().balance
check('余额状态为 ready', balanceState && balanceState.status === 'ready', balanceState && balanceState.status)
check('解析出充值钱包', Boolean(balanceState && balanceState.wallets.length === 1), JSON.stringify(balanceState && balanceState.wallets))

// ── 气泡翻页：用量 / 余额 ──
const snapshot = () => overlayProps.hooks.widget.getSnapshot()
check('气泡默认是自动翻页', snapshot().bubblePage === 'auto', snapshot().bubblePage)

const autoBubble = collectBubble(overlayReg.Component(widgetProps))
check('自动模式起始页是用量', autoBubble.some((s) => s === '12.7k'), autoBubble.join(' | '))
check('气泡画出了两个页面的小圆点', findBubble(overlayReg.Component(widgetProps)).children.some((c) => c && c.props && c.props.className === 'tw-dots'))

// 点气泡 = 翻页并固定
const bubbleEl = findBubble(overlayReg.Component(widgetProps))
check('气泡是可点的', typeof bubbleEl.props.onClick === 'function' && bubbleEl.props.tabIndex === 0)
bubbleEl.props.onClick({ stopPropagation() {} })
check('点气泡翻到余额页并固定', snapshot().bubblePage === 'balance', snapshot().bubblePage)
const balanceBubble = collectBubble(overlayReg.Component(widgetProps))
check(
  '余额页大号显示余额，且正金额**截断**到分（5.7753… → ¥5.77）',
  balanceBubble.includes('¥5.77'),
  balanceBubble.join(' | ')
)
check('余额页没有把 5.7753 四舍五入成 5.78', !balanceBubble.some((s) => s.includes('¥5.78')))

bubbleEl.props.onClick({ stopPropagation() {} })
const backBubble = collectBubble(overlayReg.Component(widgetProps))
check('再点一次翻回用量页', backBubble.some((s) => s === '12.7k'), backBubble.join(' | '))
check('翻回用量页后也固定住', snapshot().bubblePage === 'tokens', snapshot().bubblePage)

// 自动轮播：拨一次表就翻到余额页
overlayProps.setBubblePage('auto')
tickIntervals()
await new Promise((resolve) => setTimeout(resolve, 20))
const rotated = collectBubble(overlayReg.Component(widgetProps))
check('自动模式拨表推进后显示余额', rotated.includes('¥5.77'), rotated.join(' | '))
tickIntervals()
await new Promise((resolve) => setTimeout(resolve, 20))
check('自动模式再拨一次回到用量', collectBubble(overlayReg.Component(widgetProps)).some((s) => s === '12.7k'))

// 面板 / 设置行里的三选一
overlayProps.setBubblePage('auto')
const pickerTexts = collectText(overlayReg.Component({ ...widgetProps, t }))
check('面板里有「气泡显示」三选一', pickerTexts.includes('气泡显示') && pickerTexts.includes('自动'), pickerTexts.filter((s) => s.includes('气泡') || s === '自动').join(' | '))
const rowTexts0 = collectText(settingsReg.Component({ ...settingsProps, t, useWidget: (selector) => selector(settingsProps.hooks.widget.getSnapshot()) }))
check('设置行里也有「气泡显示」', rowTexts0.includes('气泡显示'), '')
check('赠金为 0 时不显示赠金行', !collectText(overlayReg.Component({ ...widgetProps, t })).includes('赠金'))
check('面板列出充值余额', collectText(overlayReg.Component({ ...widgetProps, t })).includes('充值余额'), '')

balanceReply = {
  ok: true,
  value: {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.345' }],
    bonusWallets: [{ currency: 'CNY', balance: '3.5' }]
  }
}
await overlayProps.refreshBalance()
await new Promise((resolve) => setTimeout(resolve, 20))
overlayProps.setBubblePage('balance')
const withBonusPanel = collectText(overlayReg.Component({ ...widgetProps, t }))
const withBonusBubble = collectBubble(overlayReg.Component({ ...widgetProps, t }))
check(
  '赠金为正时显示赠金行',
  withBonusPanel.includes('赠金') && withBonusPanel.includes('¥3.50'),
  withBonusPanel.filter((s) => s.includes('¥')).join(' | ')
)
check('多币种/多钱包时气泡大号取充值余额', withBonusBubble.includes('¥12.34'), withBonusBubble.join(' | '))
check('赠金金额进了气泡小号', withBonusBubble.some((s) => s.includes('¥3.50')), withBonusBubble.join(' | '))

// 查询失败必须和「零余额」区分开
balanceReply = { ok: true, value: { status: 'failed' } }
await overlayProps.refreshBalance()
await new Promise((resolve) => setTimeout(resolve, 20))
const failedTexts = collectBubble(overlayReg.Component(widgetProps))
check('查询失败显示「余额读取失败」而不是 ¥0.00', failedTexts.some((s) => s.includes('余额读取失败')), failedTexts.join(' | '))
check('失败态没有伪造零余额', !failedTexts.some((s) => s.includes('¥0.00')))

// 未登录
balanceReply = { ok: true, value: null }
await overlayProps.refreshBalance()
await new Promise((resolve) => setTimeout(resolve, 20))
const signedOutTexts = collectBubble(overlayReg.Component(widgetProps))
check('未登录时余额页说明未登录', signedOutTexts.some((s) => s.includes('未登录')), signedOutTexts.join(' | '))
check('未登录时读取已落定（不是卡在读取中）', !signedOutTexts.some((s) => s.includes('读取中')), signedOutTexts.join(' | '))

// 余额不可用时，自动模式**不该**翻到余额页
overlayProps.setBubblePage('auto')
tickIntervals()
await new Promise((resolve) => setTimeout(resolve, 20))
const autoNoBalance = collectBubble(overlayReg.Component(widgetProps))
check(
  '余额不可用时自动模式停在用量页',
  autoNoBalance.some((s) => s === '12.7k'),
  autoNoBalance.join(' | ')
)
check('余额不可用时不画翻页圆点', findBubble(overlayReg.Component(widgetProps)).children.every((c) => !(c && c.props && c.props.className === 'tw-dots')))

overlayProps.setBubblePage('auto')

console.log('\n── 账户服务缺席时挂件照常 ──')
exposeAccount = false
const bareRegistrations = registrations.length
const bareCtx = makeCtx()
let bareThrew = null
try {
  mod.apply(bareCtx)
} catch (error) {
  bareThrew = error
}
check('没有 remote 服务时 apply 不抛错', bareThrew === null, bareThrew ? String(bareThrew.message) : '')
check(
  '没有 remote 服务时两个插槽照样注册',
  registrations.length - bareRegistrations === 2,
  `${registrations.length - bareRegistrations} 个`
)
exposeAccount = true

console.log('\n── 大小滑块不会自激（抽搐 bug 的回归守卫）──')
//
// 曾经的真实 bug：面板继承了 `.tw-root` 那个跟着 --tw-scale 走的 font-size，
// 而面板内边距/间距/标签全是 em、宽度却是固定的。拖动滑块 → 缩放变大 → 面板字号变大
// → em 内边距变大 → 滑块可用轨道变窄 → 浏览器按新轨道重新换算光标处的值 → 值再变……
// 正反馈自激，表现就是抽搐。
//
// 下面几条断言把这个约束钉死：面板字号必须是**绝对长度**（不能继承缩放），
// 滑块轨道宽度不得受旁边的文字影响。CSS 改动破坏其中任何一条，这里就会红。

/** 从打包产物里抠出某个 CSS 规则的内容。 */
function cssRule(selector) {
  const marker = `\n${selector} {`
  const index = bundleText.indexOf(marker)
  if (index === -1) return null
  const start = bundleText.indexOf('{', index)
  const end = bundleText.indexOf('}', start)
  return start === -1 || end === -1 ? null : bundleText.slice(start + 1, end)
}

const panelRule = cssRule('.tw-panel')
check('.tw-panel 规则存在', typeof panelRule === 'string', panelRule === null ? '找不到' : '')
check(
  '面板字号是绝对长度（不再继承 --tw-scale）',
  typeof panelRule === 'string' && /font-size:\s*\d+(\.\d+)?px\b/.test(panelRule),
  panelRule === null ? '' : (panelRule.match(/font-size:[^;]*/) || ['(缺 font-size)'])[0]
)
check(
  '面板字号不是 em / rem / inherit',
  typeof panelRule === 'string' && !/font-size:\s*[\d.]+(em|rem)\b/.test(panelRule) && !/font-size:\s*inherit/.test(panelRule)
)

const rangeRule = cssRule('.tw-scale-control input[type="range"]')
check('滑块是弹性项', typeof rangeRule === 'string' && /flex:\s*1 1 auto/.test(rangeRule), rangeRule === null ? '找不到规则' : '')
check('滑块允许收缩到 0（不会被旁边的文字挤窄）', typeof rangeRule === 'string' && /min-width:\s*0/.test(rangeRule))

const valueRule = cssRule('.tw-scale-value')
check('数值读数是固定宽度', typeof valueRule === 'string' && /(^|[;\s])width:\s*[\d.]+em/.test(valueRule), valueRule === null ? '找不到规则' : '')
check(
  '数值读数不靠 min-width 兜底',
  typeof valueRule === 'string' && !/min-width/.test(valueRule)
)
check('数值读数用等宽数字', typeof valueRule === 'string' && /tabular-nums/.test(valueRule))

// 第二条自激回路：拖动过位置的挂件是左锚定的，右边缘会随宽度平移，
// 面板必须相应改挂左边缘（并与 --tw-scale 无关）。
const freePanelRule = cssRule('.tw-root[data-tw-pos="free"] .tw-panel')
check('拖动过位置时面板改挂左边缘', typeof freePanelRule === 'string' && /left:\s*calc\(var\(--tw-panel-w\)/.test(freePanelRule), freePanelRule === null ? '找不到规则' : '')
check('该锚点不依赖 --tw-scale', typeof freePanelRule === 'string' && !/--tw-scale/.test(freePanelRule))
check('面板宽度也走 --tw-panel-w（单一来源）', typeof panelRule === 'string' && /width:\s*var\(--tw-panel-w\)/.test(panelRule))
check(
  '面板里没有任何 em 尺寸来自 .tw-root 的字号链',
  // 面板一旦钉住 font-size，它的所有 em 后代都相对这个固定值 —— 这条只是把意图写明。
  typeof panelRule === 'string' && /font-size/.test(panelRule)
)

check('setScale 量化到 0.1', (() => {
  overlayProps.setScale(0.7000000000000001)
  return overlayProps.hooks.widget.getSnapshot().scale === 0.7
})())
check('setScale 夹在 0.5..2', (() => {
  overlayProps.setScale(9)
  const high = overlayProps.hooks.widget.getSnapshot().scale === 2
  overlayProps.setScale(0.1)
  const low = overlayProps.hooks.widget.getSnapshot().scale === 0.5
  overlayProps.setScale(1)
  return high && low
})())
check('改缩放不会动到别的状态（面板几何因此不受影响）', (() => {
  const before = JSON.stringify({ ...overlayProps.hooks.widget.getSnapshot(), scale: 0 })
  overlayProps.setScale(1.6)
  const after = JSON.stringify({ ...overlayProps.hooks.widget.getSnapshot(), scale: 0 })
  overlayProps.setScale(1)
  return before === after
})())

// ── 拖动期间钉住面板 ──
//
// 面板浮在立绘头顶，而立绘高度随缩放变：不钉住的话拖动滑块会让面板一路往上滑，
// 滑块从光标底下跑掉 —— 那是这个 bug 的第二个表现。
const scaleInput = (() => {
  let found = null
  const walk = (node) => {
    if (found !== null || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node.type === 'function') return walk(node.type(node.props || {}))
    if (node.type === 'input' && node.props?.type === 'range') {
      found = node
      return
    }
    if (node.children) node.children.forEach(walk)
    if (node.props?.children) walk(node.props.children)
  }
  walk(overlayReg.Component({ ...widgetProps, t }))
  return found
})()

check('滑块挂上了指针处理', Boolean(scaleInput) && typeof scaleInput.props.onPointerDown === 'function' && typeof scaleInput.props.onPointerUp === 'function')

/** 造一个假事件：currentTarget.closest('.tw-root') 返回一个给定高度的假元素。 */
function fakePointerEvent(rootHeight) {
  const root = {
    getBoundingClientRect: () => ({ width: 264, height: rootHeight })
  }
  return { currentTarget: { closest: (selector) => (selector === '.tw-root' ? root : null) } }
}

check('按下滑块会钉住面板', (() => {
  scaleInput.props.onPointerDown(fakePointerEvent(256))
  return overlayProps.hooks.widget.getSnapshot().frozenRootHeight === 256
})())

const findPanel = (() => {
  let found = null
  const walk = (node) => {
    if (found !== null || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node.type === 'function') return walk(node.type(node.props || {}))
    const classes = typeof node.props?.className === 'string' ? node.props.className.split(/\s+/) : []
    if (classes.includes('tw-panel')) {
      found = node
      return
    }
    if (node.children) node.children.forEach(walk)
    if (node.props?.children) walk(node.props.children)
  }
  walk(overlayReg.Component({ ...widgetProps, t }))
  return found
})()

check(
  '钉住时面板用像素高度定位（不再依赖 100%）',
  Boolean(findPanel) && typeof findPanel.props.style?.bottom === 'string' && findPanel.props.style.bottom.includes('256px'),
  findPanel ? JSON.stringify(findPanel.props.style) : '找不到面板'
)
check('松手后恢复跟随立绘', (() => {
  scaleInput.props.onPointerUp()
  return overlayProps.hooks.widget.getSnapshot().frozenRootHeight === null
})())
check('取消 / 失焦也恢复', (() => {
  scaleInput.props.onPointerDown(fakePointerEvent(300))
  const frozen = overlayProps.hooks.widget.getSnapshot().frozenRootHeight === 300
  scaleInput.props.onPointerCancel()
  scaleInput.props.onBlur()
  return frozen && overlayProps.hooks.widget.getSnapshot().frozenRootHeight === null
})())
check('量不到高度时不乱钉（假 DOM 缺 closest）', (() => {
  scaleInput.props.onPointerDown({ currentTarget: {} })
  return overlayProps.hooks.widget.getSnapshot().frozenRootHeight === null
})())
check('未钉住时面板没有内联定位（回到 CSS 的 calc(100% - 1.2em)）', (() => {
  const panel = overlayReg.Component({ ...widgetProps, t })
  let found = null
  const walk = (node) => {
    if (found !== null || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node.type === 'function') return walk(node.type(node.props || {}))
    const classes = typeof node.props?.className === 'string' ? node.props.className.split(/\s+/) : []
    if (classes.includes('tw-panel')) {
      found = node
      return
    }
    if (node.children) node.children.forEach(walk)
    if (node.props?.children) walk(node.props.children)
  }
  walk(panel)
  return found !== null && found.props.style === undefined
})())

check('冻结高度不写进 localStorage', (() => {
  scaleInput.props.onPointerDown(fakePointerEvent(256))
  const saved = sandbox.localStorage.getItem('dsh-token-widget.v1') || ''
  scaleInput.props.onPointerUp()
  return !saved.includes('frozenRootHeight')
})())

console.log('\n── 找回挂件 ──')

/** 按类名列表找节点（同 findBubble / findPanel 的规矩，不用 includes）。 */
function findByClass(node, target) {
  let found = null
  const walk = (current) => {
    if (found !== null || current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) return current.forEach(walk)
    if (typeof current.type === 'function') return walk(current.type(current.props || {}))
    const classes = typeof current.props?.className === 'string' ? current.props.className.split(/\s+/) : []
    if (classes.includes(target)) {
      found = current
      return
    }
    if (current.children) current.children.forEach(walk)
    if (current.props?.children) walk(current.props.children)
  }
  walk(node)
  return found
}

const stage = findByClass(overlayReg.Component({ ...widgetProps, t }), 'tw-stage')
check('立绘上挂了拖动处理', Boolean(stage) && typeof stage.props.onPointerMove === 'function')

// 拖动时就得钳住：松手前挂件已经不可能被甩出窗口，用户不会「拖丢」。
const dragHost = {
  getBoundingClientRect: () => ({ left: 1000, top: 800, width: 264, height: 300 }),
  setPointerCapture() {},
  releasePointerCapture() {}
}
dragHost.closest = (selector) => (selector === '.tw-root' ? dragHost : null)
stage.props.onPointerDown({ button: 0, pointerId: 1, clientX: 100, clientY: 100, currentTarget: dragHost })
stage.props.onPointerMove({ clientX: 9000, clientY: 9000 })
check(
  '往右下角拖出窗口时被钳在窗口里（留 48px）',
  snapshot().pos.x === 1552 && snapshot().pos.y === 852,
  JSON.stringify(snapshot().pos)
)
stage.props.onPointerMove({ clientX: -9000, clientY: -9000 })
check(
  '往左上角拖出窗口时同样被钳住',
  snapshot().pos.x === -216 && snapshot().pos.y === -252,
  JSON.stringify(snapshot().pos)
)
stage.props.onPointerUp({ pointerId: 1, currentTarget: dragHost })
check('拖动后的坐标已持久化', Boolean(sandbox.localStorage.getItem('dsh-token-widget.v1')))

// 窗口变小 / 换朝向把挂件挤出可视区：自动找回，用户什么都不用做。
overlayProps.setVisible(false)
overlayProps.setPos({ x: 4000, y: 3000 })
frames.length = 0
collectText(overlayReg.Component({ ...widgetProps, t }))
flushEffects()
check('挂上了窗口尺寸监听', (windowListeners.get('resize') || []).length > 0)
fakeMeasuredNode = fakeBox(4000, 3000, 264, 300)
fireWindow('resize')
flushFrames()
const afterResize = snapshot()
check(
  '窗口尺寸变化后自动回到右下角',
  afterResize.pos === null && afterResize.visible === true,
  JSON.stringify({ pos: afterResize.pos, visible: afterResize.visible })
)

// 还在屏幕里就绝不动用户摆好的位置（自动找回必须克制）。
overlayProps.setPos({ x: 400, y: 300 })
fakeMeasuredNode = fakeBox(400, 300, 264, 300)
frames.length = 0
fireWindow('resize')
flushFrames()
check('挂件还在可视区时不会被复位', snapshot().pos.x === 400, JSON.stringify(snapshot().pos))

// 量不准就别动手：宿主没 DOM（querySelector 拿不到）和盒子 0×0（立绘还没解码）
// 都当作「不知道」，宁可不动也不能把用户故意摆在角落里的位置清掉。
fakeMeasuredNode = null
frames.length = 0
fireWindow('resize')
flushFrames()
check('量不到盒子时不乱复位', snapshot().pos.x === 400, JSON.stringify(snapshot().pos))

fakeMeasuredNode = fakeBox(4000, 3000, 0, 0)
frames.length = 0
fireWindow('resize')
flushFrames()
check('盒子是 0×0 时不判为丢失', snapshot().pos.x === 400, JSON.stringify(snapshot().pos))

// 设置 → 通用里的救命按钮：挂件被路由卸载时，这是唯一还进得来的入口。
fakeMeasuredNode = null
const rowTree = settingsReg.Component({
  ...settingsProps,
  t,
  useWidget: (selector) => selector(settingsProps.hooks.widget.getSnapshot())
})
const rowRescue = findByClass(rowTree, 'tw-reset')
check('设置行有「找回挂件」按钮', Boolean(rowRescue) && collectText(rowRescue).includes('找回挂件'),
  rowRescue ? collectText(rowRescue).join('') : '找不到按钮')
overlayProps.setVisible(false)
overlayProps.setPos({ x: 4000, y: 3000 })
rowRescue.props.onClick()
check(
  '点设置行的「找回挂件」把挂件叫回来',
  snapshot().pos === null && snapshot().visible === true,
  JSON.stringify({ pos: snapshot().pos, visible: snapshot().visible })
)
check('设置行给了快捷键提示', collectText(rowTree).some((s) => s.includes('Ctrl+Alt+H')))

// 全局快捷键：Ctrl+Alt+H。
overlayProps.setVisible(false)
overlayProps.setPos({ x: 4000, y: 3000 })
let prevented = 0
fireWindow('keydown', {
  key: 'h',
  ctrlKey: true,
  altKey: true,
  repeat: false,
  preventDefault: () => {
    prevented += 1
  }
})
check(
  'Ctrl+Alt+H 把挂件叫回来',
  snapshot().pos === null && snapshot().visible === true,
  JSON.stringify({ pos: snapshot().pos, visible: snapshot().visible })
)
check(
  // 假 React 不跑 effect 的清理函数，所以每渲染一次就多挂一个监听；
  // 这里断言的是「每个挂上的监听都拦了默认行为」，真实环境里只会有一个。
  '快捷键拦下了浏览器默认行为',
  prevented > 0 && prevented === (windowListeners.get('keydown') || []).length,
  `${prevented} / ${(windowListeners.get('keydown') || []).length}`
)

overlayProps.setPos({ x: 12, y: 24 })
fireWindow('keydown', { key: 'h', ctrlKey: true, altKey: false, repeat: false, preventDefault() {} })
fireWindow('keydown', { key: 'h', ctrlKey: true, altKey: true, repeat: true, preventDefault() {} })
fireWindow('keydown', { key: 'j', ctrlKey: true, altKey: true, repeat: false, preventDefault() {} })
fireWindow('keydown', { key: 'h', ctrlKey: false, altKey: true, repeat: false, preventDefault() {} })
check('只有真正的 Ctrl+Alt+H 才触发', snapshot().pos.x === 12, JSON.stringify(snapshot().pos))

fireWindow('keydown', { key: 'h', ctrlKey: true, altKey: true, repeat: false, preventDefault() {} })
fireWindow('keydown', { key: 'h', ctrlKey: true, altKey: true, repeat: false, preventDefault() {} })
check(
  '已经在右下角时再按是幂等的',
  snapshot().pos === null && snapshot().visible === true,
  JSON.stringify({ pos: snapshot().pos, visible: snapshot().visible })
)
fakeMeasuredNode = null
frames.length = 0

console.log('\n── 切换立绘 ──')
const charCount = themeCalls.length
overlayProps.choose('gemini')
const afterSwitch = overlayProps.hooks.widget.getSnapshot()
check('立绘已切换', afterSwitch.characterId === 'gemini', afterSwitch.characterId)
check('主题覆盖层跟着换', themeCalls.length > charCount, themeCalls.length + ' 次调用')
const latest = themeCalls[themeCalls.length - 1]
check('新主题 token 是蓝紫', latest && latest.tokens['--dsw-alias-label-primary'].light === '#221E45',
  latest ? JSON.stringify(latest.tokens['--dsw-alias-label-primary']) : '')

overlayProps.setFollow(false)
check('关闭跟随后覆盖层清空', Object.keys(themeCalls[themeCalls.length - 1].tokens).length === 0)

overlayProps.setPos({ x: 120, y: 240 })
check('位置已保存', overlayProps.hooks.widget.getSnapshot().pos.x === 120)
check('位置已持久化', Boolean(sandbox.localStorage.getItem('dsh-token-widget.v1')))

console.log('\n── ZLM → GLM 存档迁移 ──')
// 旧版本把角色名写成了 zlm，用户存档里就是那个值；读到旧值必须迁移，
// 否则他的选择会悄悄掉回第一个角色。
sandbox.localStorage.setItem(
  'dsh-token-widget.v1',
  JSON.stringify({ characterId: 'zlm', follow: true, visible: true, scale: 1 })
)
const migrationCtx = makeCtx()
mod.apply(migrationCtx)
const migrated = registrations[registrations.length - 1].options.inject()
check(
  '旧存档里的 zlm 迁移成 glm',
  migrated.hooks.widget.getSnapshot().characterId === 'glm',
  migrated.hooks.widget.getSnapshot().characterId
)
sandbox.localStorage.store.clear()

console.log(`\n${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`)
process.exit(failures === 0 ? 0 : 1)
