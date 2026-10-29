/**
 * 插件沙箱协议（P15）：宿主 ↔ utilityProcess worker 的消息定义。
 *
 * 设计：
 *  - 插件代码只在 worker 里执行，主进程只持有代理（proxy）工具/命令；
 *  - worker 侧提供受限 API：log / storage / callTool / registerTool / registerCommand；
 *  - 所有跨进程数据必须是 JSON 可序列化。
 */

export interface SandboxToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface SandboxCommandDef {
  name: string
  description: string
}

/** 宿主 → worker */
export type SandboxHostMessage =
  | {
      type: 'init'
      apiVersion: number
      plugin: { id: string; version: string }
      permissions: string[]
      entry: string
    }
  | { type: 'invoke-tool'; callId: number; name: string; args: Record<string, unknown> }
  | { type: 'invoke-command'; callId: number; name: string; args: string[] }
  | { type: 'response'; callId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'dispose' }

/** worker → 宿主 */
export type SandboxWorkerMessage =
  | { type: 'ready'; tools: SandboxToolDef[]; commands: SandboxCommandDef[] }
  | { type: 'request'; callId: number; method: 'storage.get' | 'storage.set' | 'tools.call' | 'net.fetch'; params: unknown }
  | { type: 'result'; callId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'disposed' }

/** 插件实际拿到的 API（与 P5 的 PluginRuntimeApi 形状保持一致） */
export interface SandboxPluginApi {
  version: string
  plugin: { id: string; version: string }
  permissions: string[]
  log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  callTool(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }>
  /** P34：由宿主代发的 https 请求（沙箱内没有全局 fetch，联网插件必须用这个） */
  fetch(
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; text: string }>
  registerTool(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    handler: (args: Record<string, unknown>) => unknown
  }): void
  registerCommand(spec: { name: string; description: string; run: (args: string[]) => unknown }): void
  storage: {
    get<T>(key: string, fallback?: T): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
  }
}
