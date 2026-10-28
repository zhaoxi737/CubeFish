/**
 * 崩溃归因（P3）：扫描 crash-reports / latest.log / game-*.log，按已知签名分类并给建议。
 * 规则库先覆盖最常见的一批；P4 再让 AI 在这份结构化结论上做二次判断。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Diagnosis, FixAction, FixResult } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { ContentService } from './content'
import type { InstancesService } from './instances'
import type { LogService } from './logger'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'

export type DiagSeverity = Diagnosis['severity']

export interface DiagnoseService {
  run(instanceId?: string): Promise<Diagnosis>
  analyzeText(text: string, source?: string): Diagnosis
  /** 根据最近的崩溃归因给出可执行的一键修复动作 */
  fixes(instanceId?: string): Promise<FixAction[]>
  applyFix(instanceId: string, fixId: string): Promise<FixResult>
  /** 读游戏日志尾部（latest.log 或最新 game-*.log） */
  gameLog(instanceId?: string, lines?: number): { file?: string; lines: string[]; error?: string }
}

interface Signature {
  category: string
  severity: DiagSeverity
  test: RegExp
  summary: string
  suggestions: string[]
}

const SIGNATURES: Signature[] = [
  {
    category: 'missing-dependency',
    severity: 'error',
    test: /HARD_DEP|Incompatible mods found|Some of your mods are incompatible|缺少.{0,40}(前置|模组)|Missing or unsupported mandatory dependencies|requires .{0,80}?which is missing|Mod .{0,80}?requires .{0,80}?not installed|Incompatible mod set/i,
    summary: '缺少必需的前置模组，或模组之间版本不兼容（加载器拒绝启动）',
    suggestions: [
      '打开「模组」面板，搜索并安装提示里缺失的前置模组',
      '点一次「冲突检查」，会直接列出缺哪个前置',
      '若是整合包，请用整合包安装而不是逐个手动装',
    ],
  },
  {
    category: 'duplicate-mod',
    severity: 'error',
    test: /Duplicate mods|duplicate mod|Found duplicate|already installed.*mod/i,
    summary: '同一个模组装了多份（重复 modid）',
    suggestions: ['检查 mods 目录，只保留每个模组的一份 jar', '用「冲突检查」定位重复文件'],
  },
  {
    category: 'mixin-fail',
    severity: 'error',
    test: /Mixin apply failed|Mixin transformation of .{0,120} failed|mixin injection|MixinApplyError|InvalidInjectionException/i,
    summary: 'Mixin 注入失败（模组之间或模组与游戏版本不匹配）',
    suggestions: [
      '确认所有模组都是同一个游戏版本（如 1.21.11）',
      '两个模组改同一个类时可能冲突，逐个禁用排查',
      '更新相关模组到支持当前版本的版本',
    ],
  },
  {
    category: 'java-version',
    severity: 'error',
    test: /Unsupported class file major version|UnsupportedClassVersionError|class file version .* is not supported/i,
    summary: 'Java 版本与模组/游戏要求不匹配',
    suggestions: ['在设置里改用游戏要求的 Java 主版本', '老版本（1.16 及以下）通常需要 Java 8 或 17'],
  },
  {
    category: 'out-of-memory',
    severity: 'error',
    test: /OutOfMemoryError|Java heap space|GC overhead limit exceeded/i,
    summary: '内存不足（JVM 堆溢出）',
    suggestions: ['在设置里调大内存分配（整合包建议 4–8G）', '关掉其他吃内存的程序', '减少同时装的光影/高清材质包'],
  },
  {
    category: 'missing-class',
    severity: 'error',
    test: /ClassNotFoundException|NoClassDefFoundError|NoSuchMethodError|NoSuchFieldError/i,
    summary: '运行时找不到类（缺库或模组版本不匹配）',
    suggestions: ['检查缺失的前置模组是否安装', '确认加载器版本够新', '「冲突检查」可能能定位'],
  },
  {
    category: 'gl-driver',
    severity: 'error',
    test: /GLFW error|Failed to create window|OpenGL|Pixel format|GL_INVALID|Failed to initialise/i,
    summary: '图形驱动 / OpenGL 初始化失败',
    suggestions: ['更新显卡驱动', '关闭光影或降低渲染设置', '笔记本切换到独显运行'],
  },
  {
    category: 'access-violation',
    severity: 'error',
    test: /EXCEPTION_ACCESS_VIOLATION|hs_err_pid/i,
    summary: 'JVM 崩溃（native 层访问冲突，常见于显卡驱动/模组 native）',
    suggestions: ['更新显卡驱动', '移除带 native 库的模组（如某些优化/光影模组）再试'],
  },
  {
    category: 'mod-load-failed',
    severity: 'error',
    test: /Failed to load mods|Mod loading has failed|A potential solution/i,
    summary: '模组加载失败',
    suggestions: ['看日志里列出的具体模组名并逐个禁用排查', '用「冲突检查」检查前置与版本冲突'],
  },
]

