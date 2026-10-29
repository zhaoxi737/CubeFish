/**
 * 内容服务（P2 → P20）：Modrinth 搜索/安装、.mrpack、CurseForge .zip 整合包，以及 mod/资源包/光影一键装。
 * API 参考 docs/RESEARCH-P1-P2.md §4。
 */
import AdmZip from 'adm-zip'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  ContentInstallResult,
  ContentPreview,
  ContentSource,
  ContentUpdate,
  ContentVersionInfo,
  CurseForgeTestResult,
  InstalledContent,
  CursePackInspectResult,
  CursePackInstallResult,
  InstanceSummary,
  PackInspect,
  ModpackInspectResult,
  ModpackInstallResult,
  ProgressFile,
  SearchHit,
  TaskProgress,
} from '../../shared/types'
import { Downloader, type DownloadSpec, type DownloadStats } from '../lib/downloader'
import { ensureDir, readJson, safeName, sha1File, writeJsonAtomic } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { InstancesService } from './instances'
import type { LoadersService } from './loaders'
import type { LogService } from './logger'
import type { MojangService } from './mojang'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'

const BASE = 'https://api.modrinth.com/v2'
const UA = 'QDOQMC/0.1.0 (+https://qdoqmc.example/contact)'
const MIN_INTERVAL_MS = 350

export type ContentKind = 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'datapack'

interface RawSearchHit {
  project_id: string
  slug: string
  title: string
  description: string
  project_type: string
  categories: string[]
  downloads: number
  icon_url?: string
  versions: string[]
  /** Modrinth /search 返回的加载器列表（P28 新增映射） */
  loaders?: string[]
}

interface RawVersion {
  id: string
  project_id: string
  version_number: string
  version_type: string
  game_versions: string[]
  loaders: string[]
  date_published: string
  dependencies: { version_id?: string | null; project_id?: string | null; dependency_type: string }[]
  files: {
    url: string
    filename: string
    primary: boolean
    size: number
    hashes: { sha1?: string; sha512?: string }
  }[]
}

/** P29：Modrinth /project/<id> 与 /projects?ids= 的最小字段集 */
interface RawProject {
  id: string
  slug?: string
  title?: string
  description?: string
  icon_url?: string | null
  gallery?: { url?: string | null; featured?: boolean }[]
  downloads?: number
  game_versions?: string[]
  loaders?: string[]
  project_type?: string
}

export interface ContentService {
  search(
    query: string,
    opts?: {
      type?: ContentKind
      mcVersion?: string
      loader?: string
      limit?: number
      /** P31：分页偏移（0 起） */
      offset?: number
      /** P30：内容源；默认 modrinth，'all' 会合并两个源 */
      source?: ContentSource | 'all'
    },
  ): Promise<SearchHit[]>
  versions(projectId: string, opts?: { mcVersion?: string; loader?: string }): Promise<ContentVersionInfo[]>
  pickVersion(projectId: string, opts?: { mcVersion?: string; loader?: string }): Promise<ContentVersionInfo | undefined>
  install(
    instanceId: string,
    projectId: string,
    opts?: { mcVersion?: string; loader?: string },
  ): Promise<ContentInstallResult>
  /** P37：安装指定版本（解决模组版本冲突时用） */
  installVersionById(
    instanceId: string,
    projectId: string,
    versionId: string,
    kind?: ContentKind,
  ): Promise<ContentInstallResult>
  installed(instanceId: string): Promise<InstalledContent[]>
  toggle(instanceId: string, fileName: string): Promise<{ ok: boolean; enabled?: boolean; error?: string }>
  remove(instanceId: string, fileName: string): Promise<{ ok: boolean; error?: string }>
  /** 安装 .mrpack 整合包：本地路径或 http(s) URL；会新建实例 */
  installModpack(source: string, opts?: { name?: string }): Promise<ModpackInstallResult>
  /** 按 Modrinth 项目安装整合包（内部选最新版本并下载 .mrpack） */
  installModpackProject(projectId: string, name?: string): Promise<ModpackInstallResult>
  /** 只解析 .mrpack 的索引，不安装（用于预览/测试） */
  inspectModpack(source: string): Promise<ModpackInspectResult>
  /** 安装 CurseForge .zip 整合包 */
  installCursePack(source: string, opts?: { name?: string }): Promise<CursePackInstallResult>
  /** 只解析 CurseForge 整合包（预览：加载器/文件数/是否需要 API Key） */
  inspectCursePack(source: string): Promise<CursePackInspectResult>
  /** 统一预览：自动识别 .mrpack / CurseForge .zip */
  inspectPack(source: string): Promise<PackInspect>
  /** 统一安装：自动识别格式 */
  installPack(source: string, opts?: { name?: string }): Promise<ModpackInstallResult & { kind?: 'curseforge' | 'modrinth'; resolved?: number; bundled?: number; overrides?: number }>
  /** 下载任意已解析的版本文件到实例对应目录（含依赖递归） */
  installVersion(instanceId: string, version: ContentVersionInfo, kind: ContentKind, depth?: number): Promise<string[]>
  // ---- P29：模组更新检查 / 资源预览 ----
  /** 检查实例内已装模组的最新版本（Modrinth）。没有可更新的返回空数组 */
  updates(instanceId: string): Promise<ContentUpdate[]>
  /** 把某个模组更新到最新（下载新文件 → 删除旧文件 → 更新 content.json） */
  update(
    instanceId: string,
    fileName: string,
  ): Promise<{ ok: boolean; fileName?: string; version?: string; error?: string }>
  /** 资源/光影/模组的图片画廊预览 */
  preview(projectId: string, kind: ContentKind): Promise<ContentPreview>
  /** IPC 层注入，用于把内容安装进度推给渲染进程（P29，与 mojang 的 sink 同构） */
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
  /** P30：CurseForge Key 连通性测试（基础/详情/搜索三项分开报） */
  testCurseForge(): Promise<CurseForgeTestResult>
}

function kindDir(kind: ContentKind): string {
  switch (kind) {
    case 'resourcepack':
      return 'resourcepacks'
    case 'shader':
      return 'shaderpacks'
    case 'modpack':
      return 'modpacks'
    default:
      return 'mods'
  }
}

