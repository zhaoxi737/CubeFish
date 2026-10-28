/**
 * 内容服务（P2）：Modrinth 搜索 / 版本匹配 / 依赖求解 / 一键装 mod・资源包・光影。
 * API 参考 docs/RESEARCH-P1-P2.md §4。
 */
import path from 'node:path'
import type {
  ContentInstallResult,
  ContentVersionInfo,
  InstalledContent,
  SearchHit,
} from '../../shared/types'
import { Downloader } from '../lib/downloader'
import { readJson, safeName, writeJsonAtomic } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { InstancesService } from './instances'
import type { LogService } from './logger'
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

export interface ContentService {
  search(
    query: string,
    opts?: { type?: ContentKind; mcVersion?: string; loader?: string; limit?: number },
  ): Promise<SearchHit[]>
  versions(projectId: string, opts?: { mcVersion?: string; loader?: string }): Promise<ContentVersionInfo[]>
  pickVersion(projectId: string, opts?: { mcVersion?: string; loader?: string }): Promise<ContentVersionInfo | undefined>
  install(
    instanceId: string,
    projectId: string,
    opts?: { mcVersion?: string; loader?: string },
  ): Promise<ContentInstallResult>
  installed(instanceId: string): Promise<InstalledContent[]>
  /** 下载任意已解析的版本文件到实例对应目录（含依赖递归） */
  installVersion(instanceId: string, version: ContentVersionInfo, kind: ContentKind, depth?: number): Promise<string[]>
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
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    let lastRequest = 0

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
      opts: { type?: ContentKind; mcVersion?: string; loader?: string; limit?: number } = {},
    ): Promise<SearchHit[]> {
      const facets: string[][] = []
      if (opts.type) facets.push([`project_type:${opts.type}`])
      if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`])
      if (opts.loader) facets.push([`categories:${opts.loader}`])
      const params = new URLSearchParams({
        query,
        limit: String(Math.min(opts.limit ?? 12, 30)),
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
      }))
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
      return readJson<InstalledContent[]>(contentFile(instanceId), [])
    }

    async function saveInstalled(instanceId: string, items: InstalledContent[]): Promise<void> {
      await writeJsonAtomic(contentFile(instanceId), items)
    }

    async function installVersion(
      instanceId: string,
      version: ContentVersionInfo,
      kind: ContentKind,
      depth = 0,
    ): Promise<string[]> {
      const instance = instances.get(instanceId)
      if (!instance) throw new Error(`实例不存在: ${instanceId}`)
      if (!version.fileUrl) throw new Error(`版本 ${version.versionNumber} 没有可下载文件`)

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
            if (existing.some((item) => item.versionId === depVersion!.id)) continue
            const files = await installVersion(instanceId, depVersion, 'mod', depth + 1)
            if (files.length > 0) depCount += 1
          } catch (err) {
            log.warn('content', '依赖安装失败', { projectId: dep.projectId, error: String(err) })
          }
        }
      }

      // 2) 下载主文件
      const targetDir = path.join(instance.gameDir, kindDir(kind))
      const fileName = safeName(version.fileName || `${version.id}.jar`, `${version.id}.jar`)
      const dest = path.join(targetDir, fileName)
      const downloader = new Downloader({ cacheDir: paths.downloads, concurrency: 1 })
      await downloader.fetchOne({
        url: version.fileUrl,
        dest,
        sha1: version.sha1 || undefined,
        size: version.fileSize || undefined,
        label: fileName,
      })

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
      try {
        const project = await api<{ id: string; title: string; project_type: string }>(
          `/project/${encodeURIComponent(projectId)}`,
        )
        const kind = (project.project_type ?? 'mod') as ContentKind
        const instance = instances.get(instanceId)
        const mcv = opts.mcVersion ?? instance?.gameVersion ?? (instance?.loader === 'vanilla' ? instance?.versionId : undefined)
        const loader =
          opts.loader ??
          (instance?.loader === 'fabric' || instance?.versionId?.startsWith('fabric-loader') ? 'fabric' : undefined)
        const before = await installed(instanceId)
        const version = await pickVersion(projectId, { mcVersion: mcv, loader })
        if (!version) {
          return {
            ok: false,
            projectId,
            title: project.title,
            files: [],
            dependenciesInstalled: 0,
            error: `没有匹配的版本（游戏版本 ${mcv ?? '不限'} / 加载器 ${loader ?? '不限'}）`,
          }
        }
        const files = await installVersion(instanceId, version, kind)
        const after = await installed(instanceId)
        const dependenciesInstalled = Math.max(0, after.length - before.length - 1)
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
        return { ok: false, projectId, files: [], dependenciesInstalled: 0, error: message }
      }
    }

    ctx.provide('content', {
      search,
      versions,
      pickVersion,
      install,
      installed,
      installVersion,
    } satisfies ContentService)

    log.info('content', 'Modrinth 内容服务就绪', { userAgent: UA, settingsPlayer: settings.get('playerName') })
  })
}
