import type {
  AppInfo,
  ChatReply,
  EntitlementItem,
  EventSummary,
  InstanceSummary,
  LaunchDryRun,
  LogRecord,
  SettingsPatch,
  SettingsShape,
  UpdateState,
} from './types'

/** preload 暴露到 window.qdo 的 API 契约。 */
export interface QdoApi {
  info(): Promise<AppInfo>
  settings: {
    all(): Promise<SettingsShape>
    patch(patch: SettingsPatch): Promise<SettingsShape>
  }
  logs: {
    tail(limit?: number): Promise<LogRecord[]>
  }
  update: {
    check(): Promise<UpdateState>
  }
  launch: {
    dryRun(instanceId?: string): Promise<LaunchDryRun>
  }
  instances: {
    list(): Promise<InstanceSummary[]>
  }
  chat: {
    send(text: string): Promise<ChatReply>
  }
  entitlement: {
    list(): Promise<EntitlementItem[]>
  }
  events: {
    summary(): Promise<EventSummary>
  }
}
