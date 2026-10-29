/**
 * P29 验收脚本：文件级下载进度 + 模组更新检查 + 图片预览（+ 整合包 progress 采样）。
 *
 * 用法：node scripts/p29-check.mjs            （需要网络）
 *       node scripts/p29-check.mjs --no-pack  （跳过整合包真实安装采样）
 *       node scripts/p29-check.mjs --keep     （保留临时数据目录，便于排查）
 *
 * 做法与 p28-check 一致：把一段 TS 写到 scripts/.tmp-p29-check.ts，用 esbuild 编译成
 * scripts/.tmp-p29-check.mjs 后 import 执行，跑完删除两个临时文件——直接复用
 * src/main 里的真实实现（Downloader / content 插件 / 各服务），而不是复制一份逻辑。
 *
 * 数据隔离：从 %APPDATA%\QDOQMC 只读复制 instances/default + settings.json
 * （以及用于整合包安装的 versions/<gameVersion>/<gameVersion>.json/.jar）到
 * 系统临时目录，QDOQMC_DATA_DIR 指向该临时目录，绝不写原目录。
 */
import AdmZip from 'adm-zip'
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'scripts', '.tmp-p29-check.ts')
const outfile = path.join(root, 'scripts', '.tmp-p29-check.mjs')
const argv = process.argv.slice(2)
const skipPack = argv.includes('--no-pack') || process.env.P29_SKIP_PACK === '1'
const keepTemp = argv.includes('--keep')
const UA = 'QDOQMC-P29-CHECK/1.0'
const MODRINTH = 'https://api.modrinth.com/v2'

function realDataDir() {
  if (process.env.QDOQMC_REAL_DATA_DIR) return process.env.QDOQMC_REAL_DATA_DIR
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'QDOQMC')
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

function warn(message) {
  console.warn(`[p29-check] ⚠ ${message}`)
}

