/**
 * 加载器服务（P2）：Fabric。
 * 参照 docs/RESEARCH-P1-P2.md §3.1：meta API 纯合并，不跑安装器进程。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  FabricInstallResult,
  LoaderAvailability,
  LoaderChoice,
  NeoForgeInstallResult,
  TaskProgress,
} from '../../shared/types'
import { Downloader, type DownloadSpec } from '../lib/downloader'
import { runOfficialInstaller } from '../lib/forge-installer'
import { ensureDir, readJson, writeJsonAtomic } from '../lib/fsx'
import { parseMaven } from '../lib/maven'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { JavaService } from './java'
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
  installFabric(gameVersion: string, versionOverride?: string): Promise<FabricInstallResult>
  neoforgeVersions(gameVersion: string): Promise<string[]>
  installNeoForge(gameVersion: string, versionOverride?: string): Promise<NeoForgeInstallResult>
  installForge(gameVersion: string, versionOverride?: string): Promise<NeoForgeInstallResult>
  /** P28：列出某版本可用的三种加载器及版本清单（单个来源失败不抛错） */
  available(gameVersion: string): Promise<LoaderAvailability>
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
}

const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'

/** 1.21.11 → "21.11."；1.20.1 及更早没有 neoforge 客户端构建 */
function neoforgePrefix(mcVersion: string): string | undefined {
  const parts = mcVersion.split('.')
  if (parts.length < 3 || parts[0] !== '1') return undefined
  const minor = Number(parts[1])
  const patch = Number(parts[2])
  if (Number.isNaN(minor) || Number.isNaN(patch)) return undefined
  if (minor < 20 || (minor === 20 && patch < 2)) return undefined
  return `${minor}.${patch}.`
}

