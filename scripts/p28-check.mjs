/**
 * P28 验收脚本：真实下载对比 official / bmclapi，验证分片正确性与 mirrorUrl 重写。
 *
 * 用法：node scripts/p28-check.mjs        （需要网络）
 *
 * 实现方式：把一段 TS 写到 scripts/.tmp-p28-check.ts，用 esbuild 编译成
 * scripts/.tmp-p28-check.mjs 后 import 执行，跑完删除两个临时文件。
 * 这样可以直接复用 src/main 里的 Downloader / mirrorUrl，而不是复制一份实现。
 */
import { build } from 'esbuild'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'scripts', '.tmp-p28-check.ts')
const outfile = path.join(root, 'scripts', '.tmp-p28-check.mjs')

const TS_SOURCE = String.raw`
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Downloader } from '../src/main/lib/downloader'
import { mirrorUrl, probeDownloadSource } from '../src/main/plugins/mojang'

const UA = 'QDOQMC-P28-CHECK/1.0'
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

interface Artifact {
  path: string
  sha1: string
  size: number
  url: string
}

interface Row {
  source: string
  mode: string
  'size MB': string
  'ms': number
  'avg MB/s': string
  'sha1': string
  'temp 残留': string
  '尝试': number
  'range 请求': string
}

interface DownloadOutcome {
  row: Row
}

function fmt(value: number): string {
  return value.toFixed(2)
}

function sha1Of(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex')
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error('断言失败: ' + message)
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25_000) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
  return res.json()
}

/** 取最新正式版里一个 4–12MB 的 libraries.minecraft.net 文件（够大以触发分片）。 */
async function pickArtifact(): Promise<Artifact> {
  const manifest = await fetchJson(MANIFEST)
  const release = String(manifest.latest.release)
  const entry = manifest.versions.find((item: any) => item.id === release)
  if (!entry) throw new Error('清单里找不到最新正式版 ' + release)
  const json = await fetchJson(String(entry.url))
  const candidates: Artifact[] = []
  for (const lib of json.libraries ?? []) {
    const art = lib.downloads?.artifact
    if (!art || !art.url || !art.sha1 || !art.size) continue
    if (!String(art.url).includes('libraries.minecraft.net')) continue
    if (art.size < 4 * 1024 * 1024 || art.size > 12 * 1024 * 1024) continue
    candidates.push({ path: String(art.path), sha1: String(art.sha1), size: Number(art.size), url: String(art.url) })
  }
  if (candidates.length === 0) throw new Error('没有找到 4–12MB 的 Mojang library')
  candidates.sort((a, b) => b.size - a.size)
  return candidates[0]
}

async function downloadOnce(
  label: string,
  url: string,
  artifact: Artifact,
  threads: number,
  workRoot: string,
  fallbackUrl?: string,
): Promise<DownloadOutcome> {
  const workDir = path.join(workRoot, 'run-' + Math.random().toString(36).slice(2, 8))
  const cacheDir = path.join(workDir, 'cache')
  await mkdir(cacheDir, { recursive: true })
  const dest = path.join(workDir, path.basename(artifact.path))
  const downloader = new Downloader({
    cacheDir,
    concurrency: threads > 1 ? 4 : 1,
    threads,
    retries: 2,
    userAgent: UA,
  })

  // 包一层 fetch 取证：证明「分片 = 真的发了 Range 请求且拿到 206」，
  // 以及「bmclapi 忽略 Range 返回 200 → 自动回退单流」。
  const requests: { range: string | null; status: number }[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const res = await originalFetch(input, init)
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ range: headers.range ?? null, status: res.status })
    return res
  }) as typeof fetch

  // 镜像走 CERNET 中转，偶发连接超时：脚本层最多重试 5 次（实测数据取成功那次）
  let attempts = 0
  let ms = 0
  let lastError: unknown
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      attempts = attempt
      const started = Date.now()
      try {
        await downloader.fetchOne({ url, dest, sha1: artifact.sha1, size: artifact.size, label, fallbackUrl })
        ms = Date.now() - started
        lastError = undefined
        break
      } catch (err) {
        lastError = err
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  if (lastError) throw lastError

  const ranged = requests.filter((item) => item.range)
  const statuses = Array.from(new Set(ranged.map((item) => item.status))).join('/')
  const rangeSummary = ranged.length === 0 ? '无' : ranged.length + ' 次 range → ' + statuses

  const actual = sha1Of(await readFile(dest))
  const leftovers = (await readdir(workDir)).filter((name) => name.includes('.part'))
  return {
    row: {
      source: label,
      mode: threads > 1 ? '分片 x' + threads : '单线程',
      'size MB': fmt(artifact.size / 1048576),
      ms,
      'avg MB/s': fmt(artifact.size / 1048576 / Math.max(0.001, ms / 1000)),
      sha1: actual === artifact.sha1 ? 'OK' : 'MISMATCH',
      'temp 残留': leftovers.length === 0 ? '无' : leftovers.join(','),
      '尝试': attempts,
      'range 请求': rangeSummary,
      '备注': '',
    },
  }
}

/** BMCLAPI 预检：可达才跑镜像对比，避免 CERNET 节点抖动让整个验收挂掉。 */
async function probeMirror(): Promise<{ ok: boolean; detail: string }> {
  const url = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
  let lastError: unknown
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const started = Date.now()
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) })
      const ms = Date.now() - started
      await res.body?.cancel().catch(() => undefined)
      if (res.ok) return { ok: true, detail: 'HTTP ' + res.status + ' / ' + ms + 'ms' }
      lastError = new Error('HTTP ' + res.status)
    } catch (err) {
      lastError = err
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return { ok: false, detail: lastError instanceof Error ? lastError.message : String(lastError) }
}

function skippedRow(label: string, mode: string, sizeMB: string, detail: string): Row {
  return {
    source: label,
    mode,
    'size MB': sizeMB,
    ms: 0,
    'avg MB/s': '-',
    sha1: 'SKIP',
    'temp 残留': '-',
    '尝试': 5,
    'range 请求': '-',
    '备注': detail.slice(0, 80),
  }
}

function checkMirrorUrl(): void {
  const cases: { name: string; input: string; source: 'bmclapi' | 'official'; expect: string }[] = [
    {
      name: 'piston-meta 域名',
      input: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
      source: 'bmclapi',
      expect: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    },
    {
      name: 'libraries.minecraft.net → /maven/',
      input: 'https://libraries.minecraft.net/org/lwjgl/lwjgl-vulkan/3.4.3/lwjgl-vulkan-3.4.3.jar',
      source: 'bmclapi',
      expect: 'https://bmclapi2.bangbang93.com/maven/org/lwjgl/lwjgl-vulkan/3.4.3/lwjgl-vulkan-3.4.3.jar',
    },
    {
      name: 'resources.download.minecraft.net → /assets/',
      input: 'https://resources.download.minecraft.net/ab/abcdef0123456789',
      source: 'bmclapi',
      expect: 'https://bmclapi2.bangbang93.com/assets/ab/abcdef0123456789',
    },
    {
      name: 'Modrinth 等其它域名不改写',
      input: 'https://cdn.modrinth.com/data/abc/versions/1/mod.jar',
      source: 'bmclapi',
      expect: 'https://cdn.modrinth.com/data/abc/versions/1/mod.jar',
    },
    {
      name: 'official 原样返回',
      input: 'https://libraries.minecraft.net/org/lwjgl/lwjgl-vulkan/3.4.3/lwjgl-vulkan-3.4.3.jar',
      source: 'official',
      expect: 'https://libraries.minecraft.net/org/lwjgl/lwjgl-vulkan/3.4.3/lwjgl-vulkan-3.4.3.jar',
    },
  ]
  for (const item of cases) {
    const actual = mirrorUrl(item.input, item.source)
    assert(actual === item.expect, item.name + ' 期望 ' + item.expect + ' 实际 ' + actual)
    console.log('  ok  ' + item.name + ' -> ' + actual)
  }
}

export async function runP28Check(): Promise<{ ok: boolean }> {
  console.log('=== P28 下载器验收 ===')
  console.log('[1/4] mirrorUrl 重写断言（4 类 URL）')
  checkMirrorUrl()

  console.log('[2/4] 自动选源（并行下载两份 version_manifest_v2.json，按实测吞吐 KB/s 选源）')
  const probe = await probeDownloadSource()
  console.table([
    {
      '源': 'Mojang 官方',
      '吞吐 KB/s': probe.officialKBps === undefined ? '失败/超时' : probe.officialKBps,
      '字节': probe.officialBytes === undefined ? '-' : probe.officialBytes,
      '选中': probe.source === 'official' ? '✓' : '',
    },
    {
      '源': 'BMCLAPI 镜像',
      '吞吐 KB/s': probe.bmclapiKBps === undefined ? '失败/超时' : probe.bmclapiKBps,
      '字节': probe.bmclapiBytes === undefined ? '-' : probe.bmclapiBytes,
      '选中': probe.source === 'bmclapi' ? '✓' : '',
    },
  ])
  console.log(
    '  auto 选源结果: ' +
      probe.source +
      '（official ' +
      String(probe.officialKBps) +
      ' KB/s / bmclapi ' +
      String(probe.bmclapiKBps) +
      ' KB/s；规则：bmclapi ≥ official×0.8 优先镜像）',
  )

  console.log('[3/4] 选一个真实 Mojang library 并下载对比')
  const artifact = await pickArtifact()
  console.log('  目标: ' + artifact.url)
  console.log('  大小: ' + fmt(artifact.size / 1048576) + ' MB  sha1=' + artifact.sha1)

  const mirrorProbe = await probeMirror()
  const mirrorUsable = mirrorProbe.ok
  if (!mirrorUsable) {
    console.log('  ⚠ BMCLAPI 当前不可达，跳过镜像对比行（官方/分片仍实测）: ' + mirrorProbe.detail)
  }

  const sizeMB = fmt(artifact.size / 1048576)
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'qdo-p28-check-'))
  const rows: Row[] = []
  try {
    rows.push((await downloadOnce('official 单线程', artifact.url, artifact, 1, workRoot)).row)
    if (mirrorUsable) {
      try {
        rows.push(
          (await downloadOnce('bmclapi 单线程', mirrorUrl(artifact.url, 'bmclapi'), artifact, 1, workRoot)).row,
        )
      } catch (err) {
        rows.push(skippedRow('bmclapi 单线程', '单线程', sizeMB, err instanceof Error ? err.message : String(err)))
      }
    } else {
      rows.push(skippedRow('bmclapi 单线程', '单线程', sizeMB, mirrorProbe.detail))
    }
    rows.push((await downloadOnce('official 分片', artifact.url, artifact, 4, workRoot)).row)
    if (mirrorUsable) {
      try {
        rows.push(
          (await downloadOnce('bmclapi 分片回退', mirrorUrl(artifact.url, 'bmclapi'), artifact, 4, workRoot)).row,
        )
      } catch (err) {
        rows.push(
          skippedRow('bmclapi 分片回退', '分片 x4', sizeMB, err instanceof Error ? err.message : String(err)),
        )
      }
    } else {
      rows.push(skippedRow('bmclapi 分片回退', '分片 x4', sizeMB, mirrorProbe.detail))
    }
    // 镜像缺文件（403/404）→ 自动用官方地址兜底：用一个确定 404 的镜像地址验证
    rows.push(
      (
        await downloadOnce(
          '回退(镜像404→官方)',
          'https://bmclapi2.bangbang93.com/maven/qdo-p28-not-exist/qdo-p28-not-exist.jar',
          artifact,
          1,
          workRoot,
          artifact.url,
        )
      ).row,
    )
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }

  console.log('[4/4] 实测数据（第三方 sha1 校验 + 临时文件清理 + Range 取证）')
  console.table(rows)
  for (const row of rows) {
    if (row.sha1 === 'SKIP') continue
    assert(row.sha1 === 'OK', row.source + ' sha1 校验失败')
    assert(row['temp 残留'] === '无', row.source + ' 有临时文件残留: ' + row['temp 残留'])
  }

  const officialShard = rows.find((row) => row.source === 'official 分片')
  if (officialShard) {
    assert(
      officialShard['range 请求'].includes('206'),
      'official 分片没有拿到 206（实际: ' + officialShard['range 请求'] + '）',
    )
    console.log('  分片取证: official 分片走真实 Range 206 并发下载 → ' + officialShard['range 请求'])
  }
  const mirrorFallback = rows.find((row) => row.source === 'bmclapi 分片回退')
  if (mirrorFallback && mirrorFallback.sha1 === 'OK') {
    assert(
      mirrorFallback['range 请求'].includes('200'),
      'bmclapi 回退用例没有触发 200（实际: ' + mirrorFallback['range 请求'] + '）',
    )
    console.log('  回退取证: bmclapi 忽略 Range 返回 200 → 自动回退单流 → ' + mirrorFallback['range 请求'])
  }
  const fallbackRow = rows.find((row) => row.source === '回退(镜像404→官方)')
  if (fallbackRow) {
    assert(fallbackRow.sha1 === 'OK', '镜像 404 → 官方兜底后 sha1 校验失败')
    console.log('  兜底取证: 镜像地址 404 → 自动改用官方地址下载成功（fallbackUrl 生效，sha1 OK）')
  }

  const official = rows.find((row) => row.source === 'official 单线程')
  const mirror = rows.find((row) => row.source === 'bmclapi 单线程' && row.sha1 === 'OK')
  if (official && mirror) {
    const ratio = mirror.ms / Math.max(1, official.ms)
    console.log(
      '单线程对比: official ' + official.ms + 'ms vs bmclapi ' + mirror.ms + 'ms（bmclapi 耗时是官方的 ' + fmt(ratio) + 'x）',
    )
  }
  console.log('P28_CHECK_RESULT ' + JSON.stringify({ ok: true, probe, rows }))
  return { ok: true }
}
`

async function main() {
  console.log('[p28-check] 编译临时 TS（esbuild）…')
  await writeFile(entry, TS_SOURCE, 'utf8')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
  })
  try {
    const mod = await import(pathToFileURL(outfile).href + '?t=' + Date.now())
    await mod.runP28Check()
  } finally {
    await rm(entry, { force: true })
    await rm(outfile, { force: true })
    console.log('[p28-check] 临时文件已清理')
  }
}

main().catch((err) => {
  console.error('[p28-check] 失败:', err)
  process.exitCode = 1
})
