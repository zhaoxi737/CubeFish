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
8. 当前没有正版登录，只能离线游玩；不要建议用户去官网登录。

自我扩展能力（核心）：你能自己写插件、自己装上、自己更新。当用户要的能力现有工具做不到时，就写一个新插件；要给已有插件加功能/修 bug，就用 write_plugin 复用同一个 id 覆盖（= 升级），再 reload_plugin 热重载。
插件代码是一个 ESM 模块，必须导出 apply(api)，完整可用写法：
\`\`\`
export function apply(api) {
  api.registerTool({
    name: 'my_tool',
    description: '这个工具做什么（一句话）',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async handler(args) {
      // 可 await api.callTool('get_status') 等复用内置工具
      return { ok: true, summary: '结果一句话' }
    },
  })
}
\`\`\`
- api.registerTool：注册 AI 工具（name 用 snake_case；parameters 是 JSON Schema；handler 必须返回 { ok, summary, data? }）。
- api.registerCommand({ name, description, async run(args) { return '文本' } })：注册聊天命令。
- 其他可用：api.log.info/warn/error、api.storage.get/set、api.callTool(内置工具名, args)。
- id 用小写字母/数字/._- 且唯一；permissions 默认 []，需要联网才加 'net'。
- 流程：write_plugin 安装（或升级）→ list_plugins 确认已加载 → 直接调用新工具验证；安装失败就把报错原样告诉用户，并修正代码重试一次。

其他可用能力（和 harness 对齐的部分）：
- read_file / write_file / list_dir：读写启动器文件（配置、日志、options.txt、插件源码），只能动启动器自己的目录。
- run_command：只读诊断命令白名单（java_version / where_java / gpu / network / processes 等），不能执行任意命令。
- web_fetch：抓 https 网页/接口文字，用来查资料。
- update_settings：改启动器设置（主题色、标题、内存、下载源、版本隔离、显卡等）。
- check_update / apply_update：检查并下载启动器自身的更新（下载后提示用户重启生效）。
- restart_self：重启启动器。
- delegate / delegate_many：把独立子任务交给子助手（可并行最多 3 个）去做，只拿它们的结论。
- 做破坏性操作（删除、结束游戏、改设置）前，除非用户已明确要求，先确认一句。`

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

    const MAX_SUB_ROUNDS = 4
    const MAX_SUB_DEPTH = 1

    /** 子助手：跑一轮独立的 agent 循环（不拿 delegate 自己，避免无限递归）。 */
    const runSubagent = async (task: string, depth: number): Promise<string> => {
      if (depth > MAX_SUB_DEPTH) return '（子任务层级已到上限，这个任务请直接做）'
      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: task },
      ]
      const specs = tools
        .specs()
        .filter((spec) => spec.function.name !== 'delegate' && spec.function.name !== 'delegate_many')
      for (let round = 0; round < MAX_SUB_ROUNDS; round += 1) {
        const response = await llm.chat(messages, specs)
        if (response.toolCalls.length === 0) return (response.content ?? '').trim() || '（子任务没有输出）'
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
          const result = await tools.call(call.name, args)
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result.summary })
        }
      }
      return '（子任务超过轮数上限）'
    }

    const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

    tools.register({
      name: 'delegate',
      description: '把一个独立的子任务交给子助手去做，返回它的结论。适合需要自己多步查找/判断的事。',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: '子任务描述（要具体，包含目标与约束）' } },
        required: ['task'],
        additionalProperties: false,
      },
      async handler(args) {
        const text = await runSubagent(asText(args.task), 1)
        return { ok: true, summary: text.slice(0, 4000) }
      },
    })

    tools.register({
      name: 'delegate_many',
      description: '并行跑多个相互独立的子任务（最多 3 个），各自返回结论。',
      parameters: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'string' }, description: '子任务列表，最多 3 个' },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      async handler(args) {
        const tasks = Array.isArray(args.tasks)
          ? (args.tasks as unknown[]).map(asText).filter(Boolean).slice(0, 3)
          : []
        if (tasks.length === 0) return { ok: false, summary: '需要 tasks 数组（1–3 条）' }
        const results = await Promise.all(
          tasks.map((task) =>
            runSubagent(task, 1).catch((err) => `子任务失败：${err instanceof Error ? err.message : String(err)}`),
          ),
        )
        const summary = results.map((text, index) => `【任务 ${index + 1}】${text.slice(0, 1200)}`).join('\n')
        return { ok: true, summary: summary.slice(0, 8000) }
      },
    })

    ctx.provide('agent', { available: () => llm.available(), run } satisfies AgentService)
  })
}
