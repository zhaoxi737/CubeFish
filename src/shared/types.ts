/** Renderer 与主进程共用的类型定义。纯类型，无运行时代码。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: number
  level: LogLevel
  scope: string
  message: string
  data?: unknown
}

export interface AppMeta {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  isSmoke: boolean
  bootedAt: number
}

export interface AppInfo extends AppMeta {
  installId: string
  dataDir: string
  logsDir: string
  plugins: string[]
  failedPlugins: { name: string; error: string }[]
}

export interface UpdateManifest {
  version: string
  url?: string
  notes?: string
  minSupported?: string
  rollout?: number
  sha256?: string
  size?: number
  releasedAt?: string
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'offline'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  current: string
  latest?: string
  notes?: string
  url?: string
  message?: string
  checkedAt?: number
  minSupported?: string
  mustUpdate?: boolean
  sha256?: string
  size?: number
  /** 已下载待安装的包路径 */
  stagedPath?: string
}

export interface InstanceSummary {
  id: string
  name: string
  /** 已选定的游戏版本（Mojang 版本 id 或加载器 profile id） */
  versionId?: string
  /** 底层游戏版本（加载器实例也指向原版版本号，如 1.21.11） */
  gameVersion?: string
  mcVersion: string
  loader: string
  loaderVersion?: string
  memoryMb: number
  playerName: string
  /** 绑定的微软账号 UUID；空 = 跟随全局当前账号 */
  accountId?: string
  /** 绑定账号的显示名（快照） */
  accountName?: string
  createdAt: number
  installed: boolean
  path: string
  /** 游戏目录（= 进程 cwd，版本隔离的真正根） */
  gameDir: string
}

export interface LaunchStep {
  step: string
  status: 'ok' | 'pending' | 'skipped' | 'error'
  detail?: string
}

export interface LaunchDryRun {
  ok: boolean
  instance: InstanceSummary
  steps: LaunchStep[]
  hint: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  ts: number
}

/** P37：系统信息（系统对接面板用） */
export interface SystemInfo {
  platform: string
  arch: string
  release: string
  hostname: string
  cpus: number
  cpuModel: string
  totalMemMb: number
  freeMemMb: number
  uptimeSec: number
  electron: string
  node: string
}

/** P37：一条麦克风录音 */
export interface RecordingItem {
  name: string
  bytes: number
  path: string
}

/** P36：一个对话会话（可多开） */
export interface ChatSessionInfo {
  id: string
  title: string
  updatedAt: number
  count: number
}

/** P36：AI 工作过程事件（实时显示在对话里） */
export type ChatProgressEvent =
  | { type: 'round'; round: number }
  | { type: 'tool'; tool: string; phase: 'start'; detail?: string }
  | { type: 'tool'; tool: string; phase: 'end'; ok: boolean; summary?: string }

/** P36：发送选项（replaceLast = 补充/修改上一条用户消息） */
export interface ChatSendOptions {
  replaceLast?: boolean
}

export interface ToolCallTrace {
  id: string
  tool: string
  args: Record<string, unknown>
  ok: boolean
  summary: string
  ms: number
}

export interface ChatReply {
  ok: boolean
  text: string
  kind?: 'text' | 'action' | 'error' | 'agent' | 'confirm'
  trace?: ToolCallTrace[]
  /** 文本是否通过流式增量推送过（渲染层避免重复拼接） */
  streamed?: boolean
}

