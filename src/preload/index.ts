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
  },
  launch: {
    dryRun: (instanceId) => ipcRenderer.invoke(CH.launchDryRun, instanceId),
    start: (instanceId) => ipcRenderer.invoke(CH.launchStart, instanceId),
    stop: () => ipcRenderer.invoke(CH.launchStop),
  },
  instances: {
    list: () => ipcRenderer.invoke(CH.instancesList),
  },
  versions: {
    list: () => ipcRenderer.invoke(CH.versionsList),
    install: (versionId) => ipcRenderer.invoke(CH.versionInstall, versionId),
    installed: () => ipcRenderer.invoke(CH.versionsInstalled),
  },
  java: {
    list: () => ipcRenderer.invoke(CH.javaList),
  },
  chat: {
    send: (text) => ipcRenderer.invoke(CH.chatSend, text),
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
