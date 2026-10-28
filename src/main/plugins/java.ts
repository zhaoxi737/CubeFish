/**
 * Java 运行时：探测本机 JDK + 按 MC 版本要求匹配 + 必要时下载 Mojang 官方运行时。
 * 参照 docs/RESEARCH-P1-P2.md §1.5。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { JavaRuntimeInfo, TaskProgress } from '../../shared/types'
import { Downloader } from '../lib/downloader'
import { ensureDir, readJson } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'

const execFileAsync = promisify(execFile)
const JAVA_RUNTIME_ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'
const USER_AGENT = 'QDOQMC/0.1.0 (+https://qdoqmc.example/contact)'

interface RuntimeAll {
  [platform: string]: Record<
    string,
    { manifest: { url: string; sha1: string; size: number }; version: { name: string } }[]
  >
}

interface RuntimeManifest {
  files: Record<string, { type: 'file' | 'directory' | 'link'; downloads?: { raw?: { url: string; sha1: string; size: number } }; executable?: boolean; target?: string }>
}

export interface JavaService {
  detect(force?: boolean): Promise<JavaRuntimeInfo[]>
  select(major: number): Promise<JavaRuntimeInfo | undefined>
  /** 本地没有匹配的主版本时，下载 Mojang 运行时并返回它 */
  ensure(component: string, major: number, taskId: string): Promise<JavaRuntimeInfo>
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
}

function parseMajor(version: string): number {
  const parts = version.split(/[._-]/)
  if (parts[0] === '1' && parts.length > 1) return Number.parseInt(parts[1], 10) || 0
  return Number.parseInt(parts[0], 10) || 0
}

async function probe(exe: string): Promise<JavaRuntimeInfo | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(exe, ['-XshowSettings:properties', '-version'], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const text = `${stdout}\n${stderr}`
    const versionMatch = /java\.version\s*=\s*([0-9][0-9._]*)/.exec(text)
    const homeMatch = /java\.home\s*=\s*(.+)/.exec(text)
    if (!versionMatch) return undefined
    const version = versionMatch[1]
    const home = homeMatch ? homeMatch[1].trim() : path.dirname(path.dirname(exe))
    return {
      path: exe,
      home,
      version,
      major: parseMajor(version),
      source: 'common',
    }
  } catch {
    return undefined
  }
}

function candidateDirs(): string[] {
  const env = process.env
  const dirs = new Set<string>()
  const pf = env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'Temurin']
  for (const vendor of vendors) {
    dirs.add(path.join(pf, vendor))
    dirs.add(path.join(pf86, vendor))
  }
  dirs.add(path.join(os.homedir(), '.jdks'))
  return [...dirs]
}