export function createContentPlugin(): LauncherPlugin<void> {
  return definePlugin('content', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const instances = use<InstancesService>(ctx, 'instances')
    const settings = use<SettingsService>(ctx, 'settings')
    const mojang = use<MojangService>(ctx, 'mojang')
    const loaders = use<LoadersService>(ctx, 'loaders')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    let lastRequest = 0
    /** P29：内容安装进度 sink（由 IPC 层注入，和 mojang.setProgressSink 同构） */
    let progressSink: ((progress: TaskProgress) => void) | null = null

    /** P31：按内容类型解析落盘目录；mods/resourcepacks/shaderpacks 走版本隔离，modpacks 保持原样。 */
    function contentDirFor(instanceId: string, instance: InstanceSummary, kind: ContentKind): string {
      const folder = kindDir(kind)
      if (folder === 'modpacks') return path.join(instance.gameDir, folder)
      return instances.contentDir(instanceId, folder as 'mods' | 'resourcepacks' | 'shaderpacks')
    }

    /** P31：按相对路径解析落盘目录（mrpack/overrides 用）；mods/… 等前缀走版本隔离。 */
    function destForRel(instanceId: string, instance: InstanceSummary, rel: string): string {
      const normalized = rel.replace(/\\/g, '/')
      const m = /^(mods|resourcepacks|shaderpacks)\/(.+)$/.exec(normalized)
      if (m) {
        return path.join(
          instances.contentDir(instanceId, m[1] as 'mods' | 'resourcepacks' | 'shaderpacks'),
          ...m[2].split('/'),
        )
      }
      return path.join(instance.gameDir, ...normalized.split('/'))
    }

    async function api<T>(pathname: string): Promise<T> {
      const wait = Math.max(0, lastRequest + MIN_INTERVAL_MS - Date.now())
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastRequest = Date.now()
      const res = await fetch(`${BASE}${pathname}`, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`Modrinth ${pathname} 请求失败: HTTP ${res.status}`)
      return (await res.json()) as T
    }

    /** P29：POST（/version_files/update 批量更新检查用），同样 350ms 限速 + 20s 超时。 */
    async function apiPost<T>(pathname: string, body: unknown): Promise<T> {
      const wait = Math.max(0, lastRequest + MIN_INTERVAL_MS - Date.now())
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastRequest = Date.now()
      const res = await fetch(`${BASE}${pathname}`, {
        method: 'POST',
        headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`Modrinth ${pathname} 请求失败: HTTP ${res.status}`)
      return (await res.json()) as T
    }

    /** 画廊/图标 URL 绝对化：Modrinth 常返回 `//cdn.modrinth.com/...`。 */
    function absoluteImageUrl(url?: string | null): string | undefined {
      const value = (url ?? '').trim()
      if (!value) return undefined
      if (value.startsWith('//')) return `https:${value}`
      if (value.startsWith('http://')) return `https://${value.slice('http://'.length)}`
      if (/^https:\/\//i.test(value)) return value
      if (value.startsWith('/')) return `https://cdn.modrinth.com${value}`
      return value
    }

    /* ---------- P29：内容安装的 PCL 式进度 ---------- */

    /** 各阶段进度合并窗口（与下载器解耦，保证 IPC 不被刷爆） */
    const CONTENT_PROGRESS_INTERVAL_MS = 200
    /** 文件清单最多 200 条（前端逐行显示） */
    const MAX_PROGRESS_FILES = 200

    interface ContentTask {
      taskId: string
      /** 例如「安装整合包 Fabulously Optimized」 */
      title: string
      message: string
      files: ProgressFile[]
      bytes: number
      bytesTotal: number
      speed?: number
      etaMs?: number
      lastEmit: number
    }

    let taskSeq = 0

    function createTask(title: string, message = title): ContentTask {
      taskSeq += 1
      return {
        taskId: `content-${Date.now()}-${taskSeq}`,
        title,
        message,
        files: [],
        bytes: 0,
        bytesTotal: 0,
        lastEmit: 0,
      }
    }

    function filesDoneOf(task: ContentTask): number {
      let done = 0
      for (const file of task.files) {
        if (file.state === 'done' || file.state === 'skipped') done += 1
      }
      return done
    }

    function percentOf(task: ContentTask): number {
      if (task.bytesTotal > 0) return Math.min(100, Math.round((task.bytes / task.bytesTotal) * 1000) / 10)
      if (task.files.length > 0) {
        return Math.min(100, Math.round((filesDoneOf(task) / task.files.length) * 1000) / 10)
      }
      return 0
    }

    /** 发一次进度（默认 200ms 节流；阶段切换/完成/失败用 force）。 */
    function emitTask(task: ContentTask, stage: 'content' | 'done' | 'failed', force = false, message?: string): void {
      if (!progressSink) return
      const now = Date.now()
      if (!force && now - task.lastEmit < CONTENT_PROGRESS_INTERVAL_MS) return
      task.lastEmit = now
      const filesDone = filesDoneOf(task)
      const filesTotal = task.files.length
      progressSink({
        taskId: task.taskId,
        kind: 'content',
        stage,
        title: task.title,
        message: message ?? task.message,
        done: filesDone,
        total: filesTotal,
        bytes: Math.round(task.bytes),
        bytesTotal: Math.round(task.bytesTotal),
        speed: task.speed && task.speed > 0 ? Math.round(task.speed) : undefined,
        etaMs: task.etaMs,
        filesDone,
        filesTotal,
        percent: stage === 'done' ? 100 : percentOf(task),
        files: task.files.slice(0, MAX_PROGRESS_FILES).map((file) => ({ ...file })),
      })
    }

    function kindLabel(kind: ContentKind): string {
      switch (kind) {
        case 'resourcepack':
          return '资源包'
        case 'shader':
          return '光影'
        case 'modpack':
          return '整合包'
        case 'datapack':
          return '数据包'
        default:
          return '模组'
      }
    }

    /**
     * 用下载器跑一批文件并把 file/bytes/速度/ETA 转成 TaskProgress：
     * 支持在一个任务里多次调用（依赖递归/CurseForge 逐个解析），文件清单累加。
     */
    async function downloadWithTask(
      task: ContentTask,
      specs: DownloadSpec[],
      concurrency = 8,
    ): Promise<DownloadStats> {
      if (specs.length === 0) return { skipped: 0, downloaded: 0, bytes: 0, failed: [] }
      const baseBytes = task.bytes
      let offset = task.files.length
      const downloader = new Downloader({
        cacheDir: paths.downloads,
        concurrency,
        onVerbose: (message, data) => log.warn('content', message, data),
        onFiles: (files) => {
          offset = task.files.length
          for (const file of files) task.files.push({ name: file.name, size: file.size, state: 'pending' })
          task.bytesTotal += files.reduce((sum, file) => sum + (file.size ?? 0), 0)
          emitTask(task, 'content', true)
        },
        onFileState: (index, state) => {
          const file = task.files[offset + index]
          if (!file) return
          file.state = state
          emitTask(task, 'content')
        },
        onProgress: (_done, _total, bytes, _label, stats) => {
          task.bytes = baseBytes + bytes
          if (stats) {
            task.speed = stats.speed
            task.etaMs = stats.etaMs
          }
          emitTask(task, 'content')
        },
      })
      const stats = await downloader.downloadAll(specs)
      return stats
    }

    function toVersionInfo(raw: RawVersion): ContentVersionInfo {
      const primary = raw.files.find((file) => file.primary) ?? raw.files[0]
      return {
        id: raw.id,
        projectId: raw.project_id,
        versionNumber: raw.version_number,
        gameVersions: raw.game_versions,
        loaders: raw.loaders,
        versionType: raw.version_type,
        datePublished: raw.date_published,
        fileName: primary?.filename ?? '',
        fileUrl: primary?.url ?? '',
        fileSize: primary?.size ?? 0,
        sha1: primary?.hashes.sha1 ?? '',
        dependencies: (raw.dependencies ?? []).map((dep) => ({
          projectId: dep.project_id ?? undefined,
          versionId: dep.version_id ?? undefined,
          dependencyType: dep.dependency_type,
        })),
      }
    }

    async function search(
      query: string,
      opts: {
        type?: ContentKind
        mcVersion?: string
        loader?: string
        limit?: number
        offset?: number
        source?: ContentSource | 'all'
      } = {},
    ): Promise<SearchHit[]> {
      const limit = Math.min(opts.limit ?? 12, 30)
      const offset = Math.max(0, opts.offset ?? 0)
      const runModrinth = async (): Promise<SearchHit[]> => {
        const facets: string[][] = []
        if (opts.type) facets.push([`project_type:${opts.type}`])
        if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`])
        if (opts.loader) facets.push([`categories:${opts.loader}`])
        const params = new URLSearchParams({
          query,
          limit: String(limit),
          offset: String(offset),
          index: 'relevance',
        })
        if (facets.length > 0) params.set('facets', JSON.stringify(facets))
        const data = await api<{ hits: RawSearchHit[] }>(`/search?${params.toString()}`)
        return (data.hits ?? []).map((hit) => ({
          projectId: hit.project_id,
          slug: hit.slug,
          title: hit.title,
          description: hit.description,
          projectType: hit.project_type,
          categories: hit.categories ?? [],
          downloads: hit.downloads ?? 0,
          iconUrl: hit.icon_url,
          versions: hit.versions ?? [],
          // P28：前端「支持 1.20.1 · Fabric」chips
          gameVersions: hit.versions ?? [],
          loaders: hit.loaders ?? [],
          source: 'modrinth' as ContentSource,
        }))
      }

      const sourceSel = opts.source ?? 'modrinth'
      if (sourceSel === 'curseforge') {
        return searchCurseforge(query, { ...opts, limit })
      }
      if (sourceSel === 'all') {
        // P30：两个源并发，单个失败不影响另一个
        const [modrinth, curseforge] = await Promise.allSettled([
          runModrinth(),
          searchCurseforge(query, { ...opts, limit }),
        ])
        if (modrinth.status === 'rejected' && curseforge.status === 'rejected') {
          throw modrinth.reason instanceof Error ? modrinth.reason : new Error(String(modrinth.reason))
        }
        if (modrinth.status === 'rejected') {
          log.warn('content', 'Modrinth 搜索结果已跳过', { error: String(modrinth.reason) })
        }
        if (curseforge.status === 'rejected') {
          log.warn('content', 'CurseForge 搜索结果已跳过', { error: String(curseforge.reason) })
        }
        const merged = [
          ...(modrinth.status === 'fulfilled' ? modrinth.value : []),
          ...(curseforge.status === 'fulfilled' ? curseforge.value : []),
        ]
        return merged.sort((a, b) => b.downloads - a.downloads).slice(0, limit)
      }
      return runModrinth()
    }

    async function versions(
      projectId: string,
      opts: { mcVersion?: string; loader?: string } = {},
    ): Promise<ContentVersionInfo[]> {
      const params = new URLSearchParams()
      if (opts.loader) params.set('loaders', JSON.stringify([opts.loader]))
      if (opts.mcVersion) params.set('game_versions', JSON.stringify([opts.mcVersion]))
      const query = params.toString()
      const raw = await api<RawVersion[]>(`/project/${encodeURIComponent(projectId)}/version${query ? `?${query}` : ''}`)
      return raw.map(toVersionInfo)
    }

    function pickFromList(list: ContentVersionInfo[]): ContentVersionInfo | undefined {
      if (list.length === 0) return undefined
      const sorted = [...list].sort((a, b) => {
        if (a.versionType === 'release' && b.versionType !== 'release') return -1
        if (b.versionType === 'release' && a.versionType !== 'release') return 1
        return new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime()
      })
      return sorted[0]
    }

    async function pickVersion(
      projectId: string,
      opts: { mcVersion?: string; loader?: string } = {},
    ): Promise<ContentVersionInfo | undefined> {
      return pickFromList(await versions(projectId, opts))
    }

    function contentFile(instanceId: string): string {
      const instance = instances.get(instanceId)
      const dir = instance?.path ?? path.join(paths.instances, instanceId)
      return path.join(dir, 'content.json')
    }

    async function installed(instanceId: string): Promise<InstalledContent[]> {
      const instance = instances.get(instanceId)
      const dir = instance?.gameDir ?? path.join(paths.instances, instanceId, '.minecraft')
      const list = await readJson<InstalledContent[]>(contentFile(instanceId), [])
      return list.map((item) => {
        const kind = (item.kind as ContentKind) ?? 'mod'
        const folder = kindDir(kind)
        const base =
          instance && folder !== 'modpacks'
            ? instances.contentDir(instanceId, folder as 'mods' | 'resourcepacks' | 'shaderpacks')
            : path.join(dir, folder)
        const normal = path.join(base, item.fileName)
        const disabled = `${normal}.disabled`
        return { ...item, enabled: existsSync(normal) || !existsSync(disabled) }
      })
    }

    /** P37：安装新版本前，清掉同一项目旧版本的文件（避免 duplicate mods） */
    async function removeProjectFiles(instanceId: string, projectId: string): Promise<number> {
      const instance = instances.get(instanceId)
      if (!instance) return 0
      const file = contentFile(instanceId)
      const list = await readJson<InstalledContent[]>(file, [])
      if (!Array.isArray(list) || list.length === 0) return 0
      let removed = 0
      const keep: InstalledContent[] = []
      for (const item of list) {
        if (item.projectId !== projectId) {
          keep.push(item)
          continue
        }
        const kind = (item.kind as ContentKind) ?? 'mod'
        const folder = kindDir(kind)
        const base =
          folder !== 'modpacks'
            ? instances.contentDir(instanceId, folder as 'mods' | 'resourcepacks' | 'shaderpacks')
            : path.join(instance.gameDir, folder)
        for (const candidate of [path.join(base, item.fileName), `${path.join(base, item.fileName)}.disabled`]) {
          try {
            if (existsSync(candidate)) {
              rmSync(candidate, { force: true })
              removed += 1
            }
          } catch {
            /* 文件被占用就跳过 */
          }
        }
      }
      if (removed > 0) {
        await writeJsonAtomic(file, keep)
        log.info('content', '已移除旧版本文件', { instanceId, projectId, removed })
      }
      return removed
    }

    async function toggle(
      instanceId: string,
      fileName: string,
    ): Promise<{ ok: boolean; enabled?: boolean; error?: string }> {      const instance = instances.get(instanceId)
      if (!instance) return { ok: false, error: '实例不存在' }
      const list = await installed(instanceId)
      const item = list.find((entry) => entry.fileName === fileName)
      const base = contentDirFor(instanceId, instance, (item?.kind as ContentKind) ?? 'mod')
      const normal = path.join(base, fileName)
      const disabled = `${normal}.disabled`
      try {
        const { rename } = await import('node:fs/promises')
        if (existsSync(normal)) {
          await rename(normal, disabled)
          log.info('content', '已禁用内容', { fileName })
          return { ok: true, enabled: false }
        }
        if (existsSync(disabled)) {
          await rename(disabled, normal)
          log.info('content', '已启用内容', { fileName })
          return { ok: true, enabled: true }
        }
        return { ok: false, error: '文件不存在（可能已被手动删除）' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    async function remove(instanceId: string, fileName: string): Promise<{ ok: boolean; error?: string }> {
      const instance = instances.get(instanceId)
      if (!instance) return { ok: false, error: '实例不存在' }
      const list = await installed(instanceId)
      const item = list.find((entry) => entry.fileName === fileName)
      const base = contentDirFor(instanceId, instance, (item?.kind as ContentKind) ?? 'mod')
      try {
        const { rm } = await import('node:fs/promises')
        await rm(path.join(base, fileName), { force: true })
        await rm(path.join(base, `${fileName}.disabled`), { force: true })
        await saveInstalled(
          instanceId,
          list.filter((entry) => entry.fileName !== fileName),
        )
        telemetry.record('content:remove', { instanceId, fileName })
        log.info('content', '已删除内容', { fileName })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    async function saveInstalled(instanceId: string, items: InstalledContent[]): Promise<void> {
      await writeJsonAtomic(contentFile(instanceId), items)
    }

    async function installVersion(
      instanceId: string,
      version: ContentVersionInfo,
      kind: ContentKind,
      depth = 0,
      task?: ContentTask,
    ): Promise<string[]> {
      const instance = instances.get(instanceId)
      if (!instance) throw new Error(`实例不存在: ${instanceId}`)
      if (!version.fileUrl) throw new Error(`版本 ${version.versionNumber} 没有可下载文件`)
      // P29：没有外部任务时也建一个（sink 为空时 emitTask 自动 no-op）
      const progressTask = task ?? createTask(`安装${kindLabel(kind)} ${version.fileName || version.versionNumber}`)

      // 1) 必需依赖先装（递归，最多 3 层）
      let depCount = 0
      if (depth < 3) {
        for (const dep of version.dependencies) {
          if (dep.dependencyType !== 'required') continue
          try {
            let depVersion: ContentVersionInfo | undefined
            if (dep.versionId) {
              const raw = await api<RawVersion>(`/version/${encodeURIComponent(dep.versionId)}`)
              depVersion = toVersionInfo(raw)
            } else if (dep.projectId) {
              depVersion = await pickVersion(dep.projectId, {
                mcVersion: instance.gameVersion ?? undefined,
                loader: instance.loader === 'fabric' ? 'fabric' : undefined,
              })
            }
            if (!depVersion) continue
            const existing = await installed(instanceId)
            // P37：同一个项目已经有任何版本了就不再装依赖版本，否则会出现两份同 mod（duplicate mods）
            if (existing.some((item) => item.versionId === depVersion!.id || item.projectId === depVersion!.projectId)) continue
            const files = await installVersion(instanceId, depVersion, 'mod', depth + 1, progressTask)
            if (files.length > 0) depCount += 1
          } catch (err) {
            log.warn('content', '依赖安装失败', { projectId: dep.projectId, error: String(err) })
          }
        }
      }

      // 2) 下载主文件（P29：走 downloadWithTask，文件清单/字节/速度进 progress）
      const targetDir = contentDirFor(instanceId, instance, kind)
      const fileName = safeName(version.fileName || `${version.id}.jar`, `${version.id}.jar`)
      const dest = path.join(targetDir, fileName)
      const stats = await downloadWithTask(
        progressTask,
        [
          {
            url: version.fileUrl,
            dest,
            sha1: version.sha1 || undefined,
            size: version.fileSize || undefined,
            label: fileName,
          },
        ],
        1,
      )
      if (stats.failed.length > 0) throw new Error(`下载失败：${fileName}`)

      // 3) 记录 manifest（冲突分析与回滚用）
      const list = await installed(instanceId)
      const next = list.filter((item) => item.versionId !== version.id && item.projectId !== version.projectId)
      next.push({
        projectId: version.projectId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        fileName,
        kind,
        sha1: version.sha1,
        installedAt: Date.now(),
      })
      await saveInstalled(instanceId, next)

      telemetry.record('content:install', { instanceId, kind, file: fileName, depth })
      log.info('content', '内容已安装', { fileName, kind, deps: depCount })
      return [fileName]
    }

    async function install(
      instanceId: string,
      projectId: string,
      opts: { mcVersion?: string; loader?: string } = {},
    ): Promise<ContentInstallResult> {
      // P30：cf-<id> 走 CurseForge 分支（详情 → 文件 → 下载 → 记 content.json）
      if (projectId.startsWith('cf-')) {
        const cfId = Number.parseInt(projectId.slice(3), 10)
        if (!Number.isFinite(cfId)) {
          return { ok: false, projectId, files: [], dependenciesInstalled: 0, error: `无效的 CurseForge 项目 id: ${projectId}` }
        }
        return installCurseforge(instanceId, cfId, opts)
      }
      const task = createTask('安装内容', '安装内容')
      try {
        const project = await api<{ id: string; title: string; project_type: string }>(
          `/project/${encodeURIComponent(projectId)}`,
        )
        const kind = (project.project_type ?? 'mod') as ContentKind
        task.title = `安装${kindLabel(kind)} ${project.title ?? projectId}`
        task.message = task.title
        emitTask(task, 'content', true)
        const instance = instances.get(instanceId)
        const mcv = opts.mcVersion ?? instance?.gameVersion ?? (instance?.loader === 'vanilla' ? instance?.versionId : undefined)
        const loader =
          opts.loader ??
          (instance?.loader === 'fabric' || instance?.versionId?.startsWith('fabric-loader') ? 'fabric' : undefined)
        const before = await installed(instanceId)
        const version = await pickVersion(projectId, { mcVersion: mcv, loader })
        if (!version) {
          const error = `没有匹配的版本（游戏版本 ${mcv ?? '不限'} / 加载器 ${loader ?? '不限'}）`
          emitTask(task, 'failed', true, error)
          return { ok: false, projectId, title: project.title, files: [], dependenciesInstalled: 0, error }
        }
        // P37：先把旧版本文件清掉，避免同一模组两份 jar
        await removeProjectFiles(instanceId, projectId)
        const files = await installVersion(instanceId, version, kind, 0, task)
        const after = await installed(instanceId)
        const dependenciesInstalled = Math.max(0, after.length - before.length - 1)
        emitTask(task, 'done', true)
        return {
          ok: true,
          projectId,
          title: project.title,
          versionNumber: version.versionNumber,
          files,
          dependenciesInstalled,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('content', '安装失败', { projectId, error: message })
        emitTask(task, 'failed', true, message)
        return { ok: false, projectId, files: [], dependenciesInstalled: 0, error: message }
      }
    }

    /** P37：按版本 id 精确安装（安装冲突修复指定的版本） */
    async function installVersionById(
      instanceId: string,
      projectId: string,
      versionId: string,
      kind: ContentKind = 'mod',
    ): Promise<ContentInstallResult> {
      const task = createTask('安装指定版本', '安装指定版本')
      try {
        const raw = await api<RawVersion>(`/version/${encodeURIComponent(versionId)}`)
        const info = toVersionInfo(raw)
        task.title = `安装 ${projectId} ${info.versionNumber}`
        task.message = task.title
        emitTask(task, 'content', true)
        const before = await installed(instanceId)
        // P37：安装指定版本时同样先清掉同项目旧文件
        await removeProjectFiles(instanceId, projectId)
        const files = await installVersion(instanceId, info, kind, 0, task)
        const after = await installed(instanceId)
        emitTask(task, 'done', true)
        log.info('content', '已安装指定版本', { projectId, versionId, versionNumber: info.versionNumber })
        return {
          ok: true,
          projectId,
          title: info.versionNumber,
          versionNumber: info.versionNumber,
          files,
          dependenciesInstalled: Math.max(0, after.length - before.length - 1),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emitTask(task, 'failed', true, message)
        log.error('content', '安装指定版本失败', { projectId, versionId, error: message })
        return { ok: false, projectId, files: [], dependenciesInstalled: 0, error: message }
      }
    }

    /* ---------- .mrpack 整合包 ---------- */
    interface MrpackFile {
      path?: string
      hashes?: { sha1?: string; sha512?: string }
      env?: { client?: string; server?: string }
      downloads?: string[]
      fileSize?: number
    }

    interface MrpackIndex {
      formatVersion?: number
      game?: string
      name?: string
      versionId?: string
      files?: MrpackFile[]
      dependencies?: Record<string, string>
    }

    async function readSource(source: string): Promise<Buffer> {
      if (/^https?:\/\//i.test(source)) {
        const res = await fetch(source, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(120_000),
        })
        if (!res.ok) throw new Error(`下载整合包失败：HTTP ${res.status}`)
        return Buffer.from(await res.arrayBuffer())
      }
      return readFile(source)
    }

    function parseIndex(buffer: Buffer): { index: MrpackIndex; zip: AdmZip } {
      const zip = new AdmZip(buffer)
      const entry = zip.getEntry('modrinth.index.json')
      if (!entry) throw new Error('不是合法的 .mrpack（缺 modrinth.index.json）')
      const index = JSON.parse(entry.getData().toString('utf8')) as MrpackIndex
      if (!index.dependencies?.minecraft) throw new Error('整合包没有声明 minecraft 版本')
      return { index, zip }
    }

    async function inspectModpack(source: string): Promise<ModpackInspectResult> {
      try {
        const { index } = parseIndex(await readSource(source))
        const deps = index.dependencies ?? {}
        const unsupportedLoader = deps['quilt-loader'] ? 'quilt' : undefined
        const files = index.files ?? []
        return {
          ok: true,
          name: index.name,
          versionId: index.versionId,
          game: index.game,
          dependencies: deps,
          fileCount: files.length,
          totalBytes: files.reduce((sum, file) => sum + (file.fileSize ?? 0), 0),
          unsupportedLoader,
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    async function installModpack(source: string, opts?: { name?: string }): Promise<ModpackInstallResult> {
      const task = createTask('安装整合包', '安装整合包')
      try {
        const { index, zip } = parseIndex(await readSource(source))
        const deps = index.dependencies ?? {}
        const mc = deps.minecraft as string
        if (deps['quilt-loader']) {
          const error = '暂不支持 Quilt 整合包（支持 Fabric / NeoForge / Forge / 原版）'
          emitTask(task, 'failed', true, error)
          return { ok: false, error }
        }
        const packName = opts?.name ?? index.name ?? '整合包'
        task.title = `安装整合包 ${packName}`
        task.message = task.title
        emitTask(task, 'content', true)

        const instance = instances.create(opts?.name ?? index.name ?? '整合包')
        instances.setActive(instance.id)
        const packVersion = index.versionId ?? ''

        let loaderName = 'vanilla'
        let versionId = mc
        if (deps.neoforge) {
          const neo = await loaders.installNeoForge(mc, String(deps.neoforge))
          if (!neo.ok || !neo.versionId) throw new Error(`NeoForge 安装失败：${neo.error ?? '未知错误'}`)
          versionId = neo.versionId
          loaderName = 'neoforge'
        } else if (deps.forge) {
          const forge = await loaders.installForge(mc, String(deps.forge))
          if (!forge.ok || !forge.versionId) throw new Error(`Forge 安装失败：${forge.error ?? '未知错误'}`)
          versionId = forge.versionId
          loaderName = 'forge'
        } else if (deps['fabric-loader']) {
          if (!existsSync(path.join(paths.versions, mc, `${mc}.json`))) {
            const base = await mojang.install(mc, `mrpack-base-${Date.now()}`)
            if (!base.ok) throw new Error(`整合包依赖的原版 ${mc} 安装失败：${base.error}`)
          }
          const fabric = await loaders.installFabric(mc)
          if (!fabric.ok || !fabric.versionId) throw new Error(`Fabric 安装失败：${fabric.error ?? '未知错误'}`)
          versionId = fabric.versionId
          loaderName = 'fabric'
        } else {
          const base = await mojang.install(mc, `mrpack-base-${Date.now()}`)
          if (!base.ok) throw new Error(`原版 ${mc} 安装失败：${base.error}`)
        }
        instances.setVersion(instance.id, versionId, mc, mc, loaderName)

        // 模组文件
        const specs: DownloadSpec[] = []
        const filePaths: { rel: string; sha1: string }[] = []
        for (const file of index.files ?? []) {
          if (file.env?.client === 'unsupported') continue
          const rel = String(file.path ?? '').replace(/\\/g, '/')
          if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue
          const url = file.downloads?.[0]
          if (!url) continue
          specs.push({
            url,
            dest: destForRel(instance.id, instance, rel),
            sha1: file.hashes?.sha1,
            size: file.fileSize,
            label: rel,
          })
          filePaths.push({ rel, sha1: file.hashes?.sha1 ?? '' })
        }

        const stats = await downloadWithTask(task, specs, 8)
        if (stats.failed.length > 0) {
          throw new Error(`${stats.failed.length} 个整合包文件下载失败（首个：${stats.failed[0].label}）`)
        }

        // overrides / client-overrides 覆盖到实例目录
        let overrides = 0
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          const name = entry.entryName.replace(/\\/g, '/')
          const matched = /^(?:overrides|client-overrides)\/(.+)$/.exec(name)
          if (!matched) continue
          const rel = matched[1]
          if (rel.includes('..')) continue
          const dest = destForRel(instance.id, instance, rel)
          await ensureDir(path.dirname(dest))
          writeFileSync(dest, entry.getData())
          overrides += 1
        }

        // 记录 manifest（回滚/冲突分析用）
        const list = await installed(instance.id)
        for (const item of filePaths) {
          const kind = item.rel.startsWith('mods/')
            ? 'mod'
            : item.rel.startsWith('resourcepacks/')
              ? 'resourcepack'
              : item.rel.startsWith('shaderpacks/')
                ? 'shader'
                : 'file'
          list.push({
            projectId: `mrpack:${instance.id}`,
            versionId: packVersion,
            versionNumber: packVersion,
            fileName: item.rel,
            kind,
            sha1: item.sha1,
            installedAt: Date.now(),
          })
        }
        await saveInstalled(instance.id, list)

        telemetry.record('content:modpack', {
          instanceId: instance.id,
          mc,
          loader: loaderName,
          files: specs.length,
          overrides,
        })
        log.info('content', '整合包安装完成', {
          pack: index.name,
          instanceId: instance.id,
          files: specs.length,
          overrides,
        })
        emitTask(task, 'done', true, '安装完成')
        return {
          ok: true,
          packName: index.name ?? instance.name,
          instanceId: instance.id,
          mcVersion: mc,
          loader: loaderName,
          files: specs.length,
          bytes: stats.bytes,
          overrides,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('content', '整合包安装失败', { error: message })
        telemetry.record('content:modpack:error', { error: message })
        emitTask(task, 'failed', true, message)
        return { ok: false, error: message }
      }
    }

    async function installModpackProject(projectId: string, name?: string): Promise<ModpackInstallResult> {
      try {
        const version = await pickVersion(projectId)
        if (!version?.fileUrl) {
          const error = '这个整合包没有可下载的 .mrpack 文件'
          const task = createTask(`安装整合包 ${name ?? projectId}`)
          emitTask(task, 'failed', true, error)
          return { ok: false, error }
        }
        return installModpack(version.fileUrl, { name })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const task = createTask(`安装整合包 ${name ?? projectId}`)
        emitTask(task, 'failed', true, message)
        return { ok: false, error: message }
      }
    }

    /* ---------- CurseForge .zip 整合包 ---------- */

    interface CurseManifest {
      name?: string
      version?: string
      minecraft?: { version?: string; modLoaders?: { id?: string; primary?: boolean }[] }
      files?: { projectID?: number; fileID?: number; required?: boolean }[]
      overrides?: string
    }

    interface CurseFileInfo {
      fileName?: string
      downloadUrl?: string
      displayName?: string
      /** 文件字节数（CF API 的 fileLength，用于文件清单显示） */
      fileLength?: number
    }

    const CF_API = (): string => (process.env.QDOQMC_CF_API_BASE || 'https://api.curseforge.com').replace(/\/+$/, '')
    const CF_KEY = (): string => process.env.QDOQMC_CF_API_KEY || settings.get('curseforgeApiKey') || ''

    function parseCurseLoader(id: string | undefined): { loader: string; version: string } | undefined {
      const match = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(id ?? '')
      if (!match) return undefined
      return { loader: match[1].toLowerCase(), version: match[2] }
    }

    async function cfFileInfo(projectId: number, fileId: number): Promise<CurseFileInfo> {
      const key = CF_KEY()
      if (!key) {
        throw new Error('缺少 CurseForge API Key（设置 → CurseForge API Key，或环境变量 QDOQMC_CF_API_KEY）')
      }
      const res = await fetch(`${CF_API()}/v1/mods/${projectId}/files/${fileId}`, {
        headers: { 'x-api-key': key, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`CurseForge 文件解析失败（HTTP ${res.status}）`)
      const data = (await res.json()) as { data?: CurseFileInfo }
      if (!data.data?.fileName || !data.data?.downloadUrl) throw new Error('CurseForge 没有返回文件下载地址（可能被作者禁用）')
      return data.data
    }

    /* ---------- P30：CurseForge 内容源（搜索 / 单文件安装 / Key 测试） ---------- */

    /** classId：模组 6、资源包 12、光影 6552、整合包 4471 */
    const CF_CLASS: Partial<Record<ContentKind, number>> = {
      mod: 6,
      resourcepack: 12,
      shader: 6552,
      modpack: 4471,
    }
    const CF_KIND_BY_CLASS: Record<number, ContentKind> = { 6: 'mod', 12: 'resourcepack', 6552: 'shader', 4471: 'modpack' }
    /** modLoaderType：forge 1、fabric 4、quilt 5、neoforge 6 */
    const CF_LOADER_TYPE: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }

    interface CfLogo {
      thumbnailUrl?: string | null
      url?: string | null
    }
    interface CfFileIndex {
      gameVersion?: string
      fileId?: number
      filename?: string
      releaseType?: number
      modLoader?: number
    }
    interface CfMod {
      id: number
      name: string
      slug?: string
      summary?: string
      classId?: number
      downloadCount?: number
      logo?: CfLogo | null
      latestFilesIndexes?: CfFileIndex[]
    }
    interface CfModFile {
      id: number
      modId?: number
      displayName?: string
      fileName: string
      downloadUrl?: string | null
      fileLength?: number
      releaseType?: number
      fileDate?: string
      hashes?: { value: string; algo: number }[]
    }

    /** CurseForge GET：把「Key 无效」和「没有搜索权限」分开报，用户看得懂。 */
    async function cfGet<T>(pathname: string): Promise<T> {
      const key = CF_KEY()
      if (!key) throw new Error('缺少 CurseForge API Key：设置 → 内容与插件市场 → CurseForge API Key')
      const res = await fetch(`${CF_API()}${pathname}`, {
        headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 403) {
        throw new Error('CurseForge 拒绝访问（403）：这把 Key 没有搜索/列表权限，或当前网络被 Cloudflare 拦截')
      }
      if (!res.ok) throw new Error(`CurseForge 请求失败：HTTP ${res.status}`)
      return (await res.json()) as T
    }

    function cfLoaderName(modLoader?: number): string | undefined {
      switch (modLoader) {
        case 1:
          return 'forge'
        case 4:
          return 'fabric'
        case 5:
          return 'quilt'
        case 6:
          return 'neoforge'
        default:
          return undefined
      }
    }

    function cfToHit(mod: CfMod): SearchHit {
      const indexes = mod.latestFilesIndexes ?? []
      const gameVersions = [
        ...new Set(indexes.map((item) => item.gameVersion).filter((value): value is string => Boolean(value))),
      ]
      const loaders = [
        ...new Set(indexes.map((item) => cfLoaderName(item.modLoader)).filter((value): value is string => Boolean(value))),
      ]
      return {
        projectId: `cf-${mod.id}`,
        slug: mod.slug ?? String(mod.id),
        title: mod.name,
        description: mod.summary ?? '',
        projectType: CF_KIND_BY_CLASS[mod.classId ?? 6] ?? 'mod',
        categories: [],
        downloads: mod.downloadCount ?? 0,
        iconUrl: mod.logo?.thumbnailUrl ?? mod.logo?.url ?? undefined,
        versions: gameVersions,
        gameVersions,
        loaders,
        source: 'curseforge',
      }
    }

    async function searchCurseforge(
      query: string,
      opts: { type?: ContentKind; mcVersion?: string; loader?: string; limit?: number; offset?: number },
    ): Promise<SearchHit[]> {
      const classId = CF_CLASS[opts.type ?? 'mod']
      if (!classId) return []
      const params = new URLSearchParams({
        gameId: '432',
        classId: String(classId),
        index: String(Math.max(0, opts.offset ?? 0)),
        pageSize: String(Math.min(opts.limit ?? 20, 50)),
        sortField: '2',
        sortOrder: 'desc',
      })
      if (query.trim()) params.set('searchFilter', query.trim())
      if (opts.mcVersion) params.set('gameVersion', opts.mcVersion)
      const loaderType = opts.loader ? CF_LOADER_TYPE[opts.loader] : undefined
      if (loaderType) params.set('modLoaderType', String(loaderType))
      const data = await cfGet<{ data?: CfMod[] }>(`/v1/mods/search?${params.toString()}`)
      return (data.data ?? []).map(cfToHit)
    }

    /** 三项分别探：基础接口 / 详情文件接口 / 搜索接口（很多 Key 只有前两项）。 */
    async function testCurseForge(): Promise<CurseForgeTestResult> {
      const started = Date.now()
      if (!CF_KEY()) return { ok: false, error: '还没有填 CurseForge API Key' }
      const result: CurseForgeTestResult = { ok: false }
      try {
        const basic = await cfGet<{ data?: unknown[] }>('/v1/games?pageSize=5')
        result.basicOk = true
        result.games = Array.isArray(basic.data) ? basic.data.length : 0
      } catch (err) {
        result.basicOk = false
        result.error = err instanceof Error ? err.message : String(err)
        result.ms = Date.now() - started
        return result
      }
      try {
        // JEI 的固定 id，用来验证「详情/文件」接口，不依赖搜索权限
        await cfGet('/v1/mods/238222')
        result.detailOk = true
      } catch (err) {
        result.detailOk = false
        result.searchError = err instanceof Error ? err.message : String(err)
      }
      try {
        await cfGet('/v1/mods/search?gameId=432&pageSize=1')
        result.searchOk = true
      } catch (err) {
        result.searchOk = false
        result.searchError = err instanceof Error ? err.message : String(err)
      }
      result.ms = Date.now() - started
      result.ok = Boolean(result.basicOk && result.detailOk && result.searchOk)
      return result
    }

    /** 从 CurseForge 装单个 mod / 资源包 / 光影：详情 → 挑兼容文件 → 下载 → 记 content.json。 */
    async function installCurseforge(
      instanceId: string,
      cfId: number,
      opts: { mcVersion?: string; loader?: string },
    ): Promise<ContentInstallResult> {
      const task = createTask('安装内容', '安装内容')
      try {
        const instance = instances.get(instanceId)
        if (!instance) throw new Error(`实例不存在: ${instanceId}`)
        const mod = (await cfGet<{ data: CfMod }>(`/v1/mods/${cfId}`)).data
        const kind = CF_KIND_BY_CLASS[mod.classId ?? 6] ?? 'mod'
        task.title = `安装${kindLabel(kind)} ${mod.name}`
        task.message = task.title
        emitTask(task, 'content', true)

        const mcv = opts.mcVersion ?? instance.gameVersion ?? instance.versionId ?? undefined
        const loader = opts.loader ?? (instance.loader !== 'vanilla' ? instance.loader : undefined)
        const params = new URLSearchParams({ pageSize: '50' })
        if (mcv) params.set('gameVersion', mcv)
        const loaderType = loader ? CF_LOADER_TYPE[loader] : undefined
        if (loaderType) params.set('modLoaderType', String(loaderType))
        const files = (await cfGet<{ data?: CfModFile[] }>(`/v1/mods/${cfId}/files?${params.toString()}`)).data ?? []
        const release = files
          .filter((file) => file.releaseType === 1)
          .sort((a, b) => Date.parse(b.fileDate ?? '') - Date.parse(a.fileDate ?? ''))[0]
        const file = release ?? files[0]
        if (!file) throw new Error(`CurseForge 上没有适配 ${mcv ?? '该版本'} 的可用文件`)

        let downloadUrl = file.downloadUrl ?? undefined
        if (!downloadUrl) {
          const detail = await cfGet<{ data?: string }>(`/v1/mods/${cfId}/files/${file.id}/download-url`)
          downloadUrl = detail.data ?? undefined
        }
        if (!downloadUrl) throw new Error('CurseForge 没有返回下载地址（可能被作者禁用）')

        const fileName = safeName(file.fileName, `cf-${cfId}.jar`)
        const dest = path.join(contentDirFor(instanceId, instance, kind), fileName)
        const sha1 = file.hashes?.find((hash) => hash.algo === 1)?.value
        const stats = await downloadWithTask(
          task,
          [{ url: downloadUrl, dest, sha1, size: file.fileLength, label: fileName }],
          1,
        )
        if (stats.failed.length > 0) throw new Error(`下载失败：${fileName}`)

        const list = await installed(instanceId)
        const versionNumber = file.displayName ?? fileName
        const next = list.filter((item) => item.fileName !== fileName && item.projectId !== `cf-${cfId}`)
        next.push({
          projectId: `cf-${cfId}`,
          slug: mod.slug,
          title: mod.name,
          versionId: `cf-${file.id}`,
          versionNumber,
          fileName,
          kind,
          sha1: sha1 ?? '',
          installedAt: Date.now(),
          source: 'curseforge',
        })
        await saveInstalled(instanceId, next)
        emitTask(task, 'done', true)
        telemetry.record('content:install', { instanceId, kind, file: fileName, source: 'curseforge' })
        log.info('content', 'CurseForge 内容已安装', { cfId, fileName, kind })
        return {
          ok: true,
          projectId: `cf-${cfId}`,
          title: mod.name,
          versionNumber,
          files: [fileName],
          dependenciesInstalled: 0,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emitTask(task, 'failed', true, message)
        log.error('content', 'CurseForge 安装失败', { cfId, error: message })
        return { ok: false, projectId: `cf-${cfId}`, files: [], dependenciesInstalled: 0, error: message }
      }
    }

    function readCurseManifest(buffer: Buffer): { manifest: CurseManifest; zip: AdmZip } {      const zip = new AdmZip(buffer)
      const entry = zip.getEntry('manifest.json')
      if (!entry) throw new Error('不是 CurseForge 整合包（缺 manifest.json）')
      const manifest = JSON.parse(entry.getData().toString('utf8')) as CurseManifest
      if (!manifest.minecraft?.version) throw new Error('manifest.json 没有声明 minecraft.version')
      return { manifest, zip }
    }

    function countBundledMods(zip: AdmZip): number {
      return zip.getEntries().filter((entry) => !entry.isDirectory && /^mods\/.+\.jar$/i.test(entry.entryName)).length
    }

    async function inspectCursePack(source: string): Promise<CursePackInspectResult> {
      try {
        const { manifest, zip } = readCurseManifest(await readSource(source))
        const primary = manifest.minecraft?.modLoaders?.find((item) => item.primary) ?? manifest.minecraft?.modLoaders?.[0]
        const parsed = parseCurseLoader(primary?.id)
        const bundled = countBundledMods(zip)
        return {
          ok: true,
          name: manifest.name,
          mcVersion: manifest.minecraft?.version,
          loader: parsed?.loader,
          loaderVersion: parsed?.version,
          fileCount: manifest.files?.length ?? 0,
          bundledMods: bundled,
          needsApiKey: (manifest.files?.length ?? 0) > 0 && bundled === 0 && !CF_KEY(),
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    async function installCursePack(source: string, opts?: { name?: string }): Promise<CursePackInstallResult> {
      const task = createTask('安装整合包', '安装整合包')
      try {
        const { manifest, zip } = readCurseManifest(await readSource(source))
        const mc = manifest.minecraft?.version as string
        const primary = manifest.minecraft?.modLoaders?.find((item) => item.primary) ?? manifest.minecraft?.modLoaders?.[0]
        const parsed = parseCurseLoader(primary?.id)
        if (!parsed) {
          const error = `无法识别的加载器：${primary?.id ?? '（未声明）'}`
          emitTask(task, 'failed', true, error)
          return { ok: false, error }
        }
        if (parsed.loader === 'quilt') {
          const error = '暂不支持 Quilt 整合包'
          emitTask(task, 'failed', true, error)
          return { ok: false, error }
        }
        const packName = opts?.name ?? manifest.name ?? 'CF 整合包'
        task.title = `安装整合包 ${packName}`
        task.message = task.title
        emitTask(task, 'content', true)

        const instance = instances.create(opts?.name ?? manifest.name ?? 'CF 整合包')
        instances.setActive(instance.id)

        let loaderName = 'vanilla'
        let versionId = mc
        if (parsed.loader === 'forge') {
          const result = await loaders.installForge(mc, parsed.version)
          if (!result.ok || !result.versionId) throw new Error(`Forge 安装失败：${result.error ?? '未知错误'}`)
          versionId = result.versionId
          loaderName = 'forge'
        } else if (parsed.loader === 'neoforge') {
          const result = await loaders.installNeoForge(mc, parsed.version)
          if (!result.ok || !result.versionId) throw new Error(`NeoForge 安装失败：${result.error ?? '未知错误'}`)
          versionId = result.versionId
          loaderName = 'neoforge'
        } else {
          const result = await loaders.installFabric(mc)
          if (!result.ok || !result.versionId) throw new Error(`Fabric 安装失败：${result.error ?? '未知错误'}`)
          versionId = result.versionId
          loaderName = 'fabric'
        }
        instances.setVersion(instance.id, versionId, mc, mc, loaderName)

        const modsDir = instances.contentDir(instance.id, 'mods')
        await ensureDir(modsDir)
        const added: InstalledContent[] = []
        const addEntry = (fileName: string, projectId: string, versionNumber: string) => {
          added.push({
            projectId,
            versionId: versionNumber,
            versionNumber,
            fileName,
            kind: 'mod',
            sha1: '',
            installedAt: Date.now(),
          })
        }

        // 1) 包内自带的 mods（离线包）：直接落盘，进度里记为 done
        let bundled = 0
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          const name = entry.entryName.replace(/\\/g, '/')
          if (!/^mods\/.+\.jar$/i.test(name)) continue
          const fileName = name.slice('mods/'.length)
          writeFileSync(path.join(modsDir, ...fileName.split('/')), entry.getData())
          addEntry(fileName, `curse:bundled:${fileName}`, 'bundled')
          task.files.push({ name: fileName, size: entry.header?.size, state: 'done' })
          bundled += 1
        }

        // 2) manifest 里的文件（需要 API Key 解析文件名与下载地址）
        const files = manifest.files ?? []
        let resolved = 0
        if (files.length > 0) {
          if (!CF_KEY() && bundled === 0) {
            throw new Error('这个整合包只带文件清单（没有内置 mods），需要配置 CurseForge API Key 才能下载')
          }
          // 先逐个把 fileID 解析成文件名/下载地址，再统一并发下载（P29：同样有文件级进度）
          const specs: DownloadSpec[] = []
          const resolvedNames: { fileName: string; projectId: string; versionNumber: string }[] = []
          let scanned = 0
          for (const file of files) {
            if (file.required === false) continue
            if (!file.projectID || !file.fileID) continue
            if (!CF_KEY()) continue
            if (specs.length >= 200) break
            const info = await cfFileInfo(file.projectID, file.fileID)
            specs.push({
              url: info.downloadUrl as string,
              dest: path.join(modsDir, info.fileName as string),
              size: info.fileLength && info.fileLength > 0 ? info.fileLength : undefined,
              label: info.fileName as string,
            })
            resolvedNames.push({
              fileName: info.fileName as string,
              projectId: `curse:${file.projectID}`,
              versionNumber: String(file.fileID),
            })
            scanned += 1
            if (scanned % 10 === 0) {
              task.message = `${task.title}（解析文件 ${scanned}/${files.length}）`
              emitTask(task, 'content')
            }
          }
          task.message = task.title
          const stats = await downloadWithTask(task, specs, 8)
          if (stats.failed.length > 0) {
            throw new Error(`${stats.failed.length} 个 CurseForge 文件下载失败（首个：${stats.failed[0].label}）`)
          }
          for (const entry of resolvedNames) {
            addEntry(entry.fileName, entry.projectId, entry.versionNumber)
            resolved += 1
          }
        }

        // 3) overrides 覆盖目录
        const overridesPrefix = `${(manifest.overrides ?? 'overrides').replace(/\/+$/, '')}/`
        let overrides = 0
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          const name = entry.entryName.replace(/\\/g, '/')
          if (!name.startsWith(overridesPrefix)) continue
          const relative = name.slice(overridesPrefix.length)
          if (!relative || relative.includes('..')) continue
          const dest = destForRel(instance.id, instance, relative)
          await ensureDir(path.dirname(dest))
          writeFileSync(dest, entry.getData())
          overrides += 1
        }

        const list = await installed(instance.id)
        list.push(...added)
        await saveInstalled(instance.id, list)

        telemetry.record('content:curse-pack', {
          instanceId: instance.id,
          mc,
          loader: loaderName,
          resolved,
          bundled,
          overrides,
        })
        log.info('content', 'CurseForge 整合包安装完成', {
          pack: manifest.name,
          instanceId: instance.id,
          resolved,
          bundled,
          overrides,
        })
        emitTask(task, 'done', true, '安装完成')
        return {
          ok: true,
          packName: manifest.name ?? instance.name,
          instanceId: instance.id,
          mcVersion: mc,
          loader: loaderName,
          loaderVersion: parsed.version,
          resolved,
          bundled,
          overrides,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('content', 'CurseForge 整合包安装失败', { error: message })
        telemetry.record('content:curse-pack:error', { error: message })
        emitTask(task, 'failed', true, message)
        return { ok: false, error: message }
      }
    }

    /* ---------- 统一整合包入口（P21：UI 用） ---------- */

    async function inspectPack(source: string): Promise<PackInspect> {
      try {
        const buffer = await readSource(source)
        const zip = new AdmZip(buffer)
        if (zip.getEntry('manifest.json')) {
          const result = await inspectCursePack(source)
          return {
            ok: result.ok,
            kind: 'curseforge',
            name: result.name,
            mcVersion: result.mcVersion,
            loader: result.loader,
            loaderVersion: result.loaderVersion,
            fileCount: result.fileCount,
            bundledMods: result.bundledMods,
            needsApiKey: result.needsApiKey,
            error: result.error,
          }
        }
        if (zip.getEntry('modrinth.index.json')) {
          const result = await inspectModpack(source)
          const deps = result.dependencies ?? {}
          const loader = deps['fabric-loader']
            ? 'fabric'
            : deps.neoforge
              ? 'neoforge'
              : deps.forge
                ? 'forge'
                : deps['quilt-loader']
                  ? 'quilt'
                  : 'vanilla'
          const loaderVersion = (deps['fabric-loader'] ?? deps.neoforge ?? deps.forge ?? deps['quilt-loader']) as
            | string
            | undefined
          return {
            ok: result.ok,
            kind: 'modrinth',
            name: result.name,
            mcVersion: result.dependencies?.minecraft,
            loader,
            loaderVersion,
            fileCount: result.fileCount,
            bundledMods: 0,
            needsApiKey: false,
            error: result.error,
          }
        }
        return { ok: false, error: '不是可识别的整合包（缺 manifest.json 或 modrinth.index.json）' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    async function installPack(source: string, opts?: { name?: string }): Promise<ModpackInstallResult & { kind?: 'curseforge' | 'modrinth'; resolved?: number; bundled?: number; overrides?: number }> {
      const inspected = await inspectPack(source)
      if (!inspected.ok) {
        const error = inspected.error ?? '无法识别整合包'
        const task = createTask('安装整合包')
        emitTask(task, 'failed', true, error)
        return { ok: false, error }
      }
      if (inspected.kind === 'curseforge') {
        const result = await installCursePack(source, opts)
        return { ...result, kind: 'curseforge' }
      }
      const result = await installModpack(source, opts)
      return { ...result, kind: 'modrinth' }
    }

    /* ---------- P29：模组更新检查 / 更新 / 图片预览 ---------- */

    /** 当前实例的加载器标签（vanilla 不传，避免 Modrinth 全过滤掉） */
    function loaderTags(instance: InstanceSummary): string[] {
      const loader = instance.loader
      if (loader === 'fabric' || loader === 'forge' || loader === 'neoforge' || loader === 'quilt') return [loader]
      if (instance.versionId?.startsWith('fabric-loader')) return ['fabric']
      if (instance.versionId?.startsWith('neoforge')) return ['neoforge']
      if (instance.versionId?.startsWith('forge')) return ['forge']
      return []
    }

    /** 当前游戏版本（gameVersion 优先，加载器实例也指向原版版本号） */
    function gameVersionTags(instance: InstanceSummary): string[] {
      const version = instance.gameVersion ?? instance.mcVersion
      return version ? [version] : []
    }

    /** Modrinth 官方批量接口：sha1 → 最新 version 对象（不在返回里 = 无匹配/已删） */
    async function queryLatestVersions(
      instance: InstanceSummary,
      hashes: string[],
    ): Promise<Record<string, RawVersion>> {
      const body: Record<string, unknown> = { hashes, algorithm: 'sha1' }
      const loaders = loaderTags(instance)
      if (loaders.length > 0) body.loaders = loaders
      const gameVersions = gameVersionTags(instance)
      if (gameVersions.length > 0) body.game_versions = gameVersions
      return apiPost<Record<string, RawVersion>>('/version_files/update', body)
    }

    /** 实例 mods/ 下的文件路径（兼容 .disabled） */
    function modFileCandidates(instanceId: string, instance: InstanceSummary, fileName: string): { active: string; disabled: string } {
      const normal = path.join(instances.contentDir(instanceId, 'mods'), fileName)
      return { active: normal, disabled: `${normal}.disabled` }
    }

    /**
     * 检查实例内已装模组的最新版本。
     * 网络/单个项目失败只 warn + 返回能拿到的部分（不整体抛错），没有可更新返回 []。
     */
    async function updates(instanceId: string): Promise<ContentUpdate[]> {
      try {
        const instance = instances.get(instanceId)
        if (!instance) {
          log.warn('content', '检查更新失败：实例不存在', { instanceId })
          return []
        }
        const list = await installed(instanceId)
        const candidates: { item: InstalledContent; sha1: string }[] = []
        for (const item of list) {
          if ((item.kind ?? 'mod') !== 'mod') continue
          // 整合包记录的文件名带目录前缀（mods/xxx.jar），不是简单文件名，跳过
          if (!item.fileName || item.fileName.includes('/') || item.fileName.includes('\\')) continue
          const file = modFileCandidates(instanceId, instance, item.fileName)
          const existing = existsSync(file.active) ? file.active : existsSync(file.disabled) ? file.disabled : undefined
          if (!existing) continue
          try {
            candidates.push({ item, sha1: await sha1File(existing) })
          } catch (err) {
            log.warn('content', '计算模组 sha1 失败', { fileName: item.fileName, error: String(err) })
          }
        }
        if (candidates.length === 0) return []

        const latest = await queryLatestVersions(
          instance,
          candidates.map((candidate) => candidate.sha1),
        )
        const items: ContentUpdate[] = []
        for (const candidate of candidates) {
          const version = latest[candidate.sha1]
          if (!version) continue
          if (version.version_number === candidate.item.versionNumber) continue
          const primary = version.files?.find((file) => file.primary) ?? version.files?.[0]
          if (!primary) continue
          items.push({
            fileName: candidate.item.fileName,
            projectId: version.project_id ?? candidate.item.projectId,
            currentVersion: candidate.item.versionNumber,
            latestVersion: version.version_number,
            latestFileName: primary.filename,
            gameVersions: version.game_versions ?? [],
            loaders: version.loaders ?? [],
          })
        }

        // 补项目标题（可选字段；失败不影响主流程）
        if (items.length > 0) {
          const ids = [...new Set(items.map((item) => item.projectId).filter((id): id is string => Boolean(id)))]
          if (ids.length > 0) {
            try {
              const projects = await api<RawProject[]>(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`)
              const titles = new Map(projects.map((project) => [project.id, project.title]))
              for (const item of items) {
                if (item.projectId) item.title = titles.get(item.projectId) ?? item.title
              }
            } catch (err) {
              log.warn('content', '获取更新项目标题失败', { error: String(err) })
            }
          }
        }
        log.info('content', '模组更新检查完成', {
          instanceId,
          checked: candidates.length,
          updates: items.length,
        })
        return items
      } catch (err) {
        log.warn('content', '模组更新检查失败（返回空数组）', { instanceId, error: String(err) })
        return []
      }
    }

    /**
     * 更新单个模组：查最新版 → 旧文件改名 .old → 下载新文件 → 删旧文件 → 更新 content.json。
     * 任一步失败回滚（恢复旧文件，不留下两个同名文件）。
     */
    async function update(
      instanceId: string,
      fileName: string,
    ): Promise<{ ok: boolean; fileName?: string; version?: string; error?: string }> {
      try {
        const instance = instances.get(instanceId)
        if (!instance) return { ok: false, error: '实例不存在' }
        if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
          return { ok: false, error: '只支持更新 mods/ 目录下的单个模组文件' }
        }
        const list = await installed(instanceId)
        const item = list.find((entry) => entry.fileName === fileName && (entry.kind ?? 'mod') === 'mod')
        if (!item) return { ok: false, error: '没有找到这个模组的安装记录' }

        const files = modFileCandidates(instanceId, instance, fileName)
        const wasDisabled = !existsSync(files.active) && existsSync(files.disabled)
        const oldPath = existsSync(files.active)
          ? files.active
          : existsSync(files.disabled)
            ? files.disabled
            : undefined
        if (!oldPath) return { ok: false, error: '模组文件不存在（可能已被手动删除）' }

        // 1) 算当前 sha1 查最新版
        const currentSha1 = await sha1File(oldPath)
        const latestMap = await queryLatestVersions(instance, [currentSha1]).catch((err) => {
          log.warn('content', '更新检查网络失败', { fileName, error: String(err) })
          return {} as Record<string, RawVersion>
        })
        const latest = latestMap[currentSha1]
        if (!latest) return { ok: false, error: 'Modrinth 上没有可用的更新（可能项目未收录或网络失败）' }
        if (latest.version_number === item.versionNumber) return { ok: false, error: '已是最新版本' }
        const primary = latest.files?.find((file) => file.primary) ?? latest.files?.[0]
        if (!primary) return { ok: false, error: '最新版本没有可下载文件' }
        const newFileName = safeName(primary.filename, `${latest.id}.jar`)

        // 2) 旧文件先改名 .old（后续失败可回滚）；同名覆盖时也不会有两个同名文件
        const backup = `${files.active}.old`
        await rm(backup, { force: true })
        await rename(oldPath, backup)

        // 3) 下载新文件（原本禁用的仍保持禁用）
        const targetNormal = path.join(instances.contentDir(instanceId, 'mods'), newFileName)
        const dest = wasDisabled ? `${targetNormal}.disabled` : targetNormal
        try {
          await new Downloader({ cacheDir: paths.downloads, concurrency: 1 }).fetchOne({
            url: primary.url,
            dest,
            sha1: primary.hashes?.sha1,
            size: primary.size,
            label: newFileName,
          })
        } catch (err) {
          await rm(dest, { force: true }).catch(() => undefined)
          await rename(backup, oldPath).catch(() => undefined)
          const message = err instanceof Error ? err.message : String(err)
          log.warn('content', '模组更新下载失败，已回滚', { fileName, error: message })
          return { ok: false, error: `下载新版本失败：${message}` }
        }

        // 4) 成功后删旧文件 + 更新 content.json（失败则回滚）
        await rm(backup, { force: true }).catch(() => undefined)
        const nextList = list.map((entry) =>
          entry.fileName === fileName
            ? {
                ...entry,
                projectId: latest.project_id ?? entry.projectId,
                versionId: latest.id,
                versionNumber: latest.version_number,
                fileName: newFileName,
                sha1: primary.hashes?.sha1 ?? '',
                installedAt: Date.now(),
              }
            : entry,
        )
        try {
          await saveInstalled(instanceId, nextList)
        } catch (err) {
          await rm(dest, { force: true }).catch(() => undefined)
          await rm(`${targetNormal}`, { force: true }).catch(() => undefined)
          await rename(backup, oldPath).catch(() => undefined)
          const message = err instanceof Error ? err.message : String(err)
          log.warn('content', '更新 content.json 失败，已回滚', { fileName, error: message })
          return { ok: false, error: `保存安装记录失败：${message}` }
        }

        telemetry.record('content:update', { instanceId, fileName, newFileName, version: latest.version_number })
        log.info('content', '模组已更新', {
          fileName,
          newFileName,
          from: item.versionNumber,
          to: latest.version_number,
        })
        return { ok: true, fileName: newFileName, version: latest.version_number }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('content', '模组更新失败', { instanceId, fileName, error: message })
        return { ok: false, error: message }
      }
    }

    /**
     * 图片画廊预览：只打 GET /project/<id>；网络失败返回空 gallery 不抛错。
     * gallery.url 可能是协议相对（`//cdn.modrinth.com/...`），统一补成 https。
     */
    async function preview(projectId: string, kind: ContentKind): Promise<ContentPreview> {
      const empty: ContentPreview = {
        projectId,
        title: '',
        description: '',
        gallery: [],
        downloads: 0,
        gameVersions: [],
        loaders: [],
      }
      try {
        const project = await api<RawProject>(`/project/${encodeURIComponent(projectId)}`)
        const gallery = (project.gallery ?? [])
          .map((entry) => absoluteImageUrl(entry?.url))
          .filter((url): url is string => Boolean(url))
        const previewData: ContentPreview = {
          projectId: project.id ?? projectId,
          title: project.title ?? '',
          description: project.description ?? '',
          iconUrl: absoluteImageUrl(project.icon_url),
          gallery,
          downloads: project.downloads ?? 0,
          gameVersions: project.game_versions ?? [],
          loaders: project.loaders ?? [],
        }
        log.info('content', '内容预览已获取', { projectId, kind, gallery: gallery.length })
        return previewData
      } catch (err) {
        log.warn('content', '内容预览获取失败（返回空画廊）', { projectId, kind, error: String(err) })
        return empty
      }
    }

    ctx.provide('content', {
      search,
      versions,
      pickVersion,
      install,
      installed,
      toggle,
      remove,
      installModpack,
      installModpackProject,
      inspectModpack,
      installCursePack,
      inspectCursePack,
      inspectPack,
      installPack,
      installVersion,
      updates,
      update,
      testCurseForge,
      preview,
      installVersionById,
      setProgressSink: (next) => {
        progressSink = next
      },
    } satisfies ContentService)

    log.info('content', 'Modrinth 内容服务就绪', { userAgent: UA, settingsPlayer: settings.get('playerName') })
  })
}
