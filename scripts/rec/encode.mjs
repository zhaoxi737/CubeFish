#!/usr/bin/env node
/**
 * 把 CDP 录屏的 PNG 序列编码成恒定 30fps 的 H.264 mp4。
 *
 *   node scripts/rec/encode.mjs --all
 *   node scripts/rec/encode.mjs --scene=home
 *
 * 关键点：CDP screencast 是**变帧率**的（页面静止时 Chromium 不推帧），
 * 直接把 frame_*.png 按 30fps 播会变成快放。所以这里先按 meta.json 里每帧的
 * 时间戳，把帧重采样成严格 30fps 的序列 out/rec/<scene>/cfr30/frame_%06d.png
 * （静止段 hold 最后一帧），再喂给 ffmpeg：
 *
 *   ffmpeg -framerate 30 -i frame_%06d.png -c:v libx264 -crf 14 -pix_fmt yuv420p \
 *          -movflags +faststart out.mp4
 *
 * 产物：video/public/rec/<scene>.mp4 + video/public/rec/<scene>.events.json
 *      + out/rec/review/<scene>_a|b|c.png（3 张代表帧，优先用录制时 mark 的时间点）
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const REC_DIR = path.join(ROOT, 'out', 'rec')
const PUBLIC_REC = path.join(ROOT, 'video', 'public', 'rec')
const REVIEW_DIR = path.join(REC_DIR, 'review')
const FFMPEG = path.join(ROOT, 'video', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const FPS = 30
const ALL_SCENES = ['home', 'versions', 'download', 'logs', 'ai']

// 每个场景抽 3 张代表帧给结尾拼贴用（秒）；超出实际时长会自动截到片尾前 0.1s
const REVIEW_TIMES = {
  home: [2.0, 3.4, 6.4],
  versions: [3.2, 6.2, 7.9],
  download: [3.3, 7.2, 9.4],
  logs: [2.6, 4.4, 6.2],
  ai: [4.3, 5.9, 8.6],
}

function parseArgs(argv) {
  const out = { scenes: [], all: false }
  for (const arg of argv) {
    if (arg === '--all') out.all = true
    else if (arg.startsWith('--scene=')) out.scenes.push(arg.slice('--scene='.length))
  }
  if (out.all) out.scenes = [...ALL_SCENES]
  if (out.scenes.length === 0) out.scenes = [...ALL_SCENES]
  return out
}

const log = (...args) => console.log('[encode]', ...args)

/** 按时间戳重采样到 30fps；返回写入的帧数 */
function resampleToCfr(sceneDir, meta) {
  const frames = meta.frames ?? []
  if (frames.length === 0) throw new Error(`${sceneDir} 没有帧`)
  const frameExt = meta.frameExt ?? path.extname(frames[0].file).replace('.', '') ?? 'jpg'
  const outDir = path.join(sceneDir, 'cfr30')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const duration = Math.max(meta.duration ?? 0, frames[frames.length - 1].t + 1 / FPS)
  const count = Math.max(1, Math.round(duration * FPS))
  let cursor = 0
  let linked = 0
  let copied = 0
  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / FPS // 取该输出帧中点时刻之前的最后一帧（静止段 hold 住）
    while (cursor + 1 < frames.length && frames[cursor + 1].t <= t) cursor += 1
    const src = path.join(sceneDir, frames[cursor].file)
    const dst = path.join(outDir, `frame_${String(i + 1).padStart(6, '0')}.${frameExt}`)
    try {
      linkSync(src, dst)
      linked += 1
    } catch {
      copyFileSync(src, dst)
      copied += 1
    }
  }
  return { count, duration, frameExt, linked, copied }
}