export function createLoadersPlugin(): LauncherPlugin<void> {
  return definePlugin('loaders', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const mojang = use<MojangService>(ctx, 'mojang')
    const java = use<JavaService>(ctx, 'java')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    let sink: ((progress: TaskProgress) => void) | null = null

    async function getJson<T>(url: string): Promise<T> {
      const text = await fetchText(url)
      return JSON.parse(text) as T
    }

    /** 元数据请求偶发 `fetch failed`（DNS/连接抖动），重试 3 次避免面板少显示版本。 */
    async function fetchText(url: string): Promise<string> {
      let lastError: unknown
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
          if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
          return await res.text()
        } catch (err) {
          lastError = err
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    }

    async function fabricVersions(gameVersion: string): Promise<{ version: string; stable: boolean }[]> {
      const list = await getJson<FabricLoaderEntry[]>(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`)
      return list.map((entry) => ({ version: entry.loader.version, stable: entry.loader.stable }))
    }

    async function installFabric(gameVersion: string, versionOverride?: string): Promise<FabricInstallResult> {
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

        // 2) 选 loader 版本（显式指定优先，否则 stable → 最新）
        emit('libraries', 0, 1, 0, '查询 Fabric loader 版本')
        const loaders = await fabricVersions(gameVersion)
        if (loaders.length === 0) return { ok: false, gameVersion, error: `Fabric 不支持 ${gameVersion}` }
        const chosen = versionOverride
          ? (loaders.find((entry) => entry.version === versionOverride) ?? {
              version: versionOverride,
              stable: false,
            })
          : (loaders.find((entry) => entry.stable) ?? loaders[0])

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

    /* ---------- NeoForge ---------- */

    async function neoforgeVersions(mcVersion: string): Promise<string[]> {
      const prefix = neoforgePrefix(mcVersion)
      if (!prefix) return []
      const xml = await fetchText(`${NEOFORGE_MAVEN}/maven-metadata.xml`)
      const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1])
      const numeric = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
      return all
        .filter((version) => version.startsWith(prefix) && !version.includes('-beta'))
        .sort((a, b) => {
          const pa = numeric(a)
          const pb = numeric(b)
          for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
            const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
            if (diff !== 0) return diff
          }
          return 0
        })
    }

    async function installNeoForge(gameVersion: string, versionOverride?: string): Promise<NeoForgeInstallResult> {
      const started = Date.now()
      const taskId = `neoforge-${gameVersion}-${Date.now()}`
      const emit = (stage: string, done: number, total: number, bytes = 0, message?: string) =>
        sink?.({ taskId, kind: 'install', stage, done, total, bytes, message })

      try {
        const versions = await neoforgeVersions(gameVersion)
        if (versions.length === 0) {
          return {
            ok: false,
            gameVersion,
            error: `NeoForge 没有支持 ${gameVersion} 的版本（1.20.1 及更早请用 Forge）`,
          }
        }
        const loaderVersion = versionOverride ?? versions[versions.length - 1]

        emit('version', 0, 1, 0, `准备 NeoForge ${loaderVersion}`)
        const vanillaJson = path.join(paths.versions, gameVersion, `${gameVersion}.json`)
        const vanillaJar = path.join(paths.versions, gameVersion, `${gameVersion}.jar`)
        if (!existsSync(vanillaJson) || !existsSync(vanillaJar)) {
          const base = await mojang.install(gameVersion, taskId)
          if (!base.ok) return { ok: false, gameVersion, error: `原版安装失败：${base.error}` }
        }

        const installerName = `neoforge-${loaderVersion}-installer.jar`
        const installerPath = path.join(paths.cache, 'installers', installerName)
        if (!existsSync(installerPath)) {
          emit('libraries', 0, 1, 0, '下载 NeoForge 安装器')
          await new Downloader({ cacheDir: paths.downloads, concurrency: 1 }).fetchOne({
            url: `${NEOFORGE_MAVEN}/${loaderVersion}/${installerName}`,
            dest: installerPath,
            label: installerName,
          })
        }

        // Java：按原版版本的 javaVersion 选（1.21.x = 21）
        const baseVersionJson = await mojang.versionJson(gameVersion)
        const major = baseVersionJson.javaVersion?.majorVersion ?? 21
        const component = baseVersionJson.javaVersion?.component
        const javaInfo = component
          ? await java.ensure(component, major, taskId)
          : (await java.select(major)) ?? (await java.ensure('java-runtime-delta', major, taskId))

        // 官方安装器要求目标目录有 launcher_profiles.json（原版启动器文件），缺了就补一个
        const profilesFile = path.join(paths.data, 'launcher_profiles.json')
        if (!existsSync(profilesFile)) {
          await writeJsonAtomic(profilesFile, {
            profiles: {},
            settings: { enableSnapshots: false, keepLauncherOpen: false },
            version: 3,
          })
        }

        // 直接调用官方安装器：它会跑 processors 并注入版本 profile（FML 的生产模式校验依赖它）
        emit('legacy', 0, 1, 0, '执行 NeoForge 官方安装器（可能需要几分钟）')
        const installed = await runOfficialInstaller({
          installerPath,
          dataRoot: paths.data,
          javaPath: javaInfo.path,
          log: (message) => log.info('loaders', message),
        })
        if (!installed) {
          return { ok: false, gameVersion, error: 'NeoForge 官方安装器执行失败（详见日志）' }
        }
        const versionId = `neoforge-${loaderVersion}`
        const installedJson = path.join(paths.versions, versionId, `${versionId}.json`)
        if (!existsSync(installedJson)) {
          return { ok: false, gameVersion, error: `安装器未写入版本文件：${installedJson}` }
        }
        emit('done', 1, 1, 0, `NeoForge ${loaderVersion} 安装完成`)

        telemetry.record('loader:neoforge', {
          gameVersion,
          loaderVersion,
          versionId,
          ms: Date.now() - started,
        })
        log.info('loaders', 'NeoForge 安装完成', {
          versionId,
          loaderVersion,
          ms: Date.now() - started,
        })
        return { ok: true, gameVersion, versionId, loaderVersion }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('loaders', 'NeoForge 安装失败', { gameVersion, error: message })
        telemetry.record('loader:neoforge:error', { gameVersion, error: message })
        return { ok: false, gameVersion, error: message }
      }
    }

    async function installForge(gameVersion: string, versionOverride?: string): Promise<NeoForgeInstallResult> {
      const started = Date.now()
      const taskId = `forge-${gameVersion}-${Date.now()}`
      const emit = (stage: string, done: number, total: number, message?: string) =>
        sink?.({ taskId, kind: 'install', stage, done, total, bytes: 0, message })

      try {
        emit('version', 0, 1, `查询 Forge ${gameVersion} 版本`)
        const res = await fetch(FORGE_PROMOS, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
        if (!res.ok) return { ok: false, gameVersion, error: `Forge 版本列表获取失败：HTTP ${res.status}` }
        const promos = (await res.json()) as { promos?: Record<string, string> }
        const table = promos.promos ?? {}
        const forgeVersion =
          versionOverride ?? table[`${gameVersion}-recommended`] ?? table[`${gameVersion}-latest`]
        if (!forgeVersion) {
          return { ok: false, gameVersion, error: `Forge 没有支持 ${gameVersion} 的版本（查看 forge 官网支持列表）` }
        }

        const installerName = `forge-${gameVersion}-${forgeVersion}-installer.jar`
        const installerPath = path.join(paths.cache, 'installers', installerName)
        if (!existsSync(installerPath)) {
          emit('libraries', 0, 1, '下载 Forge 安装器')
          await new Downloader({ cacheDir: paths.downloads, concurrency: 1 }).fetchOne({
            url: `${FORGE_MAVEN}/${gameVersion}-${forgeVersion}/${installerName}`,
            dest: installerPath,
            label: installerName,
          })
        }

        // 原版与 Java
        const vanillaJson = path.join(paths.versions, gameVersion, `${gameVersion}.json`)
        const vanillaJar = path.join(paths.versions, gameVersion, `${gameVersion}.jar`)
        if (!existsSync(vanillaJson) || !existsSync(vanillaJar)) {
          emit('version', 0, 1, `先安装原版 ${gameVersion}（含资源，可能较久）`)
          const base = await mojang.install(gameVersion, taskId)
          if (!base.ok) return { ok: false, gameVersion, error: `原版安装失败：${base.error}` }
        }
        const baseVersionJson = await mojang.versionJson(gameVersion)
        const major = baseVersionJson.javaVersion?.majorVersion ?? 17
        const component = baseVersionJson.javaVersion?.component
        const javaInfo = component
          ? await java.ensure(component, major, taskId)
          : (await java.select(major)) ?? (await java.ensure('java-runtime-delta', major, taskId))

        const profilesFile = path.join(paths.data, 'launcher_profiles.json')
        if (!existsSync(profilesFile)) {
          await writeJsonAtomic(profilesFile, {
            profiles: {},
            settings: { enableSnapshots: false, keepLauncherOpen: false },
            version: 3,
          })
        }

        emit('legacy', 0, 1, '执行 Forge 官方安装器（跑 processors）')
        const installed = await runOfficialInstaller({
          installerPath,
          dataRoot: paths.data,
          javaPath: javaInfo.path,
          log: (message) => log.info('loaders', message),
        })
        if (!installed) return { ok: false, gameVersion, error: 'Forge 官方安装器执行失败（详见日志）' }

        const versionId = `${gameVersion}-forge-${forgeVersion}`
        if (!existsSync(path.join(paths.versions, versionId, `${versionId}.json`))) {
          return { ok: false, gameVersion, error: `安装器未写入版本文件：versions/${versionId}` }
        }
        emit('done', 1, 1, `Forge ${forgeVersion} 安装完成`)
        telemetry.record('loader:forge', { gameVersion, forgeVersion, versionId, ms: Date.now() - started })
        log.info('loaders', 'Forge 安装完成', { versionId, forgeVersion, ms: Date.now() - started })
        return { ok: true, gameVersion, versionId, loaderVersion: forgeVersion }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('loaders', 'Forge 安装失败', { gameVersion, error: message })
        telemetry.record('loader:forge:error', { gameVersion, error: message })
        return { ok: false, gameVersion, error: message }
      }
    }

    /* ---------- P28：加载器可用性清单 ---------- */

    let promosCache: { at: number; table: Record<string, string> } | undefined

    async function forgePromos(): Promise<Record<string, string>> {
      if (promosCache && Date.now() - promosCache.at < 10 * 60 * 1000) return promosCache.table
      const text = await fetchText(FORGE_PROMOS)
      const data = JSON.parse(text) as { promos?: Record<string, string> }
      promosCache = { at: Date.now(), table: data.promos ?? {} }
      return promosCache.table
    }

    /** Forge maven 里 `<gv>-<build>` 的 build 列表，新→旧。 */
    async function forgeMavenVersions(gameVersion: string): Promise<string[]> {
      const xml = await fetchText(`${FORGE_MAVEN}/maven-metadata.xml`)
      const prefix = `${gameVersion}-`
      const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
        .map((match) => match[1])
        .filter((version) => version.startsWith(prefix))
        .map((version) => version.slice(prefix.length))
        .filter((version) => /^\d/.test(version))
      const numeric = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0)
      return all.sort((a, b) => {
        const pa = numeric(a)
        const pb = numeric(b)
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
          if (diff !== 0) return diff
        }
        return 0
      })
    }

    async function forgeChoice(gameVersion: string): Promise<LoaderChoice> {
      let promos: Record<string, string> | undefined
      let mavenError: unknown
      let versions: string[] = []
      try {
        promos = await forgePromos()
      } catch (err) {
        log.warn('loaders', 'Forge promotions 查询失败，回退 maven 元数据', { gameVersion, error: String(err) })
      }
      try {
        versions = await forgeMavenVersions(gameVersion)
      } catch (err) {
        mavenError = err
      }
      if (!promos && versions.length === 0) {
        throw mavenError instanceof Error ? mavenError : new Error('Forge 版本来源不可用')
      }
      const recommended = promos?.[`${gameVersion}-recommended`] ?? promos?.[`${gameVersion}-latest`]
      const latest = promos?.[`${gameVersion}-latest`]
      for (const value of [latest, recommended]) {
        if (value && !versions.includes(value)) versions.unshift(value)
      }
      if (versions.length === 0) {
        return { loader: 'forge', versions: [], note: `Forge 没有支持 ${gameVersion} 的版本` }
      }
      return {
        loader: 'forge',
        versions: versions.slice(0, 20),
        recommended: recommended ?? versions[0],
      }
    }

    /** 三种加载器可用版本清单；单个来源失败只在该项 note 里提示，不整体抛错。 */
    async function available(gameVersion: string): Promise<LoaderAvailability> {
      let release = false
      let javaMajor: number | undefined
      try {
        const all = await mojang.list('all')
        release = all.versions.find((entry) => entry.id === gameVersion)?.type === 'release'
      } catch (err) {
        log.warn('loaders', '版本清单查询失败（可用性面板降级）', { gameVersion, error: String(err) })
      }
      try {
        const json = await mojang.versionJson(gameVersion)
        javaMajor = json.javaVersion?.majorVersion
      } catch (err) {
        log.warn('loaders', '版本 JSON 查询失败（可用性面板降级）', { gameVersion, error: String(err) })
      }

      const choices: LoaderChoice[] = []

      // Fabric：过滤 beta，保留历史正式版（stable 只用于 recommended，不能当唯一版本）
      try {
        const list = await fabricVersions(gameVersion)
        const versions = list
          .map((entry) => entry.version)
          .filter((version) => !version.includes('-beta'))
          .slice(0, 20)
        const stable = list.find((entry) => entry.stable && !entry.version.includes('-beta'))?.version
        choices.push(
          versions.length > 0
            ? { loader: 'fabric', versions, recommended: stable ?? versions[0] }
            : { loader: 'fabric', versions: [], note: 'Fabric 没有可用版本' },
        )
      } catch {
        choices.push({ loader: 'fabric', versions: [], note: '查询失败，可稍后重试' })
      }

      // Forge
      try {
        choices.push(await forgeChoice(gameVersion))
      } catch {
        choices.push({ loader: 'forge', versions: [], note: '查询失败，可稍后重试' })
      }

      // NeoForge：1.20.2 起才有客户端构建（更早走 Forge，不出现该项）
      if (neoforgePrefix(gameVersion)) {
        try {
          const versions = (await neoforgeVersions(gameVersion)).reverse().slice(0, 20)
          choices.push(
            versions.length > 0
              ? { loader: 'neoforge', versions, recommended: versions[0] }
              : { loader: 'neoforge', versions: [], note: `NeoForge 没有支持 ${gameVersion} 的版本` },
          )
        } catch {
          choices.push({ loader: 'neoforge', versions: [], note: '查询失败，可稍后重试' })
        }
      }

      log.info('loaders', '加载器可用性查询完成', {
        gameVersion,
        release,
        javaMajor,
        loaders: choices.map((choice) => `${choice.loader}:${choice.versions.length}`),
      })
      return { gameVersion, release, javaMajor, loaders: choices }
    }

    ctx.provide('loaders', {
      fabricVersions,
      installFabric,
      neoforgeVersions,
      installNeoForge,
      installForge,
      available,
      readProfile,
      setProgressSink: (next) => {
        sink = next
      },
    } as LoadersService & { readProfile: typeof readProfile })
  })
}
