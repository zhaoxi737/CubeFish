import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { definePlugin, type LauncherPlugin } from '../plugin-kit'
import { stripBom } from '../lib/fsx'

/**
 * 存储抽象（云存档的地基）。
 *
 * P0 只有本地实现；未来加云端后端时，只需替换实现，
 * 上层调用与目录布局不变。`syncableSubdirs` 定义了「可同步」的边界：
 * 存档/配置能同步，jar 与大资源不进云端。
 */
export interface StorageService {
  readonly kind: 'local'
  readonly syncableSubdirs: readonly string[]
  readJson<T>(file: string, fallback: T): T
  writeJson(file: string, value: unknown): void
  writeText(file: string, text: string): void
  readText(file: string): string | undefined
  exists(file: string): boolean
  ensureDir(dir: string): void
}

export const SYNCABLE_SUBDIRS = ['saves', 'config', 'screenshots'] as const
export const LOCAL_ONLY_SUBDIRS = ['mods', 'resourcepacks', 'shaderpacks', 'logs', 'crash-reports'] as const

export function createStoragePlugin(): LauncherPlugin<void> {
  return definePlugin('storage', () => (ctx) => {
    const svc: StorageService = {
      kind: 'local',
      syncableSubdirs: SYNCABLE_SUBDIRS,
      readJson<T>(file: string, fallback: T): T {
        try {
          if (!existsSync(file)) return fallback
          return JSON.parse(stripBom(readFileSync(file, 'utf8'))) as T
        } catch {
          return fallback
        }
      },
      writeJson(file: string, value: unknown): void {
        mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        renameSync(tmp, file)
      },
      writeText(file: string, text: string): void {
        mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, text, 'utf8')
        renameSync(tmp, file)
      },
      readText(file: string): string | undefined {
        try {
          return existsSync(file) ? readFileSync(file, 'utf8') : undefined
        } catch {
          return undefined
        }
      },
      exists: (file) => existsSync(file),
      ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
    }
    ctx.provide('storage', svc)
  })
}
