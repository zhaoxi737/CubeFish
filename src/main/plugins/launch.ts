/**
 * 启动引擎：合并版本 → 选 Java → natives → classpath → 参数展开 → spawn → 日志/退出归因。
 * 参照 docs/RESEARCH-P1-P2.md §2。
 */
import AdmZip from 'adm-zip'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppMeta, GameStateEvent, LaunchResult, TaskProgress } from '../../shared/types'
import { ensureDir } from '../lib/fsx'
import { parseMaven } from '../lib/maven'
import { detectOsContext, evaluateRules, type OsContext } from '../lib/rules'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { AuthService } from './auth'
import type { InstancesService } from './instances'
import type { JavaService } from './java'
import type { LogService } from './logger'
import type { ArgumentEntry, LibraryJson, MojangService, VersionJson } from './mojang'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'

export interface LaunchService {
  start(instanceId: string): Promise<LaunchResult>
  stop(): Promise<{ ok: boolean; forced?: boolean }>
  current(): { pid: number; instanceId: string; versionId: string; startedAt: number } | null
  setGameStateSink(sink: ((state: GameStateEvent) => void) | null): void
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
}

interface ResolvedVersion {
  id: string
  /** 继承链最底层的原版版本 id（客户端 jar 在这里） */
  baseVersionId: string
  mainClass: string
  type: string
  assetIndexId?: string
  javaMajor: number
  javaComponent?: string
  logging?: VersionJson['logging']
  libraries: LibraryJson[]
  gameArgs: ArgumentEntry[]
  jvmArgs: ArgumentEntry[]
  minecraftArguments?: string
}

interface RunningGame {
  child: ChildProcessWithoutNullStreams
  instanceId: string
  versionId: string
  startedAt: number
  pid: number
}

const EXIT_HINTS: Record<number, string> = {
  0: '正常退出',
  1: '未捕获异常（常见：缺依赖 / 参数错误 / 模组加载失败）',
  [-1]: 'JVM 内部错误',
  [-1073741819]: '访问冲突 0xC0000005（显卡驱动或 native 库）',
  [-1073740791]: '栈溢出 0xC0000409',
  [-1073741515]: '缺少 DLL 0xC0000135（Java 位数不匹配 / VC++ 运行库缺失）',
  [-1073741510]: '进程被 Ctrl+C 终止',
}

