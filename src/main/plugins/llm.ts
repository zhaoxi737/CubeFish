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

    ctx.provide('llm', {
      available: () => Boolean(key()),
      baseUrl,
      model,
      chat,
    } satisfies LlmService)
  })
}
