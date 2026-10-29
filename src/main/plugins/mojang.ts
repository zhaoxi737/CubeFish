/**
 * Mojang 官方资源服务：版本清单 / 版本 JSON / 原版安装（client + libraries + assets + logging）。
 * 参照 docs/RESEARCH-P1-P2.md §1、docs/P28-SPEC.md §2.5–2.6。
 *
 * P28 新增：
 * - `mirrorUrl()`：纯函数，官方 URL → BMCLAPI 镜像 URL（便于单测）；
 * - `downloadSource: 'auto'` 时 800ms 探测 BMCLAPI，结果缓存 10 分钟，失败静默走官方；
 * - `cancel()`：中止当前安装（AbortController 贯穿所有 Downloader），发 `stage:'cancelled'`；
 * - PCL 式加权阶段进度（version 5% / libraries 30% / assets 60% / logging 5%），200ms 节流。
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  DownloadSource,
  InstallResult,
  ProgressFile,
  StageProgress,
  TaskProgress,
  VersionList,
  VersionSummary,
  VersionType,
} from '../../shared/types'
import {
  Downloader,
  isAbortError,
  throwIfAborted,
  type DownloadProgressStats,
  type DownloadSpec,
} from '../lib/downloader'
import { ensureDir, readJson, writeJsonAtomic } from '../lib/fsx'
import { parseMaven } from '../lib/maven'
import { detectOsContext, evaluateRules, type OsContext } from '../lib/rules'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const RESOURCES_BASE = 'https://resources.download.minecraft.net'
const USER_AGENT = 'QDOQMC/0.1.0 (+https://qdoqmc.example/contact)'
const MANIFEST_TTL_MS = 30 * 60 * 1000

export const BMCLAPI_BASE = 'https://bmclapi2.bangbang93.com'
const PROBE_URL = `${BMCLAPI_BASE}/mc/game/version_manifest_v2.json`
/** 自动测速超时：探测的是完整清单吞吐，6000ms 足够；两个源并行，最多等这么久 */
const PROBE_TIMEOUT_MS = 6000
const SOURCE_CACHE_MS = 15 * 60 * 1000
/** progress 推送节流：每 200ms 最多一次 */
const PROGRESS_INTERVAL_MS = 200
/** P29：逐文件清单最多显示 200 条（assets 常上千个） */
const MAX_PROGRESS_FILES = 200

const MOJANG_HOSTS = new Set([
  'launchermeta.mojang.com',
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
])

/** 安装阶段定义（顺序与权重见 docs/P28-SPEC.md §2.6）。 */
interface StageDef {
  stage: string
  label: string
  weight: number
}

const STAGE_DEFS: StageDef[] = [
  { stage: 'version', label: '下载版本信息', weight: 5 },
  { stage: 'libraries', label: '下载库文件', weight: 30 },
  { stage: 'assets', label: '下载资源文件', weight: 60 },
  { stage: 'logging', label: '下载日志配置', weight: 5 },
]

interface StageState extends StageProgress {
  weight: number
}

/**
 * 官方下载地址 → 镜像地址（纯函数，便于单测）。
 * `source !== 'bmclapi'`（含 official/auto 未解析态）原样返回。
 */
export function mirrorUrl(url: string, source: DownloadSource): string {
  if (source !== 'bmclapi') return url
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const suffix = `${parsed.pathname}${parsed.search}`
    if (MOJANG_HOSTS.has(host)) return `${BMCLAPI_BASE}${suffix}`
    if (host === 'resources.download.minecraft.net') {
      // /<a>/<hash> → /assets/<a>/<hash>
      return `${BMCLAPI_BASE}/assets${parsed.pathname}${parsed.search}`
    }
    if (host === 'libraries.minecraft.net') {
      // /<path> → /maven/<path>
      return `${BMCLAPI_BASE}/maven${suffix}`
    }
    // Modrinth 等其它域名不映射
    return url
  } catch {
    return url
  }
}

/* ---------- 自动测速选源（auto 模式；模块级缓存，进程内共享） ---------- */

