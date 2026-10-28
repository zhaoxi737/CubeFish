import path from 'node:path'
import type { ChatReply } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { EntitlementService } from './entitlement'
import type { IdentityService } from './identity'
import type { InstancesService } from './instances'
import type { AgentService } from './agent'
import type { ConflictService } from './conflict'
import type { ContentService } from './content'
import type { DiagnoseService } from './diagnose'
import type { JavaService } from './java'
import type { LogService } from './logger'
import type { SettingsService } from './settings'
import type { StorageService } from './storage'
import type { TelemetryService } from './telemetry'
import type { PathsService } from './paths'
import type { UpdaterService } from './updater'

/**
 * 聊天服务（AI 工具调用层的雏形）。
 *
 * P0：本地命令路由 + 占位回复。
 * P4：这里换成「模型 → 工具调用 → 服务」的循环，命令注册表升级为工具注册表，
 *      每个工具带权限声明与审计记录。
 */
export interface CommandSpec {
  name: string
  description: string
  run: (args: string[]) => string | Promise<string>
}

export interface ChatService {
  send(text: string): Promise<ChatReply>
  register(spec: CommandSpec): void
  unregister(name: string): void
  commands(): { name: string; description: string }[]
  /** 流式增量回调（主进程 → 渲染进程） */
  setStreamSink(sink: ((text: string) => void) | null): void
  history(): { role: 'user' | 'assistant'; text: string }[]
  clearHistory(): void
}

