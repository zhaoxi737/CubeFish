/**
 * 下载器：断点续传 + sha1/size 校验 + 原子落盘 + 内容寻址缓存 + 并发。
 *
 * 设计要点（见 docs/RESEARCH-P1-P2.md §0）：
 * - 先写 `.part`，校验通过再 rename，避免半截文件被误认为完整；
 * - sha1 同时是缓存 key：全局 cache/objects/xx/<sha1>，多实例/多版本复用；
 * - 缓存命中用硬链接（同卷），失败回退复制。
 */
import { createWriteStream } from 'node:fs'
import { copyFile, link, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ensureDir, fileSize, sha1File } from './fsx'

export interface DownloadSpec {
  url: string
  dest: string
  sha1?: string
  size?: number
  label?: string
}

export interface DownloadStats {
  skipped: number
  downloaded: number
  bytes: number
  failed: DownloadSpec[]
}

export interface DownloaderOptions {
  cacheDir: string
  concurrency?: number
  retries?: number
  userAgent?: string
  onProgress?: (done: number, total: number, bytes: number, label?: string) => void
  onVerbose?: (message: string, data?: unknown) => void
}

const DEFAULT_UA = 'QDOQMC/0.1.0 (+https://qdoqmc.example/contact)'

export class Downloader {
  private readonly cacheDir: string
  private readonly concurrency: number
  private readonly retries: number
  private readonly userAgent: string
  private readonly onProgress?: DownloaderOptions['onProgress']
  private readonly onVerbose?: DownloaderOptions['onVerbose']

  constructor(options: DownloaderOptions) {
    this.cacheDir = options.cacheDir
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 16))
    this.retries = Math.max(1, options.retries ?? 3)
    this.userAgent = options.userAgent ?? DEFAULT_UA
    this.onProgress = options.onProgress
    this.onVerbose = options.onVerbose
  }

  private async verify(file: string, spec: DownloadSpec): Promise<boolean> {
    const size = await fileSize(file)
    if (size === undefined) return false
    if (spec.size !== undefined && size !== spec.size) return false
    if (spec.sha1) return (await sha1File(file)) === spec.sha1.toLowerCase()
    return true
  }

  private cachePathOf(sha1?: string): string | undefined {
    if (!sha1) return undefined
    return path.join(this.cacheDir, sha1.slice(0, 2), sha1.toLowerCase())
  }

  private async placeFromCache(cacheFile: string, dest: string): Promise<void> {
    await ensureDir(path.dirname(dest))
    await rm(dest, { force: true })
    try {
      await link(cacheFile, dest)
    } catch {
      await copyFile(cacheFile, dest)
    }
  }

  private async storeIntoCache(source: string, cacheFile: string): Promise<void> {
    await ensureDir(path.dirname(cacheFile))
    if (await this.verify(cacheFile, { url: '', dest: cacheFile, sha1: path.basename(cacheFile) })) return
    await rm(cacheFile, { force: true })
    try {
      await link(source, cacheFile)
    } catch {
      await copyFile(source, cacheFile)
    }
  }

  /** 单文件：已存在且校验通过则跳过；缓存命中直接链接。 */
  async fetchOne(spec: DownloadSpec): Promise<'skipped' | 'downloaded'> {
    if (await this.verify(spec.dest, spec)) return 'skipped'

    const cacheFile = this.cachePathOf(spec.sha1)
    if (cacheFile && (await this.verify(cacheFile, spec))) {
      await this.placeFromCache(cacheFile, spec.dest)
      return 'downloaded'
    }

    await ensureDir(path.dirname(spec.dest))
    const part = `${spec.dest}.part`
    let lastError: unknown

    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      try {
        const existing = (await fileSize(part)) ?? 0
        const resumeFrom = existing > 0 && spec.size !== undefined && existing < spec.size ? existing : 0

        const headers: Record<string, string> = { 'user-agent': this.userAgent }
        if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`

        // 空闲超时：慢网下大文件可能需要很久，只要还有数据就不中断；60s 无数据才放弃。
        const controller = new AbortController()
        let lastActivity = Date.now()
        const idleTimer = setInterval(() => {
          if (Date.now() - lastActivity > 60_000) controller.abort()
        }, 5000)

        let res: Response
        try {
          res = await fetch(spec.url, { headers, signal: controller.signal })
        } catch (err) {
          clearInterval(idleTimer)
          throw err
        }
        if (!res.ok && res.status !== 206) {
          clearInterval(idleTimer)
          throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }

        if (resumeFrom > 0 && res.status === 200) {
          await rm(part, { force: true }) // 服务端不支持 Range，重头来
        }

        const append = resumeFrom > 0 && res.status === 206
        const body = res.body
        if (!body) {
          clearInterval(idleTimer)
          throw new Error('响应没有 body')
        }

        const source = Readable.fromWeb(body as any)
        source.on('data', () => {
          lastActivity = Date.now()
        })
        try {
          await pipeline(source, createWriteStream(part, { flags: append ? 'a' : 'w' }))
        } finally {
          clearInterval(idleTimer)
        }

        if (!(await this.verify(part, spec))) {
          throw new Error(`校验失败（sha1/size 不匹配）: ${spec.label ?? path.basename(spec.dest)}`)
        }

        await rename(part, spec.dest)
        if (cacheFile) await this.storeIntoCache(spec.dest, cacheFile)
        return 'downloaded'
      } catch (err) {
        lastError = err
        this.onVerbose?.(`下载失败（第 ${attempt}/${this.retries} 次）`, { url: spec.url, error: String(err) })
        await rm(part, { force: true }).catch(() => undefined)
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)))
        }
      }
    }
    throw new Error(`下载失败: ${spec.label ?? spec.url} — ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  /** 批量下载（并发池按文件计；进度按完成数回调）。 */
  async downloadAll(specs: DownloadSpec[]): Promise<DownloadStats> {
    const stats: DownloadStats = { skipped: 0, downloaded: 0, bytes: 0, failed: [] }
    const total = specs.length
    let done = 0
    let bytes = 0
    let cursor = 0
    let lastEmit = 0

    const emit = (label?: string) => {
      const now = Date.now()
      if (now - lastEmit < 200 && done < total) return
      lastEmit = now
      this.onProgress?.(done, total, bytes, label)
    }

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= specs.length) return
        const spec = specs[index]
        try {
          const result = await this.fetchOne(spec)
          if (result === 'skipped') stats.skipped += 1
          else {
            stats.downloaded += 1
            bytes += spec.size ?? 0
            stats.bytes += spec.size ?? 0
          }
        } catch {
          stats.failed.push(spec)
        } finally {
          done += 1
          emit(spec.label)
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, total)) }, () => worker()))
    this.onProgress?.(total, total, bytes, '完成')
    return stats
  }
}

export async function statSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}
