import type {
  AppInfo,
  ChatReply,
  ConflictReport,
  ContentInstallResult,
  ContentVersionInfo,
  Diagnosis,
  EntitlementItem,
  EventSummary,
  FabricInstallResult,
  GameStateEvent,
  InstanceSummary,
  InstalledContent,
  InstallResult,
  JavaRuntimeInfo,
  LaunchDryRun,
  LaunchResult,
  LogRecord,
  SearchHit,
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
  content: {
    search(
      query: string,
      opts?: { type?: string; mcVersion?: string; loader?: string; limit?: number },
    ): Promise<SearchHit[]>
    versions(projectId: string, opts?: { mcVersion?: string; loader?: string }): Promise<ContentVersionInfo[]>
    install(instanceId: string, projectId: string, opts?: { mcVersion?: string; loader?: string }): Promise<ContentInstallResult>
    installed(instanceId: string): Promise<InstalledContent[]>
    toggle(instanceId: string, fileName: string): Promise<{ ok: boolean; enabled?: boolean; error?: string }>
    remove(instanceId: string, fileName: string): Promise<{ ok: boolean; error?: string }>
  }
  conflict: {
    analyze(instanceId?: string): Promise<ConflictReport>
  }
  diagnose: {
    run(instanceId?: string): Promise<Diagnosis>
  }
  loaders: {
    fabric(gameVersion: string): Promise<FabricInstallResult>
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
