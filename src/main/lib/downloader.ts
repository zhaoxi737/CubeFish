/**
 * 下载器：断点续传 + sha1/size 校验 + 原子落盘 + 内容寻址缓存 + 并发 + 分片 + 取消。
 *
 * 设计要点（见 docs/RESEARCH-P1-P2.md §0、docs/P28-SPEC.md §2.3）：
 * - 先写 `.part`，校验通过再 rename，避免半截文件被误认为完整；
 * - sha1 同时是缓存 key：全局 cache/objects/xx/<sha1>，多实例/多版本复用；
 * - 缓存命中用硬链接（同卷），失败回退复制；
 * - P28：字节级实时进度 + 2s 滑动平均速度 + ETA；
 * - P28：大文件分片下载（先写 `${dest}.part.<i>`，全部完成后按序合并成 `.part`，
 *   再校验 sha1 再 rename），服务端 200/416 时自动回退单流；
 * - P28：`signal` 中断时清理所有临时文件并抛 AbortError（由上层计 cancelled）。
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ProgressFile } from '../../shared/types'
import { ensureDir, fileSize, sha1File } from './fsx'

export interface DownloadSpec {
  url: string
  dest: string
  sha1?: string
  size?: number
  label?: string
  /**
   * 备用地址（P28）：镜像同步滞后时 BMCLAPI 会对新文件返回 403/404，
   * 主地址不可用时自动改用该官方地址重试，避免整批安装失败。
   */
  fallbackUrl?: string
}

export interface DownloadStats {
  skipped: number
  downloaded: number
  bytes: number
  failed: DownloadSpec[]
}

/** 实时进度统计（P28）。旧调用方只用前 4 个参数，不受影响。 */
export interface DownloadProgressStats {
  /** 全部 spec 的 size 之和（未知按 0 计） */
  bytesTotal: number
  /** 最近 2s 滑动平均速度（字节/秒） */
  speed: number
  /** 预计剩余毫秒（总量未知或速度为 0 时省略） */
  etaMs?: number
  /** 当前正在下载的文件 label */
  currentFile?: string
  filesDone: number
  filesTotal: number
}

export interface DownloaderOptions {
  cacheDir: string
  /** 文件级并发（同时在处理的文件数），默认 8；总 socket 连接数上限为 concurrency * 2 */
  concurrency?: number
  /** 单文件分片数 1..16，默认 4 */
  threads?: number
  retries?: number
  userAgent?: string
  /** 外部取消信号：中断时清理临时文件并抛 AbortError */
  signal?: AbortSignal
  onProgress?: (done: number, total: number, bytes: number, label?: string, stats?: DownloadProgressStats) => void
  onVerbose?: (message: string, data?: unknown) => void
  // ---- P29：PCL 式文件级进度（可选，旧调用方不受影响） ----
  /** 下载开始前回调一次：本次要下的文件清单 */
  onFiles?: (files: { name: string; size?: number }[]) => void
  /** 单文件状态变化（含 running/done/failed/skipped），index 为 files 下标；≥100ms 合并一次 */
  onFileState?: (index: number, state: ProgressFile['state']) => void
}

const DEFAULT_UA = 'QDOQMC/0.1.0 (+https://qdoqmc.example/contact)'
const DEFAULT_THREADS = 4
/** 小于 4MB 的文件分片收益低，直接单流 */
const SHARD_THRESHOLD = 4 * 1024 * 1024
/** 每个分片至少 1MB，避免开一堆极小分片 */
const SHARD_MIN_CHUNK = 1024 * 1024
/** 单分片总尝试次数（首次 + 重试 2 次） */
const SHARD_ATTEMPTS = 3
/** progress 推送节流：每 200ms 最多一次 */
const PROGRESS_INTERVAL_MS = 200
/** 文件状态推送节流：至少 100ms 合并一次（P29） */
const FILE_STATE_INTERVAL_MS = 120
/** 速度统计窗口 */
const SPEED_WINDOW_MS = 2000
/** 空闲超时：60s 没有数据才放弃（慢网但仍在传输时不中断） */
const IDLE_TIMEOUT_MS = 60_000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 地址本身不可用（镜像缺文件/域名连不上）：值得立刻换备用地址重试。 */
function isSourceUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    /HTTP (403|404|410|451)\b/.test(message) ||
    message.includes('fetch failed') ||
    message.includes('下载超时') ||
    message.includes('Content-Range 不匹配')
  )
}

