/**
 * Agent 循环（P4）：用户自然语言 → 模型 → 工具调用 → 结果 → 模型 → 回答。
 * 这是「AI 真的能操作启动器」的那一层，工具执行与审计在 tools 插件。
 */
import type { ChatProgressEvent, ChatReply, ToolCallTrace } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LlmMessage, LlmService } from './llm'
import type { LogService } from './logger'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'
import type { ToolsService } from './tools'

const MAX_ROUNDS = 24
/** 到这个轮数还没收敛，就提醒模型直接用已有信息回答（只提醒一次） */
const SYNTHESIS_ROUND = 12

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
- api.registerButton({ id, label, description, async run() { return '文本' } })：往启动器顶栏加一个按钮（这就是「改界面」的正确方式），点击执行 run，结果显示成提示。
- 其他可用：api.log.info/warn/error、api.storage.get/set、api.callTool(内置工具名, args)、api.fetch(url, {method,headers,body})。
- 插件运行在沙箱里：没有 window/document/全局 fetch，联网必须用 api.fetch（只允许 https）；也不能读启动器文件，只能通过 api.callTool 调内置工具。
- id 用小写字母/数字/._- 且唯一；permissions 默认 []，需要联网才加 'net'。
- 流程：write_plugin 安装（或升级）→ list_plugins 确认已加载 → 直接调用新工具验证；安装失败就把报错原样告诉用户，并修正代码重试一次。

其他可用能力（和 harness 对齐的部分）：
- read_file / write_file / edit_file / list_dir / search_files：读写/搜索启动器文件（配置、日志、options.txt、插件源码），只能动启动器自己的目录。
- run_command：只读诊断命令白名单（java_version / where_java / gpu / network / processes 等），不能执行任意命令。
- web_fetch / web_search：抓网页 / 联网搜索，用来查资料。
- update_settings：改启动器设置（主题色、标题、内存、下载源、版本隔离、显卡等）。
- check_update / apply_update：检查并下载启动器自身的更新（下载后提示用户重启生效）。
- restart_self：重启启动器。
- deepseek_balance：查当前配置的 DeepSeek 余额（用启动器已存的 Key，**不要向用户索要 API Key**，也不要让用户把 Key 贴到聊天里）。
- remember / recall：记住用户偏好、跨会话检索。
- delegate / delegate_many：把独立子任务交给子助手（可并行最多 3 个）去做，只拿它们的结论。
- 做破坏性操作（删除、结束游戏、改设置）前，除非用户已明确要求，先确认一句。