export interface SettingsShape {
  /** 匿名使用统计总开关（默认开，可关） */
  telemetry: boolean
  /** 更新清单地址；留空 = 离线模式 */
  updateFeedUrl: string
  /** 用户自己填的模型 API Key，只存本地 */
  apiKey: string
  /** OpenAI 兼容接口地址（DeepSeek 默认） */
  llmBaseUrl: string
  /** 模型名 */
  llmModel: string
  /** 默认内存分配（MB） */
  memoryMb: number
  /** 离线登录玩家名 */
  playerName: string
  /** 当前实例 id */
  activeInstance: string
  /** 插件市场 feed 地址；留空 = 不启用市场 */
  marketUrl: string
  /** 市场 feed 签名公钥（PEM，Ed25519）。留空 = 不校验签名（开发模式） */
  marketPublicKey: string
  /** 微软登录的 Azure 应用 client_id；留空 = 只能离线登录 */
  msClientId: string
  /** CurseForge API Key（仅本机，用于解析整合包文件）；留空 = 只能装自带 mods 的包 */
  curseforgeApiKey: string
  /** 启动时自动检查更新 */
  autoCheckUpdate: boolean
  /** P28：下载源（auto 自动测速选最快） */
  downloadSource: DownloadSource
  /** P28：单文件分片下载数 1..16 */
  downloadThreads: number
  /** P31：各实例 mods/资源包/光影 是否独立（true）；false = 共用（junction 指向共享目录） */
  isolatedMods: boolean
  /** P31：启动时用高性能显卡（写入 Windows 用户级 GPU 偏好） */
  useHighPerformanceGpu: boolean
  /** P31：首选 Java 路径；空 = 自动选择 */
  preferredJavaPath: string
  /** P31：手动添加的 java.exe 路径 */
  manualJavaPaths: string[]
  /** P31：启动窗口宽 0..16384；0 = 用游戏默认 */
  launchWindowWidth: number
  /** P31：启动窗口高 0..16384；0 = 用游戏默认 */
  launchWindowHeight: number
  /** P31：启动时全屏 */
  launchFullscreen: boolean
  /** P31：追加 JVM 参数（空格分隔，支持引号内空格） */
  jvmArgs: string
  /** P31：主题强调色（#hex 或常见色名） */
  themeAccent: string
  /** P31：自定义背景图路径；空 = 内置背景图 */
  customBackground: string
  /** P31：标题文本；空 = 'QDOQMC' */
  titleText: string
  /** P34：AI 执行危险操作（结束游戏/删插件/写文件等）前需要用户确认 */
  confirmDangerousOps: boolean
  /** P41：允许 AI 执行系统命令 / 修改启动器源码（默认关闭，需用户显式开启） */
  allowDangerousAiTools: boolean
}

export type SettingsPatch = Partial<SettingsShape>

export interface EntitlementItem {
  feature: string
  granted: boolean
  source: 'free' | 'license' | 'trial'
}

export interface EventSummary {
  total: number
  today: number
  lastEventAt?: number
  types: Record<string, number>
  uploaded: boolean
}

export interface TelemetryEvent {
  type: string
  ts: number
  installId: string
  payload?: Record<string, unknown>
}

export interface ServiceStatus {
  name: string
  loaded: boolean
  detail?: string
}

/* ---------- P1：下载 / 安装 / Java / 启动 ---------- */

export type VersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

export interface VersionSummary {
  id: string
  type: VersionType
  releaseTime: string
}

export interface VersionList {
  latest: { release: string; snapshot: string }
  versions: VersionSummary[]
  installed: string[]
}

export type InstallStage =
  | 'version'
  | 'libraries'
  | 'assets'
  | 'logging'
  | 'legacy'
  | 'done'
  | 'cancelled'
  /** P29：安装失败（整合包/原版安装出错时发一次，前端据此把任务标记为失败） */
  | 'failed'

/** 下载源：auto = 自动测速选最快，official = Mojang 官方，bmclapi = 国内镜像 */
export type DownloadSource = 'auto' | 'official' | 'bmclapi'

/** 一个下载阶段（PCL 式分阶段进度条） */
export interface StageProgress {
  /** 'version' | 'libraries' | 'assets' | 'logging' | 'done' | 'content' */
  stage: string
  /** 中文短名，如 '下载库文件' */
  label: string
  /** 该阶段已完成文件数 */
  done: number
  /** 该阶段文件总数 */
  total: number
  /** 该阶段已下载字节 */
  bytes: number
  /** 该阶段总字节（未知时 0） */
  bytesTotal: number
  state: 'pending' | 'running' | 'done'
}