export interface SourceProbeResult {
  /** 实际选中的下载源（official 或 bmclapi） */
  source: 'official' | 'bmclapi'
  /** 官方清单实测吞吐（KB/s，按读完整个 body 计算）；失败/超时为 undefined */
  officialKBps?: number
  /** BMCLAPI 清单实测吞吐（KB/s）；失败/超时为 undefined */
  bmclapiKBps?: number
  /** 实测读到的字节数（用于判断是否读到完整清单） */
  officialBytes?: number
  bmclapiBytes?: number
  /** 是否来自 15 分钟缓存 */
  cached?: boolean
}

let probeCache: { at: number; result: SourceProbeResult } | undefined
let probeInflight: Promise<SourceProbeResult> | undefined

interface SourceMeasurement {
  KBps: number
  bytes: number
}

/**
 * 下载完整版清单并计时，返回实测吞吐（KB/s）。
 * 只比 TTFB 会误判：bmclapi 常见「握手快、大文件带宽差」，必须按吞吐选。
 */
async function measureSource(url: string): Promise<SourceMeasurement | undefined> {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return undefined
    }
    const buffer = await res.arrayBuffer()
    const ms = Math.max(1, Date.now() - started)
    const bytes = buffer.byteLength
    if (bytes === 0) return undefined
    return { KBps: Math.round(bytes / 1024 / (ms / 1000)), bytes }
  } catch {
    return undefined
  }
}

/**
 * 自动测速：并行下载官方 / BMCLAPI 的 version_manifest_v2.json，按实测吞吐选源。
 * - 两者都成功：bmclapi ≥ official × 0.8 时优先国内镜像，否则取更快者；
 * - 只有一个成功：用它；都失败：official（静默回退，不向用户报错）。
 * 结果缓存 15 分钟；并发只探测一次（inflight Promise 复用）。
 */
export async function probeDownloadSource(): Promise<SourceProbeResult> {
  if (probeCache && Date.now() - probeCache.at < SOURCE_CACHE_MS) {
    return { ...probeCache.result, cached: true }
  }
  if (!probeInflight) {
    probeInflight = (async (): Promise<SourceProbeResult> => {
      const [official, bmclapi] = await Promise.all([measureSource(MANIFEST_URL), measureSource(PROBE_URL)])
      let source: 'official' | 'bmclapi' = 'official'
      if (official && bmclapi) {
        source = bmclapi.KBps >= official.KBps * 0.8 ? 'bmclapi' : official.KBps >= bmclapi.KBps ? 'official' : 'bmclapi'
      } else if (bmclapi) {
        source = 'bmclapi'
      } else {
        source = 'official'
      }
      return {
        source,
        officialKBps: official?.KBps,
        bmclapiKBps: bmclapi?.KBps,
        officialBytes: official?.bytes,
        bmclapiBytes: bmclapi?.bytes,
      }
    })()
      .then((result) => {
        probeCache = { at: Date.now(), result }
        return result
      })
      .finally(() => {
        probeInflight = undefined
      })
  }
  return probeInflight
}

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
  versionJson(versionId: string, signal?: AbortSignal): Promise<VersionJson>
  installed(): Promise<string[]>
  install(versionId: string, taskId: string): Promise<InstallResult>
  /** P28：取消当前安装任务（中止下载，清理 .part） */
  cancel(): Promise<{ ok: boolean; cancelled: boolean }>
  /** IPC 层注入，用于把安装进度推给渲染进程 */
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
}

function joinUrl(base: string, rel: string): string {
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
}

interface DownloaderOptionsLike {
  concurrency?: number
  threads?: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number, bytes: number, label?: string, stats?: DownloadProgressStats) => void
  /** P29：文件清单 / 单文件状态回调 */
  onFiles?: (files: { name: string; size?: number }[]) => void
  onFileState?: (index: number, state: ProgressFile['state']) => void
}

