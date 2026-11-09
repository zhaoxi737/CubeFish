/**
 * 渲染层真机自检（CDP）：接上一个开着 --remote-debugging-port 的启动器，
 * 用真实鼠标/键盘事件验证「发消息 → 回复 → 还能继续输入 → 停止 → 插件删除」这些交互。
 *
 *   node scripts/mock-llm.mjs
 *   QDOQMC_LLM_BASE_URL=http://127.0.0.1:18080/v1 QDOQMC_LLM_KEY=test npx electron . --remote-debugging-port=9333
 *   node scripts/cdp-check.mjs 9333
 */
const PORT = Number(process.argv[2] || 9333)
const TEST_PLUGIN = '__TEST_PLUGIN__'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error(`连不上 CDP 端口 ${PORT}`)
}

function cdp(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('ws error')))
  })
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return result.result.value
  }
  return { ready, call, evaluate, close: () => ws.close() }
}

const rectOf = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
})()`

const setInput = (text) => `(() => {
  const input = document.querySelector('.composer input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(text)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input.value
})()`

const waitIdle = (minBubbles) => `new Promise((resolve) => {
  const started = Date.now()
  const timer = setInterval(() => {
    const bubbles = [...document.querySelectorAll('.chat-list .bubble')]
    const busy = Boolean(document.querySelector('.composer-stop'))
    const streaming = Boolean(document.querySelector('.bubble-streaming'))
    if (!busy && !streaming && bubbles.length >= ${minBubbles}) {
      clearInterval(timer)
      const last = bubbles[bubbles.length - 1]
      resolve({
        ok: true,
        ms: Date.now() - started,
        count: bubbles.length,
        lastRole: last.className,
        last: last.textContent.replace(/\\s+/g, ' ').slice(0, 150),
      })
    } else if (Date.now() - started > 60000) {
      clearInterval(timer)
      resolve({ ok: false, timeout: true, busy, streaming, count: bubbles.length })
    }
  }, 200)
})`

async function clickAt(page, point) {
  const { x, y } = point
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(120)
}

const main = async () => {
  const page = cdp(await connect())
  await page.ready
  const out = {}

  // 等渲染层挂载完成（内核 boot + React 首屏）
  for (let i = 0; i < 100; i += 1) {
    if (await page.evaluate(`Boolean(document.querySelector('.composer input'))`)) break
    await sleep(200)
  }

  // S2 起 AI 面板默认收成右侧抽屉：先点开入口，后续的输入/气泡/停止断言才可见
  await page.evaluate(`(() => {
    const pill = document.querySelector('.cf-ai-pill')
    if (pill) { pill.click(); return 'opened' }
    return 'already-open'
  })()`)
  await sleep(600)

  // 响应性模式：模型端完全不回数据时，界面是不是还活着（这是「卡住」投诉的核心）
  if (process.argv[3] === 'hang') {
    const pings = []
    await page.evaluate(setInput('卡住测试'))
    await page.evaluate(`document.querySelector('.composer').requestSubmit()`)
    for (let i = 0; i < 8; i += 1) {
      const t0 = Date.now()
      await page.evaluate('1 + 1')
      pings.push({ at: i, ms: Date.now() - t0 })
      if (i === 2) {
        out.busyAt3s = await page.evaluate(`(() => ({
          stopVisible: Boolean(document.querySelector('.composer-stop')),
          hint: document.querySelector('.composer-hint')?.textContent?.replace(/\\s+/g, ' ') ?? null,
          placeholder: document.querySelector('.composer input').placeholder,
        }))()`)
      }
      await sleep(1000)
    }
    out.pings = pings
    const stopRect = await page.evaluate(`(() => {
      const el = document.querySelector('.composer-stop')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (stopRect) await clickAt(page, stopRect)
    await sleep(700)
    out.afterStop = await page.evaluate(`(() => ({
      stillBusy: Boolean(document.querySelector('.composer-stop')),
      placeholder: document.querySelector('.composer input').placeholder,
      last: [...document.querySelectorAll('.chat-list .bubble')].pop()?.textContent.replace(/\\s+/g, ' ').slice(0, 100) ?? null,
      focused: document.activeElement === document.querySelector('.composer input'),
    }))()`)
    console.log(JSON.stringify(out, null, 2))
    page.close()
    return
  }

  // 布局模式：工具调用轨迹会不会横向溢出、收起按钮会不会压住标题
  if (process.argv[3] === 'layout') {
    await page.evaluate(setInput('你好'))
    await page.evaluate(`document.querySelector('.composer').requestSubmit()`)
    await page.evaluate(waitIdle(2))
    out.layout = await page.evaluate(`(() => {
      const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null
      const title = rect('.chat-title')
      const collapse = rect('.chat-side-collapse')
      const overlap =
        title && collapse
          ? !(collapse.right <= title.left || collapse.left >= title.right || collapse.bottom <= title.top || collapse.top >= title.bottom)
          : null
      const items = [...document.querySelectorAll('.trace-item')]
      const summary = [...document.querySelectorAll('.trace-summary')]
      return {
        overlap,
        titleLeft: title ? Math.round(title.left) : null,
        collapseRight: collapse ? Math.round(collapse.right) : null,
        traceCount: items.length,
        traceOverflowX: items.map((el) => el.scrollWidth - el.clientWidth),
        summaryOverflowX: summary.map((el) => el.scrollWidth - el.clientWidth),
        chatOverflowX: (() => {
          const chat = document.querySelector('.chat')
          return chat ? chat.scrollWidth - chat.clientWidth : null
        })(),
        headOverflowX: (() => {
          const head = document.querySelector('.chat-head')
          return head ? head.scrollWidth - head.clientWidth : null
        })(),
        sample: summary[0]?.textContent?.length ?? 0,
      }
    })()`)
    console.log(JSON.stringify(out, null, 2))
    page.close()
    return
  }

  if (process.argv[3] === 'watchdog') {
    await page.evaluate(setInput('卡住测试'))
    await page.evaluate(`document.querySelector('.composer').requestSubmit()`)
    await sleep(20000)
    out.at20s = await page.evaluate(`(() => ({
      busy: Boolean(document.querySelector('.composer-stop')),
      hint: document.querySelector('.composer-hint')?.textContent?.replace(/\\s+/g, ' ') ?? null,
    }))()`)
    out.final = await page.evaluate(waitIdle(2))
    out.lastBubble = await page.evaluate(`[...document.querySelectorAll('.chat-list .bubble')].pop()?.textContent.replace(/\\s+/g, ' ') ?? null`)
    console.log(JSON.stringify(out, null, 2))
    page.close()
    return
  }

  const composer = await page.evaluate(rectOf('.composer input'))
  out.viewport = await page.evaluate(`({ vw: innerWidth, vh: innerHeight, composer: ${JSON.stringify(composer)} })`)

  // 1. 第一条消息（模拟粘贴后回车发送）
  await page.evaluate(setInput('你好'))
  await page.evaluate(`document.querySelector('.composer').requestSubmit()`)
  out.reply1 = await page.evaluate(waitIdle(2))

  // 2. 回复结束后：真实鼠标点输入框 → 应该聚焦；再真实打字 → 应该进入输入框
  await clickAt(page, await page.evaluate(rectOf('.composer input')))
  out.focusAfterReply = await page.evaluate(`(() => {
    const input = document.querySelector('.composer input')
    const r = input.getBoundingClientRect()
    return {
      focused: document.activeElement === input,
      activeTag: document.activeElement?.tagName ?? null,
      stack: document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).slice(0, 3).map((el) => el.className || el.tagName),
    }
  })()`)
  await page.call('Input.insertText', { text: '第二次' })
  out.typingAfterReply = await page.evaluate(`document.querySelector('.composer input').value`)

  // 3. 回车发送（真实按键）
  for (const type of ['keyDown', 'char', 'keyUp']) {
    await page.call('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: type === 'char' ? '\r' : undefined,
    })
  }
  out.reply2 = await page.evaluate(waitIdle(4))

  // 4. 停止按钮：mock 挂起流，确认「停止」出现且点了之后界面立刻可继续用
  await page.evaluate(setInput('卡住测试'))
  await page.evaluate(`document.querySelector('.composer').requestSubmit()`)
  await sleep(1500)
  out.busyWhileHung = await page.evaluate(`(() => {
    const stop = document.querySelector('.composer-stop')
    const hint = document.querySelector('.composer-hint')
    return {
      stopVisible: Boolean(stop),
      hint: hint?.textContent?.replace(/\\s+/g, ' ') ?? null,
      placeholder: document.querySelector('.composer input').placeholder,
      stopRect: stop ? stop.getBoundingClientRect().toJSON() : null,
    }
  })()`)
  if (out.busyWhileHung.stopRect) {
    await clickAt(page, { x: out.busyWhileHung.stopRect.x + out.busyWhileHung.stopRect.width / 2, y: out.busyWhileHung.stopRect.y + out.busyWhileHung.stopRect.height / 2 })
  }
  await sleep(700)
  out.afterStop = await page.evaluate(`(() => {
    const input = document.querySelector('.composer input')
    return {
      stillBusy: Boolean(document.querySelector('.composer-stop')),
      hint: document.querySelector('.composer-hint')?.textContent?.replace(/\\s+/g, ' ') ?? null,
      placeholder: input.placeholder,
      last: [...document.querySelectorAll('.chat-list .bubble')].pop()?.textContent.replace(/\\s+/g, ' ').slice(0, 80) ?? null,
    }
  })()`)

  // 5. 停止后还能正常发新消息
  await page.evaluate(setInput('第三次'))
  await page.evaluate(`document.querySelector('.composer').requestSubmit()`)
  out.reply3 = await page.evaluate(waitIdle(6))

  // 6. 插件面板：删除按钮存在 + 真的删掉测试插件
  await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent.trim() === '插件')
    btn?.click()
    return Boolean(btn)
  })()`)
  await sleep(900)
  out.pluginRows = await page.evaluate(`(() => {
    if (window.confirm) window.confirm = () => true
    return [...document.querySelectorAll('.plugin-row')].map((row) => ({
      title: row.querySelector('.plugin-title')?.textContent?.trim().slice(0, 40) ?? '',
      actions: [...row.querySelectorAll('.plugin-actions button')].map((b) => b.textContent.trim()),
    }))
  })()`)
  const delPoint = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('.plugin-row')].find((r) => r.textContent.includes(${JSON.stringify(TEST_PLUGIN)}))
    if (!row) return null
    const btn = [...row.querySelectorAll('.plugin-actions button')].find((b) => b.textContent.trim() === '删除')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (delPoint) await clickAt(page, delPoint)
  await sleep(1200)
  out.pluginAfterDelete = await page.evaluate(`(() => ({
    rows: [...document.querySelectorAll('.plugin-row')].map((row) => row.querySelector('.plugin-title')?.textContent?.trim().slice(0, 40) ?? ''),
    stillHasTestPlugin: [...document.querySelectorAll('.plugin-row')].some((row) => row.textContent.includes(${JSON.stringify(TEST_PLUGIN)})),
    removeApi: typeof window.qdo.plugins.remove,
  }))()`)

  console.log(JSON.stringify(out, null, 2))
  page.close()
}

main().catch((err) => {
  console.error('[cdp-check] 失败：', err)
  process.exit(1)
})
