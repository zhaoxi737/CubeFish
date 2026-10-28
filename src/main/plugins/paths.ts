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
  /** 全局内容寻址下载缓存（cache/objects/xx/<sha1>） */
  downloads: string
  tmp: string
  /** 官方 JSON 原始缓存（manifest / version json / asset index） */
  meta: string
  /** 原版与加载器版本目录（<id>/<id>.json、<id>.jar、natives/） */
  versions: string
  /** 全局共享：库（Maven 布局） */
  libraries: string
  /** 全局共享：资源（indexes / objects / virtual / log_configs） */
  assets: string
  /** 全局共享：Java 运行时 */
  runtimes: string
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
      downloads: path.join(data, 'cache', 'objects'),
      tmp: path.join(data, 'tmp'),
      meta: path.join(data, 'meta'),
      versions: path.join(data, 'versions'),
      libraries: path.join(data, 'libraries'),
      assets: path.join(data, 'assets'),
      runtimes: path.join(data, 'runtimes'),
      ensureAll() {
        for (const p of [
          this.logs,
          this.cache,
          this.instances,
          this.downloads,
          this.tmp,
          this.meta,
          this.versions,
          this.libraries,
          this.assets,
          this.runtimes,
        ]) {
          mkdirSync(p, { recursive: true })
        }
      },
    }
    svc.ensureAll()
    ctx.provide('paths', svc)
  })
}