export function createDiagnosePlugin(): LauncherPlugin<void> {
  return definePlugin('diagnose', () => (ctx) => {
    const instances = use<InstancesService>(ctx, 'instances')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')
    const content = use<ContentService>(ctx, 'content')
    const settings = use<SettingsService>(ctx, 'settings')

    function analyzeText(text: string, source?: string): Diagnosis {
      const lines = text.split(/\r?\n/)
      for (const sig of SIGNATURES) {
        if (!sig.test.test(text)) continue
        const evidence = lines
          .filter((line) => sig.test.test(line) || /Caused by:|Description:|Fix:|Reason:/i.test(line))
          .slice(0, 6)
          .map((line) => line.trim().slice(0, 300))
        return refine(
          {
            found: true,
            source,
            category: sig.category,
            severity: sig.severity,
            summary: sig.summary,
            evidence,
            suggestions: sig.suggestions,
            checkedAt: Date.now(),
          },
          text,
        )
      }
      if (/crash|exception|error/i.test(text)) {
        const evidence = lines
          .filter((line) => /exception|error|Description:|Caused by:/i.test(line))
          .slice(0, 6)
          .map((line) => line.trim().slice(0, 300))
        return {
          found: true,
          source,
          category: 'unknown',
          severity: 'error',
          summary: '发生了崩溃，但没有命中已知签名',
          evidence,
          suggestions: ['把日志或 crash-report 发出来，或等 AI 诊断（P4）', '先「冲突检查」排除前置与版本问题'],
          checkedAt: Date.now(),
        }
      }
      return {
        found: false,
        category: 'none',
        severity: 'info',
        summary: '日志里没有发现崩溃迹象',
        evidence: [],
        suggestions: [],
        checkedAt: Date.now(),
      }
    }

    function newestFile(dir: string, filter?: (name: string) => boolean): string | undefined {
      try {
        if (!existsSync(dir)) return undefined
        const files = readdirSync(dir)
          .filter((name) => !filter || filter(name))
          .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
        return files[0]?.name
      } catch {
        return undefined
      }
    }

    async function run(instanceId = 'default'): Promise<Diagnosis> {
      const instance = instances.get(instanceId)
      if (!instance) {
        return {
          found: false,
          category: 'none',
          severity: 'info',
          summary: '实例不存在',
          evidence: [],
          suggestions: [],
          checkedAt: Date.now(),
        }
      }
      const gameDir = instance.gameDir
      const crashDir = path.join(gameDir, 'crash-reports')
      const crashFile = newestFile(crashDir)
      let diagnosis: Diagnosis

      if (crashFile) {
        const full = path.join(crashDir, crashFile)
        const text = readSliced(full)
        diagnosis = analyzeText(text, crashFile)
      } else {
        const logFile = newestFile(path.join(gameDir, 'logs'), (name) => name === 'latest.log' || name.startsWith('game-'))
        if (logFile) {
          const full = path.join(gameDir, 'logs', logFile)
          diagnosis = analyzeText(readSliced(full, 256 * 1024), logFile)
        } else {
          diagnosis = {
            found: false,
            category: 'none',
            severity: 'info',
            summary: '还没有游戏日志（先启动一次游戏）',
            evidence: [],
            suggestions: [],
            checkedAt: Date.now(),
          }
        }
      }

      telemetry.record('diagnose:run', { instanceId, category: diagnosis.category, found: diagnosis.found })
      log.info('diagnose', '崩溃归因完成', { instanceId, category: diagnosis.category, found: diagnosis.found })
      return diagnosis
    }

    /* ---------- P13：一键修复 ---------- */

    async function fixes(instanceId = 'default'): Promise<FixAction[]> {
      const instance = instances.get(instanceId)
      if (!instance) return []
      const diagnosis = await run(instanceId)
      const actions: FixAction[] = []

      if (diagnosis.category === 'out-of-memory') {
        const current = instance.memoryMb
        const next = Math.min(current + 2048, 16384)
        if (next > current) {
          actions.push({
            id: `memory:${next}`,
            label: `把内存从 ${current} MB 调到 ${next} MB`,
            description: '堆内存不足是最常见的 OOM 原因；整合包建议 4–8 GB',
            kind: 'set-memory',
            detail: `${next} MB`,
          })
        }
      }

      if (diagnosis.category === 'missing-dependency') {
        const match = HARD_DEP.exec(diagnosis.evidence.join('\n'))
        const dep = match?.[3]
        if (dep) {
          actions.push({
            id: `install:${dep}`,
            label: `安装缺失前置「${dep}」`,
            description: '在 Modrinth 搜索同名项目并安装到当前实例',
            kind: 'install-dependency',
            detail: dep,
          })
        }
      }

      const mods = await content.installed(instanceId)
      const enabled = mods.filter((mod) => mod.enabled !== false)
      const suspicious = [...enabled].sort((a, b) => b.installedAt - a.installedAt).slice(0, 3)

      if (['duplicate-mod', 'mixin-fail', 'mod-load-failed', 'missing-class', 'unknown'].includes(diagnosis.category)) {
        for (const mod of suspicious) {
          actions.push({
            id: `disable:${mod.fileName}`,
            label: `禁用 ${mod.fileName}`,
            description: '最近安装的模组最可疑，禁用后重新启动即可验证',
            kind: 'disable-mod',
            detail: mod.fileName,
          })
        }
      }

      const crashDir = path.join(instance.gameDir, 'crash-reports')
      if (existsSync(crashDir)) {
        const count = readdirSync(crashDir).length
        if (count > 0) {
          actions.push({
            id: 'clear-crash',
            label: `清理 ${count} 个崩溃报告`,
            description: '删掉旧报告，避免下次诊断读到历史崩溃',
            kind: 'clear-crash-reports',
            detail: `${count} 个文件`,
          })
        }
      }

      // 兜底：没有崩溃时也给最近安装的模组禁用项，方便手动排查
      if (actions.filter((action) => action.kind === 'disable-mod').length === 0) {
        for (const mod of suspicious) {
          actions.push({
            id: `disable:${mod.fileName}`,
            label: `禁用 ${mod.fileName}`,
            description: '排查模组冲突时用：禁用后重启，看问题是否消失',
            kind: 'disable-mod',
            detail: mod.fileName,
          })
        }
      }

      return actions
    }

    async function applyFix(instanceId: string, fixId: string): Promise<FixResult> {
      const instance = instances.get(instanceId)
      if (!instance) return { ok: false, message: '实例不存在' }
      try {
        if (fixId.startsWith('disable:')) {
          const fileName = fixId.slice('disable:'.length)
          const result = await content.toggle(instanceId, fileName)
          if (!result.ok) return { ok: false, message: `禁用失败：${result.error ?? '未知错误'}` }
          telemetry.record('diagnose:fix', { instanceId, kind: 'disable-mod', fileName })
          log.info('diagnose', '已禁用可疑模组', { instanceId, fileName })
          return {
            ok: Boolean(result.enabled === false),
            message: result.enabled === false ? `已禁用 ${fileName}，重新启动试试` : `${fileName} 仍然是启用状态`,
            refresh: true,
          }
        }
        if (fixId.startsWith('memory:')) {
          const target = Number(fixId.slice('memory:'.length))
          if (!Number.isFinite(target)) return { ok: false, message: '内存值不合法' }
          const bounded = Math.min(Math.max(Math.round(target), 512), 32768)
          instances.setMemory(instanceId, bounded)
          telemetry.record('diagnose:fix', { instanceId, kind: 'set-memory', mb: bounded })
          log.info('diagnose', '已调整内存', { instanceId, mb: bounded })
          return { ok: true, message: `内存已调到 ${bounded} MB，重新启动生效`, refresh: true }
        }
        if (fixId.startsWith('install:')) {
          const dep = fixId.slice('install:'.length)
          const mcVersion = instance.gameVersion ?? instance.mcVersion
          const loader = instance.loader === 'fabric' ? 'fabric' : undefined
          const hits = await content.search(dep, { type: 'mod', mcVersion, loader, limit: 5 })
          if (hits.length === 0) return { ok: false, message: `没在 Modrinth 找到「${dep}」，请手动搜索安装` }
          const hit = hits[0]
          const result = await content.install(instanceId, hit.projectId, { mcVersion, loader })
          if (!result.ok) return { ok: false, message: `安装失败：${result.error ?? '未知错误'}` }
          telemetry.record('diagnose:fix', { instanceId, kind: 'install-dependency', project: hit.projectId })
          log.info('diagnose', '已安装缺失前置', { instanceId, project: hit.projectId })
          return {
            ok: true,
            message: `已安装 ${result.title ?? hit.title} ${result.versionNumber ?? ''}，重新启动试试`,
            refresh: true,
          }
        }
        if (fixId === 'clear-crash') {
          const crashDir = path.join(instance.gameDir, 'crash-reports')
          let removed = 0
          if (existsSync(crashDir)) {
            for (const name of readdirSync(crashDir)) {
              try {
                rmSync(path.join(crashDir, name), { recursive: true, force: true })
                removed += 1
              } catch {
                /* 跳过被占用的文件 */
              }
            }
          }
          telemetry.record('diagnose:fix', { instanceId, kind: 'clear-crash-reports', removed })
          return { ok: true, message: `已清理 ${removed} 个崩溃报告` }
        }
        return { ok: false, message: `未知的修复动作：${fixId}` }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('diagnose', '修复动作失败', { instanceId, fixId, error: message })
        return { ok: false, message }
      }
    }

    function gameLog(instanceId = 'default', lines = 300): { file?: string; lines: string[]; error?: string } {
      const instance = instances.get(instanceId)
      if (!instance) return { lines: [], error: '实例不存在' }
      const logDir = path.join(instance.gameDir, 'logs')
      const file = newestFile(logDir, (name) => name === 'latest.log' || name.startsWith('game-')) 
      if (!file) return { lines: [], error: '还没有游戏日志（先启动一次游戏）' }
      try {
        const full = path.join(logDir, file)
        const size = statSync(full).size
        const buffer = readFileSync(full)
        const chunk = size > 256 * 1024 ? buffer.subarray(size - 256 * 1024) : buffer
        const all = chunk.toString('utf8').split(/\r?\n/)
        return { file, lines: all.slice(-Math.max(10, lines)) }
      } catch (err) {
        return { lines: [], error: err instanceof Error ? err.message : String(err) }
      }
    }

    ctx.provide('diagnose', { run, analyzeText, fixes, applyFix, gameLog } satisfies DiagnoseService)
  })
}

