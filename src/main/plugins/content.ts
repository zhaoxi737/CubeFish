/**
 * 内容服务（P2 → P20）：Modrinth 搜索/安装、.mrpack、CurseForge .zip 整合包，以及 mod/资源包/光影一键装。
 * API 参考 docs/RESEARCH-P1-P2.md §4。
 */
import AdmZip from 'adm-zip'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ContentInstallResult,
  ContentVersionInfo,
  InstalledContent,
  CursePackInspectResult,
  CursePackInstallResult,
  PackInspect,
  ModpackInspectResult,
  ModpackInstallResult,
  SearchHit,
} from '../../shared/types'
import { Downloader, type DownloadSpec } from '../lib/downloader'
import { ensureDir, readJson, safeName, writeJsonAtomic } from '../lib/fsx'
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
        // P28：前端「支持 1.20.1 · Fabric」chips
        gameVersions: hit.versions ?? [],
        loaders: hit.loaders ?? [],
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
      const instance = instances.get(instanceId)
      const dir = instance?.gameDir ?? path.join(paths.instances, instanceId, '.minecraft')
      const list = await readJson<InstalledContent[]>(contentFile(instanceId), [])
      return list.map((item) => {
        const folder = kindDir((item.kind as ContentKind) ?? 'mod')
        const normal = path.join(dir, folder, item.fileName)
        const disabled = `${normal}.disabled`
        return { ...item, enabled: existsSync(normal) || !existsSync(disabled) }
      })
    }

    async function toggle(
      instanceId: string,
      fileName: string,
    ): Promise<{ ok: boolean; enabled?: boolean; error?: string }> {
      const instance = instances.get(instanceId)
      if (!instance) return { ok: false, error: '实例不存在' }
      const list = await installed(instanceId)
      const item = list.find((entry) => entry.fileName === fileName)
      const folder = kindDir((item?.kind as ContentKind) ?? 'mod')
      const normal = path.join(instance.gameDir, folder, fileName)
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
      const folder = kindDir((item?.kind as ContentKind) ?? 'mod')
      try {
        const { rm } = await import('node:fs/promises')
        await rm(path.join(instance.gameDir, folder, fileName), { force: true })
        await rm(path.join(instance.gameDir, folder, `${fileName}.disabled`), { force: true })
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
      try {
        const { index, zip } = parseIndex(await readSource(source))
        const deps = index.dependencies ?? {}
        const mc = deps.minecraft as string
        if (deps['quilt-loader']) {
          return { ok: false, error: '暂不支持 Quilt 整合包（支持 Fabric / NeoForge / Forge / 原版）' }
        }

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
            dest: path.join(instance.gameDir, ...rel.split('/')),
            sha1: file.hashes?.sha1,
            size: file.fileSize,
            label: rel,
          })
          filePaths.push({ rel, sha1: file.hashes?.sha1 ?? '' })
        }

        const downloader = new Downloader({
          cacheDir: paths.downloads,
          concurrency: 8,
          onVerbose: (message, data) => log.warn('content', message, data),
        })
        const stats = await downloader.downloadAll(specs)
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
          const dest = path.join(instance.gameDir, ...rel.split('/'))
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
        return { ok: false, error: message }
      }
    }

    async function installModpackProject(projectId: string, name?: string): Promise<ModpackInstallResult> {
      try {
        const version = await pickVersion(projectId)
        if (!version?.fileUrl) return { ok: false, error: '这个整合包没有可下载的 .mrpack 文件' }
        return installModpack(version.fileUrl, { name })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
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

    function readCurseManifest(buffer: Buffer): { manifest: CurseManifest; zip: AdmZip } {
      const zip = new AdmZip(buffer)
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
      try {
        const { manifest, zip } = readCurseManifest(await readSource(source))
        const mc = manifest.minecraft?.version as string
        const primary = manifest.minecraft?.modLoaders?.find((item) => item.primary) ?? manifest.minecraft?.modLoaders?.[0]
        const parsed = parseCurseLoader(primary?.id)
        if (!parsed) return { ok: false, error: `无法识别的加载器：${primary?.id ?? '（未声明）'}` }
        if (parsed.loader === 'quilt') return { ok: false, error: '暂不支持 Quilt 整合包' }

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

        const modsDir = path.join(instance.gameDir, 'mods')
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

        // 1) 包内自带的 mods（离线包）
        let bundled = 0
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          const name = entry.entryName.replace(/\\/g, '/')
          if (!/^mods\/.+\.jar$/i.test(name)) continue
          const fileName = name.slice('mods/'.length)
          writeFileSync(path.join(modsDir, ...fileName.split('/')), entry.getData())
          addEntry(fileName, `curse:bundled:${fileName}`, 'bundled')
          bundled += 1
        }

        // 2) manifest 里的文件（需要 API Key 解析文件名与下载地址）
        const files = manifest.files ?? []
        let resolved = 0
        if (files.length > 0) {
          if (!CF_KEY() && bundled === 0) {
            throw new Error('这个整合包只带文件清单（没有内置 mods），需要配置 CurseForge API Key 才能下载')
          }
          for (const file of files) {
            if (file.required === false) continue
            if (!file.projectID || !file.fileID) continue
            if (!CF_KEY()) continue
            const info = await cfFileInfo(file.projectID, file.fileID)
            const dest = path.join(modsDir, info.fileName as string)
            await new Downloader({ cacheDir: paths.downloads, concurrency: 1 }).fetchOne({
              url: info.downloadUrl as string,
              dest,
              label: info.fileName as string,
            })
            addEntry(info.fileName as string, `curse:${file.projectID}`, String(file.fileID))
            resolved += 1
            if (resolved >= 200) break
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
          const dest = path.join(instance.gameDir, ...relative.split('/'))
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
      if (!inspected.ok) return { ok: false, error: inspected.error ?? '无法识别整合包' }
      if (inspected.kind === 'curseforge') {
        const result = await installCursePack(source, opts)
        return { ...result, kind: 'curseforge' }
      }
      const result = await installModpack(source, opts)
      return { ...result, kind: 'modrinth' }
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
    } satisfies ContentService)

    log.info('content', 'Modrinth 内容服务就绪', { userAgent: UA, settingsPlayer: settings.get('playerName') })
  })
}
