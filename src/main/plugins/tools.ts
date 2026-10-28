/**
 * 工具注册表（P4）：把启动器能力暴露成模型可调用的函数。
 *
 * 每个工具 = 权限点 + 审计点。P4 全部是用户级操作；后续插件市场的第三方工具走权限分级。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ToolCallTrace } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { ConflictService } from './conflict'
import type { ContentService } from './content'
import type { DiagnoseService } from './diagnose'
import type { InstancesService } from './instances'
import type { JavaService } from './java'
import type { LaunchService } from './launch'
import type { LlmToolSpec } from './llm'
import type { LoadersService } from './loaders'
import type { LogService } from './logger'
import type { MojangService } from './mojang'
import type { TelemetryService } from './telemetry'

export interface ToolResult {
  ok: boolean
  summary: string
  data?: unknown
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler(args: Record<string, unknown>): Promise<ToolResult>
  /** 来源：内置 or 插件 id */
  source?: string
}

export interface ToolsService {
  specs(): LlmToolSpec[]
  names(): string[]
  call(name: string, args: unknown): Promise<ToolResult>
  /** 动态注册（插件宿主 / AI 生成的插件用） */
  register(definition: ToolDefinition): void
  unregister(name: string): void
}

const EMPTY_PARAMS = { type: 'object', properties: {}, additionalProperties: false }

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function createToolsPlugin(): LauncherPlugin<void> {
  return definePlugin('tools', () => (ctx) => {
    const instances = use<InstancesService>(ctx, 'instances')
    const mojang = use<MojangService>(ctx, 'mojang')
    const java = use<JavaService>(ctx, 'java')
    const loaders = use<LoadersService>(ctx, 'loaders')
    const content = use<ContentService>(ctx, 'content')
    const conflict = use<ConflictService>(ctx, 'conflict')
    const diagnose = use<DiagnoseService>(ctx, 'diagnose')
    const launch = use<LaunchService>(ctx, 'launch')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    const registry = new Map<string, ToolDefinition>()

    const register = (definition: ToolDefinition) => {
      registry.set(definition.name, definition)
    }

    const instance = () => instances.active()
    const activeId = () => instance().id

    register({
      name: 'get_status',
      description: '查看启动器与当前实例状态：游戏版本、加载器、内存、玩家名、已装模组数、可用 Java、游戏是否在运行。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const inst = instance()
        const mods = await content.installed(activeId())
        const runtimes = await java.detect()
        const running = launch.current()
        const lines = [
          `实例：${inst?.name ?? '无'}（${inst?.id ?? '-'}）`,
          `游戏版本：${inst?.gameVersion ?? '未绑定'} / 加载器：${inst?.loader ?? 'vanilla'}`,
          `内存：${inst?.memoryMb ?? 0} MB / 玩家名：${inst?.playerName ?? '-'}`,
          `已装模组：${mods.filter((m) => m.enabled !== false).length} 个（共 ${mods.length}）`,
          `可用 Java：${runtimes.length} 个（主版本 ${[...new Set(runtimes.map((r) => r.major))].join(', ')}）`,
          `游戏状态：${running ? `运行中 PID ${running.pid}` : '未运行'}`,
        ]
        return { ok: true, summary: lines.join('；') }
      },
    })

    register({
      name: 'search_mods',
      description:
        '在 Modrinth 搜索模组（自动按当前实例的游戏版本与加载器过滤）。返回 slug、标题、下载量。安装前先用它确认 slug。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，例如 sodium / jei / 优化' },
          limit: { type: 'number', description: '返回条数，默认 5，最多 10' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async handler(args) {
        const inst = instance()
        const hits = await content.search(str(args.query), {
          type: 'mod',
          mcVersion: inst?.gameVersion,
          loader: inst?.loader === 'fabric' ? 'fabric' : undefined,
          limit: Math.min(10, Math.max(1, num(args.limit, 5))),
        })
        if (hits.length === 0) return { ok: true, summary: '没有搜到匹配的模组' }
        const summary = hits
          .map((hit) => `${hit.slug}（${hit.title}，${Math.round(hit.downloads / 1000)}k 下载）`)
          .join('；')
        return { ok: true, summary: `找到 ${hits.length} 个：${summary}`, data: hits }
      },
    })

    register({
      name: 'install_mod',
      description:
        '安装一个模组到当前实例（自动匹配游戏版本与加载器，递归安装 required 前置）。参数是 Modrinth 的 slug。',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Modrinth 项目 slug，例如 sodium' },
        },
        required: ['slug'],
        additionalProperties: false,
      },
      async handler(args) {
        const inst = instance()
        const result = await content.install(activeId(), str(args.slug), {
          mcVersion: inst?.gameVersion,
          loader: inst?.loader === 'fabric' ? 'fabric' : undefined,
        })
        if (!result.ok) return { ok: false, summary: `安装失败：${result.error ?? '未知错误'}` }
        return {
          ok: true,
          summary: `已安装 ${result.title ?? args.slug} ${result.versionNumber ?? ''} → ${result.files.join('、')}`,
          data: result,
        }
      },
    })

    register({
      name: 'list_mods',
      description: '列出当前实例已安装的模组文件与启用状态。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const mods = await content.installed(activeId())
        if (mods.length === 0) return { ok: true, summary: '当前实例还没有安装任何模组' }
        const summary = mods
          .map((mod) => `${mod.fileName}${mod.enabled === false ? '（已禁用）' : ''}`)
          .join('；')
        return { ok: true, summary, data: mods }
      },
    })

    register({
      name: 'analyze_conflicts',
      description: '静态冲突检查：重复 modid、缺少前置、加载器不匹配、模组互斥（breaks）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const report = conflict.analyze(activeId())
        if (report.issues.length === 0) {
          return { ok: true, summary: `检查了 ${report.mods.length} 个模组，没有发现冲突`, data: report }
        }
        const summary = report.issues
          .map((issue) => `[${issue.severity}] ${issue.message} → ${issue.suggestion}`)
          .join('；')
        return { ok: true, summary: `发现 ${report.issues.length} 个问题：${summary}`, data: report }
      },
    })

    register({
      name: 'diagnose_crash',
      description: '崩溃归因：读取最近一次 crash-report / latest.log，判断原因（缺前置、Mixin、OOM、Java 版本等）并给建议。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const result = await diagnose.run(activeId())
        if (!result.found) return { ok: true, summary: result.summary, data: result }
        return {
          ok: true,
          summary: `${result.summary}；建议：${result.suggestions.slice(0, 3).join('；')}`,
          data: result,
        }
      },
    })

    register({
      name: 'read_game_log',
      description: '读取游戏最新日志的最后若干行（默认 40 行，最多 200 行），用于排查问题。',
      parameters: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: '行数，默认 40' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const inst = instance()
        if (!inst) return { ok: false, summary: '没有实例' }
        const file = path.join(inst.gameDir, 'logs', 'latest.log')
        if (!existsSync(file)) return { ok: false, summary: '还没有游戏日志（先启动一次游戏）' }
        const all = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
        const take = Math.min(200, Math.max(1, num(args.lines, 40)))
        const tail = all.slice(-take).join('\n')
        return { ok: true, summary: `最后 ${take} 行：\n${tail.slice(0, 6000)}` }
      },
    })

    register({
      name: 'launch_game',
      description: '启动当前实例的游戏。用户说“开玩/启动/进游戏”时调用。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const result = await launch.start(activeId())
        if (!result.ok) return { ok: false, summary: `启动失败：${result.error ?? '未知错误'}` }
        return { ok: true, summary: `已启动 ${result.versionId}（PID ${result.pid ?? '?'}，玩家 ${result.playerName}）` }
      },
    })

    register({
      name: 'stop_game',
      description: '结束正在运行的游戏进程。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const running = launch.current()
        if (!running) return { ok: true, summary: '游戏本来就没在运行' }
        await launch.stop()
        return { ok: true, summary: '已结束游戏进程' }
      },
    })

    register({
      name: 'install_version',
      description:
        '下载并安装一个原版游戏版本（如 1.21.11），装完会绑定到当前实例。耗时较长（几百 MB），调用前先确认用户真的要装。',
      parameters: {
        type: 'object',
        properties: {
          versionId: { type: 'string', description: 'Mojang 版本号，例如 1.21.11' },
        },
        required: ['versionId'],
        additionalProperties: false,
      },
      async handler(args) {
        const versionId = str(args.versionId)
        const result = await mojang.install(versionId, `tool-install-${Date.now()}`)
        if (!result.ok) return { ok: false, summary: `安装失败：${result.error}` }
        instances.setVersion(activeId(), versionId, versionId)
        return { ok: true, summary: `已安装 ${versionId}（Java ${result.javaMajor}，用时 ${Math.round(result.ms / 1000)}s）` }
      },
    })

    register({
      name: 'install_fabric',
      description: '给当前原版版本安装 Fabric 加载器（装完就能装模组）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const inst = instance()
        const gameVersion = inst?.gameVersion
        if (!gameVersion) return { ok: false, summary: '实例还没有绑定游戏版本，先装原版' }
        const result = await loaders.installFabric(gameVersion)
        if (!result.ok) return { ok: false, summary: `Fabric 安装失败：${result.error}` }
        instances.setVersion(activeId(), result.versionId!, gameVersion, gameVersion, 'fabric')
        return { ok: true, summary: `已安装 Fabric ${result.loaderVersion}（${result.libraries} 个库）` }
      },
    })

    register({
      name: 'set_memory',
      description: '设置当前实例的内存分配（MB），范围 512–32768。',
      parameters: {
        type: 'object',
        properties: {
          mb: { type: 'number', description: '内存大小（MB），例如 4096' },
        },
        required: ['mb'],
        additionalProperties: false,
      },
      async handler(args) {
        const mb = Math.min(32768, Math.max(512, Math.round(num(args.mb, 4096))))
        instances.setMemory(activeId(), mb)
        return { ok: true, summary: `内存已设为 ${mb} MB` }
      },
    })

    async function call(name: string, rawArgs: unknown): Promise<ToolResult> {
      const definition = registry.get(name)
      if (!definition) return { ok: false, summary: `没有这个工具：${name}` }
      const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
      const started = Date.now()
      try {
        const result = await definition.handler(args)
        telemetry.record('tool:call', {
          tool: name,
          ok: result.ok,
          ms: Date.now() - started,
        })
        log.info('tools', '工具调用', { tool: name, ok: result.ok, ms: Date.now() - started })
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        telemetry.record('tool:error', { tool: name, error: message })
        log.warn('tools', '工具调用失败', { tool: name, error: message })
        return { ok: false, summary: `工具执行失败：${message}` }
      }
    }

    ctx.provide('tools', {
      specs: () =>
        [...registry.values()].map((definition) => ({
          type: 'function' as const,
          function: {
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
          },
        })),
      names: () => [...registry.keys()],
      call,
      register: (definition) => {
        if (registry.has(definition.name)) {
          log.warn('tools', '工具名冲突，已覆盖', { tool: definition.name, source: definition.source })
        }
        registry.set(definition.name, definition)
        log.info('tools', '工具已注册', { tool: definition.name, source: definition.source ?? 'builtin' })
      },
      unregister: (name) => {
        const existed = registry.delete(name)
        if (existed) log.info('tools', '工具已注销', { tool: name })
      },
    } satisfies ToolsService)

    log.info('tools', '工具注册完成', { tools: [...registry.keys()] })
  })
}
