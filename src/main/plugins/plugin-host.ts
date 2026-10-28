/**
 * 插件宿主（P5）：运行时加载 / 卸载第三方插件。
 *
 * 插件目录：<data>/plugins/<id>/  （plugin.json + index.mjs）
 * 权限：插件默认「未授权」，必须在界面或 CLI 显式启用后才会加载；
 *       启用的同时把插件注册的工具/命令挂到当前会话，禁用时全部撤回。
 *
 * 安全边界：当前实现是「主进程内加载 + 权限提示」，不是真正的沙箱。
 * 真正的沙箱（utilityProcess + RPC + fs/net 代理）列入 P5 待办。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginInfo, PluginManifest, PluginPermission } from '../../shared/types'
import { writeJsonAtomic, stripBom } from '../lib/fsx'
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

const API_VERSION = 1
const VALID_PERMISSIONS: PluginPermission[] = ['read', 'net', 'exec']

interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  tools: string[]
  commands: string[]
  disposer?: () => void | Promise<void>
  error?: string
}

interface GrantFile {
  [id: string]: { grantedAt: number; permissions: PluginPermission[] }
}

interface PluginRuntimeApi {
  version: string
  plugin: { id: string; version: string }
  permissions: PluginPermission[]
  log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  callTool(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }>
  registerTool(definition: Omit<ToolDefinition, 'source'>): void
  registerCommand(spec: CommandSpec): void
  storage: {
    get<T>(key: string, fallback?: T): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
  }
}

export interface PluginHostService {
  dir(): string
  list(): PluginInfo[]
  load(id: string): Promise<PluginInfo>
  unload(id: string): Promise<PluginInfo>
  reload(id: string): Promise<PluginInfo>
  setGranted(id: string, granted: boolean): Promise<PluginInfo>
  /** 等待启动时的自动加载全部结束（内核 boot 后调用） */
  init(): Promise<PluginInfo[]>
}

function parseManifest(raw: unknown): PluginManifest | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const data = raw as Record<string, unknown>
  const id = typeof data.id === 'string' ? data.id.trim() : ''
  const name = typeof data.name === 'string' ? data.name : id
  const version = typeof data.version === 'string' ? data.version : '0.0.0'
  const main = typeof data.main === 'string' ? data.main : 'index.mjs'
  const apiVersion = typeof data.apiVersion === 'number' ? data.apiVersion : API_VERSION
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
          const manifest = parseManifest(JSON.parse(readFileSync(manifestFile, 'utf8')))
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

    const readPluginData = (id: string): Record<string, unknown> => {
      return readSync<Record<string, unknown>>(path.join(dataDir, `${id}.json`), {})
    }

    const writePluginData = async (id: string, value: Record<string, unknown>): Promise<void> => {
      await writeJsonAtomic(path.join(dataDir, `${id}.json`), value)
    }

    const createApi = (manifest: PluginManifest, state: LoadedPlugin): PluginRuntimeApi => {
      const scope = `plugin:${manifest.id}`
      return {
        version: String(API_VERSION),
        plugin: { id: manifest.id, version: manifest.version },
        permissions: manifest.permissions,
        log: {
          info: (message) => log.info(scope, message),
          warn: (message) => log.warn(scope, message),
          error: (message) => log.error(scope, message),
        },
        callTool: (name, args) => tools.call(name, args ?? {}),
        registerTool: (definition) => {
          if (!definition?.name) throw new Error('registerTool 需要 name')
          tools.register({ ...definition, source: manifest.id })
          state.tools.push(definition.name)
        },
        registerCommand: (spec) => {
          if (!spec?.name) throw new Error('registerCommand 需要 name')
          chat.register(spec)
          state.commands.push(spec.name)
        },
        storage: {
          get: async <T,>(key: string, fallback?: T) => {
            const store = readPluginData(manifest.id)
            return (key in store ? (store[key] as T) : fallback) as T | undefined
          },
          set: async (key, value) => {
            const store = readPluginData(manifest.id)
            store[key] = value
            await writePluginData(manifest.id, store)
          },
        },
      }
    }

    const teardown = async (state: LoadedPlugin): Promise<void> => {
      for (const tool of state.tools) tools.unregister(tool)
      for (const command of state.commands) chat.unregister(command)
      if (state.disposer) {
        try {
          await state.disposer()
        } catch (err) {
          log.warn('plugin-host', '插件卸载回调失败', { id: state.manifest.id, error: String(err) })
        }
      }
      state.tools = []
      state.commands = []
      state.disposer = undefined
    }

    const load = async (id: string): Promise<PluginInfo> => {
      scan()
      const entry = manifests.get(id)
      if (!entry) throw new Error(`插件不存在: ${id}`)
      const existing = loaded.get(id)
      if (existing) return toInfo(existing)

      grants[id] = { grantedAt: Date.now(), permissions: entry.manifest.permissions }
      await persistGrants()

      const state: LoadedPlugin = {
        manifest: entry.manifest,
        dir: entry.dir,
        tools: [],
        commands: [],
      }
      loaded.set(id, state)

      try {
        const entryFile = path.join(entry.dir, entry.manifest.main)
        if (!existsSync(entryFile)) throw new Error(`入口文件不存在: ${entry.manifest.main}`)
        const module = (await import(`${pathToFileURL(entryFile).href}?t=${Date.now()}`)) as {
          apply?: (api: PluginRuntimeApi) => void | (() => void) | Promise<void | (() => void)>
          default?: (api: PluginRuntimeApi) => void | (() => void)
        }
        const apply = module.apply ?? module.default
        if (typeof apply !== 'function') throw new Error('插件必须导出 apply(api) 函数')
        const result = await apply(createApi(entry.manifest, state))
        if (typeof result === 'function') state.disposer = result as () => void
        telemetry.record('plugin:load', { id, tools: state.tools.length, commands: state.commands.length })
        log.info('plugin-host', '插件已加载', { id, tools: state.tools, commands: state.commands })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state.error = message
        await teardown(state)
        telemetry.record('plugin:error', { id, error: message })
        log.error('plugin-host', '插件加载失败', { id, error: message })
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

    ctx.provide('pluginHost', {
      dir: () => pluginsDir,
      list,
      load,
      unload,
      reload,
      setGranted,
      init: async () => {
        await ready
        scan()
        return list()
      },
    } satisfies PluginHostService)

    // 启动时自动加载已授权的插件。
    // 注意：load() 内部会 scan() 重建 manifests，所以必须先快照 id 再加载，
    // 否则在遍历 Map 的同时重建它会导致死循环。
    const loading: Promise<unknown>[] = []
    scan()
    const grantedIds = [...manifests.keys()].filter((id) => Boolean(grants[id]))
    for (const id of grantedIds) {
      loading.push(load(id).catch((err) => log.warn('plugin-host', '自动加载插件失败', { id, error: String(err) })))
    }
    const ready = Promise.all(loading).then(() => undefined)
    log.info('plugin-host', '插件宿主就绪', { dir: pluginsDir, plugins: manifests.size })
  })
}
