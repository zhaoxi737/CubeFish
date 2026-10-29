import electron from 'electron'
import { dialog, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { CH, EVT } from '../../shared/channels'
import type {
  AppInfo,
  AppMeta,
  ChatReply,
  ConflictReport,
  ContentInstallResult,
  ContentPreview,
  ContentUpdate,
  ContentVersionInfo,
  CursePackInspectResult,
  CursePackInstallResult,
  CurseForgeTestResult,
  PackInspect,
  AccountState,
  AccountSummary,
  DeviceCodeInfo,
  Diagnosis,
  EventSummary,
  LoginStatus,
  FabricInstallResult,
  FixAction,
  FixResult,
  InstanceSummary,
  InstalledContent,
  InstallerRunRequest,
  InstallerRunResult,
  JavaRuntimeInfo,
  LaunchDryRun,
  LaunchResult,
  LoaderAvailability,
  LogRecord,
  MarketListResult,
  PluginInfo,
  PluginUiButton,
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
import type { ContentKind, ContentService } from './content'
import type { DiagnoseService } from './diagnose'
import type { EntitlementService } from './entitlement'
import type { GpuService } from './gpu'
import type { IdentityService } from './identity'
import type { InstancesService } from './instances'
import type { InstallerService } from './installer'
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
    const gpu = use<GpuService>(ctx, 'gpu')
    const loaders = use<LoadersService>(ctx, 'loaders')
    const installer = use<InstallerService>(ctx, 'installer')
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
    content.setProgressSink((progress: TaskProgress) => push(EVT.progress, progress))
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
    handle<SettingsShape>(CH.settingsPatch, (patch: SettingsPatch) => {
      const result = settings.patch(patch)
      // P31：切换 isolatedMods 时重建所有实例的内容 junction
      if (patch.isolatedMods !== undefined) instances.rebindContentDirs()
      return result
    })
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
    handle(CH.instancesExport, (id?: string, dest?: string) => instances.exportInstance(id, dest))
    handle<InstanceSummary>(CH.instancesRename, (id: string, name: string) => instances.rename(id, name))
    handle<{ ok: boolean }>(CH.instancesSetMemory, (id: string, memoryMb: number) => {
      instances.setMemory(id, memoryMb)
      return { ok: true }
    })
    handle(CH.instancesFolders, (id: string) => instances.folders(id))
    handle(CH.instancesOpenFolder, async (id: string, kind: 'root' | 'game' | 'mods' | 'logs') => {
      const folders = instances.folders(id)
      const target = folders[kind] ?? folders.game
      if (!existsSync(target)) return { ok: false, error: `目录不存在：${target}` }
      const error = await electron.shell.openPath(target)
      return error ? { ok: false, path: target, error } : { ok: true, path: target }
    })
    handle<InstanceSummary>(CH.instancesAccount, (id: string, accountId?: string, accountName?: string) => {
      instances.setAccount(id, accountId, accountName)
      return instances.get(id) ?? instances.active()
    })
    handle(CH.instancesImport, (zipPath: string, name?: string) => instances.importInstance(zipPath, { name }))
    handle<ChatReply>(CH.chatSend, async (text: string, opts?: { replaceLast?: boolean }) => {
      const win = config.getWindow()
      if (win && !win.isDestroyed()) {
        chat.setStreamSink((chunk) => {
          const target = config.getWindow()
          if (target && !target.isDestroyed()) target.webContents.send(CH.chatDelta, { text: chunk })
        })
        chat.setProgressSink((event) => {
          const target = config.getWindow()
          if (target && !target.isDestroyed()) target.webContents.send(EVT.chatProgress, event)
        })
      }
      try {
        return await chat.send(text, opts)
      } finally {
        chat.setStreamSink(null)
        chat.setProgressSink(null)
      }
    })
    handle(CH.chatAbort, () => {
      chat.abort()
      return { ok: true }
    })
    handle(CH.chatSessions, () => ({ active: chat.activeSession(), sessions: chat.sessions() }))
    handle(CH.chatNewSession, () => chat.newSession())
    handle(CH.chatSwitchSession, (id: string) => ({ ok: chat.switchSession(id) }))
    handle(CH.chatDeleteSession, (id: string) => ({ ok: chat.deleteSession(id) }))
    handle(CH.chatHistory, () => chat.history())
    handle(CH.chatClear, () => {
      chat.clearHistory()
      return { ok: true }
    })
    handle(CH.dialogPickFile, async (kind?: 'pack' | 'zip' | 'image' | 'java') => {
      // 自动化测试钩子：设置 QDOQMC_PICK_FILE 时跳过原生对话框
      const override = process.env.QDOQMC_PICK_FILE
      if (override) return override
      const win = config.getWindow()
      if (!win) return null
      const filters =
        kind === 'zip'
          ? [{ name: '导出包', extensions: ['zip'] }]
          : kind === 'image'
            ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
            : kind === 'java'
              ? [{ name: 'Java 可执行文件', extensions: ['exe'] }]
              : [{ name: '整合包', extensions: ['zip', 'mrpack'] }]
      const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })
    handle(CH.dialogPickSave, async (defaultName: string) => {
      const override = process.env.QDOQMC_SAVE_FILE
      if (override) return override
      const win = config.getWindow()
      if (!win) return null
      const result = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'Zip', extensions: ['zip'] }] })
      return result.canceled || !result.filePath ? null : result.filePath
    })
    handle<AccountState>(CH.authState, () => auth.account())
    handle<DeviceCodeInfo>(CH.authBegin, () => auth.beginLogin())
    handle<LoginStatus>(CH.authComplete, () => auth.completeLogin())
    handle<AccountState>(CH.authLogout, () => auth.logout())
    handle<AccountSummary[]>(CH.authAccounts, () => auth.accounts())
    handle<AccountState>(CH.authSwitch, (uuid: string) => auth.switchAccount(uuid))
    handle<AccountState>(CH.authRemove, (uuid: string) => auth.removeAccount(uuid))
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
    handle<{ ok: boolean; cancelled: boolean }>(CH.versionCancel, () => mojang.cancel())
    handle<{ ok: boolean; bytes?: number; error?: string }>(CH.versionRemove, (versionId: string) => mojang.remove(versionId))
    handle<JavaRuntimeInfo[]>(CH.javaList, () => java.detect())
    handle<JavaRuntimeInfo>(CH.javaAddManual, (exePath: string) => java.addManual(exePath))
    handle<{ ok: boolean }>(CH.javaSetPreferred, (exePath: string) => {
      java.setPreferred(exePath)
      return { ok: true }
    })
    handle<JavaRuntimeInfo>(CH.javaInstallRuntime, (major: number) => java.installRuntime(major))
    handle<{ ok: boolean; applied: number; message?: string }>(CH.gpuSet, (enabled: boolean) => gpu.setEnabled(enabled))
    handle<{ enabled: boolean; entries: number }>(CH.gpuStatus, () => gpu.status())
    handle<LaunchResult>(CH.launchStart, (instanceId?: string) => launch.start(instanceId ?? 'default'))
    handle(CH.launchStop, () => launch.stop())

    handle<SearchHit[]>(
      CH.contentSearch,
      (
        query: string,
        opts?: {
          type?: string
          mcVersion?: string
          loader?: string
          limit?: number
          offset?: number
          source?: 'modrinth' | 'curseforge' | 'all'
        },
      ) =>
        content.search(query, {
          type: opts?.type as never,
          mcVersion: opts?.mcVersion,
          loader: opts?.loader,
          limit: opts?.limit,
          offset: opts?.offset,
          source: opts?.source,
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
    handle(CH.contentCursePack, (source: string) => content.installCursePack(source))
    handle(CH.contentInspectCurse, (source: string) => content.inspectCursePack(source))
    handle(CH.contentInspectPack, (source: string) => content.inspectPack(source))
    handle(CH.contentInstallPack, (source: string) => content.installPack(source))
    // P29：模组更新检查 / 单个更新 / 图片画廊预览
    handle<ContentUpdate[]>(CH.contentUpdates, (instanceId: string) => content.updates(instanceId))
    handle(CH.contentUpdate, (instanceId: string, fileName: string) => content.update(instanceId, fileName))
    handle<ContentPreview>(CH.contentPreview, (projectId: string, kind: ContentKind) =>
      content.preview(projectId, kind),
    )
    // P30：CurseForge Key 连通性测试
    handle<CurseForgeTestResult>(CH.contentTestCf, () => content.testCurseForge())
    handle<ConflictReport>(CH.conflictAnalyze, (instanceId?: string) => conflict.analyze(instanceId ?? 'default'))
    handle<Diagnosis>(CH.diagnoseRun, (instanceId?: string) => diagnose.run(instanceId ?? 'default'))
    handle<FixAction[]>(CH.diagnoseFixes, (instanceId?: string) => diagnose.fixes(instanceId ?? 'default'))
    handle<FixResult>(CH.diagnoseApplyFix, (instanceId: string, fixId: string) => diagnose.applyFix(instanceId, fixId))
    handle(CH.diagGameLog, (instanceId?: string, lines?: number) => diagnose.gameLog(instanceId ?? 'default', lines ?? 300))
    handle<PluginInfo[]>(CH.pluginsList, () => pluginHost.list())
    handle<PluginInfo>(CH.pluginsToggle, (id: string, granted: boolean) => pluginHost.setGranted(id, granted))
    handle<PluginInfo>(CH.pluginsReload, (id: string) => pluginHost.reload(id))
    handle<PluginUiButton[]>(CH.pluginsButtons, () => pluginHost.buttons())
    handle<{ ok: boolean; summary: string }>(CH.pluginsPress, (pluginId: string, buttonId: string) =>
      pluginHost.press(pluginId, buttonId),
    )
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

    handle<LoaderAvailability>(CH.loaderAvailable, (gameVersion: string) => loaders.available(gameVersion))
    handle<InstallerRunResult>(CH.installerRun, (req: InstallerRunRequest) => installer.run(req))

    log.info('ipc', 'IPC 通道已注册', { count: Object.keys(CH).length })
  })
}
