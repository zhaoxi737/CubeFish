import { contextBridge, ipcRenderer } from 'electron'
import { CH, EVT } from '../shared/channels'
import type { QdoApi } from '../shared/api'
import type { GameStateEvent, TaskProgress } from '../shared/types'

const api: QdoApi = {
  info: () => ipcRenderer.invoke(CH.appInfo),
  settings: {
    all: () => ipcRenderer.invoke(CH.settingsAll),
    patch: (patch) => ipcRenderer.invoke(CH.settingsPatch, patch),
  },
  logs: {
    tail: (limit) => ipcRenderer.invoke(CH.logsTail, limit),
  },
  update: {
    check: () => ipcRenderer.invoke(CH.updateCheck),
    download: () => ipcRenderer.invoke(CH.updateDownload),
    apply: () => ipcRenderer.invoke(CH.updateApply),
  },
  launch: {
    dryRun: (instanceId) => ipcRenderer.invoke(CH.launchDryRun, instanceId),
    start: (instanceId) => ipcRenderer.invoke(CH.launchStart, instanceId),
    stop: () => ipcRenderer.invoke(CH.launchStop),
  },
  instances: {
    list: () => ipcRenderer.invoke(CH.instancesList),
    create: (name) => ipcRenderer.invoke(CH.instancesCreate, name),
    remove: (id) => ipcRenderer.invoke(CH.instancesRemove, id),
    activate: (id) => ipcRenderer.invoke(CH.instancesActivate, id),
  },
  versions: {
    list: () => ipcRenderer.invoke(CH.versionsList),
    install: (versionId) => ipcRenderer.invoke(CH.versionInstall, versionId),
    installed: () => ipcRenderer.invoke(CH.versionsInstalled),
  },
  java: {
    list: () => ipcRenderer.invoke(CH.javaList),
  },
  content: {
    search: (query, opts) => ipcRenderer.invoke(CH.contentSearch, query, opts),
    versions: (projectId, opts) => ipcRenderer.invoke(CH.contentVersions, projectId, opts),
    install: (instanceId, projectId, opts) => ipcRenderer.invoke(CH.contentInstall, instanceId, projectId, opts),
    installed: (instanceId) => ipcRenderer.invoke(CH.contentInstalled, instanceId),
    toggle: (instanceId, fileName) => ipcRenderer.invoke(CH.contentToggle, instanceId, fileName),
    remove: (instanceId, fileName) => ipcRenderer.invoke(CH.contentRemove, instanceId, fileName),
    installModpack: (source) => ipcRenderer.invoke(CH.contentModpack, source),
    inspectModpack: (source) => ipcRenderer.invoke(CH.contentInspect, source),
  },
  conflict: {
    analyze: (instanceId) => ipcRenderer.invoke(CH.conflictAnalyze, instanceId),
  },
  diagnose: {
    run: (instanceId) => ipcRenderer.invoke(CH.diagnoseRun, instanceId),
    fixes: (instanceId) => ipcRenderer.invoke(CH.diagnoseFixes, instanceId),
    applyFix: (instanceId, fixId) => ipcRenderer.invoke(CH.diagnoseApplyFix, instanceId, fixId),
  },
  loaders: {
    fabric: (gameVersion) => ipcRenderer.invoke(CH.loaderFabric, gameVersion),
    neoforge: (gameVersion) => ipcRenderer.invoke(CH.loaderNeoForge, gameVersion),
    forge: (gameVersion) => ipcRenderer.invoke(CH.loaderForge, gameVersion),
  },
  plugins: {
    list: () => ipcRenderer.invoke(CH.pluginsList),
    setGranted: (id, granted) => ipcRenderer.invoke(CH.pluginsToggle, id, granted),
    reload: (id) => ipcRenderer.invoke(CH.pluginsReload, id),
  },
  market: {
    list: (force) => ipcRenderer.invoke(CH.marketList, force),
    install: (id) => ipcRenderer.invoke(CH.marketInstall, id),
  },
  chat: {
    send: (text) => ipcRenderer.invoke(CH.chatSend, text),
    history: () => ipcRenderer.invoke(CH.chatHistory),
    clear: () => ipcRenderer.invoke(CH.chatClear),
    onDelta: (callback) => {
      const listener = (_event: unknown, payload: { text?: string }) => callback(payload?.text ?? '')
      ipcRenderer.on(CH.chatDelta, listener)
      return () => {
        ipcRenderer.removeListener(CH.chatDelta, listener)
      }
    },
  },
  auth: {
    state: () => ipcRenderer.invoke(CH.authState),
    accounts: () => ipcRenderer.invoke(CH.authAccounts),
    switchAccount: (uuid) => ipcRenderer.invoke(CH.authSwitch, uuid),
    removeAccount: (uuid) => ipcRenderer.invoke(CH.authRemove, uuid),
    begin: () => ipcRenderer.invoke(CH.authBegin),
    complete: () => ipcRenderer.invoke(CH.authComplete),
    logout: () => ipcRenderer.invoke(CH.authLogout),
  },
  entitlement: {
    list: () => ipcRenderer.invoke(CH.entitlements),
  },
  events: {
    summary: () => ipcRenderer.invoke(CH.eventsSummary),
  },
  onProgress(listener: (progress: TaskProgress) => void) {
    const handler = (_event: unknown, payload: TaskProgress) => listener(payload)
    ipcRenderer.on(EVT.progress, handler)
    return () => ipcRenderer.removeListener(EVT.progress, handler)
  },
  onGameState(listener: (state: GameStateEvent) => void) {
    const handler = (_event: unknown, payload: GameStateEvent) => listener(payload)
    ipcRenderer.on(EVT.gameState, handler)
    return () => ipcRenderer.removeListener(EVT.gameState, handler)
  },
}

contextBridge.exposeInMainWorld('qdo', api)
