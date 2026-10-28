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
  releasedAt?: string
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'uptodate' | 'offline' | 'error'

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

export interface ChatReply {
  ok: boolean
  text: string
  kind?: 'text' | 'action' | 'error'
}

export interface SettingsShape {
  /** 匿名使用统计总开关（默认开，可关） */
  telemetry: boolean
  /** 更新清单地址；留空 = 离线模式 */
  updateFeedUrl: string
  /** 用户自己填的模型 API Key，只存本地 */
  apiKey: string
  /** 默认内存分配（MB） */
  memoryMb: number
  /** 离线登录玩家名 */
  playerName: string
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
  kind: 'install'
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