/** P29：下载任务里的单个文件（PCL 式文件清单） */
export interface ProgressFile {
  /** 显示名：库坐标 / mod 文件名 / assets 的 key */
  name: string
  /** 字节数，未知省略 */
  size?: number
  /** 该文件当前状态 */
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
}

export interface TaskProgress {
  taskId: string
  kind: 'install' | 'update' | 'content'
  stage: InstallStage | string
  done: number
  total: number
  bytes: number
  message?: string
  // ---- P28 新增（全部可选，旧发射方不受影响） ----
  /** 整体加权百分比 0..100 */
  percent?: number
  /** 本次任务总字节 */
  bytesTotal?: number
  /** 字节/秒（最近 2s 滑动平均） */
  speed?: number
  /** 预计剩余毫秒（未知时省略） */
  etaMs?: number
  /** 当前正在下载的文件名/label */
  currentFile?: string
  filesDone?: number
  filesTotal?: number
  /** 阶段快照，按顺序 */
  stages?: StageProgress[]
  /** 实际使用的下载源 */
  source?: DownloadSource
  // ---- P29 新增（全部可选，旧发射方不受影响） ----
  /** 当前阶段的文件清单（最多 200 条，按 PCL 的样式逐行显示） */
  files?: ProgressFile[]
  /** 任务标题，例如「安装 1.21.11」「安装整合包 Fabulously Optimized」 */
  title?: string
}

export interface InstallResult {
  ok: boolean
  versionId: string
  ms: number
  javaMajor?: number
  assetIndex?: string
  files?: number
  error?: string
}

export interface JavaRuntimeInfo {
  /** java.exe / javaw.exe 绝对路径 */
  path: string
  home: string
  version: string
  major: number
  source: 'env' | 'path' | 'common' | 'mojang' | 'manual'
  /** P31：是否是用户首选 Java（settings.preferredJavaPath） */
  preferred?: boolean
}

export interface LaunchResult {
  ok: boolean
  pid?: number
  versionId?: string
  javaPath?: string
  playerName?: string
  /** 本次启动用的账号类型 */
  accountType?: 'offline' | 'microsoft'
  ms?: number
  error?: string
}

export interface GameStateEvent {
  state: 'running' | 'exited'
  pid?: number
  versionId?: string
  instanceId?: string
  exitCode?: number | null
  signal?: string | null
  uptimeMs?: number
  crashReport?: string
  hint?: string
}

/* ---------- P2：加载器 / 内容（Modrinth） ---------- */

export interface SearchHit {
  projectId: string
  slug: string
  title: string
  description: string
  projectType: string
  categories: string[]
  downloads: number
  iconUrl?: string
  versions: string[]
  // ---- P28 新增：Modrinth search 响应里本来就有 ----
  /** 该项目最新版本支持的游戏版本 */
  gameVersions?: string[]
  /** 'fabric' | 'forge' | 'neoforge' | 'quilt' */
  loaders?: string[]
  /** P30：这条结果来自哪个源；不填按 modrinth 处理 */
  source?: ContentSource
}

/** P30：内容来源 */
export type ContentSource = 'modrinth' | 'curseforge'

/** P30：CurseForge Key 连通性测试结果（三项分开报，区分「Key 无效」和「没有搜索权限」） */
export interface CurseForgeTestResult {
  ok: boolean
  basicOk?: boolean
  detailOk?: boolean
  searchOk?: boolean
  games?: number
  ms?: number
  error?: string
  searchError?: string
}

export interface ContentVersionInfo {
  id: string
  projectId: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  versionType: string
  datePublished: string
  fileName: string
  fileUrl: string
  fileSize: number
  sha1: string
  dependencies: { projectId?: string; versionId?: string; dependencyType: string }[]
}

