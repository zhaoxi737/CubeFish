import type {
  AccountState,
  AccountSummary,
  AppInfo,
  ChatReply,
  DeviceCodeInfo,
  LoginStatus,
  ConflictReport,
  ContentInstallResult,
  ContentVersionInfo,
  CursePackInspectResult,
  CursePackInstallResult,
  PackInspect,
  Diagnosis,
  EntitlementItem,
  FixAction,
  FixResult,
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
  MarketListResult,
  ModpackInspectResult,
  ModpackInstallResult,
  NeoForgeInstallResult,
  PluginInfo,
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
    download(): Promise<UpdateState>
    apply(): Promise<{ ok: boolean; script?: string; error?: string }>
  }
  launch: {
    dryRun(instanceId?: string): Promise<LaunchDryRun>
    start(instanceId?: string): Promise<LaunchResult>
    stop(): Promise<{ ok: boolean; forced?: boolean }>
  }
  instances: {
    list(): Promise<InstanceSummary[]>
    create(name: string): Promise<InstanceSummary>
    remove(id: string): Promise<{ ok: boolean; error?: string }>
    activate(id: string): Promise<InstanceSummary>
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
    installModpack(source: string): Promise<ModpackInstallResult>
    inspectModpack(source: string): Promise<ModpackInspectResult>
    installCursePack(source: string): Promise<CursePackInstallResult>
    inspectCursePack(source: string): Promise<CursePackInspectResult>
    inspectPack(source: string): Promise<PackInspect>
    installPack(source: string): Promise<ModpackInstallResult & { kind?: 'curseforge' | 'modrinth'; resolved?: number; bundled?: number; overrides?: number }>
  }
  conflict: {
    analyze(instanceId?: string): Promise<ConflictReport>
  }
  diagnose: {
    run(instanceId?: string): Promise<Diagnosis>
    fixes(instanceId?: string): Promise<FixAction[]>
    applyFix(instanceId: string, fixId: string): Promise<FixResult>
  }
  loaders: {
    fabric(gameVersion: string): Promise<FabricInstallResult>
    neoforge(gameVersion: string): Promise<NeoForgeInstallResult>
    forge(gameVersion: string): Promise<NeoForgeInstallResult>
  }
  plugins: {
    list(): Promise<PluginInfo[]>
    setGranted(id: string, granted: boolean): Promise<PluginInfo>
    reload(id: string): Promise<PluginInfo>
  }
  market: {
    list(force?: boolean): Promise<MarketListResult>
    install(id: string): Promise<{ ok: boolean; pluginId?: string; error?: string }>
  }
  chat: {
    send(text: string): Promise<ChatReply>
    history(): Promise<{ role: 'user' | 'assistant'; text: string }[]>
    clear(): Promise<{ ok: boolean }>
    /** 订阅流式增量；返回取消订阅函数 */
    onDelta(callback: (text: string) => void): () => void
  }
  auth: {
    state(): Promise<AccountState>
    accounts(): Promise<AccountSummary[]>
    switchAccount(uuid: string): Promise<AccountState>
    removeAccount(uuid: string): Promise<AccountState>
    begin(): Promise<DeviceCodeInfo>
    complete(): Promise<LoginStatus>
    logout(): Promise<AccountState>
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
