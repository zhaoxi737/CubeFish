/**
 * 插件宿主（P5 → P15 沙箱化）。
 *
 * 插件目录：<data>/plugins/<id>/  （plugin.json + index.mjs）
 * 权限：插件默认「未授权」，必须显式启用后才会加载；启用时把插件声明的工具/命令挂上，禁用时全部撤回。
 *
 * P15 起：插件代码在 **utilityProcess** 里执行，主进程只持有代理（proxy）工具/命令。
 *  - 插件崩溃/死循环不会拖死主进程，宿主会检测到 worker 退出并把状态标成错误；
 *  - 插件只能通过沙箱 API（log/storage/callTool/register*）与宿主交互，拿不到宿主对象；
 *  - 能力边界仍是「进程隔离 + 受限桥接」，不是 capability 级沙箱（插件进程内仍有 Node 能力）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import type { PluginInfo, PluginManifest, PluginPermission, PluginUiButton } from '../../shared/types'
import type { SandboxButtonDef, SandboxCommandDef, SandboxToolDef, SandboxWorkerMessage } from '../../shared/plugin-sandbox'
import { writeJsonAtomic, writeTextAtomic, stripBom } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { ChatService, CommandSpec } from './chat'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { TelemetryService } from './telemetry'
import type { ToolDefinition, ToolsService } from './tools'

function readSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(stripBom(readFileSync(file, 'utf8'))) as T
  } catch {
    return fallback
  }
}

const API_VERSION = 2
const VALID_PERMISSIONS: PluginPermission[] = ['read', 'net', 'exec']
const READY_TIMEOUT_MS = 20_000
const TOOL_TIMEOUT_MS = 120_000

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  tools: string[]
  commands: string[]
  buttons: SandboxButtonDef[]
  worker?: ChildProcess
  pid?: number
  pending: Map<number, PendingCall>
  nextCallId: number
  /** 主动卸载中（忽略 worker 退出告警） */
  disposing: boolean
  /** worker 初始化完成（收到 ready） */
  ready: boolean
  readyWait: Promise<void>
  readyResolve?: () => void
  error?: string
}

interface GrantFile {
  [id: string]: { grantedAt: number; permissions: PluginPermission[] }
}

export interface PluginHostService {
  dir(): string
  list(): PluginInfo[]
  load(id: string): Promise<PluginInfo>
  unload(id: string): Promise<PluginInfo>
  reload(id: string): Promise<PluginInfo>
  setGranted(id: string, granted: boolean): Promise<PluginInfo>
  /** P32：从源码安装/升级一个插件（AI 写插件 / 自升级用），加载失败自动回滚 */
  installFromSource(input: {
    id: string
    name?: string
    description?: string
    version?: string
    permissions?: PluginPermission[]
    code: string
  }): Promise<PluginInfo>
  /** P32：卸载并删除插件目录 */
  remove(id: string): Promise<{ ok: boolean; error?: string }>
  /** P34：所有插件注册的界面按钮 */
  buttons(): PluginUiButton[]
  /** P34：点击某个插件按钮（执行插件里的 run） */
  press(pluginId: string, buttonId: string): Promise<{ ok: boolean; summary: string }>
  /** 等待启动时的自动加载全部结束（内核 boot 后调用） */
  init(): Promise<PluginInfo[]>
  /** 应用退出前调用：把 worker 退出视为预期，避免误报崩溃 */
  beginShutdown(): void
}


/** fork 出来的子进程带 IPC；统一用一个宽松签名的封装，避免 unknown 类型噪音 */
function postToWorker(worker: ChildProcess | undefined, message: unknown): void {
  if (!worker) return
  ;(worker as unknown as { send(payload: unknown): boolean }).send(message)
}

