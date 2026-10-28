/**
 * Mojang 官方资源服务：版本清单 / 版本 JSON / 原版安装（client + libraries + assets + logging）。
 * 参照 docs/RESEARCH-P1-P2.md §1。
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { InstallResult, TaskProgress, VersionList, VersionSummary, VersionType } from '../../shared/types'
import { Downloader, type DownloadSpec } from '../lib/downloader'
import { ensureDir, readJson, writeJsonAtomic } from '../lib/fsx'
import { parseMaven } from '../lib/maven'
import { detectOsContext, evaluateRules, type OsContext } from '../lib/rules'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { TelemetryService } from './telemetry'

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const RESOURCES_BASE = 'https://resources.download.minecraft.net'
const USER_AGENT = 'QDOQMC/0.1.0 (+https://qdoqmc.example/contact)'
const MANIFEST_TTL_MS = 30 * 60 * 1000

export type ArgumentEntry = string | { rules?: unknown[]; value: string | string[] }

export interface LibraryJson {
  name: string
  url?: string
  rules?: unknown[]
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  sha1?: string
  size?: number
  downloads?: {
    artifact?: { path: string; sha1: string; size: number; url: string }
    classifiers?: Record<string, { path: string; sha1: string; size: number; url: string }>
  }
}

export interface VersionJson {
  id: string
  type?: string
  mainClass: string
  inheritsFrom?: string
  assets?: string
  assetIndex?: { id: string; sha1: string; size: number; totalSize?: number; url: string }
  downloads?: { client?: { sha1: string; size: number; url: string } }
  javaVersion?: { component: string; majorVersion: number }
  logging?: {
    client?: { argument: string; type: string; file: { id: string; sha1: string; size: number; url: string } }
  }
  arguments?: { game?: ArgumentEntry[]; jvm?: ArgumentEntry[] }
  minecraftArguments?: string
  libraries: LibraryJson[]
}

interface AssetIndexFile {
  objects: Record<string, { hash: string; size: number }>
  virtual?: boolean
  map_to_resources?: boolean
}

interface VersionManifestEntry {
  id: string
  type: VersionType
  url: string
  time: string
  releaseTime: string
  sha1?: string
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionManifestEntry[]
}

export interface MojangService {
  manifest(force?: boolean): Promise<VersionManifest>
  list(type?: VersionType | 'all'): Promise<VersionList>
  versionJson(versionId: string): Promise<VersionJson>
  installed(): Promise<string[]>
  install(versionId: string, taskId: string): Promise<InstallResult>
  /** IPC 层注入，用于把安装进度推给渲染进程 */
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
}

function joinUrl(base: string, rel: string): string {
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
}

