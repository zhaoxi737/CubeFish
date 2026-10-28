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
  chat(messages: LlmMessage[], tools: LlmToolSpec[]): Promise<LlmResponse>
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

export function createLlmPlugin(): LauncherPlugin<void> {
  return definePlugin('llm', () => (ctx) => {
    const settings = use<SettingsService>(ctx, 'settings')
    const log = use<LogService>(ctx, 'log')

    const key = (): string => settings.get('apiKey') || process.env.QDOQMC_LLM_KEY || ''
    const baseUrl = (): string =>
      (process.env.QDOQMC_LLM_BASE_URL || settings.get('llmBaseUrl') || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const model = (): string => process.env.QDOQMC_LLM_MODEL || settings.get('llmModel') || 'deepseek-chat'

    async function chat(messages: LlmMessage[], tools: LlmToolSpec[]): Promise<LlmResponse> {
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
      const res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      })

      const text = await res.text()
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
      const res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(120_000),
      })

      if (!res.ok) {
        const text = await res.text()
        let detail = text.slice(0, 300)
        try {
          const parsed = JSON.parse(text) as RawResponse
          if (parsed.error?.message) detail = parsed.error.message
        } catch {
          /* 原样返回 */
        }
        throw new Error(`模型请求失败（HTTP ${res.status}）：${detail}`)
      }

      const contentType = res.headers.get('content-type') ?? ''
      // 服务端不支持流式时退回一次性响应
      if (!contentType.includes('text/event-stream') || !res.body) {
        const text = await res.text()
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

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          ingest(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      }
      if (buffer.trim()) ingest(buffer)

      const toolCalls: LlmToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          id: call.id ?? `call_${index}`,
          name: call.name ?? '',
          arguments: call.args || '{}',
        }))
        .filter((call) => Boolean(call.name))

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
