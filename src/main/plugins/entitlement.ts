import path from 'node:path'
import type { EntitlementItem } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { StorageService } from './storage'

/**
 * 授权门控（付费的地基）。
 *
 * 现在：freeMode = true，所有功能放行，不联网、不校验。
 * 以后：读本地签名 license（可离线校验、可过期、可吊销），未授权功能降级而不是崩溃。
 */
export interface EntitlementService {
  /** true = 免费期，所有功能放行 */
  readonly freeMode: boolean
  has(feature: string): boolean
  list(): EntitlementItem[]
}

export const FEATURES: { id: string; label: string; paid: boolean }[] = [
  { id: 'basic', label: '基础启动', paid: false },
  { id: 'ai', label: 'AI 助手', paid: false },
  { id: 'cloudsave', label: '云存档', paid: true },
  { id: 'market', label: '插件市场', paid: true },
]

interface LicenseFile {
  subject?: string
  features?: Record<string, { expiresAt?: number }>
  signature?: string
}

export function createEntitlementPlugin(): LauncherPlugin<void> {
  return definePlugin('entitlement', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const storage = use<StorageService>(ctx, 'storage')
    const log = use<LogService>(ctx, 'log')
    const licensePath = path.join(paths.data, 'license.json')
    const license = storage.readJson<LicenseFile>(licensePath, {})
    const freeMode = true

    const has = (feature: string): boolean => {
      if (freeMode) return true
      const entry = license.features?.[feature]
      if (!entry) return false
      return !entry.expiresAt || entry.expiresAt > Date.now()
    }

    const svc: EntitlementService = {
      freeMode,
      has,
      list: () =>
        FEATURES.map((f) => ({
          feature: f.id,
          granted: has(f.id),
          source: f.paid ? 'license' : 'free',
        })),
    }
    ctx.provide('entitlement', svc)
    log.info('entitlement', '授权门控就绪', { freeMode, features: FEATURES.length })
  })
}