export interface InstalledContent {
  projectId: string
  slug?: string
  title?: string
  versionId: string
  versionNumber: string
  fileName: string
  kind: string
  sha1: string
  installedAt: number
  /** 文件当前是否启用（.jar vs .jar.disabled） */
  enabled?: boolean
  /** P30：这条内容来自哪个源；不填按 modrinth 处理 */
  source?: ContentSource
}

export interface ContentInstallResult {
  ok: boolean
  projectId: string
  title?: string
  versionNumber?: string
  files: string[]
  dependenciesInstalled: number
  error?: string
}

/* ---------- P29：模组更新检查 / 资源预览 ---------- */

/** 模组更新项 */
export interface ContentUpdate {
  /** 实例内的文件名（mods/ 下） */
  fileName: string
  projectId?: string
  title?: string
  /** 当前版本号（来自 content.json） */
  currentVersion?: string
  /** Modrinth 上的最新版本号 */
  latestVersion?: string
  /** 最新文件名（覆盖安装用） */
  latestFileName?: string
  gameVersions?: string[]
  loaders?: string[]
}

/** 资源预览（图片画廊） */
export interface ContentPreview {
  projectId: string
  title: string
  description: string
  iconUrl?: string
  /** 画廊图片（绝对 https URL，前端直接 <img>） */
  gallery: string[]
  downloads: number
  gameVersions: string[]
  loaders: string[]
}

export interface FabricInstallResult {
  ok: boolean
  gameVersion: string
  versionId?: string
  loaderVersion?: string
  libraries?: number
  error?: string
}

export interface NeoForgeInstallResult {
  ok: boolean
  gameVersion: string
  versionId?: string
  loaderVersion?: string
  libraries?: number
  processors?: number
  error?: string
}

/* ---------- P28：加载器可用性 / 一键安装 ---------- */

/** 某个 MC 版本可用的加载器 */
export interface LoaderChoice {
  loader: 'fabric' | 'forge' | 'neoforge'
  /** 可用加载器版本，新→旧，最多 20 个 */
  versions: string[]
  /** 推荐版本（Fabric 取最新稳定；Forge 取推荐 build；NeoForge 取最新） */
  recommended?: string
  /** 例如 '仅支持 1.20.1 及以下' / '查询失败，可稍后重试' */
  note?: string
}

export interface LoaderAvailability {
  gameVersion: string
  release: boolean
  javaMajor?: number
  /** 不可用的加载器不出现 */
  loaders: LoaderChoice[]
}

export type InstallerLoader = 'vanilla' | 'fabric' | 'forge' | 'neoforge'

export interface InstallerRunRequest {
  instanceId: string
  /** 例如 '1.20.1' */
  gameVersion: string
  /** 默认 'vanilla' */
  loader?: InstallerLoader
  /** 为空则由后端取 recommended */
  loaderVersion?: string
}

export interface InstallerRunResult {
  ok: boolean
  versionId?: string
  loader?: InstallerLoader
  loaderVersion?: string
  ms?: number
  error?: string
}

/* ---------- P10：整合包（.mrpack） ---------- */

export interface ModpackInstallResult {
  ok: boolean
  packName?: string
  instanceId?: string
  mcVersion?: string
  loader?: string
  files?: number
  bytes?: number
  overrides?: number
  error?: string
}

export interface PackInspect {
  ok: boolean
  kind?: 'curseforge' | 'modrinth'
  name?: string
  mcVersion?: string
  loader?: string
  loaderVersion?: string
  fileCount?: number
  bundledMods?: number
  needsApiKey?: boolean
  error?: string
}

export interface CursePackInstallResult {
  ok: boolean
  packName?: string
  instanceId?: string
  mcVersion?: string
  loader?: string
  loaderVersion?: string
  resolved?: number
  bundled?: number
  overrides?: number
  error?: string
}