/** 取消错误：name 固定为 AbortError，便于上层 `isAbortError` 判定。 */
export function abortError(): DOMException {
  return new DOMException('已取消', 'AbortError')
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  )
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/** 计数信号量：限制同时在途的 socket 连接数。 */
class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  tryAcquire(): boolean {
    if (this.active < this.limit) {
      this.active += 1
      return true
    }
    return false
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // 名额直接转交给等待者，active 不变
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }
}

/** 服务端不支持 Range：上层据此回退单流。 */
class RangeUnsupportedError extends Error {
  constructor() {
    super('服务端不支持 Range 请求')
    this.name = 'RangeUnsupportedError'
  }
}

interface SpeedSample {
  at: number
  bytes: number
}

export class Downloader {
  private readonly cacheDir: string
  private readonly concurrency: number
  private readonly threads: number
  private readonly retries: number
  private readonly userAgent: string
  private readonly signal?: AbortSignal
  private readonly onProgress?: DownloaderOptions['onProgress']
  private readonly onVerbose?: DownloaderOptions['onVerbose']
  private readonly onFiles?: DownloaderOptions['onFiles']
  private readonly onFileState?: DownloaderOptions['onFileState']

  // ---- P29 文件级状态（≥100ms 合并；每次 downloadAll/fetchOne 重置） ----
  private pendingFileStates = new Map<number, ProgressFile['state']>()
  private fileStateTimer?: ReturnType<typeof setTimeout>
  private lastFileStateAt = 0

  // ---- P28 实时进度状态（每次 downloadAll 重置） ----
  private filesTotal = 0
  private filesDone = 0
  private completedBytes = 0
  private bytesTotal = 0
  private readonly activeBytes = new Map<number, number>()
  private currentLabel?: string
  private speedSamples: SpeedSample[] = []
  private lastEmitAt = 0

