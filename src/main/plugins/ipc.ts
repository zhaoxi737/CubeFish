import electron from 'electron'
import type { BrowserWindow } from 'electron'
import { CH, EVT } from '../../shared/channels'
import type {
  AppInfo,
  AppMeta,
  ChatReply,
  ConflictReport,
  ContentInstallResult,
  ContentVersionInfo,
  AccountState,
  DeviceCodeInfo,
  Diagnosis,
  EventSummary,
  LoginStatus,
  FabricInstallResult,
  FixAction,
  FixResult,
  InstanceSummary,
  InstalledContent,
  JavaRuntimeInfo,
  LaunchDryRun,
  LaunchResult,
  LogRecord,
  MarketListResult,
  PluginInfo,
  SearchHit,
  SettingsPatch,
  SettingsShape,
  TaskProgress,
  UpdateState,
  VersionList,
  InstallResult,
} from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { ChatService } from './chat'
import type { ConflictService } from './conflict'
import type { ContentService } from './content'
import type { DiagnoseService } from './diagnose'
import type { EntitlementService } from './entitlement'
import type { IdentityService } from './identity'
import type { InstancesService } from './instances'
import type { JavaService } from './java'
import type { LaunchService } from './launch'
import type { LoadersService } from './loaders'
import type { AuthService } from './auth'
import type { LogService } from './logger'
import type { MarketService } from './market'
import type { MojangService } from './mojang'
import type { PathsService } from './paths'
import type { PluginHostService } from './plugin-host'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'
import type { UpdaterService } from './updater'

const { ipcMain, app } = electron

export type WindowProvider = () => BrowserWindow | null

export interface IpcConfig {
  getWindow: WindowProvider
  summary: { plugins: string[]; failed: { name: string; error: string }[] }
}