export function createChatPlugin(): LauncherPlugin<void> {
  return definePlugin('chat', () => (ctx) => {
    const log = use<LogService>(ctx, 'log')
    const updater = use<UpdaterService>(ctx, 'updater')
    const instances = use<InstancesService>(ctx, 'instances')
    const java = use<JavaService>(ctx, 'java')
    const content = use<ContentService>(ctx, 'content')
    const conflict = use<ConflictService>(ctx, 'conflict')
    const diagnose = use<DiagnoseService>(ctx, 'diagnose')
    const agent = use<AgentService>(ctx, 'agent')
    const settings = use<SettingsService>(ctx, 'settings')
    const identity = use<IdentityService>(ctx, 'identity')
    const entitlement = use<EntitlementService>(ctx, 'entitlement')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')
    const storage = use<StorageService>(ctx, 'storage')
    const paths = use<PathsService>(ctx, 'paths')

    const registry = new Map<string, CommandSpec>()
    let streamSink: ((text: string) => void) | null = null

    interface HistoryEntry {
      role: 'user' | 'assistant'
      text: string
      ts: number
    }
    const HISTORY_FILE = path.join(paths.data, 'chat-history.json')
    const MAX_HISTORY = 20

    const loadHistory = (): HistoryEntry[] => storage.readJson<HistoryEntry[]>(HISTORY_FILE, [])
    const saveHistory = (entries: HistoryEntry[]): void => {
      storage.writeJson(HISTORY_FILE, entries.slice(-MAX_HISTORY))
    }
    const appendHistory = (role: 'user' | 'assistant', text: string): void => {
      const trimmed = text.trim()
      if (!trimmed) return
      saveHistory([...loadHistory(), { role, text: trimmed.slice(0, 2000), ts: Date.now() }])
    }
    const clearHistory = (): void => {
      saveHistory([])
    }

    const register = (spec: CommandSpec) => {
      registry.set(spec.name.toLowerCase(), spec)
    }

    ctx.provide('chat', {
      send: async (text: string): Promise<ChatReply> => {
        const raw = text.trim()
        if (!raw) return { ok: false, text: '说点什么吧，比如 /help', kind: 'error' }
        telemetry.record('chat:send', { length: raw.length, command: raw.startsWith('/') })
        log.info('chat', '收到消息', { preview: raw.slice(0, 80) })

        if (!raw.startsWith('/')) {
          if (!agent.available()) {
            return {
              ok: false,
              kind: 'error',
              text: '还没有配置模型 API Key（设置 → 模型 API Key）。\n配置后可以直接说人话让我干活，例如“装个 sodium”“看看为什么崩了”“最近有什么优化模组”。\n没配置时可以用 /help 看本地命令。',
            }
          }
          // 会话记忆：把最近几轮带进上下文
          const history = loadHistory().map((entry) => ({ role: entry.role, content: entry.text }) as const)
          const reply = await agent.run(raw, {
            history: [...history],
            onDelta: (chunk) => streamSink?.(chunk),
          })
          if (reply.ok) {
            appendHistory('user', raw)
            appendHistory('assistant', reply.text)
          }
          return { ...reply, streamed: true }
        }

        const [head, ...args] = raw.slice(1).split(/\s+/)
        const spec = registry.get(head.toLowerCase())
        if (!spec) return { ok: false, text: `没有这个命令：/${head}，用 /help 看看。`, kind: 'error' }
        try {
          const text2 = await spec.run(args)
          return { ok: true, text: text2, kind: 'action' }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('chat', '命令执行失败', { command: head, error: message })
          return { ok: false, text: `/${head} 执行失败：${message}`, kind: 'error' }
        }
      },
      register,
      unregister: (name: string) => {
        registry.delete(name.toLowerCase())
      },
      commands: () => [...registry.values()].map((c) => ({ name: c.name, description: c.description })),
      setStreamSink: (sink) => {
        streamSink = sink
      },
      history: () => loadHistory().map((entry) => ({ role: entry.role, text: entry.text })),
      clearHistory,
    } satisfies ChatService)

    register({
      name: 'help',
      description: '列出所有可用命令',
      run: () => {
        const lines = [...registry.values()].map((c) => `/${c.name.padEnd(6)} ${c.description}`)
        return [`可用命令（P0 本地命令，P4 起换成自然语言工具）：`, ...lines].join('\n')
      },
    })

    register({
      name: 'status',
      description: '查看启动器、实例与授权状态',
      run: () => {
        const info = ctx.get('appMeta') as { version: string } | undefined
        const inst = instances.active()
        const free = entitlement.freeMode
        const lines = [
          `启动器版本：${info?.version ?? '?'}`,
          `实例：${inst?.name ?? '无'} · 版本 ${inst?.mcVersion || '未安装'} · 加载器 ${inst?.loader ?? '-'}`,
          `内存分配：${settings.get('memoryMb')} MB`,
          `匿名统计：${settings.get('telemetry') ? '开' : '关'} · 设备 ${identity.installId.slice(0, 8)}`,
          `授权：${free ? '免费期（全部功能放行）' : '已加载本地许可'}`,
          `累计事件：${telemetry.summary().total} 条（今日 ${telemetry.summary().today}）`,
        ]
        return lines.join('\n')
      },
    })

    register({
      name: 'update',
      description: '检查启动器更新',
      run: async () => {
        const state = await updater.check('chat')
        if (state.status === 'offline') return '离线模式：还没有配置更新源（设置里可填更新清单地址）。'
        if (state.status === 'error') return `检查失败：${state.message ?? '未知错误'}`
        if (state.status === 'available') {
          return `发现新版本 ${state.latest}（当前 ${state.current}）${state.mustUpdate ? '，必须更新' : ''}。下载与替换功能将在后续版本接入。`
        }
        return `已是最新版本 ${state.current}。`
      },
    })

    register({
      name: 'instance',
      description: '查看实例目录结构（版本隔离）',
      run: () => {
        const inst = instances.active()
        if (!inst) return '还没有实例。'
        return [
          `实例：${inst.name}（${inst.id}）`,
          `目录：${inst.path}`,
          `游戏目录：${inst.gameDir}`,
          '隔离目录：mods / resourcepacks / shaderpacks / saves / config / logs / crash-reports',
          '全局共享：assets / libraries / versions / runtimes / 下载缓存',
        ].join('\n')
      },
    })

    register({
      name: 'java',
      description: '列出本机探测到的 Java 运行时',
      run: async () => {
        const runtimes = await java.detect()
        if (runtimes.length === 0) return '没有探测到可用 Java。安装 JDK 或让启动器自动下载运行时。'
        return [
          `本机 Java（${runtimes.length} 个）：`,
          ...runtimes.map((r) => `- Java ${r.major} · ${r.version} · ${r.path}`),
        ].join('\n')
      },
    })

    register({
      name: 'mod',
      description: '搜索/安装模组：/mod search <关键词> | /mod install <slug>',
      run: async (args) => {
        const sub = (args[0] ?? '').toLowerCase()
        const text = args.slice(1).join(' ').trim()
        if (!sub || !text) return '用法：/mod search sodium 或 /mod install sodium'
        const instance = instances.active()
        if (!instance) return '没有可用实例。'
        const opts = {
          mcVersion: instance.gameVersion ?? undefined,
          loader: instance.loader === 'fabric' ? 'fabric' : undefined,
        }
        if (sub === 'search') {
          const hits = await content.search(text, { ...opts, type: 'mod', limit: 5 })
          if (hits.length === 0) return `没有搜到「${text}」`
          return [
            `搜索「${text}」（${instance.gameVersion ?? '不限版本'} / ${instance.loader}）：`,
            ...hits.map((hit) => `- ${hit.slug} · ${hit.title} · ${Math.round(hit.downloads / 1000)}k 下载`),
            '用 /mod install <slug> 安装',
          ].join('\n')
        }
        if (sub === 'install') {
          const result = await content.install(instance.id, text, opts)
          if (!result.ok) return `安装失败：${result.error}`
          return `已安装 ${result.title ?? text} ${result.versionNumber ?? ''} → ${result.files.join(', ')}`
        }
        return '用法：/mod search <关键词> 或 /mod install <slug>'
      },
    })

    register({
      name: 'conflict',
      description: '静态冲突检查（前置 / 版本 / 加载器 / 重复 modid）',
      run: () => {
        const report = conflict.analyze(instances.active().id)
        if (report.issues.length === 0) return `检查了 ${report.mods.length} 个模组，没有发现冲突。`
        const lines = [
          `检查了 ${report.mods.length} 个模组，发现 ${report.issues.length} 个问题：`,
          ...report.issues.map((issue) => `- [${issue.severity}] ${issue.message}\n  → ${issue.suggestion}`),
        ]
        return lines.join('\n')
      },
    })

    register({
      name: 'diag',
      description: '崩溃归因（读取 crash-report / latest.log）',
      run: async () => {
        const result = await diagnose.run(instances.active().id)
        if (!result.found) return result.summary
        return [`归因：${result.summary}（${result.category}）`, ...result.suggestions.map((s) => `- ${s}`)].join('\n')
      },
    })
  })
}
