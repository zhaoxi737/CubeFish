import electron from 'electron'
import type { BrowserWindow } from 'electron'
import { CH } from '../../shared/channels'
import type {
  AppInfo,
  AppMeta,
  ChatReply,
  EventSummary,
  InstanceSummary,
  LaunchDryRun,
  LogRecord,
  SettingsPatch,
  SettingsShape,
  UpdateState,
} from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { ChatService } from './chat'
import type { EntitlementService } from './entitlement'
import type { IdentityService } from './identity'
import type { InstancesService } from './instances'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'
import type { UpdaterService } from './updater'

const { ipcMain } = electron

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
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

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
    handle<LaunchDryRun>(CH.launchDryRun, (id?: string) => instances.dryRun(id))
    handle<InstanceSummary[]>(CH.instancesList, () => instances.list())
    handle<ChatReply>(CH.chatSend, (text: string) => chat.send(text))
    handle(CH.entitlements, () => entitlement.list())
    handle<EventSummary>(CH.eventsSummary, () => telemetry.summary())

    log.info('ipc', 'IPC 通道已注册', { count: Object.keys(CH).length })
    void config.getWindow
  })
}
