/**
 * 一键安装服务（P28）：按「游戏版本 + 加载器」装好并原子绑定到实例。
 *
 * 背景：`versions:install` 只装原版、不绑定实例（绑定散落在 cli.ts），
 * 用户装完仍是「未绑定版本」。这里把「安装 → 绑定」收敛成一次 IPC 原子操作。
 *
 * 进度沿用 mojang / loaders 的 progress sink，不重复发事件。
 */
import type { FabricInstallResult, InstallerRunRequest, InstallerRunResult, NeoForgeInstallResult } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { InstancesService } from './instances'
import type { LoadersService } from './loaders'
import type { LogService } from './logger'
import type { MojangService } from './mojang'
import type { TelemetryService } from './telemetry'

export interface InstallerService {
  run(req: InstallerRunRequest): Promise<InstallerRunResult>
}

export function createInstallerPlugin(): LauncherPlugin<void> {
  return definePlugin('installer', () => (ctx) => {
    const log = use<LogService>(ctx, 'log')
    const mojang = use<MojangService>(ctx, 'mojang')
    const loaders = use<LoadersService>(ctx, 'loaders')
    const instances = use<InstancesService>(ctx, 'instances')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    async function run(req: InstallerRunRequest): Promise<InstallerRunResult> {
      const started = Date.now()
      const gameVersion = typeof req?.gameVersion === 'string' ? req.gameVersion.trim() : ''
      const loader = req?.loader ?? 'vanilla'
      if (!gameVersion) return { ok: false, loader, error: '缺少游戏版本（gameVersion）' }
      if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(loader)) {
        return { ok: false, error: `未知加载器：${loader}` }
      }

      const target = req.instanceId ? instances.get(req.instanceId) : instances.active()
      if (!target) return { ok: false, loader, error: `实例不存在: ${req.instanceId}` }

      const taskId = `installer-${gameVersion}-${Date.now()}`
      try {
        if (loader === 'vanilla') {
          const base = await mojang.install(gameVersion, taskId)
          if (!base.ok) return { ok: false, loader, error: base.error ?? '原版安装失败' }
          instances.setVersion(target.id, gameVersion, gameVersion, gameVersion, 'vanilla')
          const ms = Date.now() - started
          telemetry.record('installer:done', { instanceId: target.id, gameVersion, loader, versionId: gameVersion, ms })
          log.info('installer', '一键安装完成', { instanceId: target.id, versionId: gameVersion, gameVersion, loader, ms })
          return { ok: true, versionId: gameVersion, loader, ms }
        }

        let result: FabricInstallResult | NeoForgeInstallResult
        if (loader === 'fabric') {
          result = await loaders.installFabric(gameVersion, req.loaderVersion)
        } else if (loader === 'forge') {
          result = await loaders.installForge(gameVersion, req.loaderVersion)
        } else {
          result = await loaders.installNeoForge(gameVersion, req.loaderVersion)
        }

        if (!result.ok) {
          return { ok: false, loader, error: result.error ?? '安装失败' }
        }
        const versionId = result.versionId
        if (!versionId) {
          return { ok: false, loader, error: '安装成功但没有返回版本 id' }
        }

        instances.setVersion(target.id, versionId, gameVersion, gameVersion, loader)
        const ms = Date.now() - started
        telemetry.record('installer:done', { instanceId: target.id, gameVersion, loader, versionId, ms })
        log.info('installer', '一键安装完成', { instanceId: target.id, versionId, gameVersion, loader, ms })
        return {
          ok: true,
          versionId,
          loader,
          loaderVersion: result.loaderVersion,
          ms,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        telemetry.record('installer:error', { instanceId: target.id, gameVersion, loader, error: message })
        log.error('installer', '一键安装失败', { instanceId: target.id, gameVersion, loader, error: message })
        return { ok: false, loader, error: message }
      }
    }

    ctx.provide('installer', { run } satisfies InstallerService)
  })
}
