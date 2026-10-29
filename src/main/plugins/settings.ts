import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stripBom } from '../lib/fsx'
import type { SettingsPatch, SettingsShape } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'

export interface SettingsService {
  all(): Readonly<SettingsShape>
  get<K extends keyof SettingsShape>(key: K): SettingsShape[K]
  patch(patch: SettingsPatch): SettingsShape
  set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]): SettingsShape
  filePath(): string
}

export const DEFAULT_SETTINGS: SettingsShape = {
  telemetry: true,
  updateFeedUrl: '',
  apiKey: '',
  llmBaseUrl: 'https://api.deepseek.com/v1',
  llmModel: 'deepseek-chat',
  memoryMb: 4096,
  playerName: 'Player',
  activeInstance: 'default',
  marketUrl: '',
  marketPublicKey: '',
  msClientId: '',
  curseforgeApiKey: '',
  autoCheckUpdate: true,
  downloadSource: 'auto',
  downloadThreads: 4,
  isolatedMods: true,
  useHighPerformanceGpu: false,
  preferredJavaPath: '',
  manualJavaPaths: [],
  launchWindowWidth: 0,
  launchWindowHeight: 0,
  launchFullscreen: false,
  jvmArgs: '',
  themeAccent: '#4d6bfe',
  customBackground: '',
  titleText: '',
  confirmDangerousOps: true,
}

const MASKED_KEYS: (keyof SettingsShape)[] = ['apiKey']

function mask(key: string, value: unknown): unknown {
  if (MASKED_KEYS.includes(key as keyof SettingsShape) && typeof value === 'string' && value.length > 0) {
    return `***(${value.length})`
  }
  return value
}

export function createSettingsPlugin(): LauncherPlugin<void> {
  return definePlugin('settings', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const file = path.join(paths.data, 'settings.json')
    mkdirSync(paths.data, { recursive: true })

    let current: SettingsShape = { ...DEFAULT_SETTINGS }
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(stripBom(readFileSync(file, 'utf8'))) as Partial<SettingsShape>
        current = { ...DEFAULT_SETTINGS, ...sanitize(parsed) }
      } catch (err) {
        log.warn('settings', '配置文件损坏，已回退默认值', { error: String(err) })
      }
    } else {
      persist(file, current)
    }

    const apply = (patch: SettingsPatch): SettingsShape => {
      current = { ...current, ...sanitize(patch) }
      persist(file, current)
      return current
    }

    const svc: SettingsService = {
      all: () => current,
      get: (key) => current[key],
      patch(patch) {
        const before = { ...current }
        const after = apply(patch)
        const changed: Record<string, unknown> = {}
        for (const key of Object.keys(patch) as (keyof SettingsShape)[]) {
          if (before[key] !== after[key]) changed[key] = mask(key, after[key])
        }
        if (Object.keys(changed).length > 0) {
          log.info('settings', '设置已更新', changed)
        }
        return after
      },
      set: (key, value) => svc.patch({ [key]: value } as SettingsPatch),
      filePath: () => file,
    }

    ctx.provide('settings', svc)
  })
}

function persist(file: string, value: SettingsShape): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function sanitize(input: Partial<SettingsShape>): Partial<SettingsShape> {
  const out: Partial<SettingsShape> = {}
  if (typeof input.telemetry === 'boolean') out.telemetry = input.telemetry
  if (typeof input.autoCheckUpdate === 'boolean') out.autoCheckUpdate = input.autoCheckUpdate
  if (typeof input.updateFeedUrl === 'string') out.updateFeedUrl = input.updateFeedUrl.trim()
  if (typeof input.apiKey === 'string') out.apiKey = input.apiKey.trim()
  if (typeof input.llmBaseUrl === 'string') out.llmBaseUrl = input.llmBaseUrl.trim() || DEFAULT_SETTINGS.llmBaseUrl
  if (typeof input.llmModel === 'string') out.llmModel = input.llmModel.trim() || DEFAULT_SETTINGS.llmModel
  if (typeof input.playerName === 'string') out.playerName = input.playerName.trim().slice(0, 16) || 'Player'
  if (typeof input.activeInstance === 'string' && input.activeInstance.trim()) out.activeInstance = input.activeInstance.trim()
  if (typeof input.marketUrl === 'string') out.marketUrl = input.marketUrl.trim()
  if (typeof input.marketPublicKey === 'string') out.marketPublicKey = input.marketPublicKey
  if (typeof input.msClientId === 'string') out.msClientId = input.msClientId.trim()
  if (typeof input.curseforgeApiKey === 'string') out.curseforgeApiKey = input.curseforgeApiKey.trim()
  if (typeof input.memoryMb === 'number' && Number.isFinite(input.memoryMb)) {
    out.memoryMb = Math.min(32768, Math.max(512, Math.round(input.memoryMb)))
  }
  if (input.downloadSource === 'auto' || input.downloadSource === 'official' || input.downloadSource === 'bmclapi') {
    out.downloadSource = input.downloadSource
  }
  if (typeof input.downloadThreads === 'number' && Number.isFinite(input.downloadThreads)) {
    out.downloadThreads = Math.min(16, Math.max(1, Math.round(input.downloadThreads)))
  }
  if (typeof input.isolatedMods === 'boolean') out.isolatedMods = input.isolatedMods
  if (typeof input.useHighPerformanceGpu === 'boolean') out.useHighPerformanceGpu = input.useHighPerformanceGpu
  if (typeof input.preferredJavaPath === 'string') out.preferredJavaPath = input.preferredJavaPath.trim()
  if (Array.isArray(input.manualJavaPaths)) {
    const seen = new Set<string>()
    const paths: string[] = []
    for (const item of input.manualJavaPaths) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (!trimmed) continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      paths.push(trimmed)
    }
    out.manualJavaPaths = paths
  }
  if (typeof input.launchWindowWidth === 'number' && Number.isFinite(input.launchWindowWidth)) {
    out.launchWindowWidth = Math.min(16384, Math.max(0, Math.round(input.launchWindowWidth)))
  }
  if (typeof input.launchWindowHeight === 'number' && Number.isFinite(input.launchWindowHeight)) {
    out.launchWindowHeight = Math.min(16384, Math.max(0, Math.round(input.launchWindowHeight)))
  }
  if (typeof input.launchFullscreen === 'boolean') out.launchFullscreen = input.launchFullscreen
  if (typeof input.jvmArgs === 'string') out.jvmArgs = input.jvmArgs.trim()
  if (typeof input.themeAccent === 'string') {
    const accent = input.themeAccent.trim()
    out.themeAccent = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{2,40})$/.test(accent) ? accent : DEFAULT_SETTINGS.themeAccent
  }
  if (typeof input.customBackground === 'string') out.customBackground = input.customBackground.trim()
  if (typeof input.titleText === 'string') out.titleText = input.titleText.trim()
  if (typeof input.confirmDangerousOps === 'boolean') out.confirmDangerousOps = input.confirmDangerousOps
  return out
}
