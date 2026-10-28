/**
 * 加载器服务（P2）：Fabric。
 * 参照 docs/RESEARCH-P1-P2.md §3.1：meta API 纯合并，不跑安装器进程。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FabricInstallResult, TaskProgress } from '../../shared/types'
import { Downloader, type DownloadSpec } from '../lib/downloader'
import { ensureDir, readJson, writeJsonAtomic } from '../lib/fsx'
import { parseMaven } from '../lib/maven'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { MojangService } from './mojang'
import type { PathsService } from './paths'
import type { TelemetryService } from './telemetry'

const FABRIC_META = 'https://meta.fabricmc.net/v2'
const UA = 'QDOQMC/0.1.0 (+https://qdoqmc.example/contact)'

interface FabricLoaderEntry {
  loader: { version: string; stable: boolean; maven: string }
  intermediary: { version: string }
  launcherMeta: unknown
}

interface FabricProfile {
  id: string
  inheritsFrom: string
  mainClass: string
  libraries: { name: string; url: string; sha1?: string; size?: number }[]
  arguments?: { game?: unknown[]; jvm?: string[] }
}

export interface LoadersService {
  fabricVersions(gameVersion: string): Promise<{ version: string; stable: boolean }[]>
  installFabric(gameVersion: string): Promise<FabricInstallResult>
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
}

export function createLoadersPlugin(): LauncherPlugin<void> {
  return definePlugin('loaders', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const mojang = use<MojangService>(ctx, 'mojang')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    let sink: ((progress: TaskProgress) => void) | null = null

    async function getJson<T>(url: string): Promise<T> {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`Fabric meta 请求失败: HTTP ${res.status} ${url}`)
      return (await res.json()) as T
    }

    async function fabricVersions(gameVersion: string): Promise<{ version: string; stable: boolean }[]> {
      const list = await getJson<FabricLoaderEntry[]>(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`)
      return list.map((entry) => ({ version: entry.loader.version, stable: entry.loader.stable }))
    }

    async function installFabric(gameVersion: string): Promise<FabricInstallResult> {
      try {
        const taskId = `fabric-${gameVersion}-${Date.now()}`
        const emit = (stage: string, done: number, total: number, bytes = 0, message?: string) =>
          sink?.({ taskId, kind: 'install', stage, done, total, bytes, message })

        // 1) 原版必须先装（Fabric profile 通过 inheritsFrom 依赖它）
        const vanillaJson = path.join(paths.versions, gameVersion, `${gameVersion}.json`)
        if (!existsSync(vanillaJson) || !existsSync(path.join(paths.versions, gameVersion, `${gameVersion}.jar`))) {
          emit('version', 0, 1, 0, `先安装原版 ${gameVersion}`)
          const baseResult = await mojang.install(gameVersion, taskId)
          if (!baseResult.ok) return { ok: false, gameVersion, error: `原版安装失败：${baseResult.error}` }
        }

        // 2) 选 loader 版本（优先 stable）
        emit('libraries', 0, 1, 0, '查询 Fabric loader 版本')
        const loaders = await fabricVersions(gameVersion)
        if (loaders.length === 0) return { ok: false, gameVersion, error: `Fabric 不支持 ${gameVersion}` }
        const chosen = loaders.find((entry) => entry.stable) ?? loaders[0]

        // 3) 拉 profile json
        const profile = await getJson<FabricProfile>(
          `${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(chosen.version)}/profile/json`,
        )
        const versionId = profile.id
        const versionDir = path.join(paths.versions, versionId)
        await ensureDir(versionDir)

        // 4) 下载 loader 库（Maven 坐标 + url 拼接）
        const specs: DownloadSpec[] = []
        for (const lib of profile.libraries ?? []) {
          const coord = parseMaven(lib.name)
          if (!coord || !lib.url) continue
          specs.push({
            url: `${lib.url.replace(/\/+$/, '')}/${coord.path}`,
            dest: path.join(paths.libraries, coord.path),
            sha1: lib.sha1,
            size: lib.size,
            label: lib.name,
          })
        }
        const downloader = new Downloader({
          cacheDir: paths.downloads,
          concurrency: 8,
          onProgress: (done, total, bytes) => emit('libraries', done, total, bytes, '下载 Fabric 库'),
          onVerbose: (message, data) => log.warn('loaders', message, data),
        })
        const stats = await downloader.downloadAll(specs)
        if (stats.failed.length > 0) {
          return {
            ok: false,
            gameVersion,
            error: `Fabric 库下载失败 ${stats.failed.length} 个（首个：${stats.failed[0].label}）`,
          }
        }

        // 5) 写版本 json
        await writeJsonAtomic(path.join(versionDir, `${versionId}.json`), profile)
        emit('done', 1, 1, 0, `Fabric ${chosen.version} 安装完成`)
        telemetry.record('loader:fabric', { gameVersion, loader: chosen.version, versionId, libraries: specs.length })
        log.info('loaders', 'Fabric 安装完成', { versionId, loader: chosen.version, libraries: specs.length })
        return { ok: true, gameVersion, versionId, loaderVersion: chosen.version, libraries: specs.length }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('loaders', 'Fabric 安装失败', { gameVersion, error: message })
        telemetry.record('loader:fabric:error', { gameVersion, error: message })
        return { ok: false, gameVersion, error: message }
      }
    }

    // 读回已安装的 profile（供 UI 展示）
    async function readProfile(versionId: string): Promise<FabricProfile | undefined> {
      return readJson<FabricProfile | undefined>(path.join(paths.versions, versionId, `${versionId}.json`), undefined)
    }

    ctx.provide('loaders', {
      fabricVersions,
      installFabric,
      readProfile,
      setProgressSink: (next) => {
        sink = next
      },
    } as LoadersService & { readProfile: typeof readProfile })
  })
}
