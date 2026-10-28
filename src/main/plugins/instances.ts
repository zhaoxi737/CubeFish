import path from 'node:path'
import type { InstanceSummary, LaunchDryRun, LaunchStep } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { StorageService } from './storage'
import type { TelemetryService } from './telemetry'

/**
 * 实例服务（版本隔离）。
 *
 * 布局：<data>/instances/<id>/ 内含 instance.json + mods/resourcepacks/shaderpacks/saves/config/logs。
 * P1 起这里的目录会成为每个版本独立的 .minecraft；assets/libraries/Java 走全局共享缓存。
 */
export interface InstancesService {
  list(): InstanceSummary[]
  get(id: string): InstanceSummary | undefined
  ensureDefault(): InstanceSummary
  dryRun(id?: string): LaunchDryRun
}

interface InstanceFile {
  id: string
  name: string
  mcVersion: string
  loader: string
  loaderVersion?: string
  memoryMb: number
  createdAt: number
}

const INSTANCE_SUBDIRS = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'logs', 'crash-reports']

export function createInstancesPlugin(): LauncherPlugin<void> {
  return definePlugin('instances', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const storage = use<StorageService>(ctx, 'storage')
    const settings = use<SettingsService>(ctx, 'settings')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    const dirOf = (id: string) => path.join(paths.instances, id)
    const fileOf = (id: string) => path.join(dirOf(id), 'instance.json')

    const toSummary = (file: InstanceFile): InstanceSummary => ({
      id: file.id,
      name: file.name,
      mcVersion: file.mcVersion,
      loader: file.loader,
      loaderVersion: file.loaderVersion,
      memoryMb: file.memoryMb,
      createdAt: file.createdAt,
      installed: file.mcVersion !== '' && storage.exists(path.join(dirOf(file.id), 'version', 'version.json')),
      path: dirOf(file.id),
    })

    const read = (id: string): InstanceFile | undefined => {
      if (!storage.exists(fileOf(id))) return undefined
      return storage.readJson<InstanceFile | undefined>(fileOf(id), undefined)
    }

    const ensureDefault = (): InstanceSummary => {
      const id = 'default'
      const existing = read(id)
      if (existing) return toSummary(existing)

      const file: InstanceFile = {
        id,
        name: '默认实例',
        mcVersion: '',
        loader: 'vanilla',
        memoryMb: settings.get('memoryMb'),
        createdAt: Date.now(),
      }
      storage.writeJson(fileOf(id), file)
      for (const sub of INSTANCE_SUBDIRS) storage.ensureDir(path.join(dirOf(id), sub))
      log.info('instances', '已创建默认实例', { id, dir: dirOf(id) })
      telemetry.record('instance:create', { id, loader: file.loader })
      return toSummary(file)
    }

    const list = (): InstanceSummary[] => {
      ensureDefault()
      // P0 只管理默认实例；P1 用 fs.readdir 扫描 instances/ 下的全部实例。
      return ['default']
        .map((id) => read(id))
        .filter((x): x is InstanceFile => Boolean(x))
        .map(toSummary)
    }

    const get = (id: string): InstanceSummary | undefined => {
      const file = read(id)
      return file ? toSummary(file) : undefined
    }

    const dryRun = (id = 'default'): LaunchDryRun => {
      const instance = get(id) ?? ensureDefault()
      const steps: LaunchStep[] = [
        { step: '实例目录', status: 'ok', detail: instance.path },
        {
          step: '游戏版本文件',
          status: instance.installed ? 'ok' : 'pending',
          detail: instance.installed ? instance.mcVersion : 'P1 接入下载（Mojang 版本清单）',
        },
        { step: 'Java 运行时', status: 'pending', detail: 'P1 接入：探测本地 JDK + 按版本自动下载' },
        { step: '启动参数组装', status: 'pending', detail: 'P1 接入：classpath / natives / 占位符替换' },
        { step: '启动进程', status: 'skipped', detail: 'P1 接入：spawn java + 日志接管' },
      ]
      telemetry.record('launch:dry-run', { instance: instance.id, steps: steps.length })
      log.info('instances', '启动预检（干跑）', { instance: instance.id, steps })
      return {
        ok: true,
        instance,
        steps,
        hint: 'P0 骨架：启动链路将在 P1 接入（见 docs/RESEARCH-P1-P2.md 与 docs/PLAN.md）',
      }
    }

    ctx.provide('instances', { list, get, ensureDefault, dryRun } satisfies InstancesService)
    ensureDefault()
  })
}
