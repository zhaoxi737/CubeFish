/**
 * 系统对接（P37）：让启动器和这台电脑连起来。
 *
 *  - info()：系统信息（平台/CPU/内存/运行时长）
 *  - speak()：喇叭说话——窗口在就用渲染层 speechSynthesis，窗口不在就用 Windows SAPI 兜底
 *  - saveRecording()/listRecordings()：麦克风录音落盘（渲染层用 getUserMedia 录音后交给这里保存）
 *
 * 注意：麦克风/喇叭属于系统能力，插件沙箱里拿不到（没有 DOM 和媒体 API），所以做成内置服务。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { RecordingItem, SystemInfo } from '../../shared/types'
import type { LogService } from './logger'
import type { PathsService } from './paths'

const execFileAsync = promisify(execFile)

export type { RecordingItem, SystemInfo }

export interface SystemService {
  info(): SystemInfo
  /** 渲染层喇叭：返回 false 表示渲染层不可用，走 SAPI 兜底 */
  setSpeaker(sink: ((text: string) => boolean) | null): void
  speak(text: string): Promise<{ ok: boolean; how: 'renderer' | 'sapi' | 'failed'; error?: string }>
  recordingsDir(): string
  saveRecording(data: Buffer, ext?: string): Promise<{ ok: boolean; path?: string; error?: string }>
  listRecordings(): RecordingItem[]
}

export function createSystemPlugin(): LauncherPlugin<void> {
  return definePlugin('system', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const log = use<LogService>(ctx, 'log')
    let speaker: ((text: string) => boolean) | null = null

    const recordingsDir = path.join(paths.data, 'recordings')

    const info = (): SystemInfo => {
      const cpus = os.cpus()
      return {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        hostname: os.hostname(),
        cpus: cpus.length,
        cpuModel: cpus[0]?.model?.trim() ?? '未知',
        totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMemMb: Math.round(os.freemem() / 1024 / 1024),
        uptimeSec: Math.round(os.uptime()),
        electron: process.versions.electron ?? '',
        node: process.versions.node ?? '',
      }
    }

    const sapiSpeak = async (text: string): Promise<{ ok: boolean; error?: string }> => {
      if (process.platform !== 'win32') return { ok: false, error: '当前系统不支持 SAPI 兜底' }
      const escaped = text.replace(/'/g, "''").replace(/[\r\n]+/g, ' ')
      const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.Speak('${escaped.slice(0, 500)}')`
      try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          timeout: 40_000,
          windowsHide: true,
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const speak = async (
      text: string,
    ): Promise<{ ok: boolean; how: 'renderer' | 'sapi' | 'failed'; error?: string }> => {
      const trimmed = text.trim()
      if (!trimmed) return { ok: false, how: 'failed', error: '文本为空' }
      if (speaker && speaker(trimmed)) return { ok: true, how: 'renderer' }
      const result = await sapiSpeak(trimmed)
      if (result.ok) return { ok: true, how: 'sapi' }
      log.warn('system', '喇叭播放失败', { error: result.error })
      return { ok: false, how: 'failed', error: result.error }
    }

    const saveRecording = async (data: Buffer, ext = 'webm'): Promise<{ ok: boolean; path?: string; error?: string }> => {
      try {
        const safeExt = /^[a-z0-9]{2,5}$/i.test(ext) ? ext : 'webm'
        mkdirSync(recordingsDir, { recursive: true })
        const file = path.join(recordingsDir, `rec-${new Date().toISOString().replace(/[:.]/g, '-')}.${safeExt}`)
        writeFileSync(file, data)
        log.info('system', '已保存录音', { file, bytes: data.length })
        return { ok: true, path: file }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const listRecordings = (): RecordingItem[] => {
      try {
        return readdirSync(recordingsDir)
          .map((name) => {
            const file = path.join(recordingsDir, name)
            try {
              return { name, bytes: statSync(file).size, path: file }
            } catch {
              return undefined
            }
          })
          .filter((item): item is RecordingItem => Boolean(item))
          .sort((a, b) => b.name.localeCompare(a.name))
          .slice(0, 50)
      } catch {
        return []
      }
    }

    ctx.provide('system', {
      info,
      setSpeaker: (sink) => {
        speaker = sink
      },
      speak,
      recordingsDir: () => recordingsDir,
      saveRecording,
      listRecordings,
    } satisfies SystemService)

    log.info('system', '系统对接就绪', { platform: process.platform, recordings: recordingsDir })
  })
}
