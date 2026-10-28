import type {
  AppInfo,
  ChatReply,
  EntitlementItem,
  EventSummary,
  GameStateEvent,
  InstanceSummary,
  InstallResult,
  JavaRuntimeInfo,
  LaunchDryRun,
  LaunchResult,
  LogRecord,
  SettingsPatch,
  SettingsShape,
  TaskProgress,
  UpdateState,
  VersionList,
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
    start(instanceId?: string): Promise<LaunchResult>
    stop(): Promise<{ ok: boolean; forced?: boolean }>
  }
  instances: {
    list(): Promise<InstanceSummary[]>
  }
  versions: {
    list(): Promise<VersionList>
    install(versionId: string): Promise<InstallResult>
    installed(): Promise<string[]>
  }
  java: {
    list(): Promise<JavaRuntimeInfo[]>
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
  /** 安装/下载进度推送；返回取消订阅函数 */
  onProgress(listener: (progress: TaskProgress) => void): () => void
  /** 游戏进程状态推送；返回取消订阅函数 */
  onGameState(listener: (state: GameStateEvent) => void): () => void
}