export interface CursePackInspectResult {
  ok: boolean
  name?: string
  mcVersion?: string
  loader?: string
  loaderVersion?: string
  fileCount?: number
  bundledMods?: number
  /** 没有 API Key 且包内没带 mods 时，需要用户填 Key 才能装 */
  needsApiKey?: boolean
  error?: string
}

export interface ModpackInspectResult {
  ok: boolean
  name?: string
  versionId?: string
  game?: string
  dependencies?: Record<string, string>
  fileCount?: number
  totalBytes?: number
  /** 已知不支持自动安装的加载器（目前只有 quilt） */
  unsupportedLoader?: string
  error?: string
}

/* ---------- P3：冲突分析 / 崩溃归因 / 模组管理 ---------- */

export type ConflictSeverity = 'error' | 'warn' | 'info'

export type ConflictIssueKind =
  | 'duplicate-id'
  | 'missing-dependency'
  | 'loader-mismatch'
  | 'breaks'
  | 'incompatible'
  | 'unreadable'
  | 'mods-in-vanilla'
  | 'disabled'

export interface ConflictIssue {
  severity: ConflictSeverity
  kind: ConflictIssueKind
  mods: string[]
  message: string
  suggestion: string
}

export interface ModInfo {
  file: string
  id: string
  name: string
  version: string
  loader: 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'unknown'
  enabled: boolean
  depends: Record<string, string>
  breaks: Record<string, string>
  provides: string[]
}

export interface ConflictReport {
  instanceId: string
  mods: ModInfo[]
  issues: ConflictIssue[]
  checkedAt: number
}

export interface Diagnosis {
  found: boolean
  source?: string
  category: string
  severity: 'info' | 'warn' | 'error'
  summary: string
  evidence: string[]
  suggestions: string[]
  checkedAt: number
}

/* ---------- P13：崩溃一键修复 ---------- */

export interface FixAction {
  id: string
  label: string
  description: string
  kind: 'disable-mod' | 'set-memory' | 'install-dependency' | 'clear-crash-reports' | 'install-version'
  /** 展示用的补充信息（如目标文件名、内存值） */
  detail?: string
}

/* ---------- P17：微软正版登录 ---------- */

export interface AccountState {
  type: 'offline' | 'microsoft'
  name: string
  uuid: string
  /** 仅微软账号：Minecraft 访问令牌（只存本机） */
  accessToken?: string
  expiresAt?: number
}

export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface AccountSummary {
  uuid: string
  name: string
  active: boolean
  expiresAt: number
  tokenStorage: 'encrypted' | 'plain' | 'none'
}

export interface LoginStatus {
  status: 'pending' | 'ok' | 'error'
  account?: AccountState
  error?: string
}

export interface FixResult {
  ok: boolean
  message: string
  /** 修复后是否建议重新诊断/启动 */
  refresh?: boolean
}

/* ---------- P5：插件 ---------- */

export type PluginPermission = 'read' | 'net' | 'exec'

export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: number
  main: string
  description?: string
  author?: string
  permissions: PluginPermission[]
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  apiVersion: number
  permissions: PluginPermission[]
  /** 用户是否授权加载（默认 false，必须显式启用） */
  granted: boolean
  loaded: boolean
  error?: string
  dir: string
  tools: string[]
  commands: string[]
  /** 是否运行在 utilityProcess 沙箱里 */
  sandbox?: boolean
  /** 沙箱进程 PID（运行时） */
  workerPid?: number
}

/** P34：插件往启动器界面加的一个按钮 */
export interface PluginUiButton {
  pluginId: string
  pluginName: string
  id: string
  label: string
  description?: string
}

/* ---------- P9：插件市场 ---------- */

export interface MarketPlugin {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  permissions: PluginPermission[]
  download: {
    url: string
    sha256: string
    size: number
  }
}

export interface MarketListResult {
  ok: boolean
  plugins: MarketPlugin[]
  /** 'none' = 未配置市场；'unsigned' = 开发模式未校验 */
  source: 'verified' | 'unsigned' | 'none' | 'error'
  error?: string
}