/** Fabric 的 HARD_DEP 行能直接给出「谁缺谁、缺哪个版本」。 */
const HARD_DEP = /HARD_DEP(?:_NO_CANDIDATE)?\s+([^\s]+)\s+([^\s{]+)\s+\{depends\s+([^\s@]+)/

function refine(diagnosis: Diagnosis, text: string): Diagnosis {
  if (diagnosis.category !== 'missing-dependency') return diagnosis
  const match = HARD_DEP.exec(text)
  if (!match) return diagnosis
  const [, modId, modVersion, depId] = match
  diagnosis.summary = `模组「${modId}」${modVersion} 需要前置「${depId}」，但实例里没有`
  diagnosis.suggestions = [`在「模组」面板搜索并安装前置 ${depId}`, ...diagnosis.suggestions].slice(0, 4)
  diagnosis.evidence = [match[0].slice(0, 300), ...diagnosis.evidence].slice(0, 6)
  return diagnosis
}

function readSliced(file: string, maxBytes = 512 * 1024): string {  try {
    const size = statSync(file).size
    const full = readFileSync(file)
    if (size <= maxBytes) return full.toString('utf8')
    const head = full.subarray(0, Math.floor(maxBytes * 0.7)).toString('utf8')
    const tail = full.subarray(size - Math.floor(maxBytes * 0.3)).toString('utf8')
    return `${head}\n…\n${tail}`
  } catch {
    return ''
  }
}