工作方式（重要）：
1. 先判断用户要的是「操作」还是「问答」。要操作就先调工具，别只回文字。
2. 多步任务先在心里列计划，再一步步做；每步做完用工具结果验证（比如写完文件读回来确认）。
2.1 要果断：同一件事最多试 2 次，别反复调同一个工具或做无关探索；拿到能回答的信息就停手回答。工具失败就换方法或直接告诉用户，不要死磕。
3. 用户纠正你时，先照做，不要辩解，也不要说「我做不到」——先看 list_tools 里有没有对应工具。
4. 用户明确说「记住…」时用 remember 存下来；开始时如果相关，用 recall 查一下偏好。
5. 回答简短、给结果和下一步，不要输出 JSON 或内部细节。`

export interface AgentRunOptions {
  /** 历史对话（不含 system），用于会话记忆 */
  history?: LlmMessage[]
  /** 流式增量回调（每收到一段文本调用一次） */
  onDelta?: (text: string) => void
  /** P36：实时过程事件（工具开始/结束、轮次），给界面显示“正在做什么” */
  onProgress?: (event: ChatProgressEvent) => void
  /** P36：中断信号（用户点“停止”） */
  signal?: AbortSignal
}

export interface AgentService {
  available(): boolean
  run(text: string, options?: AgentRunOptions): Promise<ChatReply>
}

export function createAgentPlugin(): LauncherPlugin<void> {
  return definePlugin('agent', () => (ctx) => {
    const llm = use<LlmService>(ctx, 'llm')
    const tools = use<ToolsService>(ctx, 'tools')
    const settings = use<SettingsService>(ctx, 'settings')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    /** P34：需要用户二次确认的破坏性/不可逆操作 */
    const DANGEROUS_TOOLS = new Set([
      'stop_game',
      'remove_plugin',
      'write_file',
      'import_instance',
      'install_version',
      'apply_update',
      'restart_self',
      'bind_instance_account',
    ])
    const CONFIRM_WORDS = ['确认', '确定', '同意', '执行吧', '是的']
    const ACTION_HINTS = ['帮我', '写', '装', '改', '删', '读', '查', '跑', '更新', '重启', '生成', '执行', '安装', '配置', '设置', '备份', '下载']
    const CAPABILITY_HINTS = ['能做什么', '有什么功能', '有什么能力', '有没有', '能不能', '你会', '支持吗', '哪些工具', '你的功能', '有什么工具']
    /** 模型常见的「我做不到」措辞（出现时说明它在瞎猜，需要纠正） */
    const ABILITY_DENIALS = ['没有这个能力', '没有这个功能', '无法安装插件', '不能安装插件', '没有写文件', '无法写文件', '需要你手动', '没有安装插件']
    const userConfirmed = (text: string): boolean => CONFIRM_WORDS.some((word) => text.includes(word))
    const wantsAction = (text: string): boolean => ACTION_HINTS.some((word) => text.includes(word))
    const capabilityQuestion = (text: string): boolean => CAPABILITY_HINTS.some((word) => text.includes(word))
    const deniesAbility = (text: string): boolean => ABILITY_DENIALS.some((word) => text.includes(word))

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
      let nudged = false
      let synthNudged = false
      let lastContent = ''
      const callCounts = new Map<string, number>()

      try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          if (options?.signal?.aborted) {
            return { ok: false, kind: 'error', text: '已停止。', trace }
          }
          options?.onProgress?.({ type: 'round', round: round + 1 })
          const onDelta = options?.onDelta
          const signal = options?.signal
          const response = onDelta
            ? await llm.chatStream(messages, tools.specs(), onDelta, signal)
            : await llm.chat(messages, tools.specs(), signal)
          if (response.content) lastContent = response.content

          if (response.toolCalls.length === 0) {
            const text = (response.content ?? '').trim()
            const usedTools = trace.length > 0
            // P34：模型只回了文字但用户明显要操作/在问能力/它在否认能力 → 纠正一次再试
            const denies = ABILITY_DENIALS.some((word) => text.includes(word))
            if (!nudged && !usedTools && (wantsAction(userText) || capabilityQuestion(userText) || denies)) {
              nudged = true
              log.info('agent', '模型未调用工具，追加一次纠正提示', {
                rounds: round,
                userText: userText.slice(0, 40),
                denies,
              })
              messages.push({
                role: 'user',
                content:
                  '（系统提示：你其实拥有这些工具：write_plugin / write_file / read_file / list_dir / run_command / web_fetch / update_settings / check_update / apply_update / restart_self / list_plugins / reload_plugin / remove_plugin / delegate / delegate_many，以及装版本/装模组/启动/诊断等工具。不要说你没有这些功能。如果用户要操作，请直接调用对应工具；如果用户问你的能力，请先调用 list_tools 查看，再据实回答。）',
              })
              continue
            }
            // 纠正过一次、且一个工具都没调成：多半是当前模型不支持 function calling
            if (!usedTools && (wantsAction(userText) || denies)) {
              return {
                ok: false,
                kind: 'error',
                text: `（这次模型没有调用任何工具，很可能是当前模型不支持工具调用。请在「设置 → AI 助手 → 模型名」换成 deepseek-chat 再试；deepseek-reasoner 可能不支持 function calling。）\n\n模型原话：${text.slice(0, 300)}`,
                trace,
              }
            }
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

          // P34：危险操作先要确认（用户本条消息里带「确认/确定/同意」才放行）
          if (settings.get('confirmDangerousOps') && !userConfirmed(userText)) {
            const dangerous = response.toolCalls.find((call) => DANGEROUS_TOOLS.has(call.name))
            if (dangerous) {
              const argsText = (dangerous.arguments ?? '').replace(/\s+/g, ' ').slice(0, 160)
              return {
                ok: false,
                kind: 'confirm',
                text: `我要执行「${dangerous.name}」${argsText ? `（${argsText}）` : ''}。这属于会改动启动器/游戏的操作，确认的话回复「确认」我就执行。`,
                trace,
              }
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
            if (options?.signal?.aborted) {
              return { ok: false, kind: 'error', text: '已停止。', trace }
            }
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
            } catch {
              args = {}
            }
            options?.onProgress?.({
              type: 'tool',
              tool: call.name,
              phase: 'start',
              detail: (call.arguments ?? '').replace(/\s+/g, ' ').slice(0, 120),
            })
            const toolStarted = Date.now()
            const result = await tools.call(call.name, args)
            // P37：同名同参重复调用 ≥3 次 = 死循环，直接停，别耗到轮数上限
            const signature = `${call.name}:${call.arguments ?? ''}`
            const repeats = (callCounts.get(signature) ?? 0) + 1
            callCounts.set(signature, repeats)
            if (repeats >= 3) {
              log.warn('agent', '检测到重复工具调用，提前收敛', { tool: call.name, repeats })
              return {
                ok: false,
                kind: 'error',
                text: `我卡在重复调用「${call.name}」上了（同样参数 3 次），先停下。上一个结果：${result.summary.slice(0, 200)}`,
                trace,
              }
            }
            options?.onProgress?.({
              type: 'tool',
              tool: call.name,
              phase: 'end',
              ok: result.ok,
              summary: result.summary.replace(/\s+/g, ' ').slice(0, 120),
            })
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

          // P37：调了太多工具还没收敛 → 提醒一次“直接用已有信息回答”
          if (!synthNudged && round + 1 >= SYNTHESIS_ROUND) {
            synthNudged = true
            log.info('agent', '轮数较多，要求模型收敛回答', { round: round + 1, tools: trace.length })
            messages.push({
              role: 'user',
              content:
                '（系统提示：你已经调用了较多工具。请立刻基于已经拿到的结果回答用户，不要再调用任何工具；信息确实不够就说明还缺什么，并给用户下一步建议。）',
            })
          }
        }

        telemetry.record('agent:max-rounds', { tools: trace.length })
        const lastSteps = trace
          .slice(-3)
          .map((item) => `· ${item.ok ? '✓' : '✕'} ${item.tool}：${item.summary.slice(0, 60)}`)
          .join('\n')
        return {
          ok: false,
          kind: 'error',
          text: `我执行了 ${trace.length} 步还没收敛，先停下以免死循环。\n最近做的：\n${lastSteps || '（没有成功执行任何工具）'}\n${lastContent ? `\n我最后想到的：${lastContent.slice(0, 200)}` : ''}\n\n你可以把要求拆小一点再说一次（比如「先只检查冲突」「先只读 options.txt」）。`,
          trace,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof Error && (err.name === 'AbortError' || /aborted|abort/i.test(message))) {
          return { ok: false, kind: 'error', text: '已停止。', trace }
        }
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
