/**
 * Agent 循环（P4）：用户自然语言 → 模型 → 工具调用 → 结果 → 模型 → 回答。
 * 这是「AI 真的能操作启动器」的那一层，工具执行与审计在 tools 插件。
 */
import type { ChatReply, ToolCallTrace } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LlmMessage, LlmService } from './llm'
import type { LogService } from './logger'
import type { TelemetryService } from './telemetry'
import type { ToolsService } from './tools'

const MAX_ROUNDS = 6

const SYSTEM_PROMPT = `你是 QDOQMC（Minecraft 启动器）里的助手，直接操作启动器帮用户做事。
规则：
1. 用中文回答，简短（最多 6 行），不要客套、不要复述用户的话。
2. 需要事实或操作时必须调用工具，禁止编造模组名、版本号、文件路径。
3. 用户想装模组：先 search_mods 确认 slug，再 install_mod。
4. 用户说游戏崩了/报错：先 diagnose_crash，必要时 read_game_log。
5. 安装、启动这类操作直接执行；结束游戏、删除模组等破坏性操作，除非用户明确要求，否则先问一句。
6. 工具报错就把错误原样告诉用户，并给出下一步建议。
7. 不要把 JSON、工具参数、内部实现细节展示给用户。
8. 当前没有正版登录，只能离线游玩；不要建议用户去官网登录。`

export interface AgentRunOptions {
  /** 历史对话（不含 system），用于会话记忆 */
  history?: LlmMessage[]
  /** 流式增量回调（每收到一段文本调用一次） */
  onDelta?: (text: string) => void
}

export interface AgentService {
  available(): boolean
  run(text: string, options?: AgentRunOptions): Promise<ChatReply>
}

export function createAgentPlugin(): LauncherPlugin<void> {
  return definePlugin('agent', () => (ctx) => {
    const llm = use<LlmService>(ctx, 'llm')
    const tools = use<ToolsService>(ctx, 'tools')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    async function run(userText: string, options?: AgentRunOptions): Promise<ChatReply> {
      if (!llm.available()) {
        return {
          ok: false,
          kind: 'error',
          text: '还没有配置模型 API Key（设置 → 模型 API Key），配置后就能用一句话让我干活。',
        }
      }

      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(options?.history ?? []),
        { role: 'user', content: userText },
      ]
      const trace: ToolCallTrace[] = []
      const started = Date.now()

      try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          const response = options?.onDelta
            ? await llm.chatStream(messages, tools.specs(), options.onDelta)
            : await llm.chat(messages, tools.specs())

          if (response.toolCalls.length === 0) {
            const text = (response.content ?? '').trim()
            telemetry.record('agent:answer', {
              rounds: round + 1,
              tools: trace.length,
              ms: Date.now() - started,
            })
            return {
              ok: true,
              kind: 'agent',
              text: text || '（模型没有返回内容）',
              trace,
            }
          }

          messages.push({
            role: 'assistant',
            content: response.content ?? '',
            tool_calls: response.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          })

          for (const call of response.toolCalls) {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
            } catch {
              args = {}
            }
            const toolStarted = Date.now()
            const result = await tools.call(call.name, args)
            trace.push({
              id: call.id,
              tool: call.name,
              args,
              ok: result.ok,
              summary: result.summary.slice(0, 200),
              ms: Date.now() - toolStarted,
            })
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: result.summary,
            })
          }
        }

        telemetry.record('agent:max-rounds', { tools: trace.length })
        return {
          ok: false,
          kind: 'error',
          text: '这一步操作太复杂，我调了太多工具还没收敛。你可以拆成更具体的要求，比如“先检查冲突”。',
          trace,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('agent', 'Agent 运行失败', { error: message, trace: trace.length })
        telemetry.record('agent:error', { error: message })
        return { ok: false, kind: 'error', text: message, trace }
      }
    }

    ctx.provide('agent', { available: () => llm.available(), run } satisfies AgentService)
  })
}
