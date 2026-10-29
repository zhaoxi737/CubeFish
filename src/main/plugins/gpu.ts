/**
 * P31：高性能显卡偏好（Windows 用户级 GPU 偏好注册表）。
 *
 * 写 `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`，值名为 exe 全路径，
 * 值为 `GpuPreference=2;`（2=高性能）/ `GpuPreference=0;`（0=让系统决定）。
 * 系统与 NVIDIA 都认，无需管理员、无需手动开控制面板。关闭时写 0 而不是删值，更稳。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { JavaService } from './java'
import type { LogService } from './logger'
import type { SettingsService } from './settings'

const execFileAsync = promisify(execFile)
const REG_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
const THROTTLE_MS = 5000

export interface GpuService {
  /** 立即把启用状态应用到当前探测到的所有 java.exe/javaw.exe，并持久化设置 */
  setEnabled(enabled: boolean): Promise<{ ok: boolean; applied: number; message?: string }>
  /** 把当前 useHighPerformanceGpu 设置应用到单个 java.exe（launch 前调用；5s 节流，不重复全量写） */
  apply(exePath: string): Promise<boolean>
  /** 读取设置状态 + 已写入注册表的条数（GpuPreference=2） */
  status(): Promise<{ enabled: boolean; entries: number }>
}

export function createGpuPlugin(): LauncherPlugin<void> {
  return definePlugin('gpu', () => (ctx) => {
    const log = use<LogService>(ctx, 'log')
    const settings = use<SettingsService>(ctx, 'settings')
    const java = use<JavaService>(ctx, 'java')

    const lastApply = new Map<string, number>()

    async function writePref(exePath: string, enabled: boolean): Promise<void> {
      const data = `GpuPreference=${enabled ? 2 : 0};`
      await execFileAsync('reg', ['add', REG_KEY, '/v', exePath, '/t', 'REG_SZ', '/d', data, '/f'], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      })
    }

    async function apply(exePath: string): Promise<boolean> {
      const enabled = settings.get('useHighPerformanceGpu')
      const key = `${exePath.toLowerCase()}\u0000${enabled ? '2' : '0'}`
      const now = Date.now()
      if (now - (lastApply.get(key) ?? 0) < THROTTLE_MS) return true
      try {
        await writePref(exePath, enabled)
        lastApply.set(key, now)
        return true
      } catch (err) {
        log.warn('gpu', '写入 GPU 偏好失败', { exePath, error: err instanceof Error ? err.message : String(err) })
        return false
      }
    }

    async function setEnabled(enabled: boolean): Promise<{ ok: boolean; applied: number; message?: string }> {
      settings.patch({ useHighPerformanceGpu: enabled })
      try {
        const runtimes = await java.detect(true)
        const targets = new Set<string>()
        for (const rt of runtimes) {
          targets.add(rt.path)
          const dir = path.dirname(rt.path)
          const base = path.basename(rt.path).toLowerCase()
          if (base === 'java.exe') targets.add(path.join(dir, 'javaw.exe'))
          else if (base === 'javaw.exe') targets.add(path.join(dir, 'java.exe'))
        }
        let applied = 0
        const failed: string[] = []
        for (const exe of targets) {
          try {
            await writePref(exe, enabled)
            applied += 1
          } catch {
            failed.push(exe)
          }
        }
        log.info('gpu', enabled ? '已启用高性能显卡' : '已关闭高性能显卡', { applied, failed: failed.length })
        return {
          ok: applied > 0,
          applied,
          message: failed.length > 0 ? `${failed.length} 条写入失败` : undefined,
        }
      } catch (err) {
        return { ok: false, applied: 0, message: err instanceof Error ? err.message : String(err) }
      }
    }

    async function status(): Promise<{ enabled: boolean; entries: number }> {
      const enabled = settings.get('useHighPerformanceGpu')
      let entries = 0
      try {
        const { stdout } = await execFileAsync('reg', ['query', REG_KEY], {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
        for (const line of stdout.split(/\r?\n/)) {
          if (/GpuPreference\s*=\s*2\s*;/i.test(line)) entries += 1
        }
      } catch {
        entries = 0
      }
      return { enabled, entries }
    }

    ctx.provide('gpu', {
      setEnabled,
      apply,
      status,
    } satisfies GpuService)
  })
}
