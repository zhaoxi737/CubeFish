import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AppMeta, EventSummary, TelemetryEvent } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { CloudPort } from './cloud'
import type { IdentityService } from './identity'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'

/**
 * 事件埋点（付费转化分析的地基）。
 *
 * 永远先写本地 events.jsonl；只有 settings.telemetry 打开时才会考虑上传。
 * 上传端点在 P0 为空实现（cloud.report 直接跳过）。
 */
export interface TelemetryService {
  record(type: string, payload?: Record<string, unknown>): TelemetryEvent
  summary(): EventSummary
  flush(): Promise<{ ok: boolean; uploaded: number; reason?: string }>
}

function dayStart(ts = Date.now()): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function createTelemetryPlugin(): LauncherPlugin<void> {
  return definePlugin('telemetry', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    const identity = use<IdentityService>(ctx, 'identity')
    const settings = use<SettingsService>(ctx, 'settings')
    const cloud = use<CloudPort>(ctx, 'cloud')

    const dir = path.join(paths.data, 'events')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'events.jsonl')

    const counters = { total: 0, today: 0, lastEventAt: undefined as number | undefined, types: {} as Record<string, number> }

    // 冷启动时回放已有事件，保证统计不因重启归零
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, 'utf8')
        const since = dayStart()
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as TelemetryEvent
            counters.total += 1
            counters.types[ev.type] = (counters.types[ev.type] ?? 0) + 1
            if (ev.ts >= since) counters.today += 1
            if (!counters.lastEventAt || ev.ts > counters.lastEventAt) counters.lastEventAt = ev.ts
          } catch {
            /* 跳过损坏行 */
          }
        }
      } catch (err) {
        log.warn('telemetry', '历史事件读取失败', { error: String(err) })
      }
    }

    const record = (type: string, payload?: Record<string, unknown>): TelemetryEvent => {
      const ev: TelemetryEvent = { type, ts: Date.now(), installId: identity.installId, payload }
      try {
        appendFileSync(file, `${JSON.stringify(ev)}\n`, 'utf8')
      } catch (err) {
        log.warn('telemetry', '事件写入失败', { error: String(err), type })
      }
      counters.total += 1
      counters.types[type] = (counters.types[type] ?? 0) + 1
      if (ev.ts >= dayStart()) counters.today += 1
      counters.lastEventAt = ev.ts
      return ev
    }

    const svc: TelemetryService = {
      record,
      summary: () => ({
        total: counters.total,
        today: counters.today,
        lastEventAt: counters.lastEventAt,
        types: { ...counters.types },
        uploaded: false,
      }),
      async flush() {
        if (!settings.get('telemetry')) return { ok: true, uploaded: 0, reason: '用户已关闭匿名统计' }
        const res = await cloud.report([])
        return { ok: res.ok, uploaded: 0, reason: res.reason ?? 'P0 未接入上报端点' }
      },
    }

    ctx.provide('telemetry', svc)

    const meta = use<AppMeta>(ctx, 'appMeta')
    record('app:start', { version: meta.version, smoke: meta.isSmoke })
  })
}