function runFfmpeg(args) {
  const result = spawnSync(FFMPEG, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  return result
}

function probeDuration(file) {
  const result = runFfmpeg(['-hide_banner', '-i', file])
  const text = `${result.stderr || ''}${result.stdout || ''}`
  const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const video = text.match(/Video:.*?(\d{2,4})x(\d{2,4}).*?, (\d+(?:\.\d+)?) fps/)
  return {
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    width: video ? Number(video[1]) : null,
    height: video ? Number(video[2]) : null,
    fps: video ? Number(video[3]) : null,
  }
}

/** 从成片里抽 3 张代表帧到 out/rec/review/<scene>_a|b|c.png（优先用录制时打的 hints 时间点） */
function extractReviewFrames(scene, mp4, duration, meta) {
  mkdirSync(REVIEW_DIR, { recursive: true })
  const fallback = [0.25, 0.55, 0.85].map((p) => p * (duration ?? 6))
  const configured = REVIEW_TIMES[scene] ?? fallback
  const hinted = new Map((meta?.hints ?? []).map((h) => [h.label, h.t]))
  const labels = ['a', 'b', 'c']
  const files = []
  for (let i = 0; i < labels.length; i += 1) {
    const desired = hinted.has(labels[i]) ? hinted.get(labels[i]) : configured[i]
    const seek = Math.max(0, Math.min(desired ?? fallback[i], (duration ?? 6) - 0.1))
    const file = path.join(REVIEW_DIR, `${scene}_${labels[i]}.png`)
    const result = runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', seek.toFixed(3),
      '-i', mp4,
      '-frames:v', '1',
      file,
    ])
    if (result.status !== 0) {
      log(`⚠️ 抽代表帧失败 ${scene}_${labels[i]}：${result.stderr || ''}`)
    } else {
      files.push(file)
    }
  }
  if (files.length > 0) log(`${scene}: 代表帧 ${files.map((f) => path.basename(f)).join(', ')}`)
  return files
}

function encodeScene(scene) {
  const sceneDir = path.join(REC_DIR, scene)
  const metaPath = path.join(sceneDir, 'meta.json')
  if (!existsSync(metaPath)) throw new Error(`缺少 ${metaPath}（先运行 drive.mjs --scene=${scene}）`)
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const { count, duration, frameExt } = resampleToCfr(sceneDir, meta)
  const cfrDir = path.join(sceneDir, 'cfr30')
  const output = path.join(PUBLIC_REC, `${scene}.mp4`)
  mkdirSync(PUBLIC_REC, { recursive: true })

  log(
    `${scene}: 源 ${meta.frameCount} 帧 / ${meta.duration}s（平均 ${meta.avgFps}fps，${meta.format ?? 'png'} q${meta.quality ?? '-'}）` +
      ` → 重采样 ${count} 帧 @${FPS}fps (${duration.toFixed(3)}s)`,
  )
  const started = Date.now()
  const result = runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(cfrDir, `frame_%06d.${frameExt}`),
    '-c:v', 'libx264',
    '-crf', '14',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    output,
  ])
  if (result.status !== 0) {
    throw new Error(`ffmpeg 编码 ${scene} 失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }

  // 复制输入事件表给 Remotion 用
  const eventsSrc = path.join(sceneDir, 'events.json')
  if (existsSync(eventsSrc)) {
    copyFileSync(eventsSrc, path.join(PUBLIC_REC, `${scene}.events.json`))
  } else {
    log(`⚠️ ${scene} 没有 events.json，跳过复制`)
  }

  const info = probeDuration(output)
  const size = statSync(output).size
  extractReviewFrames(scene, output, info.seconds, meta)
  log(
    `${scene}: ✅ ${output}  ${(size / 1024 / 1024).toFixed(2)} MB  ` +
      `${info.seconds?.toFixed(3) ?? '?'}s  ${info.width}×${info.height}  ${info.fps ?? '?'} fps  ` +
      `编码耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
  return { scene, output, frames: count, seconds: info.seconds, width: info.width, height: info.height, fps: info.fps, size }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(FFMPEG)) throw new Error(`找不到 ffmpeg-static：${FFMPEG}`)
  const results = []
  const failures = []
  for (const scene of args.scenes) {
    try {
      results.push(encodeScene(scene))
    } catch (err) {
      failures.push({ scene, error: err.message })
      console.error(`[encode] ${scene} 失败：${err.message}`)
    }
  }
  console.log('\n===== 编码汇总 =====')
  for (const r of results) {
    console.log(`${r.scene.padEnd(9)} ${r.seconds?.toFixed(3)}s  ${r.width}×${r.height}  ${r.fps} fps  ${(r.size / 1024 / 1024).toFixed(2)} MB`)
  }
  if (failures.length > 0) {
    console.error(`失败 ${failures.length} 个：${failures.map((f) => f.scene).join(', ')}`)
    process.exit(1)
  }
}

try {
  main()
} catch (err) {
  console.error('[encode] 失败:', err?.message ?? err)
  process.exit(1)
}
