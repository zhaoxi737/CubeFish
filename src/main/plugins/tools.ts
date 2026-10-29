/**
 * 工具注册表（P4）：把启动器能力暴露成模型可调用的函数。
 *
 * 每个工具 = 权限点 + 审计点。P4 全部是用户级操作；后续插件市场的第三方工具走权限分级。
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ToolCallTrace } from '../../shared/types'
import { writeTextAtomic } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { ConflictService } from './conflict'
import type { ContentService } from './content'
import type { DiagnoseService } from './diagnose'
import type { InstancesService } from './instances'
import type { JavaService } from './java'
import type { LaunchService } from './launch'
import type { LlmToolSpec } from './llm'
import type { AuthService } from './auth'
import type { LoadersService } from './loaders'
import type { LogService } from './logger'
import type { MojangService } from './mojang'
import type { PathsService } from './paths'
import type { PluginHostService } from './plugin-host'
import type { SettingsService } from './settings'
import type { SystemService } from './system'
import type { TelemetryService } from './telemetry'
import type { UpdaterService } from './updater'

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

const execFileAsync = promisify(execFile)

/** P33：只读诊断命令白名单（不接受任意参数，杜绝命令注入 / 任意代码执行） */
const SAFE_COMMANDS: Record<string, { exe: string; args: string[]; label: string }> = {
  java_version: { exe: 'java', args: ['-version'], label: 'Java 版本' },
  where_java: { exe: 'where', args: ['java'], label: 'java.exe 路径' },
  where_javaw: { exe: 'where', args: ['javaw'], label: 'javaw.exe 路径' },
  gpu: { exe: 'nvidia-smi', args: [], label: '显卡信息' },
  network: { exe: 'ipconfig', args: ['/all'], label: '网络配置' },
  processes: { exe: 'tasklist', args: ['/FI', 'IMAGENAME eq javaw.exe'], label: 'Java 进程' },
  git_version: { exe: 'git', args: ['--version'], label: 'git 版本' },
  node_version: { exe: 'node', args: ['--version'], label: 'node 版本' },
}

