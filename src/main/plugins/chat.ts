import type { ChatReply } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { EntitlementService } from './entitlement'
import type { IdentityService } from './identity'
import type { InstancesService } from './instances'
import type { LogService } from './logger'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'
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
  commands(): { name: string; description: string }[]
}

export function createChatPlugin(): LauncherPlugin<void> {
  return definePlugin('chat', () => (ctx) => {
    const log = use<LogService>(ctx, 'log')
    const updater = use<UpdaterService>(ctx, 'updater')
    const instances = use<InstancesService>(ctx, 'instances')
    const settings = use<SettingsService>(ctx, 'settings')
    const identity = use<IdentityService>(ctx, 'identity')
    const entitlement = use<EntitlementService>(ctx, 'entitlement')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    const registry = new Map<string, CommandSpec>()

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
          const hasKey = settings.get('apiKey').length > 0
          return {
            ok: true,
            kind: 'text',
            text: hasKey
              ? '已检测到本地 API Key，但 AI 代理（工具调用链）要到 P4 才接入。\n现在可以先用 /help 看看内置命令。'
              : 'AI 代理尚未接入（P4）。现在可以先用 /help 看内置命令；API Key 只存本地，不会上传。',
          }
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
      commands: () => [...registry.values()].map((c) => ({ name: c.name, description: c.description })),
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
        const inst = instances.list()[0]
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
          return `发现新版本 ${state.latest}（当前 ${state.current}）${state.mustUpdate ? '，必须更新' : ''}。P5 接入自动下载。`
        }
        return `已是最新版本 ${state.current}。`
      },
    })

    register({
      name: 'instance',
      description: '查看实例目录结构（版本隔离）',
      run: () => {
        const inst = instances.list()[0]
        if (!inst) return '还没有实例。'
        return [
          `实例：${inst.name}（${inst.id}）`,
          `目录：${inst.path}`,
          '隔离目录：mods / resourcepacks / shaderpacks / saves / config / logs / crash-reports',
          '全局共享（P1 接入）：assets / libraries / java / 下载缓存',
        ].join('\n')
      },
    })
  })
}
