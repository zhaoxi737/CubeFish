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

const SYSTEM_PROMPT = `你是方块鱼（CubeFish，Minecraft 启动器）里的 AI 助手。你不是聊天机器人，是一个「能操作启动器的 agent」。

【最高原则】
1. 用工具，别猜。模组名、版本号、文件路径、系统信息这类事实，一律先调工具确认；查不到就说不确定。
2. 先想再做。多步任务先调 plan 列出 2–5 步，再逐步执行；每步用结果验证（写完读回来、装完列一遍）。
3. 果断。同一件事最多试 2 次；拿到能回答的信息就停手，不做无关探索；工具报错就换方法或直接告诉用户。
4. 破坏性操作（结束游戏 / 删插件 / 写文件 / 改设置 / 装版本 / 重启）执行前先说明；用户本条消息含「确认 / 确定 / 同意」才执行。
5. 回答短：先结论，再下一步建议，最多 6 行；不贴 JSON、不贴工具参数、不复述用户的话。

【工具地图（按场景选，别乱试）】
- 看状态：get_status / system_info / list_mods / list_plugins / list_plugin_buttons / list_tools
- 查资料：web_search 先搜 → web_fetch 读正文
- 文件：read_file / list_dir / search_files；改配置用 edit_file（精确替换，优先）；新建文件才用 write_file
- 模组：search_mods → install_mod
- 进不去 / 模组不兼容：fix_mod_conflict（一步到位）；其它崩溃：diagnose_crash → auto_fix_crash(fixId) → read_game_log
- 设置：update_settings；更新：check_update / apply_update；重启：restart_self
- 系统：speak_text（喇叭念）/ deepseek_balance（查余额，不要向用户要 Key）
- 记忆：remember / recall
- 子任务：delegate / delegate_many（子助手可再委派，最多 3 层；并行最多 5 个）
- 系统命令：run_shell（任意 PowerShell，用户已授权）
- 改自己：read_source_file / write_source_file（只能 src/）→ rebuild_launcher → restart_self
- 扩展：write_plugin / reload_plugin / remove_plugin

【典型流程】
- 装东西：确认目标 → search_mods → install_mod → 报告装了哪个版本
- 崩了/进不去：先 fix_mod_conflict 或 diagnose_crash → 按建议修复 → 让用户重试
- 问能力：先 list_tools 再据实回答，绝不说「我做不到」；确实没有就 write_plugin 补一个
- 信息不够：直接问一个具体问题，不要瞎猜
- 做完：说清「做了什么 + 结果 + 下一步」

【自我扩展】
现有工具做不到时，写插件补能力。插件是 ESM，导出 apply(api)：
\`\`\`
export function apply(api) {
  api.registerTool({ name: 'snake_case', description: '做什么', parameters: { type: 'object', properties: {}, additionalProperties: false }, async handler() { return { ok: true, summary: '结果' } } })
  // 还可 api.registerCommand({name,description,async run(){}}) / api.registerButton({id,label,description,async run(){}})
}
\`\`\`
- 可用 api：log / storage.get/set / callTool(内置工具名, args) / fetch(url,{method,headers,body}) / registerTool / registerCommand / registerButton。
- 沙箱里没有 window/document/全局 fetch，联网必须用 api.fetch（只允许 https）；读不到启动器文件，只能通过 api.callTool。
- 流程：write_plugin 安装（同 id 覆盖=升级）→ list_plugins 确认 → 调用验证；失败就把报错告诉用户并修一次。

【安全与风格】
- 只能用工具做，不要假装做过。
- 中文、简短、直接。被用户纠正时先照做，先查工具再回答。`

/** P38：上下文压缩——只带最近若干条、总字符数有上限，避免长对话把上下文撑爆 */
const HISTORY_MAX_MESSAGES = 14
const HISTORY_MAX_CHARS = 8000

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

      // P38：上下文压缩：从最近往前带，超过条数或字符上限就停
      const compacted: LlmMessage[] = []
      let chars = 0
      for (let index = (options?.history ?? []).length - 1; index >= 0; index -= 1) {
        const message = (options?.history ?? [])[index]
        const length = (message.content ?? '').length
        if (compacted.length >= HISTORY_MAX_MESSAGES || chars + length > HISTORY_MAX_CHARS) break
        compacted.unshift(message)
        chars += length
      }
      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...compacted,
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

    const MAX_SUB_ROUNDS = 6
    const MAX_SUB_DEPTH = 3
    let subDepth = 0

    /** 子助手：跑一轮独立的 agent 循环（可以继续往下委派，最多 3 层）。 */
    const runSubagent = async (task: string, depth: number): Promise<string> => {
      if (depth > MAX_SUB_DEPTH) return '（子任务层级已到上限，这个任务请直接做）'
      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: task },
      ]
      const specs = tools.specs()
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

    /** 带层级计数的委派入口 */
    const delegateRun = async (task: string): Promise<string> => {
      const depth = subDepth + 1
      if (depth > MAX_SUB_DEPTH) return '（子任务层级已到上限，这个任务请直接做）'
      subDepth = depth
      try {
        return await runSubagent(task, depth)
      } finally {
        subDepth = depth - 1
      }
    }

    const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

    tools.register({
      name: 'delegate',
      description:
        '把一个独立的子任务交给子助手去做（子助手也能再往下委派，最多 3 层），返回结论。适合需要自己多步查找/判断的事。',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: '子任务描述（要具体，包含目标与约束）' } },
        required: ['task'],
        additionalProperties: false,
      },
      async handler(args) {
        const text = await delegateRun(asText(args.task))
        return { ok: true, summary: text.slice(0, 4000) }
      },
    })

    tools.register({
      name: 'delegate_many',
      description: '并行跑多个相互独立的子任务（最多 5 个），各自返回结论。',
      parameters: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'string' }, description: '子任务列表，最多 5 个' },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      async handler(args) {
        const tasks = Array.isArray(args.tasks)
          ? (args.tasks as unknown[]).map(asText).filter(Boolean).slice(0, 5)
          : []
        if (tasks.length === 0) return { ok: false, summary: '需要 tasks 数组（1–5 条）' }
        const results = await Promise.all(
          tasks.map((task) =>
            delegateRun(task).catch((err) => `子任务失败：${err instanceof Error ? err.message : String(err)}`),
          ),
        )
        const summary = results.map((text, index) => `【任务 ${index + 1}】${text.slice(0, 1200)}`).join('\n')
        return { ok: true, summary: summary.slice(0, 8000) }
      },
    })

    tools.register({
      name: 'plan',
      description:
        '为多步任务写一份执行计划（2–5 步），用户在对话里能看到你在做什么。开始做多步任务前先调用它。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: '步骤列表，例如 ["检查冲突","换兼容版本","让用户重试"]',
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      async handler(args) {
        const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).map(String).filter(Boolean).slice(0, 8) : []
        if (steps.length === 0) return { ok: false, summary: 'steps 不能为空' }
        return { ok: true, summary: `计划：\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`, data: steps }
      },
    })

    ctx.provide('agent', { available: () => llm.available(), run } satisfies AgentService)
  })
}