export function createMojangPlugin(): LauncherPlugin<void> {
  return definePlugin('mojang', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')
    const osContext: OsContext = detectOsContext(process.platform, process.arch, os.release())

    let sink: ((progress: TaskProgress) => void) | null = null

    const manifestCache = path.join(paths.meta, 'version_manifest_v2.json')
    const manifestStamp = path.join(paths.meta, 'version_manifest_v2.stamp.json')

    const dl = (concurrency: number) =>
      new Downloader({
        cacheDir: paths.downloads,
        concurrency,
        onVerbose: (message, data) => log.warn('mojang', message, data),
      })

    async function manifest(force = false): Promise<VersionManifest> {
      const stamp = await readJson<{ fetchedAt: number }>(manifestStamp, { fetchedAt: 0 })
      if (!force && existsSync(manifestCache) && Date.now() - stamp.fetchedAt < MANIFEST_TTL_MS) {
        const cached = await readJson<VersionManifest | undefined>(manifestCache, undefined)
        if (cached?.versions?.length) return cached
      }
      const res = await fetch(MANIFEST_URL, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`版本清单请求失败: HTTP ${res.status}`)
      const data = (await res.json()) as VersionManifest
      await writeJsonAtomic(manifestCache, data)
      await writeJsonAtomic(manifestStamp, { fetchedAt: Date.now() })
      log.info('mojang', '版本清单已更新', { versions: data.versions.length, latest: data.latest })
      return data
    }

    async function versionJson(versionId: string): Promise<VersionJson> {
      const list = await manifest()
      const entry = list.versions.find((v) => v.id === versionId)
      if (!entry) throw new Error(`未知版本: ${versionId}`)
      const dest = path.join(paths.meta, 'versions', `${versionId}.json`)
      await dl(1).fetchOne({ url: entry.url, dest, sha1: entry.sha1, label: `version.json ${versionId}` })
      const json = await readJson<VersionJson | undefined>(dest, undefined)
      if (!json?.libraries) throw new Error(`版本 JSON 解析失败: ${versionId}`)
      return json
    }

    async function installed(): Promise<string[]> {
      try {
        const entries = await readdir(paths.versions, { withFileTypes: true })
        return entries
          .filter((e) => e.isDirectory() && existsSync(path.join(paths.versions, e.name, `${e.name}.json`)))
          .map((e) => e.name)
      } catch {
        return []
      }
    }

    async function list(type: VersionType | 'all' = 'release'): Promise<VersionList> {
      const data = await manifest()
      const versions: VersionSummary[] = data.versions
        .filter((v) => type === 'all' || v.type === type)
        .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }))
      return { latest: data.latest, versions, installed: await installed() }
    }

    async function install(versionId: string, taskId: string): Promise<InstallResult> {
      const started = Date.now()
      const emit = (stage: TaskProgress['stage'], done: number, total: number, bytes = 0, message?: string) => {
        sink?.({ taskId, kind: 'install', stage, done, total, bytes, message })
      }
      try {
        telemetry.record('install:start', { versionId })
        emit('version', 0, 1, 0, '解析版本 JSON')
        const json = await versionJson(versionId)
        const versionDir = path.join(paths.versions, versionId)
        await ensureDir(versionDir)

        const specs: DownloadSpec[] = []

        if (json.downloads?.client) {
          specs.push({
            url: json.downloads.client.url,
            dest: path.join(versionDir, `${versionId}.jar`),
            sha1: json.downloads.client.sha1,
            size: json.downloads.client.size,
            label: 'client.jar',
          })
        }

        // 库：artifact / 加载器 Maven 坐标 / 老世代 natives 分类器
        for (const lib of json.libraries) {
          if (!evaluateRules(lib.rules as any, osContext)) continue
          const artifact = lib.downloads?.artifact
          if (artifact) {
            specs.push({
              url: artifact.url,
              dest: path.join(paths.libraries, artifact.path),
              sha1: artifact.sha1,
              size: artifact.size,
              label: lib.name,
            })
          } else if (lib.url && lib.name) {
            const coord = parseMaven(lib.name)
            if (coord) {
              specs.push({
                url: joinUrl(lib.url, coord.path),
                dest: path.join(paths.libraries, coord.path),
                sha1: lib.sha1,
                size: lib.size,
                label: lib.name,
              })
            }
          }
          const nativeKey = lib.natives?.[osContext.name]
          const classifier = nativeKey ? lib.downloads?.classifiers?.[nativeKey] : undefined
          if (classifier) {
            specs.push({
              url: classifier.url,
              dest: path.join(paths.libraries, classifier.path),
              sha1: classifier.sha1,
              size: classifier.size,
              label: `${lib.name}:${nativeKey}`,
            })
          }
        }

        const libDownloader = new Downloader({
          cacheDir: paths.downloads,
          concurrency: 8,
          onProgress: (done, total, bytes) => emit('libraries', done, total, bytes, '下载库文件'),
          onVerbose: (message, data) => log.warn('mojang', message, data),
        })
        const libStats = await libDownloader.downloadAll(specs)
        emit('libraries', specs.length, specs.length, libStats.bytes, '库文件完成')
        if (libStats.failed.length > 0) {
          throw new Error(`有 ${libStats.failed.length} 个库下载失败（首个：${libStats.failed[0].label ?? libStats.failed[0].url}）`)
        }

        // 资源索引 + 资源对象
        let assetIndexId: string | undefined
        if (json.assetIndex) {
          assetIndexId = json.assetIndex.id
          const indexDest = path.join(paths.assets, 'indexes', `${assetIndexId}.json`)
          await dl(1).fetchOne({
            url: json.assetIndex.url,
            dest: indexDest,
            sha1: json.assetIndex.sha1,
            size: json.assetIndex.size,
            label: 'asset index',
          })
          const index = await readJson<AssetIndexFile | undefined>(indexDest, undefined)
          const entries = Object.entries(index?.objects ?? {})
          emit('assets', 0, entries.length, 0, `资源索引 ${assetIndexId}（${entries.length} 个对象）`)

          const assetSpecs: DownloadSpec[] = entries.map(([key, obj]) => ({
            url: `${RESOURCES_BASE}/${obj.hash.slice(0, 2)}/${obj.hash}`,
            dest: path.join(paths.assets, 'objects', obj.hash.slice(0, 2), obj.hash),
            sha1: obj.hash,
            size: obj.size,
            label: key,
          }))

          const assetDownloader = new Downloader({
            cacheDir: paths.downloads,
            concurrency: 16,
            onProgress: (done, total, bytes) => emit('assets', done, total, bytes, '下载资源'),
            onVerbose: (message, data) => log.warn('mojang', message, data),
          })
          const assetStats = await assetDownloader.downloadAll(assetSpecs)
          if (assetStats.failed.length > 0) {
            throw new Error(`有 ${assetStats.failed.length} 个资源下载失败（首个：${assetStats.failed[0].label}）`)
          }

          if (index?.virtual || index?.map_to_resources) {
            const indexKind = index.virtual ? assetIndexId : 'pre-1.6'
            emit('legacy', 0, entries.length, 0, '物化旧版资源目录')
            await materializeVirtual(paths.assets, indexKind, index)
            emit('legacy', entries.length, entries.length)
          }
        }

        // 日志配置
        const loggingFile = json.logging?.client?.file
        if (loggingFile) {
          await dl(1).fetchOne({
            url: loggingFile.url,
            dest: path.join(paths.assets, 'log_configs', loggingFile.id),
            sha1: loggingFile.sha1,
            size: loggingFile.size,
            label: 'log config',
          })
        }

        await writeJsonAtomic(path.join(versionDir, `${versionId}.json`), json)

        const result: InstallResult = {
          ok: true,
          versionId,
          ms: Date.now() - started,
          javaMajor: json.javaVersion?.majorVersion ?? 8,
          assetIndex: assetIndexId,
          files: specs.length,
        }
        emit('done', 1, 1, 0, '安装完成')
        telemetry.record('install:done', { versionId, ms: result.ms, javaMajor: result.javaMajor })
        log.info('mojang', '版本安装完成', { versionId, ms: result.ms, javaMajor: result.javaMajor })
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        telemetry.record('install:error', { versionId, error: message })
        log.error('mojang', '版本安装失败', { versionId, error: message })
        return { ok: false, versionId, ms: Date.now() - started, error: message }
      }
    }

    ctx.provide('mojang', {
      manifest,
      list,
      versionJson,
      installed,
      install,
      setProgressSink: (next) => {
        sink = next
      },
    } satisfies MojangService)
  })
}

/** legacy（1.6.x）与 pre-1.6 资源需要物化到实际目录，旧版游戏才读得到。 */
async function materializeVirtual(assetsRoot: string, indexKind: string, index: AssetIndexFile | undefined): Promise<void> {
  const { link, copyFile } = await import('node:fs/promises')
  const targetRoot =
    indexKind === 'pre-1.6' ? path.join(assetsRoot, 'virtual', 'pre-1.6') : path.join(assetsRoot, 'virtual', indexKind)
  for (const [key, obj] of Object.entries(index?.objects ?? {})) {
    const source = path.join(assetsRoot, 'objects', obj.hash.slice(0, 2), obj.hash)
    const dest = path.join(targetRoot, key)
    if (existsSync(dest)) continue
    await ensureDir(path.dirname(dest))
    try {
      await link(source, dest)
    } catch {
      await copyFile(source, dest).catch(() => undefined)
    }
  }
}