function parseManifest(raw: unknown): PluginManifest | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const data = raw as Record<string, unknown>
  const id = typeof data.id === 'string' ? data.id.trim() : ''
  const name = typeof data.name === 'string' ? data.name : id
  const version = typeof data.version === 'string' ? data.version : '0.0.0'
  const main = typeof data.main === 'string' ? data.main : 'index.mjs'
  const apiVersion = typeof data.apiVersion === 'number' ? data.apiVersion : 1
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) return undefined
  if (apiVersion > API_VERSION) return undefined
  const permissions = Array.isArray(data.permissions)
    ? (data.permissions.filter((p): p is PluginPermission => VALID_PERMISSIONS.includes(p as PluginPermission)) as PluginPermission[])
    : []
  return {
    id,
    name,
    version,
    apiVersion,
    main,
    description: typeof data.description === 'string' ? data.description : undefined,
    author: typeof data.author === 'string' ? data.author : undefined,
    permissions,
  }
}

export function createPluginHostPlugin(): LauncherPlugin<void> {
  return definePlugin('plugin-host', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const tools = use<ToolsService>(ctx, 'tools')
    const chat = use<ChatService>(ctx, 'chat')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    const pluginsDir = path.join(paths.data, 'plugins')
    const grantFile = path.join(pluginsDir, 'permissions.json')
    const dataDir = path.join(paths.data, 'plugin-data')
    mkdirSync(pluginsDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    const workerPath = process.env.QDOQMC_PLUGIN_WORKER || path.join(process.cwd(), 'out', 'plugin-worker.mjs')

    let grants: GrantFile = readSync<GrantFile>(grantFile, {})
    const loaded = new Map<string, LoadedPlugin>()
    const manifests = new Map<string, { manifest: PluginManifest; dir: string }>()

    const persistGrants = async () => {
      await writeJsonAtomic(grantFile, grants)
    }

    const scan = (): void => {
      manifests.clear()
      for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(pluginsDir, entry.name)
        const manifestFile = path.join(dir, 'plugin.json')
        if (!existsSync(manifestFile)) continue
        try {
          const manifest = parseManifest(JSON.parse(stripBom(readFileSync(manifestFile, 'utf8'))))
          if (!manifest) {
            log.warn('plugin-host', '插件清单不合法', { dir: entry.name })
            continue
          }
          manifests.set(manifest.id, { manifest, dir })
        } catch (err) {
          log.warn('plugin-host', '插件清单解析失败', { dir: entry.name, error: String(err) })
        }
      }
    }

    const readPluginData = (id: string): Record<string, unknown> => readSync<Record<string, unknown>>(path.join(dataDir, `${id}.json`), {})

    const writePluginData = async (id: string, value: Record<string, unknown>): Promise<void> => {
      await writeJsonAtomic(path.join(dataDir, `${id}.json`), value)
    }

    const send = (state: LoadedPlugin, message: unknown): void => {
      try {
        postToWorker(state.worker, message)
      } catch (err) {
        log.warn('plugin-host', '向沙箱发送消息失败', { id: state.manifest.id, error: String(err) })
      }
    }

    const hostResponse = (state: LoadedPlugin, callId: number, ok: boolean, result?: unknown, error?: string): void => {
      send(state, { type: 'response', callId, ok, result, error })
    }

    const invoke = <T,>(state: LoadedPlugin, kind: 'invoke-tool' | 'invoke-command' | 'invoke-button', name: string, payload: unknown): Promise<T> => {
      if (!state.worker) return Promise.reject(new Error('插件沙箱未运行'))
      const callId = state.nextCallId++
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pending.delete(callId)
          reject(new Error(`插件执行超时（${kind === 'invoke-tool' ? '工具' : kind === 'invoke-button' ? '按钮' : '命令'} ${name}）`))
        }, TOOL_TIMEOUT_MS)
        state.pending.set(callId, { resolve: resolve as (value: unknown) => void, reject, timer })
        if (kind === 'invoke-tool') {
          send(state, { type: 'invoke-tool', callId, name, args: payload as Record<string, unknown> })
        } else if (kind === 'invoke-button') {
          send(state, { type: 'invoke-button', callId, name })
        } else {
          send(state, { type: 'invoke-command', callId, name, args: payload as string[] })
        }
      })
    }

    const handleWorkerMessage = async (state: LoadedPlugin, message: SandboxWorkerMessage): Promise<void> => {
      const id = state.manifest.id
      if (message.type === 'log') {
        const fn = message.level === 'error' ? log.error : message.level === 'warn' ? log.warn : log.info
        fn(`plugin:${id}`, message.message)
        return
      }
      if (message.type === 'error') {
        state.error = message.message
        state.readyResolve?.()
        log.error('plugin-host', '插件初始化失败', { id, error: message.message })
        return
      }
      if (message.type === 'result') {
        const entry = state.pending.get(message.callId)
        if (!entry) return
        state.pending.delete(message.callId)
        clearTimeout(entry.timer)
        if (message.ok) entry.resolve(message.result)
        else entry.reject(new Error(message.error ?? '插件执行失败'))
        return
      }
      if (message.type === 'request') {
        try {
          if (message.method === 'storage.get') {
            const key = String((message.params as { key?: string } | undefined)?.key ?? '')
            const store = readPluginData(id)
            hostResponse(state, message.callId, true, key in store ? store[key] : undefined)
            return
          }
          if (message.method === 'storage.set') {
            const params = (message.params ?? {}) as { key?: string; value?: unknown }
            const store = readPluginData(id)
            store[String(params.key ?? '')] = params.value
            await writePluginData(id, store)
            hostResponse(state, message.callId, true, null)
            return
          }
          if (message.method === 'tools.call') {
            const params = (message.params ?? {}) as { name?: string; args?: Record<string, unknown> }
            const result = await tools.call(String(params.name ?? ''), params.args ?? {})
            hostResponse(state, message.callId, true, result)
            return
          }
          if (message.method === 'net.fetch') {
            const params = (message.params ?? {}) as {
              url?: string
              options?: { method?: string; headers?: Record<string, string>; body?: string }
            }
            const url = String(params.url ?? '')
            if (!/^https:\/\//i.test(url)) {
              hostResponse(state, message.callId, false, undefined, '插件联网只允许 https 链接')
              return
            }
            const res = await fetch(url, {
              method: params.options?.method ?? 'GET',
              headers: { 'user-agent': `QDOQMC-plugin/${id}`, ...(params.options?.headers ?? {}) },
              body: params.options?.body,
              signal: AbortSignal.timeout(20_000),
            })
            const text = await res.text()
            hostResponse(state, message.callId, true, { ok: res.ok, status: res.status, text: text.slice(0, 200_000) })
            return
          }
          hostResponse(state, message.callId, false, undefined, `未知的沙箱请求：${message.method}`)
        } catch (err) {
          hostResponse(state, message.callId, false, undefined, err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (message.type === 'ready') {
        state.ready = true
        state.readyResolve?.()
        for (const tool of message.tools) registerProxyTool(state, tool)
        for (const command of message.commands) registerProxyCommand(state, command)
        state.buttons = message.buttons ?? []
        telemetry.record('plugin:load', { id, tools: state.tools.length, commands: state.commands.length, sandbox: true })
        log.info('plugin-host', '插件已加载（沙箱）', {
          id,
          pid: state.pid,
          tools: state.tools,
          commands: state.commands,
        })
        return
      }
      if (message.type === 'disposed') {
        log.info('plugin-host', '插件沙箱已退出', { id })
      }
    }

    const registerProxyTool = (state: LoadedPlugin, definition: SandboxToolDef): void => {
      const id = state.manifest.id
      tools.register({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        source: id,
        handler: async (args) => {
          const result = await invoke<{ ok: boolean; summary: string; data?: unknown }>(state, 'invoke-tool', definition.name, args ?? {})
          return result
        },
      })
      state.tools.push(definition.name)
    }

    const registerProxyCommand = (state: LoadedPlugin, spec: SandboxCommandDef): void => {
      const id = state.manifest.id
      const command: CommandSpec = {
        name: spec.name,
        description: spec.description,
        run: async (args) => {
          const text = await invoke<string>(state, 'invoke-command', spec.name, args)
          return text
        },
      }
      chat.register(command)
      state.commands.push(spec.name)
      log.info('plugin-host', '插件命令已注册', { id, command: spec.name })
    }

    const teardown = async (state: LoadedPlugin): Promise<void> => {
      for (const tool of state.tools) tools.unregister(tool)
      for (const command of state.commands) chat.unregister(command)
      state.tools = []
      state.commands = []
      state.disposing = true
      for (const pending of state.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('插件已卸载'))
      }
      state.pending.clear()
      const worker = state.worker
      state.worker = undefined
      if (!worker) return
      try {
        postToWorker(worker, { type: 'dispose' })
      } catch {
        /* 忽略 */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            worker.kill('SIGKILL')
          } catch {
            /* 忽略 */
          }
          resolve()
        }, 1500)
        worker.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }

    const load = async (id: string): Promise<PluginInfo> => {
      scan()
      const entry = manifests.get(id)
      if (!entry) throw new Error(`插件不存在: ${id}`)
      const existing = loaded.get(id)
      if (existing) return toInfo(existing)

      if (!existsSync(workerPath)) {
        throw new Error(`插件沙箱入口不存在：${workerPath}（先 npm run build）`)
      }
      const entryFile = path.join(entry.dir, entry.manifest.main)
      if (!existsSync(entryFile)) throw new Error(`入口文件不存在: ${entry.manifest.main}`)

      grants[id] = { grantedAt: Date.now(), permissions: entry.manifest.permissions }
      await persistGrants()

      const state: LoadedPlugin = {
        manifest: entry.manifest,
        dir: entry.dir,
        tools: [],
        commands: [],
        buttons: [],
        pending: new Map(),
        nextCallId: 1,
        disposing: false,
        ready: false,
        readyWait: Promise.resolve(),
      }
      state.readyWait = new Promise<void>((resolve) => {
        state.readyResolve = resolve
      })
      loaded.set(id, state)

      // 能力沙箱：worker 以 Node 身份启动（ELECTRON_RUN_AS_NODE），开启 permission model，
      // 只允许读插件自己的目录，禁止写盘、禁止 child_process/worker_threads。
      const child = fork(workerPath, [entry.dir, entry.manifest.main], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: ['--permission', `--allow-fs-read=${entry.dir}`, `--allow-fs-read=${path.dirname(workerPath)}`],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      state.worker = child
      state.pid = child.pid
      child.on('spawn', () => {
        state.pid = child.pid
        log.info('plugin-host', '插件沙箱进程已启动', { id, pid: state.pid })
      })
      child.stdout?.on('data', (chunk: Buffer) => log.info(`plugin:${id}`, chunk.toString('utf8').trim()))
      child.stderr?.on('data', (chunk: Buffer) => log.warn(`plugin:${id}`, chunk.toString('utf8').trim()))
      child.on('message', (message: SandboxWorkerMessage) => {
        void handleWorkerMessage(state, message)
      })
      child.on('exit', (code) => {
        if (state.disposing) return
        for (const pending of state.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`插件进程已退出（code ${code}），已隔离`))
        }
        state.pending.clear()
        // 退出码 0 且不是主动卸载：通常发生在启动器自身退出/CLI 结束时，不算插件崩溃
        // 0xFFFFFFFF / -1：进程被系统或任务管理器强杀，同样视为正常退出，不报崩溃
        if (code === 0 || code === -1 || code === 4294967295) {
          log.info('plugin-host', '插件沙箱已退出', { id, code })
          state.worker = undefined
          return
        }
        const message = `插件进程异常退出（code ${code}），已隔离，不影响启动器`
        state.error = message
        log.error('plugin-host', '插件沙箱退出', { id, code })
        telemetry.record('plugin:crash', { id, code })
        for (const tool of state.tools) tools.unregister(tool)
        for (const command of state.commands) chat.unregister(command)
        state.tools = []
        state.commands = []
        state.worker = undefined
      })

      postToWorker(child, {
        type: 'init',
        apiVersion: API_VERSION,
        plugin: { id, version: entry.manifest.version },
        permissions: entry.manifest.permissions,
        entry: pathToFileURL(entryFile).href,
      })

      const readyTimer = setTimeout(() => {
        if (!state.ready && !state.error) state.error = '插件初始化超时（20 秒）'
        state.readyResolve?.()
      }, READY_TIMEOUT_MS)
      await state.readyWait
      clearTimeout(readyTimer)

      if (state.error) {
        await teardown(state)
        loaded.delete(id)
        delete grants[id]
        await persistGrants()
      }
      return toInfo(state)
    }

    const unload = async (id: string): Promise<PluginInfo> => {
      const state = loaded.get(id)
      if (!state) {
        const entry = manifests.get(id)
        if (!entry) throw new Error(`插件不存在: ${id}`)
        return { ...infoOf(entry.manifest, entry.dir), granted: Boolean(grants[id]), loaded: false }
      }
      await teardown(state)
      loaded.delete(id)
      delete grants[id]
      await persistGrants()
      telemetry.record('plugin:unload', { id })
      log.info('plugin-host', '插件已卸载', { id })
      return { ...infoOf(state.manifest, state.dir), granted: false, loaded: false }
    }

    const toInfo = (state: LoadedPlugin): PluginInfo => ({
      ...infoOf(state.manifest, state.dir),
      granted: true,
      loaded: Boolean(state.error) === false,
      error: state.error,
      tools: [...state.tools],
      commands: [...state.commands],
      sandbox: true,
      workerPid: state.pid,
    })

    const infoOf = (manifest: PluginManifest, dir: string): PluginInfo => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      apiVersion: manifest.apiVersion,
      permissions: manifest.permissions,
      granted: Boolean(grants[manifest.id]),
      loaded: false,
      dir,
      tools: [],
      commands: [],
      sandbox: true,
    })

    const list = (): PluginInfo[] => {
      scan()
      const items: PluginInfo[] = []
      for (const [id, entry] of manifests) {
        const state = loaded.get(id)
        items.push(state ? toInfo(state) : infoOf(entry.manifest, entry.dir))
      }
      return items.sort((a, b) => a.id.localeCompare(b.id))
    }

    const reload = async (id: string): Promise<PluginInfo> => {
      if (loaded.has(id)) await unload(id)
      return load(id)
    }

    const setGranted = async (id: string, granted: boolean): Promise<PluginInfo> => {
      if (granted) return load(id)
      return unload(id)
    }

    /** P32：从源码安装/升级插件。校验 id / 代码体积 → 写 plugin.json + index.mjs → 加载，失败回滚。 */
    const installFromSource = async (input: {
      id: string
      name?: string
      description?: string
      version?: string
      permissions?: PluginPermission[]
      code: string
    }): Promise<PluginInfo> => {
      const id = String(input.id ?? '').trim()
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`插件 id 不合法（小写字母/数字/._- 开头）: ${id}`)
      const code = String(input.code ?? '').trim()
      if (!code) throw new Error('插件代码不能为空')
      if (code.length > 64 * 1024) throw new Error(`插件代码超过 64KB 上限（当前 ${code.length} 字节）`)
      const permissions = (input.permissions ?? []).filter((p): p is PluginPermission => VALID_PERMISSIONS.includes(p as PluginPermission))

      const dir = path.join(pluginsDir, id)
      const manifest: PluginManifest = {
        id,
        name: (input.name ?? '').trim() || id,
        version: (input.version ?? '').trim() || '1.0.0',
        apiVersion: 1,
        main: 'index.mjs',
        description: input.description?.trim(),
        author: 'AI',
        permissions,
      }

      // 已加载 → 先卸载（= 自升级覆盖）
      if (loaded.has(id)) await unload(id)
      mkdirSync(dir, { recursive: true })
      await writeJsonAtomic(path.join(dir, 'plugin.json'), manifest)
      await writeTextAtomic(path.join(dir, 'index.mjs'), `${code}\n`)

      try {
        const info = await load(id)
        telemetry.record('plugin:ai-install', { id, tools: info.tools.length, commands: info.commands.length })
        log.info('plugin-host', 'AI 已安装/升级插件', { id, tools: info.tools, commands: info.commands })
        return info
      } catch (err) {
        // 回滚：删掉刚写的目录，别留一个加载不起来的插件
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        scan()
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`插件安装失败（已回滚）：${message}`)
      }
    }

    const remove = async (id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) return { ok: false, error: `插件 id 不合法: ${id}` }
        if (loaded.has(id)) await unload(id)
        const dir = path.join(pluginsDir, id)
        if (existsSync(dir)) await rm(dir, { recursive: true, force: true })
        delete grants[id]
        await persistGrants()
        scan()
        telemetry.record('plugin:remove', { id })
        log.info('plugin-host', '插件已删除', { id })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    /** P34：汇总所有已加载插件注册的界面按钮 */
    const buttonsList = (): PluginUiButton[] => {
      const items: PluginUiButton[] = []
      for (const state of loaded.values()) {
        for (const def of state.buttons) {
          items.push({
            pluginId: state.manifest.id,
            pluginName: state.manifest.name,
            id: def.id,
            label: def.label,
            description: def.description,
          })
        }
      }
      return items.sort((a, b) => a.label.localeCompare(b.label))
    }

    /** P34：按下某个插件按钮（执行插件 worker 里的 run） */
    const press = async (pluginId: string, buttonId: string): Promise<{ ok: boolean; summary: string }> => {
      const state = loaded.get(pluginId)
      if (!state) return { ok: false, summary: `插件未加载：${pluginId}` }
      if (!state.buttons.some((button) => button.id === buttonId)) {
        return { ok: false, summary: `插件没有这个按钮：${buttonId}` }
      }
      try {
        const text = await invoke<string>(state, 'invoke-button', buttonId, {})
        return { ok: true, summary: String(text ?? '') }
      } catch (err) {
        return { ok: false, summary: err instanceof Error ? err.message : String(err) }
      }
    }

    ctx.provide('pluginHost', {
      dir: () => pluginsDir,
      list,
      buttons: buttonsList,
      press,
      load,
      unload,
      reload,
      setGranted,
      installFromSource,
      remove,
      init: async () => {
        await ready
        scan()
        return list()
      },
      beginShutdown: () => {
        for (const state of loaded.values()) state.disposing = true
      },
    } satisfies PluginHostService)

    // 启动时自动加载已授权的插件。
    // 注意：load() 内部会 scan() 重建 manifests，所以必须先快照 id 再加载。
    const loading: Promise<unknown>[] = []
    scan()
    // P35：清掉已删除插件的残留授权（否则每次启动都会尝试加载不存在的目录并报错）
    const staleGrants = Object.keys(grants).filter((id) => !manifests.has(id))
    if (staleGrants.length > 0) {
      for (const id of staleGrants) delete grants[id]
      void persistGrants()
      log.info('plugin-host', '已清理失效的插件授权', { ids: staleGrants })
    }
    const grantedIds = [...manifests.keys()].filter((id) => Boolean(grants[id]))
    for (const id of grantedIds) {
      loading.push(load(id).catch((err) => log.warn('plugin-host', '自动加载插件失败', { id, error: String(err) })))
    }
    const ready = Promise.all(loading).then(() => undefined)
    log.info('plugin-host', '插件宿主就绪（沙箱模式）', { dir: pluginsDir, plugins: manifests.size, worker: workerPath })
  })
}

function pathToFileUrl(file: string): string {
  return `file:///${file.replace(/\\/g, '/').replace(/^\/+/, '')}`
}