export function createMojangPlugin(): LauncherPlugin<void> {
  return definePlugin('mojang', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const settings = use<SettingsService>(ctx, 'settings')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')
    const osContext: OsContext = detectOsContext(process.platform, process.arch, os.release())

    let sink: ((progress: TaskProgress) => void) | null = null
    /** taskId → 取消控制器：支持「取消当前安装」 */
    const activeInstalls = new Map<string, AbortController>()

    const manifestCache = path.join(paths.meta, 'version_manifest_v2.json')
    const manifestStamp = path.join(paths.meta, 'version_manifest_v2.stamp.json')

    const threadsOf = (): number => {
      const value = settings.get('downloadThreads')
      return Number.isFinite(value) ? Math.min(16, Math.max(1, Math.round(value))) : 4
    }

    const dl = (options: DownloaderOptionsLike = {}) =>
      new Downloader({
        cacheDir: paths.downloads,
        concurrency: options.concurrency ?? 8,
        threads: options.threads ?? threadsOf(),
        signal: options.signal,
        onProgress: options.onProgress,
        onFiles: options.onFiles,
        onFileState: options.onFileState,
        onVerbose: (message, data) => log.warn('mojang', message, data),
      })

    /** 设置项 → 实际下载源；auto 时按实测吞吐选源（失败静默官方）。 */
    async function resolveSource(): Promise<'official' | 'bmclapi'> {
      const configured = settings.get('downloadSource')
      if (configured === 'official' || configured === 'bmclapi') return configured
      const result = await probeDownloadSource()
      if (!result.cached) {
        log.info('mojang', '下载源探测', {
          official: result.officialKBps === undefined ? '失败' : `${result.officialKBps} KB/s`,
          bmclapi: result.bmclapiKBps === undefined ? '失败' : `${result.bmclapiKBps} KB/s`,
          chosen: result.source,
        })
      }
      return result.source
    }

    async function loadManifest(force = false, signal?: AbortSignal): Promise<VersionManifest> {
      const stamp = await readJson<{ fetchedAt: number }>(manifestStamp, { fetchedAt: 0 })
      if (!force && existsSync(manifestCache) && Date.now() - stamp.fetchedAt < MANIFEST_TTL_MS) {
        const cached = await readJson<VersionManifest | undefined>(manifestCache, undefined)
        if (cached?.versions?.length) return cached
      }
      throwIfAborted(signal)
      const source = await resolveSource()
      const timeout = AbortSignal.timeout(20_000)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      let res = await fetch(mirrorUrl(MANIFEST_URL, source), {
        headers: { 'user-agent': USER_AGENT },
        signal: combined,
      })
      // 镜像不可用（403/404/连不上）时回退官方清单
      if (!res.ok && source === 'bmclapi') {
        await res.body?.cancel().catch(() => undefined)
        res = await fetch(MANIFEST_URL, {
          headers: { 'user-agent': USER_AGENT },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        })
      }
      if (!res.ok) throw new Error(`版本清单请求失败: HTTP ${res.status}`)
      const data = (await res.json()) as VersionManifest
      await writeJsonAtomic(manifestCache, data)
      await writeJsonAtomic(manifestStamp, { fetchedAt: Date.now() })
      log.info('mojang', '版本清单已更新', { versions: data.versions.length, latest: data.latest, source })
      return data
    }

    async function manifest(force = false): Promise<VersionManifest> {
      return loadManifest(force)
    }

    async function versionJson(versionId: string, signal?: AbortSignal): Promise<VersionJson> {
      // 1) 本地已安装版本（原版或加载器 profile）优先：加载器版本不在 Mojang 清单里
      const installedFile = path.join(paths.versions, versionId, `${versionId}.json`)
      if (existsSync(installedFile)) {
        const local = await readJson<VersionJson | undefined>(installedFile, undefined)
        if (local?.libraries) return local
      }

      // 2) Mojang 清单 → 下载并缓存
      const list = await loadManifest(false, signal)
      const entry = list.versions.find((v) => v.id === versionId)
      if (!entry) throw new Error(`未知版本: ${versionId}`)
      const source = await resolveSource()
      const dest = path.join(paths.meta, 'versions', `${versionId}.json`)
      await dl({ concurrency: 1, threads: 1, signal }).fetchOne({
        url: mirrorUrl(entry.url, source),
        dest,
        sha1: entry.sha1,
        label: `version.json ${versionId}`,
        fallbackUrl: source === 'bmclapi' ? entry.url : undefined,
      })
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

    async function cancel(): Promise<{ ok: boolean; cancelled: boolean }> {
      let cancelled = false
      for (const controller of activeInstalls.values()) {
        if (!controller.signal.aborted) {
          controller.abort()
          cancelled = true
        }
      }
      if (cancelled) log.info('mojang', '已请求取消安装', { tasks: activeInstalls.size })
      return { ok: true, cancelled }
    }

    async function install(versionId: string, taskId: string): Promise<InstallResult> {
      const started = Date.now()
      const controller = new AbortController()
      activeInstalls.set(taskId, controller)
      const signal = controller.signal

      const source = await resolveSource()
      const threadCount = threadsOf()

      // ---- PCL 式阶段状态：权重见 STAGE_DEFS ----
      const stages: StageState[] = STAGE_DEFS.map((def) => ({
        ...def,
        done: 0,
        total: 0,
        bytes: 0,
        bytesTotal: 0,
        state: 'pending',
      }))
      let speed = 0
      let etaMs: number | undefined
      let currentFile: string | undefined
      let lastEmit = 0
      let lastPercent = 0

      // ---- P29：当前阶段的逐文件清单（PCL 式） ----
      let progressFiles: ProgressFile[] = []
      const setProgressFiles = (files: { name: string; size?: number }[]): void => {
        progressFiles = files.slice(0, MAX_PROGRESS_FILES).map((file) => ({
          name: file.name,
          size: file.size,
          state: 'pending' as const,
        }))
      }
      const setProgressFileState = (index: number, state: ProgressFile['state']): void => {
        const file = progressFiles[index]
        if (file) file.state = state
      }

      const stageOf = (name: string): StageState => stages.find((item) => item.stage === name) ?? stages[0]
      const snapshot = (): StageProgress[] =>
        stages.map(({ stage, label, done, total, bytes, bytesTotal, state }) => ({
          stage,
          label,
          done,
          total,
          bytes,
          bytesTotal,
          state,
        }))

      const percentOf = (): number => {
        let sum = 0
        for (const stage of stages) {
          const fraction =
            stage.state === 'done'
              ? 1
              : stage.bytesTotal > 0
                ? Math.min(1, stage.bytes / stage.bytesTotal)
                : stage.total > 0
                  ? Math.min(1, stage.done / stage.total)
                  : 0
          sum += stage.weight * fraction
        }
        return Math.round(Math.min(100, Math.max(0, sum)) * 10) / 10
      }

      const totals = () => {
        let bytes = 0
        let bytesTotal = 0
        let filesDone = 0
        let filesTotal = 0
        for (const stage of stages) {
          bytes += stage.bytes
          bytesTotal += stage.bytesTotal
          filesDone += stage.done
          filesTotal += stage.total
        }
        return { bytes, bytesTotal, filesDone, filesTotal }
      }

      /* 每 200ms 最多发一次 progress（force 用于阶段切换/完成/取消）。 */
      const emit = (stage: string, force = false, message?: string): void => {
        const now = Date.now()
        if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
        lastEmit = now
        lastPercent = percentOf()
        const current = stages.find((item) => item.stage === stage) ?? stages.find((item) => item.state === 'running') ?? stages[0]
        const sum = totals()
        sink?.({
          taskId,
          kind: 'install',
          stage,
          done: current.done,
          total: current.total,
          bytes: current.bytes,
          message,
          percent: stage === 'done' ? 100 : lastPercent,
          bytesTotal: sum.bytesTotal > 0 ? sum.bytesTotal : undefined,
          speed: speed > 0 ? Math.round(speed) : undefined,
          etaMs,
          currentFile,
          filesDone: sum.filesDone,
          filesTotal: sum.filesTotal,
          stages: snapshot(),
          source,
          // P29：任务标题 + 当前阶段文件清单
          title: `安装 ${versionId}`,
          files: progressFiles.length > 0 ? progressFiles.map((file) => ({ ...file })) : undefined,
        })
      }

      try {
        telemetry.record('install:start', { versionId })
        throwIfAborted(signal)

        const versionStage = stageOf('version')
        versionStage.state = 'running'
        versionStage.total = 1
        emit('version', true, '解析版本 JSON')

        const json = await versionJson(versionId, signal)
        const versionDir = path.join(paths.versions, versionId)
        await ensureDir(versionDir)
        versionStage.done = 1
        versionStage.state = 'done'

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

        // 统一过镜像重写；镜像缺文件（403/404）时用官方地址兜底
        const downloadSpecs: DownloadSpec[] = specs.map((spec) => ({
          ...spec,
          url: mirrorUrl(spec.url, source),
          fallbackUrl: source === 'bmclapi' ? spec.url : undefined,
        }))

        const libStage = stageOf('libraries')
        libStage.state = 'running'
        libStage.total = downloadSpecs.length
        libStage.bytesTotal = downloadSpecs.reduce((sum, spec) => sum + (spec.size ?? 0), 0)
        setProgressFiles(downloadSpecs.map((spec) => ({ name: spec.label ?? path.basename(spec.dest), size: spec.size })))
        emit('libraries', true, '下载库文件')

        const libDownloader = dl({
          concurrency: 8,
          threads: threadCount,
          signal,
          onFiles: (files) => {
            setProgressFiles(files)
            emit('libraries')
          },
          onFileState: (index, state) => {
            setProgressFileState(index, state)
            emit('libraries')
          },
          onProgress: (done, total, bytes, label, stats) => {
            libStage.done = done
            libStage.total = total
            libStage.bytes = bytes
            if (stats) {
              libStage.bytesTotal = Math.max(libStage.bytesTotal, stats.bytesTotal)
              speed = stats.speed
              etaMs = stats.etaMs
            }
            currentFile = label
            emit('libraries')
          },
        })
        const libStats = await libDownloader.downloadAll(downloadSpecs)
        libStage.done = downloadSpecs.length
        if (libStats.failed.length > 0) {
          throw new Error(
            `有 ${libStats.failed.length} 个库下载失败（首个：${libStats.failed[0].label ?? libStats.failed[0].url}）`,
          )
        }
        libStage.state = 'done'
        libStage.bytes = Math.max(libStage.bytes, libStage.bytesTotal)
        emit('libraries', true, '库文件完成')

        // 资源索引 + 资源对象
        let assetIndexId: string | undefined
        const assetStage = stageOf('assets')
        if (json.assetIndex) {
          assetIndexId = json.assetIndex.id
          const indexSize = json.assetIndex.size ?? 0
          assetStage.state = 'running'
          assetStage.total = 1
          assetStage.bytesTotal = indexSize
          setProgressFiles([{ name: `asset index ${assetIndexId}`, size: indexSize }])
          emit('assets', true, `下载资源索引 ${assetIndexId}`)

          const indexDest = path.join(paths.assets, 'indexes', `${assetIndexId}.json`)
          await dl({ concurrency: 1, threads: 1, signal }).fetchOne({
            url: mirrorUrl(json.assetIndex.url, source),
            dest: indexDest,
            sha1: json.assetIndex.sha1,
            size: json.assetIndex.size,
            label: 'asset index',
            fallbackUrl: source === 'bmclapi' ? json.assetIndex.url : undefined,
          })
          const index = await readJson<AssetIndexFile | undefined>(indexDest, undefined)
          const entries = Object.entries(index?.objects ?? {})
          assetStage.done = 1
          assetStage.total = entries.length + 1
          emit('assets', true, `资源索引 ${assetIndexId}（${entries.length} 个对象）`)

          const assetSpecs: DownloadSpec[] = entries.map(([key, obj]) => {
            const officialUrl = `${RESOURCES_BASE}/${obj.hash.slice(0, 2)}/${obj.hash}`
            return {
              url: mirrorUrl(officialUrl, source),
              dest: path.join(paths.assets, 'objects', obj.hash.slice(0, 2), obj.hash),
              sha1: obj.hash,
              size: obj.size,
              label: key,
              fallbackUrl: source === 'bmclapi' ? officialUrl : undefined,
            }
          })

          const assetDownloader = dl({
            concurrency: 16,
            threads: threadCount,
            signal,
            onFiles: (files) => {
              setProgressFiles(files)
              emit('assets')
            },
            onFileState: (index, state) => {
              setProgressFileState(index, state)
              emit('assets')
            },
            onProgress: (done, total, bytes, label, stats) => {
              assetStage.done = done + 1
              assetStage.total = total + 1
              assetStage.bytes = bytes + indexSize
              if (stats) {
                assetStage.bytesTotal = indexSize + stats.bytesTotal
                speed = stats.speed
                etaMs = stats.etaMs
              }
              currentFile = label
              emit('assets')
            },
          })
          const assetStats = await assetDownloader.downloadAll(assetSpecs)
          if (assetStats.failed.length > 0) {
            throw new Error(`有 ${assetStats.failed.length} 个资源下载失败（首个：${assetStats.failed[0].label}）`)
          }

          if (index?.virtual || index?.map_to_resources) {
            const indexKind = index.virtual ? assetIndexId : 'pre-1.6'
            emit('assets', true, '物化旧版资源目录')
            await materializeVirtual(paths.assets, indexKind, index)
          }

          assetStage.done = assetStage.total
          assetStage.state = 'done'
          assetStage.bytes = Math.max(assetStage.bytes, assetStage.bytesTotal)
          emit('assets', true, '资源文件完成')
        } else {
          assetStage.total = 0
          assetStage.state = 'done'
        }

        // 日志配置
        const loggingStage = stageOf('logging')
        progressFiles = []
        const loggingFile = json.logging?.client?.file
        if (loggingFile) {
          loggingStage.state = 'running'
          loggingStage.total = 1
          loggingStage.bytesTotal = loggingFile.size ?? 0
          emit('logging', true, '下载日志配置')
          await dl({ concurrency: 1, threads: 1, signal }).fetchOne({
            url: mirrorUrl(loggingFile.url, source),
            dest: path.join(paths.assets, 'log_configs', loggingFile.id),
            sha1: loggingFile.sha1,
            size: loggingFile.size,
            label: 'log config',
            fallbackUrl: source === 'bmclapi' ? loggingFile.url : undefined,
          })
        }
        loggingStage.done = 1
        loggingStage.bytes = loggingStage.bytesTotal
        loggingStage.state = 'done'
        emit('logging', true)

        throwIfAborted(signal)
        await writeJsonAtomic(path.join(versionDir, `${versionId}.json`), json)

        for (const stage of stages) {
          stage.state = 'done'
          stage.done = Math.max(stage.done, stage.total)
          stage.bytes = Math.max(stage.bytes, stage.bytesTotal)
        }
        const result: InstallResult = {
          ok: true,
          versionId,
          ms: Date.now() - started,
          javaMajor: json.javaVersion?.majorVersion ?? 8,
          assetIndex: assetIndexId,
          files: specs.length,
        }
        emit('done', true, '安装完成')
        telemetry.record('install:done', { versionId, ms: result.ms, javaMajor: result.javaMajor, source })
        log.info('mojang', '版本安装完成', {
          versionId,
          ms: result.ms,
          javaMajor: result.javaMajor,
          source,
          threads: threadCount,
        })
        return result
      } catch (err) {
        const ms = Date.now() - started
        if (isAbortError(err)) {
          // 阶段停在中断处；发一次 cancelled，前端据此把进度卡切成「已取消」
          emit('cancelled', true, '已取消')
          telemetry.record('install:cancel', { versionId, ms, percent: lastPercent })
          log.info('mojang', '版本安装已取消', { versionId, ms, percent: lastPercent })
          return { ok: false, versionId, ms, error: '已取消' }
        }
        const message = err instanceof Error ? err.message : String(err)
        telemetry.record('install:error', { versionId, error: message })
        log.error('mojang', '版本安装失败', { versionId, error: message, source })
        // P29：失败时发一次 stage:'failed'，前端把任务标记为失败（保留已下载文件供续传）
        emit('failed', true, message)
        return { ok: false, versionId, ms, error: message }
      } finally {
        activeInstalls.delete(taskId)
      }
    }

    ctx.provide('mojang', {
      manifest,
      list,
      versionJson,
      installed,
      install,
      cancel,
      setProgressSink: (next) => {
        sink = next
      },
    } satisfies MojangService)
  })
}

/** legacy（1.6.x）与 pre-1.6 资源需要物化到实际目录，旧版游戏才读得到。 */
async function materializeVirtual(
  assetsRoot: string,
  indexKind: string,
  index: AssetIndexFile | undefined,
): Promise<void> {
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
