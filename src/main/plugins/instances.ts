import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { InstanceSummary, LaunchDryRun, LaunchStep } from '../../shared/types'
import { ensureDir, safeName } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { MojangService } from './mojang'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { StorageService } from './storage'
import type { TelemetryService } from './telemetry'

/**
 * 实例服务（版本隔离 + 多实例）。
 *
 * 布局（Prism 式：根共享 + 实例独立 .minecraft）：
 *   <data>/instances/<id>/instance.json
 *   <data>/instances/<id>/.minecraft/{mods,resourcepacks,shaderpacks,saves,config,logs,crash-reports}
 * 游戏进程的 cwd = .minecraft；assets/libraries/versions/java 全局共享。
 *
 * 「当前实例」存在 settings.activeInstance，AI 工具 / 命令默认作用于它。
 */
export interface InstancesService {
  list(): InstanceSummary[]
  get(id: string): InstanceSummary | undefined
  create(name: string): InstanceSummary
  remove(id: string): { ok: boolean; error?: string }
  active(): InstanceSummary
  setActive(id: string): InstanceSummary
  ensureDefault(): InstanceSummary
  gameDir(id: string): string
  setVersion(id: string, versionId: string, mcVersion: string, gameVersion?: string, loader?: string): InstanceSummary
  setMemory(id: string, memoryMb: number): void
  setPlayerName(id: string, playerName: string): void
  /** 绑定/解绑实例账号（accountId 为空 = 跟随全局账号） */
  setAccount(id: string, accountId?: string, accountName?: string): void
  /** 重命名实例（显示名，id 不变） */
  rename(id: string, name: string): InstanceSummary
  /** 实例的各个目录（PCL 式文件管理用） */
  folders(id: string): { root: string; game: string; mods: string; logs: string; versions: string }
  dryRun(id?: string): Promise<LaunchDryRun>
  /** 导出实例为 zip（mods/config/存档 等，跳过日志与缓存） */
  exportInstance(id?: string, dest?: string): Promise<{ ok: boolean; path?: string; bytes?: number; files?: number; error?: string }>
  /** 从 zip 导入为新实例 */
  importInstance(zipPath: string, opts?: { name?: string }): Promise<{ ok: boolean; instance?: InstanceSummary; error?: string }>
}

interface InstanceFile {
  id: string
  name: string
  versionId?: string
  gameVersion?: string
  mcVersion: string
  loader: string
  loaderVersion?: string
  memoryMb: number
  playerName?: string
  accountId?: string
  accountName?: string
  createdAt: number
}

const INSTANCE_SUBDIRS = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'logs', 'crash-reports', 'screenshots']
const DEFAULT_ID = 'default'

