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
  mcVersion: string
  loader: string
  loaderVersion?: string
  memoryMb: number
  createdAt: number
  installed: boolean
  path: string
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