function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`).digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  return hash.toString('hex')
}

function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => values[key] ?? '')
}

function expandArguments(entries: ArgumentEntry[], ctx: OsContext, values: Record<string, string>): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(substitute(entry, values))
      continue
    }
    if (!evaluateRules(entry.rules as never, ctx)) continue
    if (Array.isArray(entry.value)) out.push(...entry.value.map((v) => substitute(v, values)))
    else out.push(substitute(entry.value, values))
  }
  return out
}

export function createLaunchPlugin(): LauncherPlugin<void> {
  return definePlugin('launch', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const meta = use<AppMeta>(ctx, 'appMeta')
    const settings = use<SettingsService>(ctx, 'settings')
    const auth = use<AuthService>(ctx, 'auth')
    const instances = use<InstancesService>(ctx, 'instances')
    const mojang = use<MojangService>(ctx, 'mojang')
    const java = use<JavaService>(ctx, 'java')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    const osContext = detectOsContext(process.platform, process.arch, '')
    let running: RunningGame | null = null
    let gameStateSink: ((state: GameStateEvent) => void) | null = null
    let progressSink: ((progress: TaskProgress) => void) | null = null

    async function resolve(id: string): Promise<ResolvedVersion> {
      const chain: VersionJson[] = []
      let cursor: VersionJson | undefined = await mojang.versionJson(id)
      const guard = new Set<string>()
      while (cursor) {
        if (guard.has(cursor.id)) throw new Error(`版本继承出现环: ${id}`)
        guard.add(cursor.id)
        chain.unshift(cursor)
        cursor = cursor.inheritsFrom ? await mojang.versionJson(cursor.inheritsFrom) : undefined
      }
      const base = chain[0]
      const top = chain[chain.length - 1]

      const merged = new Map<string, LibraryJson>()
      for (const version of chain) {
        for (const lib of version.libraries ?? []) {
          const coord = parseMaven(lib.name)
          const key = coord ? `${coord.group}:${coord.artifact}:${coord.classifier ?? ''}` : lib.name
          merged.set(key, lib)
        }
      }

      const topGameArgs = top.arguments?.game ?? []
      const baseGameArgs = base.arguments?.game ?? []
      return {
        id: top.id,
        baseVersionId: base.id,
        mainClass: top.mainClass ?? base.mainClass,
        type: top.type ?? base.type ?? 'release',
        assetIndexId: top.assetIndex?.id ?? base.assetIndex?.id,
        javaMajor: top.javaVersion?.majorVersion ?? base.javaVersion?.majorVersion ?? 8,
        javaComponent: top.javaVersion?.component ?? base.javaVersion?.component,
        logging: top.logging ?? base.logging,
        libraries: [...merged.values()],
        // NeoForge/Forge 的版本 json 只带自己的 --fml.* 参数，必须和原版的
        // --username/--accessToken/--version 等合并，而不是二选一
        gameArgs: chain.flatMap((v) => v.arguments?.game ?? []),
        jvmArgs: chain.flatMap((v) => v.arguments?.jvm ?? []),
        minecraftArguments: top.minecraftArguments ?? base.minecraftArguments,
      }
    }

    function libraryPath(lib: LibraryJson): string | undefined {
      if (lib.downloads?.artifact) return path.join(paths.libraries, lib.downloads.artifact.path)
      if (lib.url) {
        const coord = parseMaven(lib.name)
        if (coord) return path.join(paths.libraries, coord.path)
      }
      return undefined
    }

    function prepareNatives(versionId: string, libraries: LibraryJson[]): string {
      const nativesDir = path.join(paths.versions, versionId, 'natives')
      rmSync(nativesDir, { recursive: true, force: true })
      mkdirSync(nativesDir, { recursive: true })
      for (const lib of libraries) {
        if (!evaluateRules(lib.rules as never, osContext)) continue
        const nativeKey = lib.natives?.[osContext.name]
        if (!nativeKey) continue
        const classifier = lib.downloads?.classifiers?.[nativeKey]
        if (!classifier) continue
        const jarPath = path.join(paths.libraries, classifier.path)
        if (!existsSync(jarPath)) continue
        const excludes = lib.extract?.exclude ?? ['META-INF/']
        try {
          const zip = new AdmZip(jarPath)
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue
            const name = entry.entryName.replace(/\\/g, '/')
            if (name.includes('..')) continue
            if (excludes.some((ex) => name.startsWith(ex))) continue
            const dest = path.join(nativesDir, ...name.split('/'))
            mkdirSync(path.dirname(dest), { recursive: true })
            writeFileSync(dest, entry.getData())
          }
        } catch (err) {
          log.warn('launch', 'natives 解压失败', { lib: lib.name, error: String(err) })
        }
      }
      return nativesDir
    }

    function findCrashReport(gameDir: string): string | undefined {
      try {
        const dir = path.join(gameDir, 'crash-reports')
        if (!existsSync(dir)) return undefined
        const files = readdirSync(dir)
          .map((file) => ({ file, mtime: statSync(path.join(dir, file)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
        if (files.length === 0) return undefined
        const newest = files[0]
        if (Date.now() - newest.mtime > 10 * 60 * 1000) return undefined
        return path.join(dir, newest.file)
      } catch {
        return undefined
      }
    }

    async function start(instanceId = 'default'): Promise<LaunchResult> {
      const startedAt = Date.now()
      if (running) return { ok: false, error: `已有游戏在运行（PID ${running.pid}）` }
      const instance = instances.get(instanceId)
      if (!instance) return { ok: false, error: `实例不存在: ${instanceId}` }
      if (!instance.versionId) return { ok: false, error: '该实例还没有选择游戏版本' }

      try {
        const resolved = await resolve(instance.versionId)
        const jarVersion = resolved.baseVersionId
        const versionJar = path.join(paths.versions, jarVersion, `${jarVersion}.jar`)
        if (!existsSync(versionJar)) throw new Error(`缺少客户端 jar（重新安装 ${jarVersion}）`)

        const taskId = `launch-${Date.now()}`
        const javaInfo = resolved.javaComponent
          ? await java.ensure(resolved.javaComponent, resolved.javaMajor, taskId)
          : await java.select(resolved.javaMajor)
        if (!javaInfo) throw new Error(`找不到 Java ${resolved.javaMajor}，请安装或改用其他版本`)
        if (javaInfo.major !== resolved.javaMajor) {
          log.warn('launch', 'Java 主版本与要求不完全一致', { required: resolved.javaMajor, actual: javaInfo.major })
        }

        const gameDir = instance.gameDir
        await ensureDir(gameDir)
        const nativesDir = prepareNatives(instance.versionId, resolved.libraries)

        const cp: string[] = []
        const seen = new Set<string>()
        for (const lib of resolved.libraries) {
          if (!evaluateRules(lib.rules as never, osContext)) continue
          const libPath = libraryPath(lib)
          if (!libPath) continue
          if (!existsSync(libPath)) throw new Error(`缺少库文件: ${lib.name}`)
          const key = libPath.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          cp.push(libPath)
        }
        // Forge (BootstrapLauncher) / NeoForge (fml.startup) 会从 -DlibraryDirectory
        // 自己加载 patched client jar；把原版 jar 放进 classpath 会变成自动模块
        // `_1._20._1` 并与 Forge 的 `minecraft` 模块抢包（ResolutionException）。
        const bootstrapLoader = /bootstraplauncher|fml\.startup/i.test(resolved.mainClass ?? '')
        if (!bootstrapLoader) cp.push(versionJar)
        const classpath = cp.join(path.delimiter)

        // 账号：微软已登录则用正版令牌，否则离线
        const account = instance.accountId
          ? ((await auth.ensureAccountById(instance.accountId)) ?? (await auth.ensureAccount()))
          : await auth.ensureAccount()
        const microsoft = account.type === 'microsoft'
        const playerName = microsoft ? account.name : instance.playerName || settings.get('playerName') || 'Player'
        const uuid = microsoft ? account.uuid : offlineUuid(playerName)
        const accessToken = microsoft && account.accessToken ? account.accessToken : '-'
        const assetIndexId = resolved.assetIndexId ?? 'legacy'
        const virtualAssets =
          assetIndexId === 'pre-1.6' ? 'pre-1.6' : assetIndexId === 'legacy' ? 'legacy' : assetIndexId

        const values: Record<string, string> = {
          auth_player_name: playerName,
          auth_uuid: uuid,
          auth_access_token: accessToken,
          auth_session: accessToken,
          version_name: instance.versionId,
          version_type: resolved.type,
          game_directory: gameDir,
          assets_root: paths.assets,
          assets_index_name: assetIndexId,
          game_assets: path.join(paths.assets, 'virtual', virtualAssets),
          user_type: microsoft ? 'msa' : 'legacy',
          user_properties: '{}',
          natives_directory: nativesDir,
          launcher_name: 'QDOQMC',
          launcher_version: meta.version,
          classpath,
          classpath_separator: path.delimiter,
          library_directory: paths.libraries,
          resolution_width: '854',
          resolution_height: '480',
          clientid: '-',
          auth_xuid: '-',
          path: '',
        }

        const memoryMb = instance.memoryMb || settings.get('memoryMb') || 4096
        const jvm: string[] = [`-Xmx${memoryMb}M`, '-Xms512M']

        const logConfig = resolved.logging?.client?.file
        if (logConfig) {
          const logConfigPath = path.join(paths.assets, 'log_configs', logConfig.id)
          if (existsSync(logConfigPath)) jvm.push(`-Dlog4j.configurationFile=${logConfigPath}`)
        }

        const jvmTemplate = resolved.jvmArgs.length > 0 ? resolved.jvmArgs : ['-Djava.library.path=${natives_directory}']
        const jvmExpanded = expandArguments(jvmTemplate, osContext, values)
        jvm.push(...jvmExpanded)
        if (!jvm.some((arg) => arg === '-cp' || arg === '-classpath')) jvm.push('-cp', classpath)

        let gameArgs: string[]
        if (resolved.gameArgs.length > 0) {
          gameArgs = expandArguments(resolved.gameArgs, osContext, values)
        } else if (resolved.minecraftArguments) {
          gameArgs = resolved.minecraftArguments.split(/\s+/).filter(Boolean).map((token) => substitute(token, values))
        } else {
          gameArgs = ['--username', playerName, '--version', instance.versionId, '--gameDir', gameDir]
        }

        const finalArgs = [...jvm, resolved.mainClass, ...gameArgs]
        // 默认中文：options.txt 里没有 lang 时补一个（不覆盖玩家已选的语言）
        try {
          const optionsFile = path.join(gameDir, 'options.txt')
          if (!existsSync(optionsFile)) {
            writeFileSync(optionsFile, 'lang:zh_cn\n')
            log.info('launch', '已写入默认语言 zh_cn', { optionsFile })
          } else {
            const current = readFileSync(optionsFile, 'utf8')
            if (!/^lang:/m.test(current)) {
              writeFileSync(optionsFile, current + (current.endsWith('\n') ? '' : '\n') + 'lang:zh_cn\n')
              log.info('launch', 'options.txt 缺少语言项，已补 zh_cn', { optionsFile })
            } else if (/^lang:en_us\s*$/m.test(current)) {
              // 游戏首次启动默认是英文；中文用户直接改成简体中文（玩家手动选过其他语言则不动）
              writeFileSync(optionsFile, current.replace(/^lang:en_us\s*$/m, 'lang:zh_cn'))
              log.info('launch', '已把默认英文改为简体中文', { optionsFile })
            }
          }
        } catch (err) {
          log.warn('launch', '写入默认语言失败', { error: err instanceof Error ? err.message : String(err) })
        }

        const logDir = path.join(gameDir, 'logs')
        await ensureDir(logDir)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const gameLogFile = path.join(logDir, `game-${stamp}.log`)
        const rawStream = createWriteStream(gameLogFile, { flags: 'a' })

        log.info('launch', '启动游戏进程', {
          version: instance.versionId,
          java: javaInfo.path,
          javaMajor: javaInfo.major,
          memoryMb,
          classpathEntries: cp.length,
          args: finalArgs.length,
        })
        telemetry.record('launch:start', { versionId: instance.versionId, javaMajor: javaInfo.major, memoryMb })

        const child = spawn(javaInfo.path, finalArgs, {
          cwd: gameDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as unknown as ChildProcessWithoutNullStreams

        attachStream(child.stdout, rawStream, 'stdout')
        attachStream(child.stderr, rawStream, 'stderr')

        running = {
          child,
          instanceId,
          versionId: instance.versionId,
          startedAt: Date.now(),
          pid: child.pid ?? -1,
        }
        gameStateSink?.({ state: 'running', pid: running.pid, versionId: instance.versionId, instanceId })

        child.on('exit', (code, signal) => {
          const uptimeMs = Date.now() - (running?.startedAt ?? Date.now())
          const crashReport = findCrashReport(gameDir)
          const hint = (code !== null && EXIT_HINTS[code]) || (code === 0 ? '正常退出' : `退出码 ${code}`)
          log.info('launch', '游戏进程退出', { code, signal, uptimeMs, crashReport })
          telemetry.record('launch:exit', {
            versionId: instance.versionId,
            code,
            signal,
            uptimeMs,
            crash: Boolean(crashReport),
          })
          rawStream.end()
          running = null
          gameStateSink?.({
            state: 'exited',
            pid: undefined,
            versionId: instance.versionId,
            instanceId,
            exitCode: code,
            signal,
            uptimeMs,
            crashReport,
            hint,
          })
        })

        return {
          ok: true,
          pid: child.pid,
          versionId: instance.versionId,
          javaPath: javaInfo.path,
          playerName,
          accountType: microsoft ? 'microsoft' : 'offline',
          ms: Date.now() - startedAt,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('launch', '启动失败', { error: message })
        telemetry.record('launch:error', { error: message })
        return { ok: false, error: message }
      }
    }

    async function stop(): Promise<{ ok: boolean; forced?: boolean }> {
      if (!running) return { ok: true }
      const child = running.child
      const pid = running.pid
      child.kill()
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (!exited && process.platform === 'win32' && pid > 0) {
        const { execFile } = await import('node:child_process')
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
        return { ok: true, forced: true }
      }
      return { ok: true }
    }

    function attachStream(stream: NodeJS.ReadableStream, raw: ReturnType<typeof createWriteStream>, kind: 'stdout' | 'stderr'): void {
      let buffer = Buffer.alloc(0)
      let lineCount = 0
      let errorLines = 0
      stream.on('data', (chunk: Buffer) => {
        raw.write(chunk)
        buffer = Buffer.concat([buffer, chunk])
        let index = buffer.indexOf(0x0a)
        while (index >= 0) {
          const line = buffer.subarray(0, index)
          buffer = buffer.subarray(index + 1)
          lineCount += 1
          const text = decodeLine(line)
          if (/\b(ERROR|FATAL|Exception|Caused by)\b/.test(text) && errorLines < 200 && kind === 'stderr') {
            errorLines += 1
            log.warn('game', text.slice(0, 500))
          }
          index = buffer.indexOf(0x0a)
        }
        if (buffer.length > 64 * 1024) buffer = Buffer.alloc(0)
      })
      stream.on('end', () => {
        if (buffer.length > 0) {
          const text = decodeLine(buffer)
          if (text.trim()) log.debug('game', text.slice(0, 500))
        }
        log.debug('game', '进程输出结束', { kind, lines: lineCount })
      })
    }

    ctx.provide('launch', {
      start,
      stop,
      current: () => (running ? { pid: running.pid, instanceId: running.instanceId, versionId: running.versionId, startedAt: running.startedAt } : null),
      setGameStateSink: (next) => {
        gameStateSink = next
      },
      setProgressSink: (next) => {
        progressSink = next
      },
    } satisfies LaunchService)
    void progressSink
  })
}

const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
const gbk = new TextDecoder('gbk')

function decodeLine(line: Buffer): string {
  const cleaned = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line
  try {
    return utf8Fatal.decode(cleaned)
  } catch {
    return gbk.decode(cleaned)
  }
}