/** 从原数据目录（只读）挑一个实例，返回其 id / gameVersion。 */
async function pickInstance(realRoot) {
  const instancesDir = path.join(realRoot, 'instances')
  let ids = []
  try {
    ids = (await readdir(instancesDir, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name)
  } catch {
    ids = []
  }
  const id = ids.includes('default') ? 'default' : ids[0] ?? 'default'
  let gameVersion
  try {
    const meta = JSON.parse(await readFile(path.join(instancesDir, id, 'instance.json'), 'utf8'))
    gameVersion = meta.gameVersion ?? meta.mcVersion ?? undefined
  } catch {
    gameVersion = undefined
  }
  return { id, gameVersion }
}

/** 用实例已装模组的 Modrinth 版本信息拼一个最小 .mrpack（2 个文件，够采样）。 */
async function buildModpack(realRoot, instanceId, gameVersion, packPath) {
  let content = []
  try {
    content = JSON.parse(await readFile(path.join(realRoot, 'instances', instanceId, 'content.json'), 'utf8'))
  } catch {
    content = []
  }
  const files = []
  for (const item of content) {
    if ((item.kind ?? 'mod') !== 'mod') continue
    if (!item.versionId || String(item.versionId).startsWith('mrpack:') || String(item.versionId).startsWith('curse:')) continue
    try {
      const version = await fetchJson(`${MODRINTH}/version/${encodeURIComponent(item.versionId)}`)
      const primary = version.files?.find((file) => file.primary) ?? version.files?.[0]
      if (!primary?.hashes?.sha1) continue
      files.push({
        path: `mods/${primary.filename}`,
        hashes: { sha1: primary.hashes.sha1 },
        env: { client: 'required', server: 'unsupported' },
        downloads: [primary.url],
        fileSize: primary.size,
      })
      if (files.length >= 2) break
    } catch (err) {
      warn(`整合包采样文件解析失败（versionId=${item.versionId}）: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (files.length === 0 || !gameVersion) return undefined
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'p29-check-1',
    name: 'P29 Check Pack',
    dependencies: { minecraft: gameVersion, 'fabric-loader': '0.16.9' },
    files,
  }
  const zip = new AdmZip()
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'))
  zip.writeZip(packPath)
  return { fileCount: files.length, files: files.map((file) => file.path) }
}

const TS_SOURCE = String.raw`
import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Downloader } from '../src/main/lib/downloader'
import { createAppPlugin } from '../src/main/plugins/app'
import { createCloudPlugin } from '../src/main/plugins/cloud'
import { createContentPlugin, type ContentService } from '../src/main/plugins/content'
import { createIdentityPlugin } from '../src/main/plugins/identity'
import { createInstancesPlugin } from '../src/main/plugins/instances'
import { createJavaPlugin } from '../src/main/plugins/java'
import { createLoadersPlugin } from '../src/main/plugins/loaders'
import { createLoggerPlugin } from '../src/main/plugins/logger'
import { createMojangPlugin } from '../src/main/plugins/mojang'
import { createPathsPlugin } from '../src/main/plugins/paths'
import { createSettingsPlugin } from '../src/main/plugins/settings'
import { createStoragePlugin } from '../src/main/plugins/storage'
import { createTelemetryPlugin } from '../src/main/plugins/telemetry'
import type { ContentPreview, ContentUpdate, ProgressFile, TaskProgress } from '../src/shared/types'

const UA = 'QDOQMC-P29-CHECK/1.0'
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error('断言失败: ' + message)
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25_000) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
  return res.json()
}

interface LibSpec {
  name: string
  url: string
  sha1?: string
  size?: number
}

/** 从当前 versions/<已装版本>/<ver>.json 里挑 3 个真实的小 library。 */
async function pickLibrarySpecs(): Promise<{ versionId: string; specs: LibSpec[] }> {
  const real = process.env.QDOQMC_REAL_DATA_DIR as string
  const preferred = process.env.QDOQMC_P29_GAME_VERSION
  const candidatesVersions: { id: string; json: any }[] = []
  let ids: string[] = []
  try {
    ids = (await readdir(path.join(real, 'versions'), { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
  } catch {
    ids = []
  }
  const ordered = [preferred, ...ids.filter((id) => id !== preferred)].filter((id): id is string => Boolean(id))
  for (const id of ordered) {
    const file = path.join(real, 'versions', id, id + '.json')
    if (!existsSync(file)) continue
    try {
      const json = JSON.parse(await readFile(file, 'utf8'))
      if (!json.downloads?.client) continue
      candidatesVersions.push({ id, json })
    } catch {
      /* 跳过损坏的本地 json */
    }
  }
  // 兜底：本地没有已装版本时，从 Mojang 清单取最新正式版
  if (candidatesVersions.length === 0) {
    const manifest = await fetchJson(MANIFEST)
    const entry = manifest.versions.find((item: any) => item.id === manifest.latest.release)
    candidatesVersions.push({ id: String(manifest.latest.release), json: await fetchJson(entry.url) })
  }
  for (const { id, json } of candidatesVersions) {
    const libs: LibSpec[] = []
    for (const lib of json.libraries ?? []) {
      const artifact = lib?.downloads?.artifact
      if (!artifact?.url || !artifact?.sha1 || !artifact?.size) continue
      if (artifact.size < 4096 || artifact.size > 2 * 1024 * 1024) continue
      libs.push({ name: String(lib.name ?? artifact.path), url: String(artifact.url), sha1: String(artifact.sha1), size: Number(artifact.size) })
    }
    if (libs.length >= 3) {
      libs.sort((a, b) => (a.size ?? 0) - (b.size ?? 0))
      return { versionId: id, specs: libs.slice(0, 3) }
    }
  }
  throw new Error('找不到含 3 个可下载 library 的已装版本 JSON')
}

async function bootContent(dataDir: string): Promise<{ ctx: Context; content: ContentService }> {
  const ctx = new Context()
  const plugins = [
    createAppPlugin({
      name: 'QDOQMC-Test',
      version: '0.1.0',
      electron: '',
      chrome: '',
      isSmoke: false,
    }),
    createPathsPlugin({ dataDir }),
    createLoggerPlugin(),
    createSettingsPlugin(),
    createStoragePlugin(),
    createIdentityPlugin(),
    createCloudPlugin(),
    createTelemetryPlugin(),
    createMojangPlugin(),
    createJavaPlugin(),
    createInstancesPlugin(),
    createLoadersPlugin(),
    createContentPlugin(),
  ]
  for (const plugin of plugins) {
    const fiber = ctx.plugin(plugin.setup(undefined))
    await fiber
  }
  const content = ctx.get('content') as ContentService
  if (!content) throw new Error('content 服务未就绪')
  return { ctx, content }
}

/* ---------- a) 下载器：onFiles / onFileState ---------- */

async function checkDownloader(): Promise<any> {
  console.log('=== a) 下载器文件级进度（3 个真实 library） ===')
  const picked = await pickLibrarySpecs()
  const specs = picked.specs.map((spec) => ({
    url: spec.url,
    dest: path.join(work, 'libs', spec.name.replace(/[^a-z0-9._-]+/gi, '_')),
    sha1: spec.sha1,
    size: spec.size,
    label: spec.name,
  }))
  const onFilesCalls: { name: string; size?: number }[][] = []
  const stateCalls: { index: number; state: ProgressFile['state']; at: number }[] = []
  const downloader = new Downloader({
    cacheDir: path.join(work, 'cache'),
    concurrency: 3,
    threads: 1,
    retries: 2,
    userAgent: UA,
    onFiles: (files) => onFilesCalls.push(files),
    onFileState: (index, state) => stateCalls.push({ index, state, at: Date.now() }),
  })
  const started = Date.now()
  let stats
  try {
    stats = await downloader.downloadAll(specs)
  } catch (err) {
    // 网络抖动时脚本层重试一次（验收关注的是回调行为，不是镜像速度）
    console.warn('  ⚠ 首次下载失败，重试一次: ' + (err instanceof Error ? err.message : String(err)))
    stats = await downloader.downloadAll(specs)
  }
  const ms = Date.now() - started
  const doneStates = stateCalls.filter((call) => call.state === 'done')
  assert(onFilesCalls.length === 1, 'onFiles 应只触发一次，实际 ' + onFilesCalls.length)
  assert(onFilesCalls[0].length === specs.length, 'onFiles 文件数应等于 specs 数')
  assert(stats.failed.length === 0, '存在下载失败文件: ' + stats.failed.map((spec) => spec.label).join(','))
  assert(stats.downloaded + stats.skipped === specs.length, 'downloaded+skipped 应等于 specs 数')
  assert(doneStates.length === specs.length, 'done 状态数应等于 specs 数，实际 ' + doneStates.length)
  const batches = new Set(stateCalls.map((call) => call.at)).size
  console.log(
    '  onFiles: ' + onFilesCalls.length + ' 次 / ' + onFilesCalls[0].length + ' 个文件；' +
      'onFileState: ' + stateCalls.length + ' 次（' + batches + ' 个合并批次，≥100ms 节流）',
  )
  console.log('  stats: ' + JSON.stringify({ downloaded: stats.downloaded, skipped: stats.skipped, bytes: stats.bytes, failed: stats.failed.length }) + '，耗时 ' + ms + 'ms')
  console.table(
    specs.map((spec, index) => ({
      index,
      name: spec.label,
      'size KB': spec.size ? Math.round(spec.size / 1024) : '-',
      state: stateCalls.filter((call) => call.index === index).map((call) => call.state).join('→'),
    })),
  )
  return {
    versionId: picked.versionId,
    files: specs.length,
    onFilesCalls: onFilesCalls.length,
    stateCalls: stateCalls.length,
    batches,
    done: doneStates.length,
    stats: { downloaded: stats.downloaded, skipped: stats.skipped, bytes: stats.bytes, failed: stats.failed.length },
    ms,
  }
}

/* ---------- b) preview ---------- */

async function checkPreview(content: ContentService): Promise<any> {
  console.log('=== b) content.preview("sodium", "mod") ===')
  const preview: ContentPreview = await content.preview('sodium', 'mod')
  assert(typeof preview.projectId === 'string', 'preview.projectId 应为 string')
  assert(typeof preview.title === 'string', 'preview.title 应为 string')
  assert(typeof preview.description === 'string', 'preview.description 应为 string')
  assert(Array.isArray(preview.gallery), 'preview.gallery 应为数组')
  assert(typeof preview.downloads === 'number', 'preview.downloads 应为 number')
  assert(Array.isArray(preview.gameVersions), 'preview.gameVersions 应为数组')
  assert(Array.isArray(preview.loaders), 'preview.loaders 应为数组')
  assert(preview.gallery.every((url) => url.startsWith('https://')), 'gallery 应全是绝对 https URL')
  // sodium 在 Modrinth 上确实有截图；无图项目（如 fabric-api）返回空数组是正常行为
  assert(preview.gallery.length > 0, 'sodium 的 gallery 不应为空（说明 .url 取值/协议补全有问题）')
  console.log(
    '  gallery: ' + preview.gallery.length + ' 张；首个 URL: ' + (preview.gallery[0] ?? '（无）'),
  )
  console.log(
    '  preview: ' + JSON.stringify({
      projectId: preview.projectId,
      title: preview.title,
      iconUrl: preview.iconUrl,
      downloads: preview.downloads,
      gameVersions: preview.gameVersions.slice(0, 6),
      loaders: preview.loaders,
      description: preview.description.slice(0, 60),
    }),
  )
  return {
    gallery: preview.gallery.length,
    firstUrl: preview.gallery[0] ?? null,
    title: preview.title,
    downloads: preview.downloads,
    iconUrl: preview.iconUrl ?? null,
  }
}

/* ---------- c) updates ---------- */

async function checkUpdates(content: ContentService, instanceId: string): Promise<any> {
  console.log('=== c) content.updates("' + instanceId + '") ===')
  let updates: ContentUpdate[]
  try {
    updates = await content.updates(instanceId)
  } catch (err) {
    throw new Error('updates() 不应抛错: ' + (err instanceof Error ? err.message : String(err)))
  }
  assert(Array.isArray(updates), 'updates() 应返回数组')
  console.log('  返回 ' + updates.length + ' 项' + (updates.length === 0 ? '（空数组，允许）' : ''))
  console.log('  ' + JSON.stringify(updates, null, 2).split('\n').join('\n  '))
  return { count: updates.length, updates }
}

/* ---------- e) update()：先下新文件 → 删旧文件 → 更新 content.json ---------- */

async function checkUpdate(content: ContentService, instanceId: string, dataDir: string): Promise<any> {
  console.log('=== e) content.update("' + instanceId + '") ===')
  const pending = await content.updates(instanceId)
  if (pending.length === 0) {
    console.log('  没有可更新项（跳过）')
    return { skipped: true }
  }
  const target = pending[0]
  const result = await content.update(instanceId, target.fileName)
  console.log('  update(' + target.fileName + ') -> ' + JSON.stringify(result))
  assert(result.ok, 'update() 失败: ' + result.error)
  assert(Boolean(result.fileName), 'update() 应返回新文件名')
  assert(Boolean(result.version), 'update() 应返回新版本号')

  // 1) content.json 记录已替换（版本号/文件名）
  const after = await content.installed(instanceId)
  const entry = after.find((item) => item.fileName === result.fileName)
  assert(Boolean(entry), 'content.json 没有记录新文件名 ' + result.fileName)
  assert(entry?.versionNumber === result.version, 'content.json 版本号未更新')
  if (result.fileName !== target.fileName) {
    assert(!after.some((item) => item.fileName === target.fileName), '旧文件名仍在 content.json')
  }

  // 2) mods/ 下只有一个新文件，没有 .old 备份/同名副本
  const modsDir = path.join(dataDir, 'instances', instanceId, '.minecraft', 'mods')
  const names = existsSync(modsDir) ? await readdir(modsDir) : []
  const leftovers = names.filter((name) => name.endsWith('.old') || name.includes('.part'))
  const oldFiles = names.filter((name) => name === target.fileName)
  assert(names.includes(result.fileName as string), 'mods/ 下没有新文件 ' + result.fileName)
  assert(leftovers.length === 0, '存在临时/备份文件残留: ' + leftovers.join(','))
  if (result.fileName !== target.fileName) {
    assert(oldFiles.length === 0, '旧文件仍存在（应先下新再删旧）: ' + target.fileName)
  }
  console.log(
    '  mods/ 实测: ' + JSON.stringify({
      newFile: result.fileName,
      oldFileRemoved: result.fileName === target.fileName ? '同名覆盖' : oldFiles.length === 0,
      leftoverTemp: leftovers,
      rows: after.length,
    }),
  )
  return {
    from: target.fileName,
    to: result.fileName,
    fromVersion: target.currentVersion,
    toVersion: result.version,
    leftovers,
  }
}

/* ---------- d) 整合包安装 progress 采样 ---------- */

function summarizeSample(progress: TaskProgress): string {
  const files = progress.files ?? []
  const done = files.filter((file) => file.state === 'done').length
  const running = files.filter((file) => file.state === 'running').length
  const sizes = files.filter((file) => typeof file.size === 'number' && (file.size as number) > 0)
  return JSON.stringify({
    stage: progress.stage,
    title: progress.title,
    message: progress.message,
    filesTotal: progress.filesTotal ?? files.length,
    filesDone: progress.filesDone ?? done,
    percent: progress.percent,
    showing: files.length,
    listedDone: done,
    listedRunning: running,
    sizesKnown: sizes.length + '/' + files.length,
    firstSize: files[0]?.size,
    bytesTotal: progress.bytesTotal,
    speed: progress.speed,
    etaMs: progress.etaMs,
  })
}

async function checkPack(content: ContentService): Promise<any> {
  const packPath = process.env.QDOQMC_P29_PACK
  console.log('=== d) 整合包安装 progress 采样（本地 .mrpack） ===')
  if (!packPath || !existsSync(packPath)) {
    console.log('  （没有准备好的 .mrpack，跳过：缺少已装模组或原版版本）')
    return { skipped: true }
  }
  const samples: TaskProgress[] = []
  content.setProgressSink((progress) => {
    if (progress.kind === 'content') samples.push(progress)
  })
  let result
  try {
    result = await content.installModpack(packPath)
  } finally {
    content.setProgressSink(null)
  }
  assert(result.ok, '整合包安装失败: ' + result.error)
  assert(samples.length > 0, '整合包安装没有发 content progress')
  const withFiles = samples.filter((progress) => (progress.files?.length ?? 0) > 0)
  assert(withFiles.length > 0, '整合包 progress 没有 files 清单')
  const last = samples[samples.length - 1]
  assert(last.stage === 'done', '最后一条 progress 应为 done，实际 ' + last.stage)
  const firstThree = samples.slice(0, 3).map(summarizeSample)
  const finalSample = summarizeSample(last)
  console.log('  共 ' + samples.length + ' 条 content progress；以下为前 3 条采样:')
  for (const line of firstThree) console.log('  ' + line)
  console.log('  最后一次: ' + finalSample)
  console.log('  安装结果: ' + JSON.stringify({
    instanceId: result.instanceId,
    packName: result.packName,
    files: result.files,
    bytes: result.bytes,
    loader: result.loader,
    mcVersion: result.mcVersion,
  }))
  const firstWithFiles = withFiles[0]
  assert((firstWithFiles.filesTotal ?? 0) > 0, 'firstWithFiles.filesTotal 应大于 0')
  // files 数组必须带 size（PCL 式清单要显示体积），且 filesDone 随下载递增
  const sized = firstWithFiles.files?.filter((file) => typeof file.size === 'number' && (file.size as number) > 0) ?? []
  assert(sized.length === (firstWithFiles.files?.length ?? 0), '整合包 progress.files 有文件缺少 size')
  const doneValues = samples.map((progress) => progress.filesDone ?? 0)
  assert(
    doneValues.every((value, index) => index === 0 || value >= doneValues[index - 1]),
    'filesDone 应单调递增，实际 ' + JSON.stringify(doneValues),
  )
  assert(last.filesDone === last.filesTotal, '最后一条 filesDone 应等于 filesTotal')
  const progression = [...new Set(doneValues)]
  const midSample = samples.find((progress) => (progress.filesDone ?? 0) > 0 && (progress.filesDone ?? 0) < (progress.filesTotal ?? 0))
  console.log('  files 带 size: ' + sized.length + '/' + (firstWithFiles.files?.length ?? 0) + ' 个；filesDone 递增序列: ' + JSON.stringify(progression))
  if (midSample) console.log('  下载中样本: ' + summarizeSample(midSample))
  return {
    samples: samples.length,
    firstThree,
    finalSample,
    filesSized: sized.length,
    filesListed: firstWithFiles.files?.length ?? 0,
    filesDoneProgression: progression,
    midSample: midSample ? summarizeSample(midSample) : null,
    result: {
      instanceId: result.instanceId,
      packName: result.packName,
      files: result.files,
      bytes: result.bytes,
      loader: result.loader,
      mcVersion: result.mcVersion,
    },
  }
}

const work = process.env.QDOQMC_P29_WORK as string
const dataDir = process.env.QDOQMC_DATA_DIR as string
const instanceId = process.env.QDOQMC_P29_INSTANCE ?? 'default'

export async function runP29Check(): Promise<{ ok: boolean }> {
  await mkdir(work, { recursive: true })
  const results: Record<string, unknown> = {}

  // a) 下载器（不依赖内核）
  results.downloader = await checkDownloader()

  // b/c/d 需要真实 content 插件（隔离数据目录）
  const { content } = await bootContent(dataDir)
  results.preview = await checkPreview(content)
  results.updates = await checkUpdates(content, instanceId)
  results.update = await checkUpdate(content, instanceId, dataDir)
  if (process.env.QDOQMC_P29_PACK && existsSync(process.env.QDOQMC_P29_PACK)) {
    results.pack = await checkPack(content)
  } else {
    results.pack = { skipped: true }
  }

  console.log('P29_CHECK_RESULT ' + JSON.stringify({ ok: true, results }))
  return { ok: true }
}
`

async function main() {
  const realRoot = realDataDir()
  console.log(`[p29-check] 原数据目录（只读）: ${realRoot}`)
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'qdo-p29-check-'))
  const dataDir = path.join(tempRoot, 'data')
  const work = path.join(tempRoot, 'work')
  await mkdir(path.join(dataDir, 'instances'), { recursive: true })

  let packInfo
  let instance = { id: 'default', gameVersion: undefined }
  try {
    instance = await pickInstance(realRoot)
    // 只读复制：实例（content.json/mods）+ settings.json
    const srcInstance = path.join(realRoot, 'instances', instance.id)
    if (existsSync(srcInstance)) {
      await cp(srcInstance, path.join(dataDir, 'instances', instance.id), { recursive: true })
    }
    const srcSettings = path.join(realRoot, 'settings.json')
    if (existsSync(srcSettings)) await cp(srcSettings, path.join(dataDir, 'settings.json'))
    // 整合包采样需要“已装原版”：只读复制该版本的 json + jar，避免重新下载整包
    if (instance.gameVersion) {
      const versionDir = path.join(realRoot, 'versions', instance.gameVersion)
      if (existsSync(path.join(versionDir, `${instance.gameVersion}.json`))) {
        const target = path.join(dataDir, 'versions', instance.gameVersion)
        await mkdir(target, { recursive: true })
        for (const name of [`${instance.gameVersion}.json`, `${instance.gameVersion}.jar`]) {
          const file = path.join(versionDir, name)
          if (existsSync(file)) await cp(file, path.join(target, name))
        }
      }
    }
    // 整合包采样：本地 .mrpack（2 个真实 Modrinth 文件 + fabric 依赖）
    if (!skipPack && instance.gameVersion) {
      const packPath = path.join(tempRoot, 'p29-check.mrpack')
      packInfo = await buildModpack(realRoot, instance.id, instance.gameVersion, packPath).catch((err) => {
        warn(`构造采样整合包失败: ${err instanceof Error ? err.message : err}`)
        return undefined
      })
      if (packInfo) process.env.QDOQMC_P29_PACK = packPath
      else warn('没有已装模组可拼采样整合包，d) 步骤会跳过')
    } else if (skipPack) {
      console.log('[p29-check] --no-pack：跳过整合包 progress 采样')
    }
    console.log(`[p29-check] 临时数据目录: ${dataDir}`)
    console.log(`[p29-check] 采样实例: ${instance.id}（游戏版本 ${instance.gameVersion ?? '未知'}）`)
    if (packInfo) console.log(`[p29-check] 采样整合包: ${packInfo.files.join(', ')}`)

    process.env.QDOQMC_DATA_DIR = dataDir
    process.env.QDOQMC_REAL_DATA_DIR = realRoot
    process.env.QDOQMC_P29_WORK = work
    process.env.QDOQMC_P29_INSTANCE = instance.id
    if (instance.gameVersion) process.env.QDOQMC_P29_GAME_VERSION = instance.gameVersion

    console.log('[p29-check] 编译临时 TS（esbuild）…')
    await writeFile(entry, TS_SOURCE, 'utf8')
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'warning',
      // adm-zip 等 CJS 依赖内部 require('fs') 需要这个 banner（与 scripts/build.mjs 一致）
      banner: {
        js: "import { createRequire as __qdoCreateRequire } from 'node:module';\nconst require = __qdoCreateRequire(import.meta.url);",
      },
    })
    const mod = await import(pathToFileURL(outfile).href + '?t=' + Date.now())
    await mod.runP29Check()
  } finally {
    await rm(entry, { force: true })
    await rm(outfile, { force: true })
    if (keepTemp) console.log(`[p29-check] 保留临时目录: ${tempRoot}`)
    else await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    console.log('[p29-check] 临时文件已清理')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[p29-check] 失败:', err)
    process.exitCode = 1
  })
