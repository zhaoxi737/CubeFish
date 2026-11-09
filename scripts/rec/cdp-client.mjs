#!/usr/bin/env node
/**
 * 极简 CDP 客户端（Node 原生 fetch + 全局 WebSocket，无第三方依赖）
 * 供 cdp-rec.mjs / drive.mjs 复用。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询 http://127.0.0.1:<port>/json/list，直到出现 page target */
export async function waitForPageTarget(port, { timeoutMs = 40000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        const list = await res.json()
        const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch (err) {
      lastError = err
    }
    await sleep(pollMs)
  }
  throw new Error(`CDP 端口 ${port} 在 ${(timeoutMs / 1000).toFixed(0)}s 内没有可用 page target${lastError ? `（${lastError.message}）` : ''}`)
}

/** 只探测端口是否已有 page target（不抛错） */
export async function probePageTarget(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const list = await res.json()
    return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null
  } catch {
    return null
  }
}

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.closeReason = null
    this.ws = new WebSocket(wsUrl)
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)), { once: true })
    })
    this.ws.addEventListener('message', (event) => this.#onMessage(event))
    this.ws.addEventListener('close', (event) => {
      this.closed = true
      this.closeReason = `ws closed code=${event.code}`
      for (const [, entry] of this.pending) entry.reject(new Error(this.closeReason))
      this.pending.clear()
    })
  }

  static async connect(wsUrl) {
    const client = new CdpClient(wsUrl)
    await client.opened
    return client
  }

  #onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method} 失败：${message.error.message}`))
      else entry.resolve(message.result ?? {})
      return
    }
    if (message.method) {
      const handlers = this.listeners.get(message.method)
      if (!handlers) return
      for (const handler of handlers) {
        try {
          handler(message.params ?? {})
        } catch (err) {
          console.error(`[cdp] ${message.method} 处理器异常:`, err?.message ?? err)
        }
      }
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(handler)
    return () => this.listeners.get(method)?.delete(handler)
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`${method} 失败：${this.closeReason ?? '连接已关闭'}`))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject, method })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'
      throw new Error(`Runtime.evaluate 异常：${detail}`)
    }
    return result.result?.value
  }

  close() {
    if (this.closed) return
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
    this.closed = true
  }
}

/** 等待某个 CSS 选择器出现（在页面里轮询） */
export async function waitForSelector(client, selector, { timeoutMs = 12000, pollMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await client
      .evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      .catch(() => false)
    if (found) return true
    await sleep(pollMs)
  }
  throw new Error(`等待选择器超时：${selector}`)
}

export { sleep }
