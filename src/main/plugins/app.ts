import os from 'node:os'
import type { AppMeta } from '../../shared/types'
import { definePlugin, type LauncherPlugin } from '../plugin-kit'

export interface AppConfig {
  name: string
  version: string
  electron: string
  chrome: string
  isSmoke: boolean
}

/** 提供 appMeta：版本、运行时、启动模式。 */
export function createAppPlugin(config: AppConfig): LauncherPlugin<void> {
  return definePlugin('app', () => (ctx) => {
    const meta: AppMeta = {
      name: config.name,
      version: config.version,
      electron: config.electron,
      chrome: config.chrome,
      node: process.versions.node,
      platform: `${os.platform()}-${os.release()}`,
      arch: os.arch(),
      isSmoke: config.isSmoke,
      bootedAt: Date.now(),
    }
    ctx.provide('appMeta', meta)
  })
}
