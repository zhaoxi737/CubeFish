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
  kind?: 'text' | 'action' | 'error' | 'agent'
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
  /** 启动时自动检查更新 */
  autoCheckUpdate: boolean
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

export type InstallStage = 'version' | 'libraries' | 'assets' | 'logging' | 'legacy' | 'done'

export interface TaskProgress {
  taskId: string
  kind: 'install' | 'update'
  stage: InstallStage | string
  done: number
  total: number
  bytes: number
  message?: string
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
}

export interface LaunchResult {
  ok: boolean
  pid?: number
  versionId?: string
  javaPath?: string
  playerName?: string
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
  kind: 'disable-mod' | 'set-memory' | 'install-dependency' | 'clear-crash-reports'
  /** 展示用的补充信息（如目标文件名、内存值） */
  detail?: string
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