export function createJavaPlugin(): LauncherPlugin<void> {
  return definePlugin('java', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')

    let cache: { at: number; list: JavaRuntimeInfo[] } | null = null
    let sink: ((progress: TaskProgress) => void) | null = null

    async function detect(force = false): Promise<JavaRuntimeInfo[]> {
      if (!force && cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.list
      const seen = new Set<string>()
      const result: JavaRuntimeInfo[] = []

      const addCandidate = (exe: string | undefined, source: JavaRuntimeInfo['source']) => {
        if (!exe || !existsSync(exe)) return
        const key = exe.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        result.push({ path: exe, home: path.dirname(path.dirname(exe)), version: '?', major: 0, source })
      }

      // 1) JAVA_HOME / JDK_HOME
      for (const key of ['JAVA_HOME', 'JDK_HOME'] as const) {
        const home = process.env[key]
        if (home) {
          addCandidate(path.join(home, 'bin', 'java.exe'), 'env')
          addCandidate(path.join(home, 'bin', 'java'), 'env')
        }
      }

      // 2) PATH
      try {
        const { stdout } = await execFileAsync('where', ['java'], { timeout: 4000, windowsHide: true })
        for (const line of stdout.split(/\r?\n/)) {
          const exe = line.trim()
          if (exe) addCandidate(exe, 'path')
        }
      } catch {
        /* 没有 java 在 PATH 里 */
      }

      // 3) 常见安装目录
      for (const dir of candidateDirs()) {
        if (!existsSync(dir)) continue
        try {
          const entries = await readdir(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            addCandidate(path.join(dir, entry.name, 'bin', 'java.exe'), 'common')
          }
        } catch {
          /* 无权限等 */
        }
        // 部分发行版把 exe 放在 bin 下一层（如 Java\jdk-21\bin）
      }

      // 4) Mojang 已下载的运行时
      try {
        const components = await readdir(paths.runtimes, { withFileTypes: true })
        for (const comp of components) {
          if (!comp.isDirectory()) continue
          const versions = await readdir(path.join(paths.runtimes, comp.name), { withFileTypes: true })
          for (const ver of versions) {
            if (!ver.isDirectory()) continue
            addCandidate(path.join(paths.runtimes, comp.name, ver.name, 'bin', 'java.exe'), 'mojang')
          }
        }
      } catch {
        /* 还没有下载过 */
      }

      // 逐个探测真实版本
      const probed: JavaRuntimeInfo[] = []
      for (const info of result) {
        const real = await probe(info.path)
        if (real) probed.push({ ...real, source: info.source })
      }
      probed.sort((a, b) => b.major - a.major)
      cache = { at: Date.now(), list: probed }
      log.info('java', 'Java 运行时探测完成', { count: probed.length, majors: probed.map((j) => j.major) })
      return probed
    }

    async function select(major: number): Promise<JavaRuntimeInfo | undefined> {
      const all = await detect()
      const exact = all.find((j) => j.major === major)
      if (exact) return exact
      const newer = all.filter((j) => j.major > major).sort((a, b) => a.major - b.major)
      return newer[0]
    }

    async function ensure(component: string, major: number, taskId: string): Promise<JavaRuntimeInfo> {
      const existing = await select(major)
      if (existing && existing.major === major) return existing

      const emit = (done: number, total: number, bytes = 0, message?: string) =>
        sink?.({ taskId, kind: 'install', stage: 'libraries', done, total, bytes, message })
      emit(0, 1, 0, `下载 Java ${major} 运行时`)

      const platform =
        process.arch === 'x64' ? 'windows-x64' : process.arch === 'arm64' ? 'windows-arm64' : 'windows-x86'
      const res = await fetch(JAVA_RUNTIME_ALL, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`Java 运行时清单获取失败: HTTP ${res.status}`)
      const all = (await res.json()) as RuntimeAll
      const entry = all[platform]?.[component]?.[0]
      if (!entry) throw new Error(`没有找到 Java 组件 ${component}（平台 ${platform}）`)

      const manifestDest = path.join(paths.meta, 'java-runtime', `${component}.json`)
      await ensureDir(path.dirname(manifestDest))
      await new Downloader({ cacheDir: paths.downloads, concurrency: 1 }).fetchOne({
        url: entry.manifest.url,
        dest: manifestDest,
        sha1: entry.manifest.sha1,
        size: entry.manifest.size,
        label: `java manifest ${component}`,
      })
      const manifest = await readJson<RuntimeManifest | undefined>(manifestDest, undefined)
      if (!manifest?.files) throw new Error('Java 运行时 manifest 解析失败')

      const targetRoot = path.join(paths.runtimes, component, entry.version.name)
      const specs = Object.entries(manifest.files)
        .filter(([, file]) => file.type === 'file' && file.downloads?.raw)
        .map(([rel, file]) => ({
          url: file.downloads!.raw!.url,
          dest: path.join(targetRoot, ...rel.split('/')),
          sha1: file.downloads!.raw!.sha1,
          size: file.downloads!.raw!.size,
          label: rel,
        }))

      const downloader = new Downloader({
        cacheDir: paths.downloads,
        concurrency: 8,
        onProgress: (done, total, bytes) => emit(done, total, bytes, '下载 Java 运行时'),
        onVerbose: (message, data) => log.warn('java', message, data),
      })
      const stats = await downloader.downloadAll(specs)
      if (stats.failed.length > 0) {
        throw new Error(`Java 运行时下载失败：${stats.failed.length} 个文件（首个：${stats.failed[0].label}）`)
      }

      cache = null
      const info = await probe(path.join(targetRoot, 'bin', 'java.exe'))
      if (!info) throw new Error('Java 运行时下载完成但无法执行')
      log.info('java', '已下载 Mojang Java 运行时', { component, version: entry.version.name, major: info.major })
      return { ...info, source: 'mojang' }
    }

    ctx.provide('java', {
      detect,
      select,
      ensure,
      setProgressSink: (next) => {
        sink = next
      },
    } satisfies JavaService)
  })
}