  constructor(options: DownloaderOptions) {
    this.cacheDir = options.cacheDir
    this.concurrency = clamp(options.concurrency ?? 8, 1, 16)
    this.threads = clamp(options.threads ?? DEFAULT_THREADS, 1, 16)
    this.retries = Math.max(1, options.retries ?? 3)
    this.userAgent = options.userAgent ?? DEFAULT_UA
    this.signal = options.signal
    this.onProgress = options.onProgress
    this.onVerbose = options.onVerbose
    this.onFiles = options.onFiles
    this.onFileState = options.onFileState
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

  private checkAborted(): void {
    throwIfAborted(this.signal)
  }

  /* ---------- P28：实时进度 / 速度 / ETA ---------- */

  private resetProgress(specs: DownloadSpec[]): void {
    this.filesTotal = specs.length
    this.filesDone = 0
    this.completedBytes = 0
    this.activeBytes.clear()
    this.bytesTotal = specs.reduce((sum, spec) => sum + (spec.size ?? 0), 0)
    this.currentLabel = undefined
    this.speedSamples = []
    this.lastEmitAt = 0
    this.resetFileStates()
  }

  /* ---------- P29：PCL 式文件清单 / 单文件状态 ---------- */

  private resetFileStates(): void {
    if (this.fileStateTimer) {
      clearTimeout(this.fileStateTimer)
      this.fileStateTimer = undefined
    }
    this.pendingFileStates.clear()
    this.lastFileStateAt = 0
  }

  /** 下载前一次性把文件清单交给上层（name 优先用 label）。 */
  private announceFiles(specs: DownloadSpec[]): void {
    this.onFiles?.(specs.map((spec) => ({ name: spec.label ?? path.basename(spec.dest), size: spec.size })))
  }

  /**
   * 文件状态合并推送：同一 index 同一窗口内只保留最新状态，
   * 每 ≥120ms 最多 flush 一次，避免逐字节/逐文件刷爆 IPC。
   */
  private queueFileState(index: number, state: ProgressFile['state']): void {
    if (!this.onFileState) return
    this.pendingFileStates.set(index, state)
    if (this.fileStateTimer) return
    const wait = Math.max(0, FILE_STATE_INTERVAL_MS - (Date.now() - this.lastFileStateAt))
    this.fileStateTimer = setTimeout(() => {
      this.fileStateTimer = undefined
      this.flushFileStates()
    }, wait)
  }

  private flushFileStates(): void {
    if (this.fileStateTimer) {
      clearTimeout(this.fileStateTimer)
      this.fileStateTimer = undefined
    }
    if (!this.onFileState || this.pendingFileStates.size === 0) return
    const entries = [...this.pendingFileStates.entries()]
    this.pendingFileStates.clear()
    this.lastFileStateAt = Date.now()
    for (const [index, state] of entries) this.onFileState(index, state)
  }

  private bytesNow(): number {
    let sum = this.completedBytes
    for (const value of this.activeBytes.values()) sum += value
    return sum
  }

  private computeSpeed(now: number, bytes: number): number {
    const windowStart = now - SPEED_WINDOW_MS
    let oldest: SpeedSample | undefined
    for (const sample of this.speedSamples) {
      if (sample.at >= windowStart) {
        oldest = sample
        break
      }
    }
    if (!oldest) oldest = this.speedSamples[this.speedSamples.length - 1] ?? { at: now, bytes }
    const elapsed = now - oldest.at
    if (elapsed < 250) return 0
    return Math.max(0, (bytes - oldest.bytes) / (elapsed / 1000))
  }

  /** 每 200ms 最多一次；force 用于阶段切换/完成。 */
  private emitProgress(label?: string, force = false): void {
    if (label) this.currentLabel = label
    const now = Date.now()
    if (!force && now - this.lastEmitAt < PROGRESS_INTERVAL_MS) return
    this.lastEmitAt = now
    const bytes = this.bytesNow()
    this.speedSamples.push({ at: now, bytes })
    while (this.speedSamples.length > 2 && now - this.speedSamples[0].at > SPEED_WINDOW_MS) {
      this.speedSamples.shift()
    }
    const speed = this.computeSpeed(now, bytes)
    const etaMs =
      this.bytesTotal > bytes && speed > 0
        ? Math.round(((this.bytesTotal - bytes) / speed) * 1000)
        : undefined
    this.onProgress?.(this.filesDone, this.filesTotal, bytes, this.currentLabel, {
      bytesTotal: this.bytesTotal,
      speed,
      etaMs,
      currentFile: this.currentLabel,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
    })
  }

  /** 已完成文件计入总字节；未知 size 时用实际写入量。 */
  private markCompleted(spec: DownloadSpec, index: number): void {
    this.completedBytes += spec.size ?? this.activeBytes.get(index) ?? 0
  }

  /** 单文件：已存在且校验通过则跳过；缓存命中直接链接。 */
  async fetchOne(spec: DownloadSpec): Promise<'skipped' | 'downloaded'> {
    this.resetProgress([spec])
    this.announceFiles([spec])
    this.queueFileState(0, 'running')
    const connections = new Semaphore(this.connectionLimit())
    try {
      const result = await this.fetchInternal(spec, 0, connections)
      this.queueFileState(0, result === 'skipped' ? 'skipped' : 'done')
      return result
    } catch (err) {
      if (!isAbortError(err)) this.queueFileState(0, 'failed')
      throw err
    } finally {
      this.activeBytes.delete(0)
      this.flushFileStates()
    }
  }

  /** 批量下载（并发池按文件计；进度含在途字节）。 */
  async downloadAll(specs: DownloadSpec[]): Promise<DownloadStats> {
    this.checkAborted()
    const stats: DownloadStats = { skipped: 0, downloaded: 0, bytes: 0, failed: [] }
    this.resetProgress(specs)
    this.announceFiles(specs)
    this.emitProgress(undefined, true)

    const connections = new Semaphore(this.connectionLimit())
    const workerCount = Math.min(this.concurrency, Math.max(1, specs.length))
    let cursor = 0
    let abortedError: unknown

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.signal?.aborted) {
          abortedError = abortError()
          return
        }
        const index = cursor
        cursor += 1
        if (index >= specs.length) return
        const spec = specs[index]
        this.queueFileState(index, 'running')
        try {
          const result = await this.fetchInternal(spec, index, connections)
          if (result === 'skipped') {
            stats.skipped += 1
            this.queueFileState(index, 'skipped')
          } else {
            stats.downloaded += 1
            stats.bytes += spec.size ?? 0
            this.queueFileState(index, 'done')
          }
        } catch (err) {
          if (isAbortError(err)) {
            abortedError = err
            return
          }
          stats.failed.push(spec)
          this.queueFileState(index, 'failed')
        } finally {
          this.activeBytes.delete(index)
          this.filesDone += 1
          this.emitProgress(spec.label)
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    this.flushFileStates()
    if (abortedError) throw abortedError
    this.filesDone = specs.length
    this.emitProgress('完成', true)
    return stats
  }

  /** 总 socket 连接上限：concurrency * 2（SPEC 2.3）。 */
  private connectionLimit(): number {
    return Math.max(1, this.concurrency * 2)
  }

  private async fetchInternal(
    spec: DownloadSpec,
    index: number,
    connections: Semaphore,
  ): Promise<'skipped' | 'downloaded'> {
    this.checkAborted()
    if (spec.label) this.currentLabel = spec.label

    if (await this.verify(spec.dest, spec)) {
      this.markCompleted(spec, index)
      return 'skipped'
    }

    const cacheFile = this.cachePathOf(spec.sha1)
    if (cacheFile && (await this.verify(cacheFile, spec))) {
      await this.placeFromCache(cacheFile, spec.dest)
      this.markCompleted(spec, index)
      return 'downloaded'
    }

    await ensureDir(path.dirname(spec.dest))
    const part = `${spec.dest}.part`
    // 主地址 + 可选备用地址（镜像缺文件时回退官方）
    const urls = spec.fallbackUrl && spec.fallbackUrl !== spec.url ? [spec.url, spec.fallbackUrl] : [spec.url]
    let lastError: unknown

    for (let sourceIndex = 0; sourceIndex < urls.length; sourceIndex += 1) {
      const effective: DownloadSpec =
        sourceIndex === 0 ? spec : { ...spec, url: urls[sourceIndex], fallbackUrl: undefined }
      if (sourceIndex > 0) {
        this.onVerbose?.('主下载源不可用，回退备用地址重试', {
          label: spec.label,
          primary: urls[0],
          fallback: urls[sourceIndex],
        })
      }
      for (let attempt = 1; attempt <= this.retries; attempt += 1) {
        this.checkAborted()
        try {
          // 断点续传：只有 `.part` 比目标小的已知大小时才续传，否则重头
          const existing = (await fileSize(part)) ?? 0
          const resumeFrom = existing > 0 && spec.size !== undefined && existing < spec.size ? existing : 0

          await this.downloadFile(effective, part, resumeFrom, index, connections)

          if (!(await this.verify(part, spec))) {
            throw new Error(`校验失败（sha1/size 不匹配）: ${spec.label ?? path.basename(spec.dest)}`)
          }

          await rename(part, spec.dest)
          if (cacheFile) await this.storeIntoCache(spec.dest, cacheFile)
          this.markCompleted(spec, index)
          return 'downloaded'
        } catch (err) {
          if (isAbortError(err)) {
            // 取消：清理 `.part` 与所有分片临时文件后向上抛
            await this.cleanupTemps(spec.dest)
            throw err
          }
          lastError = err
          this.onVerbose?.(`下载失败（第 ${attempt}/${this.retries} 次）`, {
            url: effective.url,
            error: String(err),
          })
          this.activeBytes.set(index, 0)
          await rm(part, { force: true }).catch(() => undefined)
          // 地址不可用就不必在原地址上耗完重试，直接换备用地址
          if (isSourceUnavailable(err) && sourceIndex < urls.length - 1) break
          if (attempt < this.retries) await delay(400 * 2 ** (attempt - 1))
        }
      }
    }
    throw new Error(
      `下载失败: ${spec.label ?? spec.url} — ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }

  /**
   * 单文件实际下载：大文件优先分片；服务端不支持 Range 时回退单流。
   * 分片时为文件占多个连接名额，单流占 1 个。
   */
  private async downloadFile(
    spec: DownloadSpec,
    part: string,
    resumeFrom: number,
    index: number,
    connections: Semaphore,
  ): Promise<void> {
    const size = spec.size ?? 0
    const shardable = resumeFrom === 0 && size >= SHARD_THRESHOLD && this.threads > 1

    if (!shardable) {
      await connections.acquire()
      try {
        this.checkAborted()
        await this.fetchStream(spec, part, resumeFrom, index)
      } finally {
        connections.release()
      }
      return
    }

    const maxShards = Math.min(this.threads, Math.max(2, Math.floor(size / SHARD_MIN_CHUNK)))
    const slots = await this.acquireShardSlots(connections, maxShards)
    let held = slots
    try {
      if (slots >= 2) {
        const supported = await this.fetchRanged(spec, part, slots, index)
        if (supported) return
        // 服务端返回 200/416：退回单流，释放多余名额
        for (let i = 1; i < held; i += 1) connections.release()
        held = 1
      }
      this.checkAborted()
      await this.fetchStream(spec, part, 0, index)
    } finally {
      for (let i = 0; i < held; i += 1) connections.release()
    }
  }

  /** 先阻塞占 1 个名额，再尽量多占；占不到就少开几片（不死锁）。 */
  private async acquireShardSlots(connections: Semaphore, maxShards: number): Promise<number> {
    await connections.acquire()
    let slots = 1
    while (slots < maxShards && connections.tryAcquire()) slots += 1
    return slots
  }

  /** 单流下载（断点续传 + 空闲超时 + 实时字节回调）。 */
  private async fetchStream(spec: DownloadSpec, part: string, resumeFrom: number, index: number): Promise<void> {
    const headers: Record<string, string> = { 'user-agent': this.userAgent }
    if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`

    const idle = new AbortController()
    const combined = this.signal ? AbortSignal.any([this.signal, idle.signal]) : idle.signal
    let lastActivity = Date.now()
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) idle.abort()
    }, 5000)

