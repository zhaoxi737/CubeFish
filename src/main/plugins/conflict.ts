/**
 * 静态冲突分析（P3）：读取实例 mods/ 下每个 jar 的元数据，判定强/中/弱冲突。
 * 判据参考 docs/RESEARCH-P1-P2.md §5。
 */
import AdmZip from 'adm-zip'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ConflictIssue, ConflictReport, ModInfo } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { InstancesService } from './instances'
import type { LogService } from './logger'
import type { TelemetryService } from './telemetry'

export interface ConflictService {
  analyze(instanceId: string): ConflictReport
  scan(instanceId: string): ModInfo[]
}

const BUILTIN_IDS = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'fabric_loader',
  'forge',
  'neoforge',
  'quilt_loader',
  'quilt-loader',
  'mcp',
])

/* ---------- 版本谓词 ---------- */

function versionParts(input: string): number[] {
  const cleaned = input.replace(/^[a-zA-Z]+/, '').replace(/_/g, '.')
  return cleaned.split(/[.\-+\s]/).map((part) => {
    const num = Number.parseInt(part.replace(/[^0-9]/g, ''), 10)
    return Number.isFinite(num) ? num : 0
  })
}

function compareVersions(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

function satisfiesSingle(version: string, predicate: string): boolean {
  const p = predicate.trim()
  if (!p || p === '*' || p === 'x') return true
  if (p.startsWith('>=')) return compareVersions(version, p.slice(2)) >= 0
  if (p.startsWith('<=')) return compareVersions(version, p.slice(2)) <= 0
  if (p.startsWith('>')) return compareVersions(version, p.slice(1)) > 0
  if (p.startsWith('<')) return compareVersions(version, p.slice(1)) < 0
  if (p.startsWith('=')) return compareVersions(version, p.slice(1)) === 0
  if (p.startsWith('~')) {
    const base = versionParts(p.slice(1))
    const cur = versionParts(version)
    return cur[0] === base[0] && cur[1] === base[1] && compareVersions(version, p.slice(1)) >= 0
  }
  if (p.startsWith('^')) {
    const base = versionParts(p.slice(1))
    const cur = versionParts(version)
    return cur[0] === base[0] && compareVersions(version, p.slice(1)) >= 0
  }
  return compareVersions(version, p) === 0
}

/** 支持 `*`、`>=1.2 <2`、`[1.0,2.0)`、`(,1.5]`、`1.2.3`、`~1.2`、`^1.2`、`a || b` */
export function satisfiesRange(version: string, range: string): boolean {
  const r = (range ?? '').trim()
  if (!r || r === '*') return true
  if (r.includes('||')) return r.split('||').some((part) => satisfiesRange(version, part))
  if (/^[[(]/.test(r)) {
    const lowerOpen = r.startsWith('(')
    const upperOpen = r.endsWith(')')
    const inner = r.slice(1, -1)
    const [lowerRaw, upperRaw] = inner.split(',')
    const lower = lowerRaw?.trim()
    const upper = upperRaw?.trim()
    if (lower) {
      const cmp = compareVersions(version, lower)
      if (lowerOpen ? cmp <= 0 : cmp < 0) return false
    }
    if (upper) {
      const cmp = compareVersions(version, upper)
      if (upperOpen ? cmp >= 0 : cmp > 0) return false
    }
    return true
  }
  const tokens = r.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.every((token) => satisfiesSingle(version, token))
}

/* ---------- 元数据读取 ---------- */

interface ParsedMeta {
  id: string
  name: string
  version: string
  loader: ModInfo['loader']
  depends: Record<string, string>
  breaks: Record<string, string>
  provides: string[]
}

function toStringMap(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = typeof value === 'string' ? value : '*'
    }
  }
  return out
}

function readNestedProvides(zip: AdmZip, jarPaths: unknown): string[] {
  const provides: string[] = []
  if (!Array.isArray(jarPaths)) return provides
  for (const item of jarPaths) {
    const file = typeof item === 'string' ? item : (item as { file?: string })?.file
    if (!file) continue
    try {
      const entry = zip.getEntry(file)
      if (!entry) continue
      const nested = new AdmZip(entry.getData())
      const metaEntry = nested.getEntry('fabric.mod.json')
      if (!metaEntry) continue
      const meta = JSON.parse(metaEntry.getData().toString('utf8')) as { id?: string; provides?: unknown }
      if (meta.id) provides.push(meta.id)
      if (Array.isArray(meta.provides)) {
        for (const p of meta.provides) provides.push(String(p).split(':')[0])
      }
    } catch {
      /* 嵌套 jar 读不了就算了 */
    }
  }
  return provides
}

function parseFabric(zip: AdmZip): ParsedMeta | undefined {
  const entry = zip.getEntry('fabric.mod.json')
  if (!entry) return undefined
  const raw = JSON.parse(entry.getData().toString('utf8')) as {
    id?: string
    name?: string
    version?: string
    depends?: unknown
    breaks?: unknown
    provides?: unknown
    jars?: unknown
  }
  const provides = new Set<string>()
  if (Array.isArray(raw.provides)) {
    for (const p of raw.provides) provides.add(String(p).split(':')[0])
  }
  for (const id of readNestedProvides(zip, raw.jars)) provides.add(id)
  return {
    id: raw.id ?? '',
    name: raw.name ?? raw.id ?? '',
    version: typeof raw.version === 'string' ? raw.version : '',
    loader: 'fabric',
    depends: toStringMap(raw.depends),
    breaks: toStringMap(raw.breaks),
    provides: [...provides],
  }
}

function parseForge(zip: AdmZip, loader: 'forge' | 'neoforge'): ParsedMeta | undefined {
  const names = loader === 'neoforge'
    ? ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']
    : ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']
  const entry = names.map((name) => zip.getEntry(name)).find(Boolean)
  if (!entry) return undefined
  const toml = parseToml(entry.getData().toString('utf8')) as {
    mods?: { modId?: string; displayName?: string; version?: string }[]
    dependencies?: Record<string, { modId?: string; mandatory?: boolean; type?: string; versionRange?: string }[]>
  }
  const first = toml.mods?.[0]
  if (!first?.modId) return undefined
  const depends: Record<string, string> = {}
  const breaks: Record<string, string> = {}
  for (const depList of Object.values(toml.dependencies ?? {})) {
    if (!Array.isArray(depList)) continue
    for (const dep of depList) {
      if (!dep?.modId) continue
      const required = dep.mandatory === true || dep.type === 'required'
      if (required) depends[dep.modId] = dep.versionRange ?? '*'
      else if (dep.type === 'incompatible') breaks[dep.modId] = dep.versionRange ?? '*'
    }
  }
  return {
    id: first.modId,
    name: first.displayName ?? first.modId,
    version: first.version ?? '',
    loader,
    depends,
    breaks,
    provides: [],
  }
}

function readMeta(jarPath: string): ParsedMeta | 'unreadable' {
  try {
    const zip = new AdmZip(jarPath)
    return parseFabric(zip) ?? parseForge(zip, 'neoforge') ?? parseForge(zip, 'forge') ?? 'unreadable'
  } catch {
    return 'unreadable'
  }
}

export function createConflictPlugin(): LauncherPlugin<void> {
  return definePlugin('conflict', () => (ctx) => {
    const instances = use<InstancesService>(ctx, 'instances')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    function modsDir(instanceId: string): string {
      return path.join(instances.gameDir(instanceId), 'mods')
    }

    function scan(instanceId: string): ModInfo[] {
      const dir = modsDir(instanceId)
      if (!existsSync(dir)) return []
      const result: ModInfo[] = []
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jar') && !file.endsWith('.jar.disabled')) continue
        const full = path.join(dir, file)
        try {
          if (!statSync(full).isFile()) continue
        } catch {
          continue
        }
        const meta = readMeta(full)
        if (meta === 'unreadable') {
          result.push({
            file,
            id: '',
            name: file,
            version: '',
            loader: 'unknown',
            enabled: !file.endsWith('.disabled'),
            depends: {},
            breaks: {},
            provides: [],
          })
          continue
        }
        result.push({
          file,
          id: meta.id,
          name: meta.name,
          version: meta.version,
          loader: meta.loader,
          enabled: !file.endsWith('.disabled'),
          depends: meta.depends,
          breaks: meta.breaks,
          provides: meta.provides,
        })
      }
      return result
    }

    function analyze(instanceId: string): ConflictReport {
      const instance = instances.get(instanceId)
      const mods = scan(instanceId)
      const enabled = mods.filter((mod) => mod.enabled)
      const issues: ConflictIssue[] = []
      const idOf = new Map<string, ModInfo>()

      // 1) 同一 modid 多个文件（强冲突）
      for (const mod of enabled) {
        if (!mod.id) continue
        const existing = idOf.get(mod.id)
        if (existing) {
          issues.push({
            severity: 'error',
            kind: 'duplicate-id',
            mods: [existing.file, mod.file],
            message: `重复的 modid「${mod.id}」：${existing.file} 与 ${mod.file}`,
            suggestion: '只保留一个版本，删掉另一份 jar',
          })
        } else {
          idOf.set(mod.id, mod)
        }
      }

      // 2) 加载器不匹配
      const instanceLoader = instance?.loader ?? 'vanilla'
      if (instanceLoader === 'fabric') {
        for (const mod of enabled) {
          if (mod.loader === 'forge' || mod.loader === 'neoforge') {
            issues.push({
              severity: 'error',
              kind: 'loader-mismatch',
              mods: [mod.file],
              message: `${mod.name} 是 ${mod.loader} 模组，但实例是 Fabric`,
              suggestion: '换成该模组的 Fabric 版本，或新建一个 NeoForge/Forge 实例',
            })
          }
        }
      } else if (instanceLoader === 'vanilla' && enabled.length > 0) {
        issues.push({
          severity: 'warn',
          kind: 'mods-in-vanilla',
          mods: enabled.map((m) => m.file),
          message: `原版实例里放了 ${enabled.length} 个模组，不会生效`,
          suggestion: '先安装 Fabric，或把模组移到有加载器的实例',
        })
      }

      // 3) 必需依赖缺失
      const providers = new Set<string>(BUILTIN_IDS)
      for (const mod of enabled) {
        if (mod.id) providers.add(mod.id)
        for (const p of mod.provides) providers.add(p)
      }
      for (const mod of enabled) {
        for (const [depId, range] of Object.entries(mod.depends)) {
          if (providers.has(depId)) continue
          issues.push({
            severity: 'error',
            kind: 'missing-dependency',
            mods: [mod.file],
            message: `${mod.name} 需要前置「${depId}${range && range !== '*' ? ` ${range}` : ''}」，但实例里没有`,
            suggestion: `去模组市场安装 ${depId}`,
          })
        }
      }

      // 4) breaks 命中（双向检查）
      for (const a of enabled) {
        for (const [targetId, range] of Object.entries(a.breaks)) {
          const b = idOf.get(targetId)
          if (!b) continue
          if (range === '*' || satisfiesRange(b.version, range)) {
            issues.push({
              severity: 'error',
              kind: 'breaks',
              mods: [a.file, b.file],
              message: `${a.name} 声明与 ${b.name} ${range} 不兼容（当前 ${b.version}）`,
              suggestion: `升级 ${b.name} 到不冲突的版本，或移除其中一个`,
            })
          }
        }
      }
      for (const b of enabled) {
        for (const [targetId, range] of Object.entries(b.breaks)) {
          if (targetId === b.id) continue
          const a = idOf.get(targetId)
          if (!a) continue
          if (range !== '*' && !satisfiesRange(a.version, range)) continue
          if (issues.some((issue) => issue.kind === 'breaks' && issue.mods.includes(a.file) && issue.mods.includes(b.file))) continue
          issues.push({
            severity: 'error',
            kind: 'breaks',
            mods: [b.file, a.file],
            message: `${b.name} 声明与 ${a.name} 不兼容（${a.version} 命中 ${range}）`,
            suggestion: '调整两者版本组合',
          })
        }
      }

      // 5) 读不出元数据的 jar
      for (const mod of mods.filter((m) => m.loader === 'unknown' && m.enabled)) {
        issues.push({
          severity: 'warn',
          kind: 'unreadable',
          mods: [mod.file],
          message: `${mod.file} 不是可识别的 Fabric/Forge 模组（可能放错了文件）`,
          suggestion: '确认文件是不是模组，或改用加载器版本',
        })
      }

      const report: ConflictReport = { instanceId, mods, issues, checkedAt: Date.now() }
      telemetry.record('conflict:analyze', {
        instanceId,
        mods: mods.length,
        errors: issues.filter((i) => i.severity === 'error').length,
      })
      log.info('conflict', '静态冲突分析完成', {
        instanceId,
        mods: mods.length,
        errors: issues.filter((i) => i.severity === 'error').length,
      })
      return report
    }

    ctx.provide('conflict', { analyze, scan } satisfies ConflictService)
  })
}
