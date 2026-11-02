/**
 * LLM 接入（P4）：OpenAI 兼容 /chat/completions + 工具调用。
 *
 * 通道 A（现在）：用户自填 API Key，直连 DeepSeek/任何 OpenAI 兼容端点，Key 只存本地。
 * 通道 B（未来收费）：托管额度，走自己的代理与计量——接口形状不变，只换 baseUrl/key 来源。
 */
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { SettingsService } from './settings'

export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmToolCallMessage {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: LlmToolCallMessage[]
  tool_call_id?: string
  name?: string
}

export interface LlmToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmResponse {
  content: string | null
  toolCalls: LlmToolCall[]
  model?: string
  usage?: unknown
}

export interface LlmService {
  available(): boolean
  baseUrl(): string
  model(): string
  chat(messages: LlmMessage[], tools: LlmToolSpec[], signal?: AbortSignal): Promise<LlmResponse>
  /** 流式对话：每收到一段文本就回调 onDelta；工具调用也支持（聚合分片） */
  chatStream(
    messages: LlmMessage[],
    tools: LlmToolSpec[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmResponse>
}

interface RawChoice {
  message?: {
    content?: string | null
    tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[]
  }
  finish_reason?: string
}

interface RawResponse {
  choices?: RawChoice[]
  model?: string
  usage?: unknown
  error?: { message?: string }
}

/** 流式响应：多久没收到任何数据就判定卡死 */
const STREAM_IDLE_TIMEOUT_MS = 45_000
/** 流式响应：单次请求的硬上限 */
const STREAM_TOTAL_TIMEOUT_MS = 300_000
/** 非流式请求的硬上限 */
const CHAT_TIMEOUT_MS = 90_000

type WatchdogReason = 'user' | string | null

interface Watchdog {
  signal: AbortSignal
  /** 每收到一段数据就调用：重置空闲计时 */
  bump(): void
  /** 'user' = 用户主动停止；其它字符串 = 超时原因 */
  reason(): WatchdogReason
  /** 把底层 AbortError 翻译成人话；非超时错误原样返回 */
  translate(error: unknown): Error
  dispose(): void
}

/**
 * 超时看门狗：把外部 abort 信号 + 空闲超时 + 总超时合成一个信号。
 *
 * 之前这里只用 `signal ?? AbortSignal.timeout(...)`，而 agent 每次都传自己的 signal，
 * 于是「流式请求没有任何超时」——模型端半挂不挂时 reader.read() 会一直等，
 * 聊天面板就永远停在「发送中」，看起来像整个应用卡死。现在两条超时都兜住。
 */
function createWatchdog(external: AbortSignal | undefined, idleMs: number, totalMs: number): Watchdog {
  const controller = new AbortController()
  let why: WatchdogReason = null
  const kill = (reason: string): void => {
    if (controller.signal.aborted) return
    why = reason
    controller.abort()
  }
  const armIdle = (): NodeJS.Timeout =>
    setTimeout(() => kill(`模型 ${Math.round(idleMs / 1000)} 秒没有返回任何数据`), idleMs)
  let idle: NodeJS.Timeout = armIdle()
  const total = setTimeout(() => kill(`模型请求超过 ${Math.round(totalMs / 1000)} 秒还没结束`), totalMs)
  const onExternalAbort = (): void => kill('user')
  external?.addEventListener('abort', onExternalAbort, { once: true })

  return {
    signal: controller.signal,
    bump: () => {
      clearTimeout(idle)
      idle = armIdle()
    },
    reason: () => why,
    translate: (error: unknown): Error => {
      const reason = why
      if (reason && reason !== 'user') {
        return new Error(`${reason}，已中断。可以重试；连着失败就检查网络或换模型端点（设置 → 模型）。`)
      }
      return error instanceof Error ? error : new Error(String(error))
    },
    dispose: () => {
      clearTimeout(idle)
      clearTimeout(total)
      external?.removeEventListener('abort', onExternalAbort)
    },
  }
}

export function createLlmPlugin(): LauncherPlugin<void> {
  return definePlugin('llm', () => (ctx) => {
    const settings = use<SettingsService>(ctx, 'settings')
    const log = use<LogService>(ctx, 'log')

    const key = (): string => settings.get('apiKey') || process.env.QDOQMC_LLM_KEY || ''
    const baseUrl = (): string =>
      (process.env.QDOQMC_LLM_BASE_URL || settings.get('llmBaseUrl') || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const model = (): string => process.env.QDOQMC_LLM_MODEL || settings.get('llmModel') || 'deepseek-chat'

    async function chat(messages: LlmMessage[], tools: LlmToolSpec[], signal?: AbortSignal): Promise<LlmResponse> {
      const apiKey = key()
      if (!apiKey) throw new Error('还没有配置 API Key（设置 → 模型 API Key）')
      const body: Record<string, unknown> = {
        model: model(),
        messages,
        temperature: 0.2,
        stream: false,
      }
      if (tools.length > 0) {
        body.tools = tools
        body.tool_choice = 'auto'
      }

      const started = Date.now()
      const watchdog = createWatchdog(signal, CHAT_TIMEOUT_MS, CHAT_TIMEOUT_MS)
      let res!: Response
      let text!: string
      try {
        res = await fetch(`${baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
        text = await res.text()
      } catch (err) {
        throw watchdog.translate(err)
      } finally {
        watchdog.dispose()
      }
      if (!res.ok) {
        let detail = text.slice(0, 300)
        try {
          const parsed = JSON.parse(text) as RawResponse
          if (parsed.error?.message) detail = parsed.error.message
        } catch {
          /* 原样返回 */
        }
        log.warn('llm', '模型请求失败', { status: res.status, detail })
        throw new Error(`模型请求失败（HTTP ${res.status}）：${detail}`)
      }

      let data: RawResponse
      try {
        data = JSON.parse(text) as RawResponse
      } catch {
        throw new Error('模型返回的不是合法 JSON')
      }

      const choice = data.choices?.[0]
      const message = choice?.message
      const toolCalls: LlmToolCall[] = (message?.tool_calls ?? [])
        .map((call, index) => ({
          id: call.id ?? `call_${index}`,
          name: call.function?.name ?? '',
          arguments: call.function?.arguments ?? '{}',
        }))
        .filter((call) => Boolean(call.name))

      log.info('llm', '模型响应', {
        ms: Date.now() - started,
        model: data.model ?? model(),
        toolCalls: toolCalls.map((call) => call.name),
        contentLength: message?.content?.length ?? 0,
      })

      return {
        content: message?.content ?? null,
        toolCalls,
        model: data.model,
        usage: data.usage,
      }
    }

    async function chatStream(
      messages: LlmMessage[],
      tools: LlmToolSpec[],
      onDelta: (text: string) => void,
      signal?: AbortSignal,
    ): Promise<LlmResponse> {
      const apiKey = key()
      if (!apiKey) throw new Error('还没有配置 API Key（设置 → 模型 API Key）')
      const body: Record<string, unknown> = {
        model: model(),
        messages,
        temperature: 0.2,
        stream: true,
      }
      if (tools.length > 0) {
        body.tools = tools
        body.tool_choice = 'auto'
      }

      const started = Date.now()
      const watchdog = createWatchdog(signal, STREAM_IDLE_TIMEOUT_MS, STREAM_TOTAL_TIMEOUT_MS)
      let res!: Response
      try {
        res = await fetch(`${baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
      } catch (err) {
        watchdog.dispose()
        throw watchdog.translate(err)
      }

      if (!res.ok) {
        const text = await res.text()
        watchdog.dispose()
        let detail = text.slice(0, 300)
        try {
          const parsed = JSON.parse(text) as RawResponse
          if (parsed.error?.message) detail = parsed.error.message
        } catch {
          /* 原样返回 */
        }
        log.warn('llm', '模型请求失败', { status: res.status, detail, streamed: true })
        throw new Error(`模型请求失败（HTTP ${res.status}）：${detail}`)
      }

      const contentType = res.headers.get('content-type') ?? ''
      // 服务端不支持流式时退回一次性响应
      if (!contentType.includes('text/event-stream') || !res.body) {
        const text = await res.text()
        watchdog.dispose()
        const data = JSON.parse(text) as RawResponse
        const message = data.choices?.[0]?.message
        if (message?.content) onDelta(message.content)
        return {
          content: message?.content ?? null,
          toolCalls: (message?.tool_calls ?? [])
            .map((call, index) => ({
              id: call.id ?? `call_${index}`,
              name: call.function?.name ?? '',
              arguments: call.function?.arguments ?? '{}',
            }))
            .filter((call) => Boolean(call.name)),
          model: data.model,
          usage: data.usage,
        }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let content = ''
      let modelName: string | undefined
      const calls = new Map<number, { id?: string; name?: string; args: string }>()

      const ingest = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) return
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') return
        let chunk: {
          model?: string
          choices?: {
            delta?: {
              content?: string | null
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
            }
          }[]
        }
        try {
          chunk = JSON.parse(payload)
        } catch {
          return
        }
        if (chunk.model) modelName = chunk.model
        const delta = chunk.choices?.[0]?.delta
        if (!delta) return
        if (delta.content) {
          content += delta.content
          onDelta(delta.content)
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0
          const current = calls.get(index) ?? { args: '' }
          if (call.id) current.id = call.id
          if (call.function?.name) current.name = call.function.name
          if (call.function?.arguments) current.args += call.function.arguments
          calls.set(index, current)
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          watchdog.bump()
          buffer += decoder.decode(value, { stream: true })
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            ingest(buffer.slice(0, newline))
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
          }
        }
        if (buffer.trim()) ingest(buffer)
      } catch (err) {
        watchdog.dispose()
        throw watchdog.translate(err)
      }

      const toolCalls: LlmToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          id: call.id ?? `call_${index}`,
          name: call.name ?? '',
          arguments: call.args || '{}',
        }))
        .filter((call) => Boolean(call.name))

      watchdog.dispose()
      log.info('llm', '流式响应完成', {
        ms: Date.now() - started,
        toolCalls: toolCalls.map((call) => call.name),
        contentLength: content.length,
        streamed: true,
      })
      return { content: content || null, toolCalls, model: modelName }
    }

    ctx.provide('llm', {
      available: () => Boolean(key()),
      baseUrl,
      model,
      chat,
      chatStream,
    } satisfies LlmService)
  })
}