export function createInstancesPlugin(): LauncherPlugin<void> {
  return definePlugin('instances', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const storage = use<StorageService>(ctx, 'storage')
    const settings = use<SettingsService>(ctx, 'settings')
    const mojang = use<MojangService>(ctx, 'mojang')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    const dirOf = (id: string) => path.join(paths.instances, id)
    const gameDir = (id: string) => path.join(dirOf(id), '.minecraft')
    const fileOf = (id: string) => path.join(dirOf(id), 'instance.json')

    const read = (id: string): InstanceFile | undefined => {
      if (!storage.exists(fileOf(id))) return undefined
      return storage.readJson<InstanceFile | undefined>(fileOf(id), undefined) ?? undefined
    }

    const write = (file: InstanceFile): void => {
      storage.writeJson(fileOf(file.id), file)
    }

    const toSummary = (file: InstanceFile): InstanceSummary => {
      const versionId = file.versionId
      return {
        id: file.id,
        name: file.name,
        versionId,
        gameVersion: file.gameVersion ?? (file.loader === 'vanilla' ? versionId : undefined),
        mcVersion: file.mcVersion,
        loader: file.loader,
        loaderVersion: file.loaderVersion,
        memoryMb: file.memoryMb,
        playerName: file.playerName ?? settings.get('playerName'),
        accountId: file.accountId,
        accountName: file.accountName,
        createdAt: file.createdAt,
        installed: Boolean(versionId && existsSync(path.join(paths.versions, versionId, `${versionId}.json`))),
        path: dirOf(file.id),
        gameDir: gameDir(file.id),
      }
    }

    const ensureDirs = (id: string): void => {
      mkdirSync(gameDir(id), { recursive: true })
      for (const sub of INSTANCE_SUBDIRS) mkdirSync(path.join(gameDir(id), sub), { recursive: true })
    }

    /** 老布局（mods 等直接在实例根）迁移到 .minecraft 下。 */
    const migrateLayout = async (id: string): Promise<void> => {
      const root = dirOf(id)
      const mcDir = gameDir(id)
      await ensureDir(mcDir)
      for (const sub of INSTANCE_SUBDIRS) {
        const from = path.join(root, sub)
        const to = path.join(mcDir, sub)
        if (existsSync(from) && !existsSync(to)) {
          try {
            const { rename } = await import('node:fs/promises')
            await rename(from, to)
            log.info('instances', '迁移实例目录到 .minecraft', { id, sub })
          } catch {
            /* 跨卷等情况忽略，重新创建空目录 */
          }
        }
      }
      for (const sub of INSTANCE_SUBDIRS) await ensureDir(path.join(mcDir, sub))
    }

    const ensureDefault = (): InstanceSummary => {
      const existing = read(DEFAULT_ID)
      if (existing) {
        ensureDirs(DEFAULT_ID)
        return toSummary(existing)
      }
      const file: InstanceFile = {
        id: DEFAULT_ID,
        name: '默认实例',
        mcVersion: '',
        loader: 'vanilla',
        memoryMb: settings.get('memoryMb'),
        playerName: settings.get('playerName'),
        createdAt: Date.now(),
      }
      write(file)
      ensureDirs(DEFAULT_ID)
      void migrateLayout(DEFAULT_ID)
      log.info('instances', '已创建默认实例', { id: DEFAULT_ID })
      telemetry.record('instance:create', { id: DEFAULT_ID, loader: file.loader })
      return toSummary(file)
    }

    const list = (): InstanceSummary[] => {
      ensureDefault()
      const items: InstanceSummary[] = []
      let entries: string[] = []
      try {
        entries = readdirSync(paths.instances, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        entries = []
      }
      for (const id of entries) {
        const file = read(id)
        if (file) items.push(toSummary(file))
      }
      if (!items.some((item) => item.id === DEFAULT_ID)) items.push(ensureDefault())
      return items.sort((a, b) => (a.id === DEFAULT_ID ? -1 : b.id === DEFAULT_ID ? 1 : a.createdAt - b.createdAt))
    }

    const get = (id: string): InstanceSummary | undefined => {
      const file = read(id)
      return file ? toSummary(file) : undefined
    }

    const active = (): InstanceSummary => {
      const activeId = settings.get('activeInstance')
      return (activeId && get(activeId)) || list()[0] || ensureDefault()
    }

    const setActive = (id: string): InstanceSummary => {
      const instance = get(id)
      if (!instance) throw new Error(`实例不存在: ${id}`)
      settings.patch({ activeInstance: id })
      telemetry.record('instance:activate', { id })
      return instance
    }

    const uniqueId = (name: string): string => {
      const base = safeName(name, 'instance')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24)
      const seed = base || `inst-${Date.now().toString(36)}`
      if (!existsSync(dirOf(seed))) return seed
      for (let i = 2; i < 100; i += 1) {
        const candidate = `${seed}-${i}`
        if (!existsSync(dirOf(candidate))) return candidate
      }
      return `${seed}-${Date.now().toString(36)}`
    }

    const create = (name: string): InstanceSummary => {
      ensureDefault()
      const id = uniqueId(name)
      const file: InstanceFile = {
        id,
        name: safeName(name, '新实例').slice(0, 32),
        mcVersion: '',
        loader: 'vanilla',
        memoryMb: settings.get('memoryMb'),
        playerName: settings.get('playerName'),
        createdAt: Date.now(),
      }
      write(file)
      ensureDirs(id)
      telemetry.record('instance:create', { id, loader: file.loader })
      log.info('instances', '已创建实例', { id, name: file.name })
      return toSummary(file)
    }

    const remove = (id: string): { ok: boolean; error?: string } => {
      if (id === DEFAULT_ID) return { ok: false, error: '默认实例不能删除' }
      if (!get(id)) return { ok: false, error: `实例不存在: ${id}` }
      try {
        rmSync(dirOf(id), { recursive: true, force: true })
        if (settings.get('activeInstance') === id) settings.patch({ activeInstance: DEFAULT_ID })
        telemetry.record('instance:remove', { id })
        log.info('instances', '已删除实例', { id })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const setVersion = (
      id: string,
      versionId: string,
      mcVersion: string,
      gameVersion?: string,
      loader?: string,
    ): InstanceSummary => {
      const file = read(id) ?? (() => {
        throw new Error(`实例不存在: ${id}`)
      })()
      file.versionId = versionId
      file.mcVersion = mcVersion
      if (gameVersion) file.gameVersion = gameVersion
      file.loader = loader ?? (versionId.startsWith('fabric-loader') ? 'fabric' : 'vanilla')
      write(file)
      telemetry.record('instance:set-version', { id, versionId, gameVersion, loader: file.loader })
      log.info('instances', '实例已绑定版本', { id, versionId, gameVersion, loader: file.loader })
      return toSummary(file)
    }

    const setMemory = (id: string, memoryMb: number): void => {
      const file = read(id)
      if (!file) return
      file.memoryMb = Math.min(32768, Math.max(512, Math.round(memoryMb)))
      write(file)
    }

    const setPlayerName = (id: string, playerName: string): void => {
      const file = read(id)
      if (!file) return
      file.playerName = safeName(playerName, 'Player')
      write(file)
    }

    const dryRun = async (id?: string): Promise<LaunchDryRun> => {
      const instance = (id && get(id)) || active()
      const steps: LaunchStep[] = [{ step: '实例目录', status: 'ok', detail: instance.gameDir }]
      if (!instance.versionId) {
        steps.push({ step: '游戏版本', status: 'pending', detail: '尚未下载任何版本（上方选择版本并安装）' })
      } else {
        const installed = await mojang.installed()
        steps.push({
          step: '游戏版本',
          status: installed.includes(instance.versionId) ? 'ok' : 'pending',
          detail: instance.versionId,
        })
      }
      steps.push({ step: 'Java 运行时', status: 'pending', detail: '启动时自动匹配/下载' })
      steps.push({ step: '启动进程', status: 'pending', detail: '启动时执行' })
      telemetry.record('launch:dry-run', { instance: instance.id })
      return { ok: true, instance, steps, hint: '选中版本并安装后即可启动。' }
    }

    /* ---------- P23：实例导出 / 导入 ---------- */

    async function exportInstance(
      id = 'default',
      dest?: string,
    ): Promise<{ ok: boolean; path?: string; bytes?: number; files?: number; error?: string }> {
      const file = read(id)
      if (!file) return { ok: false, error: `实例不存在：${id}` }
      const root = gameDir(id)
      if (!existsSync(root)) return { ok: false, error: '实例目录不存在' }
      const zip = new AdmZip()
      zip.addFile('instance.json', Buffer.from(JSON.stringify(file, null, 2), 'utf8'))

      let files = 0
      const skipDirs = new Set(['logs', 'crash-reports', '.cache'])
      const walk = (absolute: string, relative: string): void => {
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
          const childAbs = path.join(absolute, entry.name)
          const childRel = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            if (!relative && skipDirs.has(entry.name)) continue
            walk(childAbs, childRel)
            continue
          }
          if (!entry.isFile()) continue
          zip.addFile(childRel, readFileSync(childAbs))
          files += 1
        }
      }
      walk(root, '')

      const target = dest ?? path.join(paths.data, 'exports', `${file.id}-${Date.now()}.zip`)
      await ensureDir(path.dirname(target))
      zip.writeZip(target)
      const bytes = statSync(target).size
      telemetry.record('instance:export', { id, files, bytes })
      log.info('instances', '实例已导出', { id, path: target, files, bytes })
      return { ok: true, path: target, bytes, files }
    }

    async function importInstance(zipPath: string, opts?: { name?: string }): Promise<{ ok: boolean; instance?: InstanceSummary; error?: string }> {
      try {
        if (!existsSync(zipPath)) return { ok: false, error: `文件不存在：${zipPath}` }
        const zip = new AdmZip(zipPath)
        const metaEntry = zip.getEntry('instance.json')
        const meta = metaEntry
          ? (JSON.parse(metaEntry.getData().toString('utf8')) as Partial<InstanceFile>)
          : {}
        const name = opts?.name ?? (meta.name ? `${meta.name}（导入）` : path.basename(zipPath, '.zip'))
        const created = create(name)
        const root = gameDir(created.id)

        let files = 0
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          const raw = entry.entryName.replace(/\\/g, '/')
          if (raw === 'instance.json') continue
          const parts = raw.split('/').filter(Boolean)
          if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) continue
          const target = path.join(root, ...parts)
          await ensureDir(path.dirname(target))
          writeFileSync(target, entry.getData())
          files += 1
        }

        // 恢复实例元数据（版本绑定 / 内存 / 玩家名）
        const restored = read(created.id)
        if (restored) {
          if (meta.versionId) restored.versionId = meta.versionId
          if (meta.gameVersion) restored.gameVersion = meta.gameVersion
          if (meta.mcVersion) restored.mcVersion = meta.mcVersion
          if (meta.loader) restored.loader = meta.loader
          if (meta.loaderVersion) restored.loaderVersion = meta.loaderVersion
          if (typeof meta.memoryMb === 'number') restored.memoryMb = meta.memoryMb
          if (meta.playerName) restored.playerName = meta.playerName
          write(restored)
        }
        telemetry.record('instance:import', { id: created.id, files })
        log.info('instances', '实例已导入', { id: created.id, name, files })
        return { ok: true, instance: get(created.id) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('instances', '实例导入失败', { zipPath, error: message })
        return { ok: false, error: message }
      }
    }

    const setAccount = (id: string, accountId?: string, accountName?: string): void => {
      const file = read(id)
      if (!file) return
      if (accountId) {
        file.accountId = accountId
        file.accountName = accountName
      } else {
        delete file.accountId
        delete file.accountName
      }
      write(file)
      telemetry.record('instance:account', { id, accountId: accountId ?? '' })
      log.info('instances', accountId ? '实例已绑定账号' : '实例已解绑账号', { id, accountId, accountName })
    }

    const rename = (id: string, name: string): InstanceSummary => {
      const file = read(id)
      if (!file) throw new Error(`实例不存在：${id}`)
      const trimmed = name.trim()
      if (!trimmed) throw new Error('实例名不能为空')
      file.name = trimmed.slice(0, 40)
      write(file)
      telemetry.record('instance:rename', { id })
      log.info('instances', '实例已重命名', { id, name: file.name })
      return toSummary(file)
    }

    const folders = (id: string): { root: string; game: string; mods: string; logs: string; versions: string } => ({
      root: dirOf(id),
      game: gameDir(id),
      mods: path.join(gameDir(id), 'mods'),
      logs: path.join(gameDir(id), 'logs'),
      versions: paths.versions,
    })

    ctx.provide('instances', {
      list,
      get,
      create,
      remove,
      active,
      setActive,
      ensureDefault,
      gameDir,
      setVersion,
      setMemory,
      setPlayerName,
      setAccount,
      rename,
      folders,
      dryRun,
      exportInstance,
      importInstance,
    } satisfies InstancesService)

    ensureDefault()
  })
}
