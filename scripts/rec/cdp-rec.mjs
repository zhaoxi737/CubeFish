#!/usr/bin/env node
/**
 * CDP 录屏器：把 Electron 渲染进程的 screencast 存成 PNG 序列 + events.json + meta.json。
 *
 *   node scripts/rec/cdp-rec.mjs --port=9411 --scene=home --out=out/rec/home --duration=6
 *
 * 参数：
 *   --port=9411          CDP 端口（app 需要带 --remote-debugging-port=9411 启动）
 *   --scene=home         场景名（写进 meta.json）
 *   --out=out/rec/home   输出目录（相对仓库根；会清空同名目录后重建）
 *   --duration=6         可选：独立录制 N 秒后自动停止；不传则 Ctrl+C 停止
 *   --format=jpeg        帧格式：jpeg（默认，1600×1000 实测 ~47fps）或 png（实测仅 ~9fps）
 *   --quality=95         jpeg 质量
 *
 * 说明：
 * - Emulation.setDeviceMetricsOverride 强制 1600×1000 / dsf=1 / mobile=false，
 *   与真实窗口大小无关，保证所有素材尺寸一致。
 * - 每收到一帧立刻 Page.screencastFrameAck，否则 Chromium 不再推下一帧。
 * - 帧时间取 metadata.timestamp，驱动脚本录完后再按时间戳重采样成恒定 30fps。
 * - 实测：PNG q100 在 1600×1000 详情页只有 ~9fps（PNG 编码是瓶颈），
 *   JPEG q95 能到 ~47fps、q90 ~59fps，因此默认用 jpeg。最终 H.264 编码质量足够。
 *
 * 也导出 ScreencastRecorder 供 drive.mjs 在进程内使用（可 pushEvent 记录输入事件）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, waitForPageTarget } from './cdp-client.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const VIEWPORT = { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }

const round3 = (n) => Math.round(n * 1000) / 1000

/** 强制 1600×1000 视口（与真实窗口大小无关） */
export async function configureViewport(client, viewport = VIEWPORT) {
  await client.call('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  })
  // 某些 Electron 版本没有 setVisibleSize，失败可忽略
  await client.call('Emulation.setVisibleSize', { width: viewport.width, height: viewport.height }).catch(() => undefined)
}

export class ScreencastRecorder {
  /**
   * @param {{port?:number, scene:string, outDir:string, viewport?:typeof VIEWPORT, log?:Function, client?:import('./cdp-client.mjs').CdpClient, format?:'jpeg'|'png', quality?:number}} options
   */
  constructor({ port = 9411, scene, outDir, viewport = VIEWPORT, log = console.log, client = null, format = 'jpeg', quality = 95 }) {
    this.port = port
    this.scene = scene
    this.outDir = path.isAbsolute(outDir) ? outDir : path.join(ROOT, outDir)
    this.viewport = viewport
    this.log = log
    this.client = client
    this.ownsClient = !client
    this.format = format
    this.quality = quality
    this.frameExt = format === 'png' ? 'png' : 'jpg'
    this._offFrame = null
    this.frames = []
    this.events = []
    this.hints = []
    this.pendingWrites = new Set()
    this.t0Mono = null
    this.t0Wall = null
    this.startedAt = null
    this.stopped = false
    this._resolveFirstFrame = null
    this.ackCount = 0
    this.frameErrors = 0
  }

  async connect() {
    if (!this.client) {
      const page = await waitForPageTarget(this.port)
      this.client = await CdpClient.connect(page.webSocketDebuggerUrl)
      await this.client.call('Page.enable')
      await this.client.call('Runtime.enable')
      await configureViewport(this.client, this.viewport)
    }
    if (!this._offFrame) this._offFrame = this.client.on('Page.screencastFrame', (params) => this.#onFrame(params))
    await this.client.call('Page.bringToFront').catch(() => undefined)
    return this
  }

  #onFrame(params) {
    const { data, sessionId, metadata } = params
    // 必须先 ack，Chromium 才会继续推下一帧
    this.client
      .call('Page.screencastFrameAck', { sessionId })
      .then(() => {
        this.ackCount += 1
      })
      .catch(() => undefined)

    const index = this.frames.length + 1
    const file = `frame_${String(index).padStart(6, '0')}.${this.frameExt}`
    const buffer = Buffer.from(data, 'base64')
    const record = {
      index,
      file,
      t: 0,
      timestamp: metadata.timestamp,
      width: metadata.deviceWidth,
      height: metadata.deviceHeight,
      bytes: buffer.length,
    }
    if (this.t0Mono == null) {
      // 第一帧定义为 t=0
      this.t0Mono = metadata.timestamp
      this.t0Wall = Date.now()
      record.t = 0
      const resolve = this._resolveFirstFrame
      this._resolveFirstFrame = null
      if (resolve) resolve(record)
    } else {
      record.t = round3(metadata.timestamp - this.t0Mono)
    }
    this.frames.push(record)

    const job = writeFile(path.join(this.outDir, file), buffer)
      .catch((err) => {
        this.frameErrors += 1
        this.log(`[rec] 写帧失败 ${file}: ${err.message}`)
      })
      .finally(() => this.pendingWrites.delete(job))
    this.pendingWrites.add(job)
  }

  /** 开始 screencast；等第一帧到达后返回（此时 t=0） */
  async start() {
    if (!this.client) await this.connect()
    if (existsSync(this.outDir)) rmSync(this.outDir, { recursive: true, force: true })
    mkdirSync(this.outDir, { recursive: true })
    this.startedAt = new Date().toISOString()
    this.frames = []
    this.events = []
    this.hints = []
    this.ackCount = 0
    this.frameErrors = 0
    this.stopped = false
    this.t0Mono = null
    this.t0Wall = null
    const first = new Promise((resolve) => {
      this._resolveFirstFrame = resolve
    })
    await this.client.call('Page.startScreencast', {
      format: this.format,
      quality: this.quality,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1,
    })
    return Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error('等待 screencast 第一帧超时（8s）')), 8000)),
    ])
  }

  /** 相对第一帧的秒数（events.json 的 t 用这个） */
  now() {
    return this.t0Wall == null ? 0 : round3((Date.now() - this.t0Wall) / 1000)
  }

  /** 记录一条输入事件 */
  pushEvent(event) {
    this.events.push({
      t: event.t ?? this.now(),
      kind: event.kind,
      x: Math.round(event.x ?? 0),
      y: Math.round(event.y ?? 0),
      ...(event.text !== undefined ? { text: event.text } : {}),
    })
  }

  /** 打一个代表帧时间点（encode 时按这个时间抽 review 帧） */
  mark(label) {
    this.hints.push({ label, t: this.now() })
    return this.hints[this.hints.length - 1]
  }

  async stop() {
    if (this.stopped) return this.summary()
    this.stopped = true
    const duration = this.now()
    await this.client?.call('Page.stopScreencast').catch(() => undefined)
    await Promise.allSettled([...this.pendingWrites])

    writeFileSync(path.join(this.outDir, 'events.json'), `${JSON.stringify(this.events, null, 2)}\n`, 'utf8')

    const frameCount = this.frames.length
    const meta = {
      scene: this.scene,
      port: this.port,
      viewport: this.viewport,
      format: this.format,
      quality: this.quality,
      frameExt: this.frameExt,
      startedAt: this.startedAt,
      duration: round3(duration),
      frameCount,
      lastFrameT: frameCount > 0 ? this.frames[frameCount - 1].t : 0,
      avgFps: duration > 0 ? Math.round((frameCount / duration) * 10) / 10 : 0,
      frameWidth: this.frames[0]?.width ?? null,
      frameHeight: this.frames[0]?.height ?? null,
      ackCount: this.ackCount,
      frameErrors: this.frameErrors,
      events: this.events.length,
      hints: this.hints,
      frames: this.frames,
    }
    writeFileSync(path.join(this.outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    this._offFrame?.()
    this._offFrame = null
    if (this.ownsClient) this.client?.close()
    return this.summary()
  }

  summary() {
    const frameCount = this.frames.length
    const duration = this.now()
    return {
      scene: this.scene,
      outDir: this.outDir,
      duration: round3(duration),
      frameCount,
      avgFps: duration > 0 ? Math.round((frameCount / duration) * 10) / 10 : 0,
      events: this.events.length,
      frameWidth: this.frames[0]?.width ?? null,
      frameHeight: this.frames[0]?.height ?? null,
      frameErrors: this.frameErrors,
    }
  }
}

// ---------------------------------------------------------------------------
// CLI 模式
// ---------------------------------------------------------------------------
async function cli() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((arg) => arg.startsWith('--'))
      .map((arg) => {
        const [key, ...rest] = arg.slice(2).split('=')
        return [key, rest.join('=')]
      }),
  )
  const port = Number(args.port ?? 9411)
  const scene = args.scene ?? 'scene'
  const outDir = args.out ?? `out/rec/${scene}`
  const duration = args.duration != null ? Number(args.duration) : null
  const format = args.format === 'png' ? 'png' : 'jpeg'
  const quality = args.quality != null ? Number(args.quality) : 95

  const recorder = new ScreencastRecorder({ port, scene, outDir, format, quality })
  const first = await recorder.start()
  console.log(`[rec] 开始录制 scene=${scene} ${format} q${quality} 首帧 ${first.width}x${first.height} → ${recorder.outDir}`)

  if (duration != null && Number.isFinite(duration)) {
    await new Promise((resolve) => setTimeout(resolve, duration * 1000))
    const summary = await recorder.stop()
    console.log('[rec] 完成', JSON.stringify(summary))
    return
  }

  console.log('[rec] 录制中… Ctrl+C 停止')
  await new Promise((resolve) => {
    const stop = async () => {
      process.off('SIGINT', stop)
      const summary = await recorder.stop()
      console.log('[rec] 完成', JSON.stringify(summary))
      resolve()
    }
    process.on('SIGINT', stop)
  })
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  cli().catch((err) => {
    console.error('[rec] 失败:', err?.message ?? err)
    process.exit(1)
  })
}
