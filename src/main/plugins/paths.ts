import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { definePlugin, type LauncherPlugin } from '../plugin-kit'

export interface PathsService {
  /** 用户数据根目录（Electron userData） */
  data: string
  logs: string
  cache: string
  /** 实例（版本隔离）根目录 */
  instances: string
  /** 全局下载缓存（内容寻址） */
  downloads: string
  tmp: string
  ensureAll(): void
}

export interface PathsConfig {
  dataDir: string
}

export function createPathsPlugin(config: PathsConfig): LauncherPlugin<void> {
  return definePlugin('paths', () => (ctx) => {
    const data = config.dataDir
    const svc: PathsService = {
      data,
      logs: path.join(data, 'logs'),
      cache: path.join(data, 'cache'),
      instances: path.join(data, 'instances'),
      downloads: path.join(data, 'downloads'),
      tmp: path.join(data, 'tmp'),
      ensureAll() {
        for (const p of [this.logs, this.cache, this.instances, this.downloads, this.tmp]) {
          mkdirSync(p, { recursive: true })
        }
      },
    }
    svc.ensureAll()
    ctx.provide('paths', svc)
  })
}