export function createIpcPlugin(config: IpcConfig): LauncherPlugin<void> {
  return definePlugin('ipc', () => (ctx) => {
    const log = use<LogService>(ctx, 'log')
    const meta = use<AppMeta>(ctx, 'appMeta')
    const paths = use<PathsService>(ctx, 'paths')
    const settings = use<SettingsService>(ctx, 'settings')
    const identity = use<IdentityService>(ctx, 'identity')
    const updater = use<UpdaterService>(ctx, 'updater')
    const instances = use<InstancesService>(ctx, 'instances')
    const chat = use<ChatService>(ctx, 'chat')
    const entitlement = use<EntitlementService>(ctx, 'entitlement')
    const auth = use<AuthService>(ctx, 'auth')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')
    const mojang = use<MojangService>(ctx, 'mojang')
    const java = use<JavaService>(ctx, 'java')
    const launch = use<LaunchService>(ctx, 'launch')
    const loaders = use<LoadersService>(ctx, 'loaders')
    const content = use<ContentService>(ctx, 'content')
    const conflict = use<ConflictService>(ctx, 'conflict')
    const diagnose = use<DiagnoseService>(ctx, 'diagnose')
    const pluginHost = use<PluginHostService>(ctx, 'pluginHost')
    const market = use<MarketService>(ctx, 'market')

    const push = (channel: string, payload: unknown): void => {
      const win = config.getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }

    mojang.setProgressSink((progress: TaskProgress) => push(EVT.progress, progress))
    java.setProgressSink((progress: TaskProgress) => push(EVT.progress, progress))
    loaders.setProgressSink((progress: TaskProgress) => push(EVT.progress, progress))
    updater.setProgressSink((progress: TaskProgress) => push(EVT.progress, progress))
    launch.setGameStateSink((state) => push(EVT.gameState, state))

    const handle = <T>(channel: string, handler: (...args: any[]) => T | Promise<T>): void => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (_event, ...args: any[]) => {
        try {
          return await handler(...args)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error('ipc', '调用失败', { channel, error: message })
          throw new Error(message)
        }
      })
    }

    handle<AppInfo>(CH.appInfo, () => ({
      ...meta,
      installId: identity.installId,
      dataDir: paths.data,
      logsDir: paths.logs,
      plugins: [...config.summary.plugins],
      failedPlugins: [...config.summary.failed],
    }))
    handle<Readonly<SettingsShape>>(CH.settingsAll, () => settings.all())
    handle<SettingsShape>(CH.settingsPatch, (patch: SettingsPatch) => settings.patch(patch))
    handle<LogRecord[]>(CH.logsTail, (limit?: number) => log.tail(limit ?? 200))
    handle<UpdateState>(CH.updateCheck, () => updater.check('manual'))
    handle<UpdateState>(CH.updateDownload, () => updater.download())
    handle(CH.updateApply, async () => {
      const result = await updater.apply()
      if (result.ok) {
        setTimeout(() => app.quit(), 800)
      }
      return result
    })
    handle<LaunchDryRun>(CH.launchDryRun, (id?: string) => instances.dryRun(id))
    handle<InstanceSummary[]>(CH.instancesList, () => instances.list())
    handle<InstanceSummary>(CH.instancesCreate, (name: string) => instances.create(name))
    handle(CH.instancesRemove, (id: string) => instances.remove(id))
    handle<InstanceSummary>(CH.instancesActivate, (id: string) => instances.setActive(id))
    handle<ChatReply>(CH.chatSend, async (text: string) => {
      const win = config.getWindow()
      if (win && !win.isDestroyed()) {
        chat.setStreamSink((chunk) => {
          const target = config.getWindow()
          if (target && !target.isDestroyed()) target.webContents.send(CH.chatDelta, { text: chunk })
        })
      }
      try {
        return await chat.send(text)
      } finally {
        chat.setStreamSink(null)
      }
    })
    handle(CH.chatHistory, () => chat.history())
    handle(CH.chatClear, () => {
      chat.clearHistory()
      return { ok: true }
    })
    handle<AccountState>(CH.authState, () => auth.account())
    handle<DeviceCodeInfo>(CH.authBegin, () => auth.beginLogin())
    handle<LoginStatus>(CH.authComplete, () => auth.completeLogin())
    handle<AccountState>(CH.authLogout, () => auth.logout())
    handle(CH.entitlements, () => entitlement.list())
    handle<EventSummary>(CH.eventsSummary, () => telemetry.summary())

    handle<VersionList>(CH.versionsList, () => mojang.list('release'))
    handle<InstallResult>(CH.versionInstall, async (versionId: string) => {
      const result = await mojang.install(versionId, `install-${versionId}-${Date.now()}`)
      if (result.ok) {
        instances.setVersion(instances.active().id, versionId, versionId)
      }
      return result
    })
    handle<string[]>(CH.versionsInstalled, () => mojang.installed())
    handle<JavaRuntimeInfo[]>(CH.javaList, () => java.detect())
    handle<LaunchResult>(CH.launchStart, (instanceId?: string) => launch.start(instanceId ?? 'default'))
    handle(CH.launchStop, () => launch.stop())

    handle<SearchHit[]>(
      CH.contentSearch,
      (query: string, opts?: { type?: string; mcVersion?: string; loader?: string; limit?: number }) =>
        content.search(query, {
          type: opts?.type as never,
          mcVersion: opts?.mcVersion,
          loader: opts?.loader,
          limit: opts?.limit,
        }),
    )
    handle<ContentVersionInfo[]>(
      CH.contentVersions,
      (projectId: string, opts?: { mcVersion?: string; loader?: string }) => content.versions(projectId, opts),
    )
    handle<ContentInstallResult>(
      CH.contentInstall,
      (instanceId: string, projectId: string, opts?: { mcVersion?: string; loader?: string }) =>
        content.install(instanceId, projectId, opts),
    )
    handle<InstalledContent[]>(CH.contentInstalled, (instanceId: string) => content.installed(instanceId))
    handle(CH.contentToggle, (instanceId: string, fileName: string) => content.toggle(instanceId, fileName))
    handle(CH.contentRemove, (instanceId: string, fileName: string) => content.remove(instanceId, fileName))
    handle(CH.contentModpack, async (source: string) => {
      const looksLikeLocation = /^https?:\/\//i.test(source) || source.endsWith('.mrpack')
      return looksLikeLocation ? content.installModpack(source) : content.installModpackProject(source)
    })
    handle(CH.contentInspect, (source: string) => content.inspectModpack(source))
    handle<ConflictReport>(CH.conflictAnalyze, (instanceId?: string) => conflict.analyze(instanceId ?? 'default'))
    handle<Diagnosis>(CH.diagnoseRun, (instanceId?: string) => diagnose.run(instanceId ?? 'default'))
    handle<FixAction[]>(CH.diagnoseFixes, (instanceId?: string) => diagnose.fixes(instanceId ?? 'default'))
    handle<FixResult>(CH.diagnoseApplyFix, (instanceId: string, fixId: string) => diagnose.applyFix(instanceId, fixId))
    handle<PluginInfo[]>(CH.pluginsList, () => pluginHost.list())
    handle<PluginInfo>(CH.pluginsToggle, (id: string, granted: boolean) => pluginHost.setGranted(id, granted))
    handle<PluginInfo>(CH.pluginsReload, (id: string) => pluginHost.reload(id))
    handle<MarketListResult>(CH.marketList, (force?: boolean) => market.list(Boolean(force)))
    handle(CH.marketInstall, (id: string) => market.install(id))
    handle<FabricInstallResult>(CH.loaderFabric, async (gameVersion: string) => {
      const result = await loaders.installFabric(gameVersion)
      if (result.ok && result.versionId) {
        instances.setVersion(instances.active().id, result.versionId, gameVersion, gameVersion, 'fabric')
      }
      return result
    })

    handle(CH.loaderNeoForge, async (gameVersion: string) => {
      const result = await loaders.installNeoForge(gameVersion)
      if (result.ok && result.versionId) {
        instances.setVersion(instances.active().id, result.versionId, gameVersion, gameVersion, 'neoforge')
      }
      return result
    })

    handle(CH.loaderForge, async (gameVersion: string) => {
      const result = await loaders.installForge(gameVersion)
      if (result.ok && result.versionId) {
        instances.setVersion(instances.active().id, result.versionId, gameVersion, gameVersion, 'forge')
      }
      return result
    })

    log.info('ipc', 'IPC 通道已注册', { count: Object.keys(CH).length })
  })
}
