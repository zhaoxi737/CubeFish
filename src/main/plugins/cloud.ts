import type { TelemetryEvent, UpdateManifest } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { SettingsService } from './settings'

/**
 * CloudPort：所有联网能力的唯一出口。
 *
 * 规则：核心代码永远只通过这个接口联网。
 * P0 实现 = 本地/离线（未配置更新源就完全不出网）；
 * 以后换成 Cloudflare / 自建实现，上层零改动。
 */
export interface CloudPort {
  readonly id: string
  readonly online: boolean
  getUpdateManifest(): Promise<UpdateManifest | null>
  report(batch: TelemetryEvent[]): Promise<{ ok: boolean; skipped?: boolean; reason?: string }>
}

const FETCH_TIMEOUT_MS = 8000

export function createCloudPlugin(): LauncherPlugin<void> {
  return definePlugin('cloud', () => (ctx) => {
    const settings = use<SettingsService>(ctx, 'settings')
    const log = use<LogService>(ctx, 'log')

    const svc: CloudPort = {
      id: 'local-static',
      online: true,
      async getUpdateManifest(): Promise<UpdateManifest | null> {
        const url = settings.get('updateFeedUrl')
        if (!url) {
          log.debug('cloud', '未配置更新源，跳过更新检查（离线模式）')
          return null
        }
        try {
          const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
          if (!res.ok) {
            log.warn('cloud', '更新清单请求失败', { status: res.status, url })
            return null
          }
          const data = (await res.json()) as UpdateManifest
          if (!data || typeof data.version !== 'string') {
            log.warn('cloud', '更新清单格式不合法', { url })
            return null
          }
          return data
        } catch (err) {
          log.warn('cloud', '更新清单获取异常', { url, error: String(err) })
          return null
        }
      },
      async report(): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
        // P0：不实现上报。等最小后端就绪后在这里接 Worker/D1。
        return { ok: true, skipped: true, reason: 'P0 未接入上报端点' }
      },
    }
    ctx.provide('cloud', svc)
  })
}
