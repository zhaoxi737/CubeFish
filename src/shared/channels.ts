/** IPC 通道名。主进程与 preload 共用，避免字符串漂移。 */
export const CH = {
  appInfo: 'app:info',
  settingsAll: 'settings:all',
  settingsPatch: 'settings:patch',
  logsTail: 'logs:tail',
  updateCheck: 'update:check',
  launchDryRun: 'launch:dry-run',
  instancesList: 'instances:list',
  chatSend: 'chat:send',
  entitlements: 'entitlement:list',
  eventsSummary: 'events:summary',
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