    try {
      let res: Response
      try {
        res = await fetch(spec.url, { headers, signal: combined })
      } catch (err) {
        throw this.classifyAbort(err, idle)
      }
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      if (resumeFrom > 0 && res.status === 200) {
        await rm(part, { force: true }) // 服务端不支持 Range，重头来
      }
      const append = resumeFrom > 0 && res.status === 206
      const body = res.body
      if (!body) throw new Error('响应没有 body')

      let written = resumeFrom
      const source = Readable.fromWeb(body as any)
      source.on('data', (chunk: Buffer) => {
        written += chunk.length
        this.activeBytes.set(index, written)
        lastActivity = Date.now()
        this.emitProgress(spec.label)
      })
      try {
        await pipeline(source, createWriteStream(part, { flags: append ? 'a' : 'w' }))
      } catch (err) {
        throw this.classifyAbort(err, idle)
      }
    } finally {
      clearInterval(idleTimer)
    }
  }

  /** 把本进程主动取消与空闲超时区分开：前者直接抛 AbortError，后者按可重试错误处理。 */
  private classifyAbort(err: unknown, idle: AbortController): unknown {
    if (this.signal?.aborted) return abortError()
    if (idle.signal.aborted && isAbortError(err)) return new Error('下载超时（60 秒无数据）')
    return err
  }

  /**
   * 分片下载：先并发写 `${part}.<i>`，全部成功后按序合并为 `${part}`。
   * 返回 false 表示服务端不支持 Range（调用方回退单流）。
   */
  private async fetchRanged(spec: DownloadSpec, part: string, shards: number, index: number): Promise<boolean> {
    const size = spec.size ?? 0
    const chunk = Math.ceil(size / shards)
    const shardParts = Array.from({ length: shards }, (_, i) => `${part}.${i}`)
    const shardBytes = new Array<number>(shards).fill(0)

    this.checkAborted()
    try {
      await Promise.all(
        Array.from({ length: shards }, (_, i) => {
          const start = i * chunk
          const end = Math.min(size - 1, start + chunk - 1)
          return this.fetchShard(spec, shardParts, i, start, end, shardBytes, index)
        }),
      )
    } catch (err) {
      await this.removeShardParts(shardParts)
      if (err instanceof RangeUnsupportedError) return false
      throw err
    }

    try {
      await this.mergeShards(part, shardParts)
    } finally {
      await this.removeShardParts(shardParts)
    }
    return true
  }

  /** 单个分片：任一分片失败重试 2 次（共 3 次尝试），最终失败由调用方清理。 */
  private async fetchShard(
    spec: DownloadSpec,
    shardParts: string[],
    shardIndex: number,
    start: number,
    end: number,
    shardBytes: number[],
    index: number,
  ): Promise<void> {
    const file = shardParts[shardIndex]
    const expected = end - start + 1
    let lastError: unknown

    for (let attempt = 1; attempt <= SHARD_ATTEMPTS; attempt += 1) {
      this.checkAborted()
      try {
        shardBytes[shardIndex] = 0
        this.activeBytes.set(
          index,
          shardBytes.reduce((sum, value) => sum + value, 0),
        )
        await rm(file, { force: true })

        const signal = this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000)
        const res = await fetch(spec.url, {
          headers: { 'user-agent': this.userAgent, range: `bytes=${start}-${end}` },
          signal,
        })
        if (res.status === 200 || res.status === 416) {
          await res.body?.cancel().catch(() => undefined)
          throw new RangeUnsupportedError()
        }
        if (res.status !== 206) throw new Error(`分片 HTTP ${res.status} ${res.statusText}`)
        const contentRange = res.headers.get('content-range')
        if (contentRange && !contentRange.startsWith(`bytes ${start}-`)) {
          throw new Error(`Content-Range 不匹配: ${contentRange}`)
        }
        const body = res.body
        if (!body) throw new Error('响应没有 body')

        const source = Readable.fromWeb(body as any)
        source.on('data', (chunk: Buffer) => {
          shardBytes[shardIndex] += chunk.length
          this.activeBytes.set(
            index,
            shardBytes.reduce((sum, value) => sum + value, 0),
          )
          this.emitProgress(spec.label)
        })
        await pipeline(source, createWriteStream(file, { flags: 'w' }))

        const written = (await fileSize(file)) ?? 0
        if (written !== expected) throw new Error(`分片大小不符：${written}/${expected}`)
        return
      } catch (err) {
        if (err instanceof RangeUnsupportedError) throw err
        if (this.signal?.aborted) throw abortError()
        lastError = err
        this.onVerbose?.(`分片 ${shardIndex} 下载失败（第 ${attempt}/${SHARD_ATTEMPTS} 次）`, {
          url: spec.url,
          start,
          end,
          error: String(err),
        })
        await rm(file, { force: true }).catch(() => undefined)
        if (attempt < SHARD_ATTEMPTS) await delay(300 * attempt)
      }
    }
    throw new Error(
      `分片下载失败: ${spec.label ?? spec.url} — ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }

  /** 按序合并分片为 `.part`（不校验，校验由 fetchInternal 统一做）。 */
  private async mergeShards(part: string, shardParts: string[]): Promise<void> {
    const out = createWriteStream(part, { flags: 'w' })
    try {
      for (const file of shardParts) {
        this.checkAborted()
        await pipeline(createReadStream(file), out, { end: false })
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
  }

  private async removeShardParts(files: string[]): Promise<void> {
    await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)))
  }

  /** 清理 `${dest}.part` 与所有 `${dest}.part.<i>`。 */
  private async cleanupTemps(dest: string): Promise<void> {
    const dir = path.dirname(dest)
    const base = path.basename(dest)
    this.activeBytes.clear()
    try {
      const names = await readdir(dir)
      await Promise.all(
        names
          .filter((name) => name === `${base}.part` || name.startsWith(`${base}.part.`))
          .map((name) => rm(path.join(dir, name), { force: true }).catch(() => undefined)),
      )
    } catch {
      /* 目录不存在：忽略 */
    }
  }
}

export async function statSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}
