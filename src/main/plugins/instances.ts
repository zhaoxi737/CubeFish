import { existsSync } from 'node:fs'
import { readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import type { InstanceSummary, LaunchDryRun, LaunchStep } from '../../shared/types'
import { ensureDir, readJson, safeName, writeJsonAtomic } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { MojangService } from './mojang'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { StorageService } from './storage'
import type { TelemetryService } from './telemetry'

/**
 * 实例服务（版本隔离）。
 *
 * 布局（Prism 式：根共享 + 实例独立 .minecraft）：
 *   <data>/instances/<id>/instance.json
 *   <data>/instances/<id>/.minecraft/{mods,resourcepacks,shaderpacks,saves,config,logs,crash-reports}
 * 游戏进程的 cwd = .minecraft；assets/libraries/versions/java 全局共享。
 */
export interface InstancesService {
  list(): InstanceSummary[]
  get(id: string): InstanceSummary | undefined
  ensureDefault(): InstanceSummary
  gameDir(id: string): string
  setVersion(id: string, versionId: string, mcVersion: string, gameVersion?: string, loader?: string): InstanceSummary
  setMemory(id: string, memoryMb: number): void
  setPlayerName(id: string, playerName: string): void
  dryRun(id?: string): Promise<LaunchDryRun>
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
  createdAt: number
}

const INSTANCE_SUBDIRS = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'logs', 'crash-reports', 'screenshots']

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
        createdAt: file.createdAt,
        installed: Boolean(versionId && existsSync(path.join(paths.versions, versionId, `${versionId}.json`))),
        path: dirOf(file.id),
        gameDir: gameDir(file.id),
      }
    }

    const write = (file: InstanceFile): void => {
      storage.writeJson(fileOf(file.id), file)
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
      const id = 'default'
      const existing = read(id)
      if (existing) {
        void migrateLayout(id)
        return toSummary(existing)
      }
      const file: InstanceFile = {
        id,
        name: '默认实例',
        mcVersion: '',
        loader: 'vanilla',
        memoryMb: settings.get('memoryMb'),
        playerName: settings.get('playerName'),
        createdAt: Date.now(),
      }
      write(file)
      void migrateLayout(id)
      log.info('instances', '已创建默认实例', { id, gameDir: gameDir(id) })
      telemetry.record('instance:create', { id, loader: file.loader })
      return toSummary(file)
    }

    const list = (): InstanceSummary[] => {
      ensureDefault()
      // P0/P1 只管理默认实例；多实例管理在后续阶段扩展。
      return ['default']
        .map((id) => read(id))
        .filter((x): x is InstanceFile => Boolean(x))
        .map(toSummary)
    }

    const get = (id: string): InstanceSummary | undefined => {
      const file = read(id)
      return file ? toSummary(file) : undefined
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

    const dryRun = async (id = 'default'): Promise<LaunchDryRun> => {
      const instance = get(id) ?? ensureDefault()
      const steps: LaunchStep[] = []
      steps.push({ step: '实例目录', status: 'ok', detail: instance.gameDir })
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

    ctx.provide('instances', {
      list,
      get,
      ensureDefault,
      gameDir,
      setVersion,
      setMemory,
      setPlayerName,
      dryRun,
    } satisfies InstancesService)

    ensureDefault()
    void readdir(paths.instances).catch(() => undefined)
  })
}
