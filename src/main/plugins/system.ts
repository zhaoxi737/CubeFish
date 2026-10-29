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
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import electron from 'electron'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { RecordingItem, SystemInfo } from '../../shared/types'
import { findRepoRoot, runCommand, runNpm } from '../lib/repo'
import type { LogService } from './logger'
import type { PathsService } from './paths'

const execFileAsync = promisify(execFile)
const electronApp = electron.app

export type { RecordingItem, SystemInfo }

export interface SystemService {
  info(): SystemInfo
  /** 渲染层喇叭：返回 false 表示渲染层不可用，走 SAPI 兜底 */
  setSpeaker(sink: ((text: string) => boolean) | null): void
  speak(text: string): Promise<{ ok: boolean; how: 'renderer' | 'sapi' | 'failed'; error?: string }>
  recordingsDir(): string
  saveRecording(data: Buffer, ext?: string): Promise<{ ok: boolean; path?: string; error?: string }>
  listRecordings(): RecordingItem[]
  /** P40：把 src/ 回滚到上一次提交，重新构建并同步，然后重启自己 */
  rollbackSource(): Promise<{ ok: boolean; message: string; reverted?: string[] }>
  /** P40：查看 src/ 当前有多少未提交改动 */
  sourceStatus(): Promise<{ ok: boolean; repoRoot?: string; dirty: string[]; error?: string }>
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

    const repoHints = (): string[] => {
      const hints: string[] = []
      try {
        hints.push(path.dirname(electronApp.getPath('exe')))
      } catch {
        /* 忽略 */
      }
      if (process.resourcesPath) hints.push(path.dirname(process.resourcesPath))
      return hints
    }

    const sourceStatus = async (): Promise<{ ok: boolean; repoRoot?: string; dirty: string[]; error?: string }> => {
      const root = findRepoRoot(repoHints())
      if (!root) return { ok: false, dirty: [], error: '找不到源码目录（打包版需要源码在 dist 上一级，或设置 QDOQMC_REPO）' }
      const result = await runCommand('git', ['-C', root, 'status', '--porcelain', '--', 'src'], root, 30_000)
      if (!result.ok) return { ok: false, repoRoot: root, dirty: [], error: result.stderr.slice(0, 400) }
      const dirty = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      return { ok: true, repoRoot: root, dirty }
    }

    const rollbackSource = async (): Promise<{ ok: boolean; message: string; reverted?: string[] }> => {
      const root = findRepoRoot(repoHints())
      if (!root) return { ok: false, message: '找不到源码目录：把源码放回 dist 上一级，或设置环境变量 QDOQMC_REPO' }
      const status = await runCommand('git', ['-C', root, 'status', '--porcelain', '--', 'src'], root, 30_000)
      if (!status.ok) return { ok: false, message: `git 不可用：${status.stderr.slice(0, 300)}` }
      const reverted = status.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const checkout = await runCommand('git', ['-C', root, 'checkout', '--', 'src'], root, 60_000)
      if (!checkout.ok) return { ok: false, message: `回滚失败：${checkout.stderr.slice(0, 400)}` }
      // 清掉 AI 新建但没提交的 src 文件，避免残留导致构建失败
      await runCommand('git', ['-C', root, 'clean', '-fd', '--', 'src'], root, 60_000)
      const build = await runNpm(['run', 'build'], root, 300_000)
      if (!build.ok) {
        return { ok: false, message: `回滚完成但重新构建失败：${(build.stderr || build.stdout).slice(0, 500)}`, reverted }
      }
      const outDir = path.join(root, 'out')
      const resourcesApp = process.resourcesPath ? path.join(process.resourcesPath, 'app') : ''
      if (resourcesApp && existsSync(resourcesApp) && existsSync(outDir)) {
        const target = path.join(resourcesApp, 'out')
        rmSync(target, { recursive: true, force: true })
        cpSync(outDir, target, { recursive: true })
      }
      log.info('system', '源码已回滚', { root, files: reverted.length })
      setTimeout(() => {
        try {
          electronApp.relaunch()
          electronApp.exit(0)
        } catch {
          /* 忽略 */
        }
      }, 800)
      return {
        ok: true,
        message: `已回滚 ${reverted.length} 个源码文件并重新构建，正在重启…`,
        reverted,
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
      rollbackSource,
      sourceStatus,
    } satisfies SystemService)

    log.info('system', '系统对接就绪', { platform: process.platform, recordings: recordingsDir })
  })
}
