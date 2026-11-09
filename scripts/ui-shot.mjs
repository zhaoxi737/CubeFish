/**
 * 真机截图小工具（CDP）：接上一个开着 --remote-debugging-port 的启动器，
 * 可选先执行一段 JS（例如点某个导航），再截一张 PNG。
 *
 *   npx electron . --remote-debugging-port=9333
 *   node scripts/ui-shot.mjs 9333 out/shot.png
 *   node scripts/ui-shot.mjs 9333 out/shot.png "document.querySelector('.cf-tab:nth-child(2)').click()"
 */
import { writeFileSync } from 'node:fs'

const PORT = Number(process.argv[2] || 9333)
const OUT = process.argv[3] || 'out/ui-shot.png'
const ACTION = process.argv[4] || process.env.UI_ACTION || ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  for (let i = 0; i < 120; i += 1) {
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
  return { ready, call, close: () => ws.close() }
}

async function main() {
  const client = cdp(await connect())
  await client.ready
  await client.call('Page.enable')
  await client.call('Runtime.enable')
  await sleep(2500)
  if (ACTION) {
    const result = await client.call('Runtime.evaluate', { expression: ACTION, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      console.log('action threw ->', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    } else {
      console.log('action ->', JSON.stringify(result.result?.value ?? null))
    }
    await sleep(1200)
  }
  const shot = await client.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('saved', OUT)
  client.close()
}

main().catch((err) => {
  console.error('ui-shot failed:', err.message)
  process.exit(1)
})
