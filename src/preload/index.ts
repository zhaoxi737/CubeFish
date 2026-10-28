import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/channels'
import type { QdoApi } from '../shared/api'

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
  },
  instances: {
    list: () => ipcRenderer.invoke(CH.instancesList),
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
}

contextBridge.exposeInMainWorld('qdo', api)