/** P33：允许 AI 自己修改的设置键（不含敏感凭据之外的破坏性项） */
const AI_SETTINGS_KEYS = [
  'memoryMb',
  'playerName',
  'downloadSource',
  'downloadThreads',
  'isolatedMods',
  'useHighPerformanceGpu',
  'launchWindowWidth',
  'launchWindowHeight',
  'launchFullscreen',
  'jvmArgs',
  'themeAccent',
  'customBackground',
  'titleText',
  'autoCheckUpdate',
  'preferredJavaPath',
  'llmBaseUrl',
  'llmModel',
] as const

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
    const auth = use<AuthService>(ctx, 'auth')
    const content = use<ContentService>(ctx, 'content')
    const conflict = use<ConflictService>(ctx, 'conflict')
    const diagnose = use<DiagnoseService>(ctx, 'diagnose')
    const launch = use<LaunchService>(ctx, 'launch')
    const paths = use<PathsService>(ctx, 'paths')
    const settings = use<SettingsService>(ctx, 'settings')
    const updater = use<UpdaterService>(ctx, 'updater')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    // 懒取 pluginHost：它依赖 tools，不能在 tools 初始化时反向 use（会成环）
    const host = (): PluginHostService => {
      const svc = ctx.get('pluginHost') as PluginHostService | undefined
      if (!svc) throw new Error('插件宿主尚未就绪')
      return svc
    }

    // 懒取 system：它在 tools 之后注册
    const sys = (): SystemService => {
      const svc = ctx.get('system') as SystemService | undefined
      if (!svc) throw new Error('系统服务尚未就绪')
      return svc
    }

    /** P39：找到启动器源码目录（改源码 / 重新构建用） */
    const repoRoot = (): string => {
      const candidates: string[] = []
      if (process.env.QDOQMC_REPO) candidates.push(process.env.QDOQMC_REPO)
      const push = (start: string): void => {
        let dir = start
        for (let level = 0; level < 5; level += 1) {
          candidates.push(dir)
          const parent = path.dirname(dir)
          if (parent === dir) break
          dir = parent
        }
      }
      candidates.push(process.cwd())
      try {
        push(path.dirname(app.getPath('exe')))
      } catch {
        /* 忽略 */
      }
      if (process.resourcesPath) push(path.dirname(process.resourcesPath))
      for (const dir of candidates) {
        try {
          const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }
          if (pkg.name === 'qdoqmc') return dir
        } catch {
          /* 继续找 */
        }
      }
      throw new Error('找不到启动器源码目录：把它放回开发目录，或设置环境变量 QDOQMC_REPO 指向源码根目录')
    }

    /** P39：源码路径校验：只允许 src 下的文件 */
    const sourcePath = (relInput: string): string => {
      const root = repoRoot()
      const rel = String(relInput).replace(/\\/g, '/')
      if (!rel || rel.includes('..') || rel.startsWith('/')) throw new Error('源码路径必须相对 src/，不允许 .. 或绝对路径')
      const full = path.join(root, 'src', rel)
      if (!full.startsWith(path.join(root, 'src') + path.sep)) throw new Error('只允许改 src/ 目录里的文件')
      return full
    }

    // ---- P33：文件 / 网络 / 重启（缩小与 harness 的差距）----
    const readRoots = () => [paths.data, paths.instances, paths.logs, paths.meta, paths.versions]
    const inScope = (target: string, roots: string[]): boolean => {
      const resolved = path.resolve(target)
      return roots.some((root) => {
        const r = path.resolve(root)
        return resolved === r || resolved.startsWith(r + path.sep)
      })
    }
    const resolveReadPath = (input: string): string => {
      const p = path.isAbsolute(input) ? input : path.join(instance()?.gameDir ?? paths.instances, input)
      if (!inScope(p, readRoots())) throw new Error(`路径不在允许范围内：${p}`)
      return p
    }

    const registry = new Map<string, ToolDefinition>()
    /** P38：避免 AI 反复应用同一个冲突修复（会把已修好的版本又装回来） */
    const appliedConflictFixes = new Set<string>()

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
      name: 'export_instance',
      description: '把当前实例导出成 zip（含 mods / config / 存档，跳过日志与缓存），方便备份或迁移。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const result = await instances.exportInstance(activeId())
        if (!result.ok) return { ok: false, summary: `导出失败：${result.error}` }
        return {
          ok: true,
          summary: `已导出到 ${result.path}（${result.files} 个文件，${Math.round((result.bytes ?? 0) / 1024)} KB）`,
          data: result,
        }
      },
    })

    register({
      name: 'import_instance',
      description: '从导出包 zip 导入为新实例。参数是 zip 路径。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '导出包 zip 路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        const source = str(args.path).trim()
        if (!source) return { ok: false, summary: '需要 zip 路径' }
        const result = await instances.importInstance(source)
        if (!result.ok || !result.instance) return { ok: false, summary: `导入失败：${result.error ?? '未知错误'}` }
        return { ok: true, summary: `已导入实例「${result.instance.name}」（${result.instance.id}）` }
      },
    })

    register({
      name: 'bind_instance_account',
      description: '把当前实例绑定到某个微软账号（传 uuid）；不传 uuid 则解绑，回到跟随全局账号。',
      parameters: {
        type: 'object',
        properties: { uuid: { type: 'string', description: '微软账号 UUID（auth.accounts 里可查）' } },
        required: [],
        additionalProperties: false,
      },
      async handler(args) {
        const uuid = str(args.uuid).trim()
        if (!uuid) {
          instances.setAccount(activeId())
          return { ok: true, summary: '已解绑：该实例将跟随全局当前账号' }
        }
        const account = auth.accountById(uuid)
        if (!account) return { ok: false, summary: `账号不存在：${uuid}` }
        instances.setAccount(activeId(), account.uuid, account.name)
        return { ok: true, summary: `已把当前实例绑定到「${account.name}」` }
      },
    })

    register({
      name: 'install_curse_pack',
      description: '从本机 .zip 安装 CurseForge 整合包（需要 CurseForge API Key 才能下载清单里的模组；自带 mods 的包不需要）。参数是 zip 路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '整合包 zip 的绝对路径' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        const source = str(args.path).trim()
        if (!source) return { ok: false, summary: '需要整合包 zip 路径' }
        const result = await content.installCursePack(source)
        if (!result.ok) return { ok: false, summary: `整合包安装失败：${result.error}` }
        return {
          ok: true,
          summary: `已安装「${result.packName}」到实例 ${result.instanceId}（${result.loader} ${result.mcVersion}，下载 ${result.resolved} 个模组，自带 ${result.bundled} 个）`,
        }
      },
    })

    register({
      name: 'install_forge',
      description: '给当前原版版本安装 Forge 加载器（1.20.1 等经典版本，需先装对应原版）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const inst = instance()
        const gameVersion = inst?.gameVersion
        if (!gameVersion) return { ok: false, summary: '实例还没有绑定游戏版本，先装原版' }
        const result = await loaders.installForge(gameVersion)
        if (!result.ok) return { ok: false, summary: `Forge 安装失败：${result.error}` }
        instances.setVersion(activeId(), result.versionId!, gameVersion, gameVersion, 'forge')
        return { ok: true, summary: `已安装 Forge ${result.loaderVersion}` }
      },
    })

    register({
      name: 'install_neoforge',
      description: '给当前原版版本安装 NeoForge 加载器（支持 1.20.2 及以上，需 Java 17/21）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const inst = instance()
        const gameVersion = inst?.gameVersion
        if (!gameVersion) return { ok: false, summary: '实例还没有绑定游戏版本，先装原版' }
        const result = await loaders.installNeoForge(gameVersion)
        if (!result.ok) return { ok: false, summary: `NeoForge 安装失败：${result.error}` }
        instances.setVersion(activeId(), result.versionId!, gameVersion, gameVersion, 'neoforge')
        return { ok: true, summary: `已安装 NeoForge ${result.loaderVersion}` }
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
      name: 'fix_mod_conflict',
      description:
        '一键解决「模组版本互相冲突」（例如 Iris 要求 Sodium 0.6.x 但装了 0.8.x）：自动读报错、解析冲突、换成兼容版本并安装。用户说“模组不兼容/进不去游戏/提示 Incompatible mods”时优先用这个，一步到位。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const instanceId = activeId()
        const diagnosis = await diagnose.run(instanceId)
        if (!diagnosis.found) {
          return { ok: false, summary: `没读到崩溃/报错信息：${diagnosis.summary}`, data: diagnosis }
        }
        if (diagnosis.category !== 'mod-version-conflict') {
          return {
            ok: false,
            summary: `这次不是模组版本冲突（诊断：${diagnosis.category} / ${diagnosis.summary}）。可以改用 diagnose_crash 看详情。`,
            data: diagnosis,
          }
        }
        const actions = await diagnose.fixes(instanceId)
        const versionFix = actions.find((action) => action.kind === 'install-version')
        if (!versionFix) {
          return {
            ok: false,
            summary: `识别到版本冲突，但没在 Modrinth 找到可用的兼容版本。${diagnosis.summary}`,
            data: { diagnosis, actions },
          }
        }
        const fixKey = `${instanceId}:${versionFix.id}`
        if (appliedConflictFixes.has(fixKey)) {
          return {
            ok: false,
            summary: `这个修复已经应用过：${versionFix.label}。如果游戏还报错，请换方案（比如先禁用 Iris 或 Sodium），或重启游戏再试。`,
            data: { diagnosis, actions },
          }
        }
        const result = await diagnose.applyFix(instanceId, versionFix.id)
        if (result.ok) appliedConflictFixes.add(`${instanceId}:${versionFix.id}`)
        return {
          ok: result.ok,
          summary: result.ok ? `${versionFix.label} → ${result.message}` : `修复失败：${result.message}`,
          data: { diagnosis, actions, result },
        }
      },
    })

    register({
      name: 'auto_fix_crash',
      description:
        '按最近一次崩溃归因给出一键修复动作；传 fixId 则直接执行该修复（如禁用可疑模组、调大内存、安装缺失前置）。',
      parameters: {
        type: 'object',
        properties: {
          fixId: { type: 'string', description: '要执行的修复 id；不传则只列出可用修复' },
        },
        required: [],
        additionalProperties: false,
      },
      async handler(args) {
        const instanceId = activeId()
        const fixId = str(args.fixId).trim()
        if (!fixId) {
          const [diagnosis, fixes] = await Promise.all([diagnose.run(instanceId), diagnose.fixes(instanceId)])
          if (fixes.length === 0) return { ok: true, summary: `诊断：${diagnosis.summary}；没有可自动修复的动作`, data: fixes }
          const list = fixes.map((fix) => `${fix.id}（${fix.label}）`).join('；')
          return { ok: true, summary: `诊断：${diagnosis.summary}。可执行修复：${list}`, data: fixes }
        }
        const result = await diagnose.applyFix(instanceId, fixId)
        return { ok: result.ok, summary: result.message }
      },
    })

    register({
      name: 'list_plugins',
      description: '列出本机已安装的插件及其状态（id、名称、是否加载、注册了哪些工具/命令）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const plugins = host().list()
        if (plugins.length === 0) return { ok: true, summary: '本机还没有安装任何插件' }
        const summary = plugins
          .map(
            (p) =>
              `${p.id}（${p.name}）· 加载=${p.loaded ? '是' : '否'} · 工具=${(p.tools ?? []).join(',') || '无'} · 命令=${(p.commands ?? []).join(',') || '无'}`,
          )
          .join('\n')
        return { ok: true, summary, data: plugins }
      },
    })

    register({
      name: 'write_plugin',
      description:
        '写并安装一个新插件，给启动器增加新能力（自我扩展 / 自己写插件）。插件是一个 ESM 模块，导出 apply(api)。参数 code 是完整的 index.mjs 源码；id 要唯一。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '插件 id，小写字母/数字/._-，唯一' },
          name: { type: 'string', description: '显示名' },
          description: { type: 'string', description: '这个插件做什么' },
          code: { type: 'string', description: '完整 index.mjs 源码，导出 export function apply(api)' },
          permissions: { type: 'array', items: { type: 'string', enum: ['read', 'net', 'exec'] }, description: '权限，默认 []' },
        },
        required: ['id', 'name', 'code'],
        additionalProperties: false,
      },
      async handler(args) {
        const info = await host().installFromSource({
          id: str(args.id),
          name: str(args.name),
          description: str(args.description),
          permissions: (Array.isArray(args.permissions) ? args.permissions : []).map(String) as never,
          code: str(args.code),
        })
        return {
          ok: true,
          summary: `插件 ${info.id} 已安装并加载。注册工具：${(info.tools ?? []).join(', ') || '无'}；命令：${(info.commands ?? []).join(', ') || '无'}`,
          data: info,
        }
      },
    })

    register({
      name: 'remove_plugin',
      description: '卸载并删除一个插件（id 见 list_plugins）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '插件 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      async handler(args) {
        const result = await host().remove(str(args.id))
        return result.ok ? { ok: true, summary: `插件 ${String(args.id)} 已删除` } : { ok: false, summary: result.error ?? '删除失败' }
      },
    })

    register({
      name: 'reload_plugin',
      description: '热重载一个已安装的插件（改完代码后让它重新加载；不改变磁盘上的代码）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '插件 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      async handler(args) {
        const info = await host().reload(str(args.id))
        return {
          ok: true,
          summary: `插件 ${info.id} 已重载。注册工具：${(info.tools ?? []).join(', ') || '无'}；命令：${(info.commands ?? []).join(', ') || '无'}`,
          data: info,
        }
      },
    })

    register({
      name: 'list_tools',
      description:
        '列出你现在实际拥有的全部工具（名称 + 说明）。用户问「你能做什么 / 有没有某功能 / 能不能写插件」时，先调这个再回答，不要凭印象说「没有这个功能」。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const names = [...registry.keys()]
        const summary = names.map((name) => `- ${name}：${registry.get(name)?.description ?? ''}`).join('\n')
        return { ok: true, summary: `共 ${names.length} 个工具：\n${summary}`, data: names }
      },
    })

    register({
      name: 'list_plugin_buttons',
      description: '列出插件已经加到启动器界面（顶栏）的按钮。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const items = host().buttons()
        if (items.length === 0) return { ok: true, summary: '目前没有插件往界面加按钮' }
        return {
          ok: true,
          summary: items.map((item) => `${item.label}（插件 ${item.pluginId} / id ${item.id}）`).join('\n'),
          data: items,
        }
      },
    })

    register({
      name: 'press_plugin_button',
      description: '执行某个插件界面按钮的动作（用于验证按钮可用）。',
      parameters: {
        type: 'object',
        properties: {
          pluginId: { type: 'string', description: '插件 id' },
          buttonId: { type: 'string', description: '按钮 id' },
        },
        required: ['pluginId', 'buttonId'],
        additionalProperties: false,
      },
      async handler(args) {
        const result = await host().press(str(args.pluginId), str(args.buttonId))
        return { ok: result.ok, summary: result.summary || (result.ok ? '按钮执行完成' : '按钮执行失败') }
      },
    })

    register({
      name: 'system_info',
      description: '查看这台电脑的系统信息（系统版本 / CPU / 内存 / 开机时长）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const i = sys().info()
        const hours = Math.round(i.uptimeSec / 3600)
        return {
          ok: true,
          summary: `系统：${i.platform} ${i.release}（${i.arch}）· CPU：${i.cpuModel} ×${i.cpus} · 内存 ${i.freeMemMb}/${i.totalMemMb} MB 可用 · 已开机 ${hours} 小时`,
          data: i,
        }
      },
    })

    register({
      name: 'speak_text',
      description: '用这台电脑的喇叭把一段文字读出来（语音播报）。适合播报结果、提醒。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要朗读的文字（不要太长）' } },
        required: ['text'],
        additionalProperties: false,
      },
      async handler(args) {
        const text = str(args.text).trim()
        if (!text) return { ok: false, summary: 'text 为空' }
        const result = await sys().speak(text.slice(0, 500))
        if (!result.ok) return { ok: false, summary: result.error ?? '朗读失败' }
        return { ok: true, summary: `已用${result.how === 'renderer' ? '喇叭' : '系统语音'}朗读：${text.slice(0, 60)}` }
      },
    })

    register({
      name: 'list_recordings',
      description: '列出用麦克风录过的音频文件（在启动器的 recordings 目录）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const items = sys().listRecordings()
        if (items.length === 0) return { ok: true, summary: '还没有录音。界面上点「系统」→ 开始录音。' }
        return {
          ok: true,
          summary: items.map((item) => `${item.name}（${Math.round(item.bytes / 1024)} KB）`).join('\n'),
          data: items,
        }
      },
    })

    register({
      name: 'read_file',
      description:
        '读取启动器目录里的文本文件（配置 / 日志 / 插件源码 / 崩溃报告 / options.txt 等）。传绝对路径，或相对当前实例游戏目录的路径。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        const file = resolveReadPath(str(args.path))
        if (!existsSync(file)) return { ok: false, summary: `文件不存在：${file}` }
        const info = statSync(file)
        if (info.isDirectory()) return { ok: false, summary: `这是目录，用 list_dir 查看：${file}` }
        if (info.size > 200 * 1024) return { ok: false, summary: `文件太大（${info.size} 字节），不读取` }
        const text = readFileSync(file, 'utf8')
        // P34：不把 API Key / 令牌明文返回给模型（settings.json 里有 Key）
        const redacted = text
          .replace(/("(?:apiKey|curseforgeApiKey|msAccessToken|msRefreshToken|token|secret)"\s*:\s*")[^"]*(")/gi, '$1***已隐藏***$2')
          .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, 'sk-***已隐藏***')
        return { ok: true, summary: redacted.slice(0, 60000) || '（空文件）' }
      },
    })

    register({
      name: 'write_file',
      description:
        '往当前实例的游戏目录里写一个文本文件（例如改 options.txt、加/改配置）。路径相对游戏目录，不允许 .. 或绝对路径，不能覆盖实例配置。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对游戏目录的路径，如 options.txt 或 config/xx.properties' },
          content: { type: 'string', description: '要写入的内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async handler(args) {
        const inst = instance()
        if (!inst) return { ok: false, summary: '没有当前实例' }
        const rel = str(args.path).replace(/\\/g, '/')
        if (!rel || rel.includes('..') || rel.startsWith('/')) {
          return { ok: false, summary: '路径必须相对游戏目录，不允许 .. 或绝对路径' }
        }
        const content = String(args.content)
        if (content.length > 1024 * 1024) return { ok: false, summary: '内容超过 1MB' }
        const file = path.join(inst.gameDir, rel)
        if (!inScope(file, [inst.gameDir]) || /instance\.json$/i.test(file)) {
          return { ok: false, summary: '只允许写实例游戏目录内，且不能覆盖实例配置' }
        }
        mkdirSync(path.dirname(file), { recursive: true })
        await writeTextAtomic(file, content)
        return { ok: true, summary: `已写入 ${rel}（${content.length} 字节）` }
      },
    })

    register({
      name: 'list_dir',
      description: '列目录内容（启动器数据目录或实例目录）。传绝对路径，或相对当前实例游戏目录的路径。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录路径（留空 = 当前实例游戏目录）' } },
        required: [],
        additionalProperties: false,
      },
      async handler(args) {
        const input = str(args.path).trim()
        const dir = input ? resolveReadPath(input) : (instance()?.gameDir ?? paths.instances)
        if (!existsSync(dir)) return { ok: false, summary: `目录不存在：${dir}` }
        const entries = readdirSync(dir, { withFileTypes: true })
          .slice(0, 100)
          .map((entry) => {
            const full = path.join(dir, entry.name)
            let size = ''
            try {
              if (!entry.isDirectory()) size = ` (${statSync(full).size} 字节)`
            } catch {
              /* 忽略 */
            }
            return `${entry.isDirectory() ? '[目录] ' : ''}${entry.name}${size}`
          })
        return { ok: true, summary: `${dir}\n${entries.join('\n') || '（空）'}` }
      },
    })

    register({
      name: 'web_fetch',
      description: '抓取一个网页/接口的文字内容（只允许 https，用于查资料，例如模组说明、报错原因）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'https 链接' } },
        required: ['url'],
        additionalProperties: false,
      },
      async handler(args) {
        const url = str(args.url).trim()
        if (!/^https:\/\//i.test(url)) return { ok: false, summary: '只允许 https 链接' }
        const res = await fetch(url, { headers: { 'user-agent': 'QDOQMC/0.1.0' }, signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return { ok: false, summary: `HTTP ${res.status}` }
        const text = await res.text()
        return { ok: true, summary: text.slice(0, 20000) || '（空内容）' }
      },
    })

    register({
      name: 'restart_self',
      description: '重启启动器自身（app.relaunch），用于让某些改动完全生效。',
      parameters: EMPTY_PARAMS,
      async handler() {
        app.relaunch()
        app.exit(0)
        return { ok: true, summary: '正在重启启动器…' }
      },
    })

    // ---- P35：把 harness 的 agent 层能力搬进来（精确编辑 / 内容搜索 / 记忆 / 联网搜索）----
    const memoryFile = path.join(paths.data, 'ai-memory.json')
    const readMemory = (): { content: string; kind?: string; ts: number }[] => {
      try {
        return JSON.parse(readFileSync(memoryFile, 'utf8')) as { content: string; kind?: string; ts: number }[]
      } catch {
        return []
      }
    }

    register({
      name: 'edit_file',
      description: '把当前实例目录里某个文本文件中的一段文字精确替换成另一段（只匹配一次），改配置/options.txt 用这个比 write_file 更安全。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对游戏目录的路径' },
          old: { type: 'string', description: '要替换掉的原文片段（要唯一）' },
          new: { type: 'string', description: '替换成的新内容' },
        },
        required: ['path', 'old', 'new'],
        additionalProperties: false,
      },
      async handler(args) {
        const inst = instance()
        if (!inst) return { ok: false, summary: '没有当前实例' }
        const rel = str(args.path).replace(/\\/g, '/')
        if (!rel || rel.includes('..') || rel.startsWith('/')) return { ok: false, summary: '路径必须相对游戏目录' }
        const file = path.join(inst.gameDir, rel)
        if (!inScope(file, [inst.gameDir]) || /instance\.json$/i.test(file)) return { ok: false, summary: '不允许改这个文件' }
        if (!existsSync(file)) return { ok: false, summary: `文件不存在：${file}` }
        const text = readFileSync(file, 'utf8')
        const oldText = String(args.old)
        if (!oldText) return { ok: false, summary: 'old 不能为空' }
        const count = text.split(oldText).length - 1
        if (count === 0) return { ok: false, summary: '没找到要替换的原文，先 read_file 确认内容' }
        if (count > 1) return { ok: false, summary: `匹配到 ${count} 处，请给更长的唯一片段` }
        await writeTextAtomic(file, text.replace(oldText, String(args.new)))
        return { ok: true, summary: `已替换 1 处（${rel}）` }
      },
    })

    register({
      name: 'search_files',
      description: '在启动器目录里按文件内容搜索文本（类似 grep），找配置/日志/模组信息时用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的文字' },
          path: { type: 'string', description: '在哪个目录下搜（留空=当前实例游戏目录）' },
          limit: { type: 'number', description: '最多返回条数，默认 40' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async handler(args) {
        const query = str(args.query)
        if (!query) return { ok: false, summary: 'query 不能为空' }
        const root = str(args.path).trim() ? resolveReadPath(str(args.path)) : (instance()?.gameDir ?? paths.instances)
        const limit = Math.min(100, Math.max(1, num(args.limit, 40)))
        const results: string[] = []
        let scanned = 0
        // 允许直接传一个文件：只搜这个文件
        try {
          const rootStat = statSync(root)
          if (rootStat.isFile()) {
            const text = readFileSync(root, 'utf8')
            const index = text.toLowerCase().indexOf(query.toLowerCase())
            if (index < 0) return { ok: true, summary: `没找到「${query}」（文件 ${path.basename(root)}）` }
            const line = text.slice(0, index).split('\n').length
            const snippet = text.slice(Math.max(0, index - 60), index + query.length + 60).replace(/\s+/g, ' ')
            return { ok: true, summary: `${path.basename(root)}:${line}: …${snippet}…`, data: [snippet] }
          }
        } catch {
          /* 根路径不存在时走目录分支 */
        }
        const skipDirs = new Set(['node_modules', '.git', 'assets', 'libraries', 'runtimes', 'cache'])
        const walk = (dir: string, depth: number): void => {
          if (results.length >= limit || scanned > 5000 || depth > 6) return
          let entries: { name: string; isDirectory(): boolean }[] = []
          try {
            entries = readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const entry of entries) {
            if (results.length >= limit) return
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!skipDirs.has(entry.name)) walk(full, depth + 1)
              continue
            }
            try {
              if (statSync(full).size > 512 * 1024) continue
            } catch {
              continue
            }
            scanned += 1
            try {
              const text = readFileSync(full, 'utf8')
              const index = text.toLowerCase().indexOf(query.toLowerCase())
              if (index < 0) continue
              const line = text.slice(0, index).split('\n').length
              const snippet = text.slice(Math.max(0, index - 60), index + query.length + 60).replace(/\s+/g, ' ')
              results.push(`${path.relative(root, full)}:${line}: …${snippet}…`)
            } catch {
              /* 二进制/编码问题忽略 */
            }
          }
        }
        walk(root, 0)
        return {
          ok: true,
          summary: results.length ? `找到 ${results.length} 处（扫了 ${scanned} 个文件）：\n${results.join('\n')}` : `没找到（扫了 ${scanned} 个文件）`,
          data: results,
        }
      },
    })

    register({
      name: 'remember',
      description: '把用户明确要求记住的信息存下来（跨会话保留，例如偏好、习惯、常用设置）。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的内容' },
          kind: { type: 'string', description: '类别，如 偏好/习惯/事实' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async handler(args) {
        const content = str(args.content).trim()
        if (!content) return { ok: false, summary: '内容为空' }
        const items = readMemory()
        if (!items.some((item) => item.content === content)) {
          items.push({ content: content.slice(0, 1000), kind: str(args.kind) || undefined, ts: Date.now() })
          await writeTextAtomic(memoryFile, JSON.stringify(items.slice(-200), null, 2))
        }
        return { ok: true, summary: `记住了：${content.slice(0, 80)}` }
      },
    })

    register({
      name: 'recall',
      description: '检索之前 remember 记住的信息（跨会话）。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '关键词，留空=看最近记住的' } },
        required: [],
        additionalProperties: false,
      },
      async handler(args) {
        const query = str(args.query).toLowerCase()
        const items = readMemory().filter((item) => !query || item.content.toLowerCase().includes(query))
        if (items.length === 0) return { ok: true, summary: '没有相关记忆' }
        return { ok: true, summary: items.slice(-20).map((item) => `- ${item.content}`).join('\n'), data: items }
      },
    })

    register({
      name: 'web_search',
      description: '联网搜索网页（DuckDuckGo），返回标题和链接。需要最新信息/查资料时用；要正文再配合 web_fetch。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query'],
        additionalProperties: false,
      },
      async handler(args) {
        const query = str(args.query).trim()
        if (!query) return { ok: false, summary: 'query 为空' }
        try {
          const res = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QDOQMC' },
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) return { ok: false, summary: `搜索失败：HTTP ${res.status}` }
          const html = await res.text()
          const items: string[] = []
          const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
          let match: RegExpExecArray | null
          while ((match = pattern.exec(html)) !== null && items.length < 8) {
            const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
            let href = match[1]
            const encoded = /[?&]uddg=([^&]+)/.exec(href)
            if (encoded) href = decodeURIComponent(encoded[1])
            items.push(`${title} — ${href}`)
          }
          return { ok: true, summary: items.length ? items.join('\n') : '搜索没有结果（可能被风控，试试换关键词或用 web_fetch 直接抓已知网址）' }
        } catch (err) {
          return { ok: false, summary: `搜索失败：${err instanceof Error ? err.message : String(err)}` }
        }
      },
    })

    register({
      name: 'run_command',
      description:
        '运行一条只读诊断命令（白名单，不能执行任意命令）。可用：java_version / where_java / where_javaw / gpu / network / processes / git_version / node_version。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', enum: Object.keys(SAFE_COMMANDS), description: '命令名' } },
        required: ['command'],
        additionalProperties: false,
      },
      async handler(args) {
        const key = str(args.command)
        const spec = SAFE_COMMANDS[key]
        if (!spec) return { ok: false, summary: `不支持的命令：${key}。可用：${Object.keys(SAFE_COMMANDS).join(', ')}` }
        try {
          const { stdout, stderr } = await execFileAsync(spec.exe, spec.args, {
            timeout: 10_000,
            windowsHide: true,
            maxBuffer: 512 * 1024,
          })
          const text = `${stdout}\n${stderr}`.trim()
          return { ok: true, summary: text.slice(0, 8000) || '（无输出）' }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { ok: false, summary: `命令执行失败（${spec.label}）：${message}` }
        }
      },
    })

    register({
      name: 'update_settings',
      description:
        '修改启动器设置（主题色、标题、内存、下载源、版本隔离、显卡、启动选项等）。只允许改白名单键，参数是键值对象。',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'object', description: '要改的设置，例如 {"themeAccent":"#ff3366","titleText":"我的启动器"}' },
        },
        required: ['patch'],
        additionalProperties: false,
      },
      async handler(args) {
        const raw = args.patch
        if (!raw || typeof raw !== 'object') return { ok: false, summary: 'patch 必须是对象' }
        const patch: Record<string, unknown> = {}
        const ignored: string[] = []
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if ((AI_SETTINGS_KEYS as readonly string[]).includes(key)) patch[key] = value
          else ignored.push(key)
        }
        if (Object.keys(patch).length === 0) {
          return { ok: false, summary: `没有可改的键（忽略：${ignored.join(', ') || '无'}）。可用：${AI_SETTINGS_KEYS.join(', ')}` }
        }
        const next = settings.patch(patch as never)
        return { ok: true, summary: `已更新设置：${Object.keys(patch).join(', ')}`, data: next }
      },
    })

    register({
      name: 'check_update',
      description: '检查启动器自身是否有新版本。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const state = await updater.check('chat')
        return {
          ok: true,
          summary: `当前 v${state.current}，状态：${state.status}${state.latest ? `，最新 v${state.latest}` : ''}`,
          data: state,
        }
      },
    })

    register({
      name: 'apply_update',
      description: '下载启动器更新（下载完成后重启生效）。只下载，不会在对话中途自动替换。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const state = await updater.download()
        if (state.status === 'ready') {
          return { ok: true, summary: `更新包 v${state.latest ?? '?'} 已下载，退出重启后生效。`, data: state }
        }
        return { ok: false, summary: state.message ?? '更新下载失败（可能没有配置更新地址）', data: state }
      },
    })

    register({
      name: 'deepseek_balance',
      description: '查询当前配置的 DeepSeek 账户余额（用启动器里保存的 Key 在后台查，不会把 Key 暴露出来）。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const key = settings.get('apiKey')
        if (!key) return { ok: false, summary: '还没配置模型 API Key（设置 → AI 助手）' }
        const base = settings
          .get('llmBaseUrl')
          .replace(/\/v1\/?$/i, '')
          .replace(/\/+$/, '')
        const url = `${base || 'https://api.deepseek.com'}/user/balance`
        try {
          const res = await fetch(url, {
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) return { ok: false, summary: `查询失败：HTTP ${res.status}（Key 无效或接口不支持余额查询）` }
          const data = (await res.json()) as {
            is_available?: boolean
            balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[]
          }
          const infos = (data.balance_infos ?? [])
            .map(
              (item) =>
                `${item.currency ?? '?'} 余额 ${item.total_balance ?? '?'}（赠送 ${item.granted_balance ?? '-'} / 充值 ${item.topped_up_balance ?? '-'}）`,
            )
            .join('；')
          return {
            ok: true,
            summary: `DeepSeek 账户可用：${data.is_available === false ? '否' : '是'}；${infos || '没有余额信息'}`,
            data,
          }
        } catch (err) {
          return { ok: false, summary: `查询失败：${err instanceof Error ? err.message : String(err)}` }
        }
      },
    })

    register({
      name: 'run_shell',
      description:
        '在系统 PowerShell 里执行任意命令（用户明确授权）。输出会截断到 2 万字符。危险操作自行判断。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 PowerShell 命令' },
          cwd: { type: 'string', description: '工作目录（可选）' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      async handler(args) {
        const command = str(args.command).trim()
        if (!command) return { ok: false, summary: 'command 为空' }
        const cwd = str(args.cwd).trim() || undefined
        try {
          const { stdout, stderr } = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', command],
            { cwd, timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          )
          const text = `${stdout}\n${stderr}`.trim()
          log.info('tools', '执行 shell 命令', { command: command.slice(0, 120), ms: 0 })
          return { ok: true, summary: text.slice(0, 20000) || '（无输出）' }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { ok: false, summary: `命令执行失败：${message.slice(0, 2000)}` }
        }
      },
    })

    register({
      name: 'read_source_file',
      description: '读取启动器自己的源码文件（src/ 下，用于自我修改前先看代码）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对 src/ 的路径，如 main/plugins/agent.ts' } },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        const file = sourcePath(str(args.path))
        if (!existsSync(file)) return { ok: false, summary: `源码文件不存在：src/${str(args.path)}` }
        const info = statSync(file)
        if (info.size > 512 * 1024) return { ok: false, summary: `文件太大（${info.size} 字节）` }
        return { ok: true, summary: readFileSync(file, 'utf8').slice(0, 100000) }
      },
    })

    register({
      name: 'write_source_file',
      description:
        '写启动器自己的源码文件（src/ 下）。改完要调 rebuild_launcher 重新构建并重启才生效。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 src/ 的路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async handler(args) {
        const file = sourcePath(str(args.path))
        const content = String(args.content ?? '')
        if (content.length > 512 * 1024) return { ok: false, summary: '内容超过 512KB' }
        await writeTextAtomic(file, content)
        log.info('tools', '已写源码文件', { file, bytes: content.length })
        return { ok: true, summary: `已写入 src/${str(args.path)}（${content.length} 字节），需要 rebuild_launcher 才生效` }
      },
    })

    register({
      name: 'rebuild_launcher',
      description:
        '重新构建启动器（npm run build），并同步到打包目录；之后调 restart_self 重启生效。改完源码用这个。',
      parameters: EMPTY_PARAMS,
      async handler() {
        const root = repoRoot()
        try {
          // Windows 上 npm 是 .cmd，必须经 cmd.exe 启动，execFile 直接 spawn 会 EINVAL
          const npmCommand = ['run', 'build']
          const { stdout, stderr } =
            process.platform === 'win32'
              ? await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'npm', ...npmCommand], {
                  cwd: root,
                  timeout: 300_000,
                  windowsHide: true,
                  maxBuffer: 16 * 1024 * 1024,
                })
              : await execFileAsync('npm', npmCommand, {
                  cwd: root,
                  timeout: 300_000,
                  windowsHide: true,
                  maxBuffer: 16 * 1024 * 1024,
                })
          const outDir = path.join(root, 'out')
          let synced = ''
          const resourcesApp = process.resourcesPath ? path.join(process.resourcesPath, 'app') : ''
          if (resourcesApp && existsSync(resourcesApp) && existsSync(outDir)) {
            const target = path.join(resourcesApp, 'out')
            rmSync(target, { recursive: true, force: true })
            cpSync(outDir, target, { recursive: true })
            synced = '并把构建产物同步到打包目录'
          }
          log.info('tools', '重新构建完成', { root, synced: Boolean(synced) })
          return {
            ok: true,
            summary: `构建完成${synced}。调 restart_self 重启后生效。\n${(stdout || stderr).slice(0, 800)}`,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { ok: false, summary: `构建失败：${message.slice(0, 2000)}` }
        }
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
        const existing = registry.get(definition.name)
        // P35：插件不能覆盖内置工具（否则内置能力会被沙箱里的残缺实现顶掉）
        if (existing && !existing.source && definition.source) {
          log.warn('tools', '插件试图覆盖内置工具，已忽略', { tool: definition.name, source: definition.source })
          return
        }
        if (existing) {
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
