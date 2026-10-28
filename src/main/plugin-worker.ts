/**
 * 插件沙箱 worker（P15）：在 utilityProcess 里执行第三方插件。
 *
 * 与主进程只通过 parentPort 上的 JSON 消息通信；
 * 插件拿不到宿主对象，也拿不到宿主寄存器——只能通过沙箱 API 注册工具/命令、读写自己的存储。
 *
 * 注意：这是「进程隔离 + 受限桥接」，不是 capability 级沙箱。
 * 插件仍有 Node 能力（require('fs') 等）；真正的 capability 限制需要 Node permission model 或 vm 级方案。
 */
import type {
  SandboxHostMessage,
  SandboxPluginApi,
  SandboxToolDef,
  SandboxWorkerMessage,
} from '../shared/plugin-sandbox'

interface ParentPort {
  on(event: 'message', listener: (event: { data: SandboxHostMessage }) => void): void
  postMessage(message: SandboxWorkerMessage): void
}

/**
 * 传输层：兼容两种宿主。
 *  - Electron utilityProcess：process.parentPort.on('message', (e) => e.data)
 *  - child_process.fork（ELECTRON_RUN_AS_NODE + Node permission model）：process.on('message')
 */
const electronPort = (process as unknown as { parentPort?: ParentPort }).parentPort
const nodeIpc = process as unknown as {
  send?: (message: unknown) => boolean
  on: (event: 'message', listener: (message: SandboxHostMessage) => void) => void
}

const port: ParentPort = electronPort ?? {
  on: (_event, listener) => {
    nodeIpc.on('message', (message) => listener({ data: message }))
  },
  postMessage: (message) => {
    nodeIpc.send?.(message)
  },
}

const send = (message: SandboxWorkerMessage): void => port.postMessage(message)

/* ---------- RPC：worker → host ---------- */

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextCallId = 1

function request(method: 'storage.get' | 'storage.set' | 'tools.call', params: unknown, timeoutMs = 30_000): Promise<unknown> {
  const callId = nextCallId++
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject })
    port.postMessage({ type: 'request', callId, method, params })
    setTimeout(() => {
      if (pending.delete(callId)) reject(new Error(`沙箱请求超时：${method}`))
    }, timeoutMs)
  })
}

/* ---------- 插件 API ---------- */

type ToolHandler = (args: Record<string, unknown>) => unknown
type CommandHandler = (args: string[]) => unknown

const tools = new Map<string, { name: string; description: string; parameters: Record<string, unknown>; handler: ToolHandler }>()
const commands = new Map<string, { name: string; description: string; run: CommandHandler }>()
let disposer: (() => unknown) | undefined

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createApi(init: Extract<SandboxHostMessage, { type: 'init' }>): SandboxPluginApi {
  return {
    version: String(init.apiVersion),
    plugin: init.plugin,
    permissions: init.permissions,
    log: {
      info: (message) => send({ type: 'log', level: 'info', message }),
      warn: (message) => send({ type: 'log', level: 'warn', message }),
      error: (message) => send({ type: 'log', level: 'error', message }),
    },
    callTool: async (name, args) =>
      (await request('tools.call', { name, args: args ?? {} }, 120_000)) as { ok: boolean; summary: string; data?: unknown },
    registerTool: (definition) => {
      if (!definition?.name) throw new Error('registerTool 需要 name')
      tools.set(definition.name, {
        name: definition.name,
        description: definition.description ?? '',
        parameters: definition.parameters ?? { type: 'object', properties: {} },
        handler: definition.handler,
      })
    },
    registerCommand: (spec) => {
      if (!spec?.name) throw new Error('registerCommand 需要 name')
      commands.set(spec.name.toLowerCase(), { name: spec.name, description: spec.description ?? '', run: spec.run })
    },
    storage: {
      get: async <T,>(key: string, fallback?: T) => {
        const value = await request('storage.get', { key })
        return (value === undefined ? fallback : value) as T | undefined
      },
      set: async (key, value) => {
        await request('storage.set', { key, value })
      },
    },
  }
}

/* ---------- 宿主消息处理 ---------- */

port.on('message', (event) => {
  const message = event.data
  void handle(message)
})

async function handle(message: SandboxHostMessage): Promise<void> {
  if (message.type === 'response') {
    const entry = pending.get(message.callId)
    if (!entry) return
    pending.delete(message.callId)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error ?? '沙箱请求失败'))
    return
  }

  if (message.type === 'init') {
    try {
      const module = (await import(`${message.entry}?t=${Date.now()}`)) as {
        apply?: (api: SandboxPluginApi) => unknown
        default?: (api: SandboxPluginApi) => unknown
      }
      const apply = module.apply ?? module.default
      if (typeof apply !== 'function') throw new Error('插件必须导出 apply(api) 函数')
      const result = await apply(createApi(message))
      if (typeof result === 'function') disposer = result as () => unknown
      const toolDefs: SandboxToolDef[] = [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
      send({
        type: 'ready',
        tools: toolDefs,
        commands: [...commands.values()].map((command) => ({ name: command.name, description: command.description })),
      })
    } catch (error) {
      send({ type: 'error', message: toError(error) })
    }
    return
  }

  if (message.type === 'invoke-tool') {
    const tool = tools.get(message.name)
    if (!tool) {
      send({ type: 'result', callId: message.callId, ok: false, error: `插件没有注册工具 ${message.name}` })
      return
    }
    try {
      const result = (await tool.handler(message.args ?? {})) as { ok?: boolean; summary?: string; data?: unknown } | null
      send({
        type: 'result',
        callId: message.callId,
        ok: result?.ok !== false,
        result: { ok: result?.ok !== false, summary: result?.summary ?? '', data: result?.data },
      })
    } catch (error) {
      send({ type: 'result', callId: message.callId, ok: false, error: toError(error) })
    }
    return
  }

  if (message.type === 'invoke-command') {
    const command = commands.get(message.name.toLowerCase())
    if (!command) {
      send({ type: 'result', callId: message.callId, ok: false, error: `插件没有注册命令 /${message.name}` })
      return
    }
    try {
      const text = await command.run(message.args ?? [])
      send({ type: 'result', callId: message.callId, ok: true, result: String(text ?? '') })
    } catch (error) {
      send({ type: 'result', callId: message.callId, ok: false, error: toError(error) })
    }
    return
  }

  if (message.type === 'dispose') {
    try {
      if (disposer) await disposer()
    } catch (error) {
      send({ type: 'log', level: 'warn', message: `插件卸载回调失败：${toError(error)}` })
    }
    send({ type: 'disposed' })
    setTimeout(() => process.exit(0), 50)
  }
}
