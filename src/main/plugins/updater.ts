/**
 * 自动更新（P7）：检查 → 下载（sha256 校验）→ 下次启动由外部脚本替换 → 重启。
 *
 * 便携版替换策略：
 * 运行中的 exe/dll 不能覆盖，所以写一个 apply-update.cmd，等本进程退出后再
 * Expand-Archive 覆盖安装目录并重新拉起 QDOQMC.exe。
 *
 * 安全：清单里没有 sha256 一律拒绝下载；下载后再次校验，失败即删除。
 */
import electron from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AppMeta, TaskProgress, UpdateState } from '../../shared/types'
import { isNewer } from '../../shared/version'
import { ensureDir, readJson, writeJsonAtomic } from '../lib/fsx'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { CloudPort } from './cloud'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'

const { app } = electron

export interface UpdaterService {
  state(): UpdateState
  check(trigger?: 'startup' | 'manual' | 'chat'): Promise<UpdateState>
  download(): Promise<UpdateState>
  apply(): Promise<{ ok: boolean; script?: string; error?: string }>
  setProgressSink(sink: ((progress: TaskProgress) => void) | null): void
}

export interface StagedUpdate {
  version: string
  zipPath: string
  sha256: string
  size: number
  downloadedAt: number
}

export function createUpdaterPlugin(): LauncherPlugin<void> {
  return definePlugin('updater', () => async (ctx) => {
    const cloud = use<CloudPort>(ctx, 'cloud')
    const log = use<LogService>(ctx, 'log')
    const settings = use<SettingsService>(ctx, 'settings')
    const paths = use<PathsService>(ctx, 'paths')
    const meta = use<AppMeta>(ctx, 'appMeta')

    let current: UpdateState = { status: 'idle', current: meta.version }
    let inFlight: Promise<UpdateState> | null = null
    let downloading = false
    let progressSink: ((progress: TaskProgress) => void) | null = null

    const updatesDir = path.join(paths.data, 'updates')
    const stagedFile = path.join(updatesDir, 'staged.json')

    const emit = (progress: TaskProgress) => progressSink?.(progress)

    const check = (trigger: 'startup' | 'manual' | 'chat' = 'manual'): Promise<UpdateState> => {
      if (inFlight) return inFlight
      current = { ...current, status: 'checking', message: undefined }
      log.info('updater', '开始检查更新', { trigger, current: meta.version })

      inFlight = (async (): Promise<UpdateState> => {
        try {
          const manifest = await cloud.getUpdateManifest()
          if (!manifest) {
            current = {
              status: settings.get('updateFeedUrl') ? 'error' : 'offline',
              current: meta.version,
              message: settings.get('updateFeedUrl') ? '更新清单获取失败（网络或配置问题）' : '未配置更新源 · 离线模式',
              checkedAt: Date.now(),
            }
            return current
          }

          const mustUpdate = Boolean(manifest.minSupported && isNewer(manifest.minSupported, meta.version))
          const available = isNewer(manifest.version, meta.version)
          current = {
            status: available ? 'available' : 'uptodate',
            current: meta.version,
            latest: manifest.version,
            notes: manifest.notes,
            url: manifest.url,
            sha256: manifest.sha256,
            size: manifest.size,
            minSupported: manifest.minSupported,
            mustUpdate,
            checkedAt: Date.now(),
          }
          log.info('updater', '更新检查完成', { status: current.status, latest: manifest.version, mustUpdate })
          return current
        } catch (err) {
          current = {
            status: 'error',
            current: meta.version,
            message: err instanceof Error ? err.message : String(err),
            checkedAt: Date.now(),
          }
          log.warn('updater', '更新检查异常', { error: current.message })
          return current
        } finally {
          inFlight = null
        }
      })()

      return inFlight
    }

    async function download(): Promise<UpdateState> {
      if (downloading) return current
      if (current.status !== 'available' || !current.url || !current.latest) {
        return { ...current, status: 'error', message: '当前没有可下载的更新（先检查更新）' }
      }
      if (!current.sha256) {
        return { ...current, status: 'error', message: '更新清单缺少 sha256，出于安全拒绝下载' }
      }

      const version = current.latest
      const url = current.url
      const expectedSha = current.sha256
      const expectedSize = current.size
      const targetDir = path.join(updatesDir, version)
      const zipPath = path.join(targetDir, 'payload.zip')
      await ensureDir(targetDir)
      await rm(zipPath, { force: true }).catch(() => undefined)

      downloading = true
      current = { ...current, status: 'downloading', message: '下载更新包…' }
      log.info('updater', '开始下载更新', { version, url: current.url })
      const started = Date.now()

      const controller = new AbortController()
      let lastActivity = Date.now()
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > 60_000) controller.abort()
      }, 5000)

      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)

        const total = Number(res.headers.get('content-length') ?? expectedSize ?? 0)
        const hash = createHash('sha256')
        let received = 0
        let lastEmit = 0
        const source = Readable.fromWeb(res.body as never)
        source.on('data', (chunk: Buffer) => {
          lastActivity = Date.now()
          hash.update(chunk)
          received += chunk.length
          const now = Date.now()
          if (now - lastEmit > 400) {
            lastEmit = now
            emit({
              taskId: `update-${version}`,
              kind: 'update',
              stage: 'download',
              done: received,
              total,
              bytes: received,
              message: '下载更新包',
            })
          }
        })

        await pipeline(source, createWriteStream(zipPath))
        clearInterval(idleTimer)

        const digest = hash.digest('hex')
        if (digest.toLowerCase() !== expectedSha.toLowerCase()) {
          await rm(zipPath, { force: true })
          throw new Error('sha256 校验失败，已删除下载文件（可能是网络损坏或清单不匹配）')
        }

        const staged: StagedUpdate = {
          version,
          zipPath,
          sha256: digest,
          size: received,
          downloadedAt: Date.now(),
        }
        await writeJsonAtomic(stagedFile, staged)
        current = { ...current, status: 'ready', stagedPath: zipPath, message: '已下载，重启后安装' }
        log.info('updater', '更新下载完成', { version, ms: Date.now() - started, bytes: received })
        return current
      } catch (err) {
        clearInterval(idleTimer)
        await rm(zipPath, { force: true }).catch(() => undefined)
        const message = err instanceof Error ? err.message : String(err)
        current = { ...current, status: 'error', message }
        log.error('updater', '更新下载失败', { error: message })
        return current
      } finally {
        downloading = false
      }
    }

    async function apply(): Promise<{ ok: boolean; script?: string; error?: string }> {
      if (!app.isPackaged) return { ok: false, error: '开发模式不支持自更新（请用打包版测试）' }

      const staged = await readJson<StagedUpdate | undefined>(stagedFile, undefined)
      if (!staged || !existsSync(staged.zipPath)) {
        return { ok: false, error: '没有已下载的更新包' }
      }
      const size = (await stat(staged.zipPath)).size
      if (size !== staged.size) return { ok: false, error: '更新包大小不符，请重新下载' }

      const installDir = path.dirname(app.getPath('exe'))
      const exePath = app.getPath('exe')
      const logFile = path.join(updatesDir, 'apply.log')
      const script = path.join(updatesDir, 'apply-update.ps1')
      mkdirSync(updatesDir, { recursive: true })

      const q = (value: string) => `'${value.replace(/'/g, "''")}'`
      const lines = [
        `$ErrorActionPreference = 'Continue'`,
        `$log = ${q(logFile)}`,
        `function Write-Log([string]$m) { try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format o), $m) -ErrorAction SilentlyContinue } catch {} }`,
        `Write-Log 'waiting for parent pid ${process.pid}'`,
        `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 700 }`,
        `Write-Log 'extracting'`,
        `try { Expand-Archive -LiteralPath ${q(staged.zipPath)} -DestinationPath ${q(installDir)} -Force } catch { Write-Log ("extract failed: " + $_.Exception.Message); exit 1 }`,
        `Write-Log 'restarting'`,
        `Start-Process -FilePath ${q(exePath)} | Out-Null`,
        `Remove-Item -LiteralPath (Join-Path (Split-Path $PSCommandPath) 'apply-update.cmd') -Force -ErrorAction SilentlyContinue`,
        `Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
      ]
      writeFileSync(script, `${lines.join('\r\n')}\r\n`, 'utf8')

      // Electron 主进程退出时会带走自己的子进程（Windows Job），
      // 所以用 explorer 打开一个 .cmd，让更新脚本运行在 explorer 的进程树下，
      // 父进程退出后仍能继续替换文件。
      const launcher = path.join(updatesDir, 'apply-update.cmd')
      const launcherLines = [
        '@echo off',
        'start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-update.ps1"',
      ]
      writeFileSync(launcher, `${launcherLines.join('\r\n')}\r\n`, 'utf8')

      try {
        spawn('explorer.exe', [launcher], { stdio: 'ignore', windowsHide: true }).unref()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('updater', '启动更新脚本失败', { error: message, script })
        return { ok: false, error: message }
      }

      log.info('updater', '已启动更新脚本，等待本进程退出后替换', {
        script,
        installDir,
        version: staged.version,
      })
      return { ok: true, script }
    }

    ctx.provide('updater', {
      state: () => current,
      check,
      download,
      apply,
      setProgressSink: (next) => {
        progressSink = next
      },
    } satisfies UpdaterService)

    // 启动时检查是否已有下载好的更新包
    const staged = await readJson<StagedUpdate | undefined>(stagedFile, undefined)
    if (staged && existsSync(staged.zipPath) && isNewer(staged.version, meta.version)) {
      current = {
        ...current,
        status: 'ready',
        latest: staged.version,
        stagedPath: staged.zipPath,
        sha256: staged.sha256,
        message: '已下载好新版本，重启即可更新',
      }
    }
  })
}
