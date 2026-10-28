import type { AppMeta, UpdateState } from '../../shared/types'
import { isNewer } from '../../shared/version'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { CloudPort } from './cloud'
import type { LogService } from './logger'
import type { SettingsService } from './settings'

/**
 * 自动更新（P0 只做「检查 + 状态」，下载替换在 P5）。
 *
 * 收费的地基之一：必须存在 minSupported 强制更新通道，
 * 否则以后改数据格式时老版本用户会直接崩。
 */
export interface UpdaterService {
  state(): UpdateState
  check(trigger?: 'startup' | 'manual' | 'chat'): Promise<UpdateState>
}

export function createUpdaterPlugin(): LauncherPlugin<void> {
  return definePlugin('updater', () => (ctx) => {
    const cloud = use<CloudPort>(ctx, 'cloud')
    const log = use<LogService>(ctx, 'log')
    const settings = use<SettingsService>(ctx, 'settings')
    const meta = use<AppMeta>(ctx, 'appMeta')

    let current: UpdateState = {
      status: 'idle',
      current: meta.version,
    }
    let inFlight: Promise<UpdateState> | null = null

    const check = (trigger: 'startup' | 'manual' | 'chat' = 'manual'): Promise<UpdateState> => {
      if (inFlight) return inFlight
      current = { ...current, status: 'checking', message: undefined }
      log.info('updater', '开始检查更新', { trigger, current: meta.version })

      inFlight = (async (): Promise<UpdateState> => {
        try {
          const manifest = await cloud.getUpdateManifest()
          if (!manifest) {
            current = {
              status: settings.get('updateFeedUrl') ? 'error' : 'offline',
              current: meta.version,
              message: settings.get('updateFeedUrl')
                ? '更新清单获取失败（网络或配置问题）'
                : '未配置更新源 · 离线模式',
              checkedAt: Date.now(),
            }
            log.info('updater', '更新检查结束：离线', { status: current.status })
            return current
          }

          const mustUpdate = Boolean(manifest.minSupported && isNewer(manifest.minSupported, meta.version))
          const available = isNewer(manifest.version, meta.version)
          current = {
            status: available ? 'available' : 'uptodate',
            current: meta.version,
            latest: manifest.version,
            notes: manifest.notes,
            url: manifest.url,
            minSupported: manifest.minSupported,
            mustUpdate,
            checkedAt: Date.now(),
          }
          log.info('updater', '更新检查完成', {
            status: current.status,
            latest: manifest.version,
            mustUpdate,
          })
          return current
        } catch (err) {
          current = {
            status: 'error',
            current: meta.version,
            message: err instanceof Error ? err.message : String(err),
            checkedAt: Date.now(),
          }
          log.warn('updater', '更新检查异常', { error: current.message })
          return current
        } finally {
          inFlight = null
        }
      })()

      return inFlight
    }

    ctx.provide('updater', { state: () => current, check } satisfies UpdaterService)
  })
}
