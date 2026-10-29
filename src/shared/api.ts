import type {
  AccountState,
  AccountSummary,
  AppInfo,
  ChatReply,
  DeviceCodeInfo,
  LoginStatus,
  ConflictReport,
  ContentInstallResult,
  ContentPreview,
  ContentUpdate,
  ContentVersionInfo,
  CursePackInspectResult,
  CursePackInstallResult,
  CurseForgeTestResult,
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
  InstallerRunRequest,
  InstallerRunResult,
  JavaRuntimeInfo,
  LaunchDryRun,
  LaunchResult,
  LoaderAvailability,
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
    export(id?: string, dest?: string): Promise<{ ok: boolean; path?: string; bytes?: number; files?: number; error?: string }>
    /** 绑定/解绑实例账号（accountId 为空 = 跟随全局账号） */
    bindAccount(id: string, accountId?: string, accountName?: string): Promise<InstanceSummary>
    rename(id: string, name: string): Promise<InstanceSummary>
    /** P31：单独设置实例内存（MB） */
    setMemory(id: string, memoryMb: number): Promise<{ ok: boolean }>
    folders(id: string): Promise<{ root: string; game: string; mods: string; logs: string; versions: string }>
    /** 在资源管理器中打开实例的某个目录 */
    openFolder(id: string, kind: 'root' | 'game' | 'mods' | 'logs'): Promise<{ ok: boolean; path?: string; error?: string }>
    import(zipPath: string, name?: string): Promise<{ ok: boolean; instance?: InstanceSummary; error?: string }>
  }
  versions: {
    list(): Promise<VersionList>
    install(versionId: string): Promise<InstallResult>
    installed(): Promise<string[]>
    /** P28：取消当前安装任务（中止下载并清理 .part） */
    cancel(): Promise<{ ok: boolean; cancelled: boolean }>
    /** P30：卸载一个已安装的游戏/加载器版本（释放磁盘） */
    remove(versionId: string): Promise<{ ok: boolean; bytes?: number; error?: string }>
  }
  java: {
    list(): Promise<JavaRuntimeInfo[]>
    /** P31：探测并追加手动 Java 路径（去重） */
    addManual(path: string): Promise<JavaRuntimeInfo>
    /** P31：设为首选 Java */
    setPreferred(path: string): Promise<{ ok: boolean }>
    /** P31：下载指定主版本的 Mojang 官方 Java 运行时（8/16/17/21/25）并设为首选 */
    installRuntime(major: number): Promise<JavaRuntimeInfo>
  }
  gpu: {
    /** P31：立即把高性能显卡启用状态应用到所有探测到的 java.exe/javaw.exe */
    setEnabled(enabled: boolean): Promise<{ ok: boolean; applied: number; message?: string }>
    /** P31：读取设置状态 + 已写入注册表的条数 */
    status(): Promise<{ enabled: boolean; entries: number }>
  }
  content: {
    search(
      query: string,
      opts?: { type?: string; mcVersion?: string; loader?: string; limit?: number; offset?: number; source?: 'modrinth' | 'curseforge' | 'all' },
    ): Promise<SearchHit[]>
    /** P30：测试 CurseForge API Key 是否可用（基础/详情/搜索三项分开报） */
    testCurseForge(): Promise<CurseForgeTestResult>
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
    // ---- P29：模组更新检查 / 资源预览 ----
    /** 检查实例内已装模组的最新版本（可能为空数组） */
    updates(instanceId: string): Promise<ContentUpdate[]>
    /** 更新某个模组到最新版本（下载新文件 → 删旧文件 → 更新 content.json） */
    update(
      instanceId: string,
      fileName: string,
    ): Promise<{ ok: boolean; fileName?: string; version?: string; error?: string }>
    /** 资源/光影/模组的图片画廊预览（网络失败返回空 gallery） */
    preview(projectId: string, kind: 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'datapack'): Promise<ContentPreview>
  }
  conflict: {
    analyze(instanceId?: string): Promise<ConflictReport>
  }
  diagnose: {
    run(instanceId?: string): Promise<Diagnosis>
    fixes(instanceId?: string): Promise<FixAction[]>
    applyFix(instanceId: string, fixId: string): Promise<FixResult>
    gameLog(instanceId?: string, lines?: number): Promise<{ file?: string; lines: string[]; error?: string }>
  }
  loaders: {
    fabric(gameVersion: string): Promise<FabricInstallResult>
    neoforge(gameVersion: string): Promise<NeoForgeInstallResult>
    forge(gameVersion: string): Promise<NeoForgeInstallResult>
    /** P28：列出某版本可用的三种加载器及版本清单 */
    available(gameVersion: string): Promise<LoaderAvailability>
  }
  installer: {
    /** P28：一键装（原版+加载器并绑定到实例），原子操作 */
    run(req: InstallerRunRequest): Promise<InstallerRunResult>
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
  dialog: {
    /** 系统文件选择器；kind 决定文件类型过滤 */
    pickFile(kind?: 'pack' | 'zip' | 'image' | 'java'): Promise<string | null>
    /** 系统保存对话框；返回目标路径或 null */
    pickSave(defaultName: string): Promise<string | null>
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
