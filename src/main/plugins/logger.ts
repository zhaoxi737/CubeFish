import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { LogLevel, LogRecord } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { PathsService } from './paths'

export interface ScopedLogger {
  debug(message: string, data?: unknown): LogRecord
  info(message: string, data?: unknown): LogRecord
  warn(message: string, data?: unknown): LogRecord
  error(message: string, data?: unknown): LogRecord
}

export interface LogService {
  write(level: LogLevel, scope: string, message: string, data?: unknown): LogRecord
  debug(scope: string, message: string, data?: unknown): LogRecord
  info(scope: string, message: string, data?: unknown): LogRecord
  warn(scope: string, message: string, data?: unknown): LogRecord
  error(scope: string, message: string, data?: unknown): LogRecord
  child(scope: string): ScopedLogger
  tail(limit?: number): LogRecord[]
  filePath(): string
}

const RING_SIZE = 800
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function dayStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function createLoggerPlugin(): LauncherPlugin<void> {
  return definePlugin('logger', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    mkdirSync(paths.logs, { recursive: true })
    let file = path.join(paths.logs, `app-${dayStamp()}.jsonl`)
    const ring: LogRecord[] = []
    let mirrored = 0

    const write = (level: LogLevel, scope: string, message: string, data?: unknown): LogRecord => {
      const record: LogRecord = { ts: Date.now(), level, scope, message, data }
      const today = dayStamp()
      if (!file.endsWith(`app-${today}.jsonl`)) file = path.join(paths.logs, `app-${today}.jsonl`)

      ring.push(record)
      if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)

      try {
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      } catch (err) {
        // 日志自身失败不能拖垮应用
        console.error('[logger] append failed:', err)
      }

      // 控制台镜像（便于 --smoke 时从 stdout 观察）
      const line = `[${new Date(record.ts).toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope} ${message}`
      if (level === 'error') console.error(line, data ?? '')
      else if (level === 'warn') console.warn(line, data ?? '')
      else if (mirrored < 400) {
        console.log(line, data ?? '')
        mirrored += 1
      }
      return record
    }

    const child = (scope: string): ScopedLogger => ({
      debug: (m, d) => write('debug', scope, m, d),
      info: (m, d) => write('info', scope, m, d),
      warn: (m, d) => write('warn', scope, m, d),
      error: (m, d) => write('error', scope, m, d),
    })

    const svc: LogService = {
      write,
      child,
      debug: (scope, m, d) => write('debug', scope, m, d),
      info: (scope, m, d) => write('info', scope, m, d),
      warn: (scope, m, d) => write('warn', scope, m, d),
      error: (scope, m, d) => write('error', scope, m, d),
      tail(limit = 200) {
        return ring.slice(-Math.max(1, Math.min(limit, RING_SIZE)))
      },
      filePath() {
        return file
      },
    }

    ctx.provide('log', svc)
    write('info', 'logger', '结构化日志已就绪', { file })
  })
}

/** 预留：读回历史日志（用于 P3 崩溃诊断与 P4 插件审计）。 */
export function readLogFile(filePath: string, limit = 500): LogRecord[] {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const lines = raw.split('\n').filter(Boolean).slice(-limit)
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as LogRecord
        } catch {
          return null
        }
      })
      .filter((x): x is LogRecord => x !== null)
  } catch {
    return []
  }
}

export function levelAtLeast(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold]
}
