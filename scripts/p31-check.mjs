/**
 * P31 验收脚本：GPU 高性能显卡偏好、手动 Java 管理、内容目录版本隔离（junction）。
 *
 * 用法：node scripts/p31-check.mjs
 *
 * 做法与 p28/p29-check 一致：把一段 TS 写到 scripts/.tmp-p31-check.ts，用 esbuild 编译成
 * scripts/.tmp-p31-check.mjs 后 import 执行，跑完删除两个临时文件——直接复用 src/main 里的
 * 真实实现（java / gpu / instances 插件），而不是复制一份逻辑。
 *
 * 数据隔离：QDOQMC_DATA_DIR 指向 %TEMP% 下的临时数据目录，绝不写真实数据目录。
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'scripts', '.tmp-p31-check.ts')
const outfile = path.join(root, 'scripts', '.tmp-p31-check.mjs')

const TS_SOURCE = String.raw`
import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createAppPlugin } from '../src/main/plugins/app'
import { createCloudPlugin } from '../src/main/plugins/cloud'
import { createGpuPlugin, type GpuService } from '../src/main/plugins/gpu'
import { createIdentityPlugin } from '../src/main/plugins/identity'
import { createInstancesPlugin, type InstancesService } from '../src/main/plugins/instances'
import { createJavaPlugin, type JavaService } from '../src/main/plugins/java'
import { createLoggerPlugin } from '../src/main/plugins/logger'
import { createMojangPlugin } from '../src/main/plugins/mojang'
import { createPathsPlugin } from '../src/main/plugins/paths'
import { createSettingsPlugin, type SettingsService } from '../src/main/plugins/settings'
import { createStoragePlugin } from '../src/main/plugins/storage'
import { createTelemetryPlugin } from '../src/main/plugins/telemetry'

const execFileAsync = promisify(execFile)
const REG_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error('断言失败: ' + message)
}

async function regQuery(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', REG_KEY], { windowsHide: true, timeout: 15000 })
    return stdout
  } catch {
    return ''
  }
}

async function boot(dataDir: string): Promise<{ ctx: Context; java: JavaService; gpu: GpuService; instances: InstancesService; settings: SettingsService }> {
  const ctx = new Context()
  const plugins = [
    createAppPlugin({ name: 'QDOQMC-Test', version: '0.1.0', electron: '', chrome: '', isSmoke: false }),
    createPathsPlugin({ dataDir }),
    createLoggerPlugin(),
    createSettingsPlugin(),
    createStoragePlugin(),
    createIdentityPlugin(),
    createCloudPlugin(),
    createTelemetryPlugin(),
    createMojangPlugin(),
    createJavaPlugin(),
    createGpuPlugin(),
    createInstancesPlugin(),
  ]
  for (const plugin of plugins) {
    const fiber = ctx.plugin(plugin.setup(undefined))
    await fiber
  }
  const java = ctx.get('java') as JavaService
  const gpu = ctx.get('gpu') as GpuService
  const instances = ctx.get('instances') as InstancesService
  const settings = ctx.get('settings') as SettingsService
  if (!java || !gpu || !instances || !settings) throw new Error('服务未就绪')
  return { ctx, java, gpu, instances, settings }
}

async function checkGpu(gpu: GpuService, java: JavaService): Promise<any> {
  console.log('=== a) GPU 高性能显卡偏好 ===')
  const detected = await java.detect(true)
  if (detected.length === 0) {
    console.log('  本机没有探测到 Java，跳过 GPU 注册表写入测试')
    return { skipped: true, reason: 'no-java' }
  }
  const on = await gpu.setEnabled(true)
  console.log('  setEnabled(true) -> ' + JSON.stringify(on))
  assert(on.ok, 'setEnabled(true) 应 ok')
  assert(on.applied >= 1, 'setEnabled(true).applied 应 >= 1')
  const regOn = await regQuery()
  const has2 = /GpuPreference\s*=\s*2\s*;/i.test(regOn)
  console.log('  reg query 含 GpuPreference=2: ' + has2)
  assert(has2, '启用后 reg query 应看到 GpuPreference=2')
  const st = await gpu.status()
  console.log('  status() -> ' + JSON.stringify(st))
  assert(st.enabled === true, 'status().enabled 应为 true')
  assert(st.entries >= 1, 'status().entries 应 >= 1，实际 ' + st.entries)

  const off = await gpu.setEnabled(false)
  console.log('  setEnabled(false) -> ' + JSON.stringify(off))
  assert(off.ok, 'setEnabled(false) 应 ok')
  const regOff = await regQuery()
  const has0 = /GpuPreference\s*=\s*0\s*;/i.test(regOff)
  console.log('  reg query 含 GpuPreference=0: ' + has0)
  assert(has0, '关闭后 reg query 应看到 GpuPreference=0')
  const stOff = await gpu.status()
  console.log('  status(false) -> ' + JSON.stringify(stOff))
  assert(stOff.enabled === false, 'status().enabled 应为 false')
  return {
    appliedOn: on.applied,
    entriesOn: st.entries,
    enabled: stOff.enabled,
    regOn: has2,
    regOff: has0,
  }
}

async function checkJava(java: JavaService): Promise<any> {
  console.log('=== b) 手动 Java 管理 ===')
  const detected = await java.detect(true)
  if (detected.length === 0) {
    console.log('  本机没有探测到 Java，跳过 addManual 测试')
    return { skipped: true, reason: 'no-java' }
  }
  const sample = detected[0].path
  console.log('  样本 java.exe: ' + sample)
  const info = await java.addManual(sample)
  console.log('  addManual -> ' + JSON.stringify({ path: info.path, major: info.major, source: info.source }))
  assert(info.major > 0, 'addManual 应返回 major > 0')
  assert(info.source === 'manual', 'addManual 应返回 source=manual')
  const again = await java.detect(true)
  assert(again.some((item) => item.source === 'manual'), 'detect() 应出现 source=manual')
  console.log('  detect() 中出现 source=manual: true')
  return { major: info.major, source: info.source, manualCount: again.filter((item) => item.source === 'manual').length }
}

async function checkContentDir(instances: InstancesService, settings: SettingsService, dataDir: string): Promise<any> {
  console.log('=== c) 内容目录版本隔离（junction） ===')
  const gameDir = instances.gameDir('default')
  const isolatedPath = instances.contentDir('default', 'mods')
  const expected = path.join(gameDir, 'mods')
  console.log('  isolated=true contentDir: ' + isolatedPath)
  assert(isolatedPath === expected, 'isolated 时 contentDir 应等于 gameDir/mods，实际 ' + isolatedPath)
  const stIsolated = lstatSync(isolatedPath)
  assert(stIsolated.isDirectory() && !stIsolated.isSymbolicLink(), 'isolated 时 mods 应是真实目录（非 junction）')

  settings.patch({ isolatedMods: false })
  instances.rebindContentDirs()
  const sharedPath = instances.contentDir('default', 'mods')
  console.log('  isolated=false contentDir: ' + sharedPath)
  assert(sharedPath === expected, '共用时 contentDir 返回的 link 路径应仍是 gameDir/mods，实际 ' + sharedPath)
  const stShared = lstatSync(sharedPath)
  assert(stShared.isSymbolicLink(), '共用时 mods 应是 junction/symlink')
  const sharedReal = realpathSync(sharedPath).toLowerCase()
  const targetReal = realpathSync(path.join(dataDir, 'shared', 'mods')).toLowerCase()
  console.log('  junction -> ' + sharedReal)
  console.log('  shared  -> ' + targetReal)
  assert(sharedReal === targetReal, 'junction 应指向 shared/mods')
  return { isolatedPath, sharedPath, isJunction: true, targetReal }
}

export async function runP31Check(): Promise<{ ok: boolean }> {
  const dataDir = process.env.QDOQMC_DATA_DIR as string
  const results: Record<string, unknown> = {}
  const { java, gpu, instances, settings } = await boot(dataDir)

  results.gpu = await checkGpu(gpu, java)
  results.java = await checkJava(java)
  results.contentDir = await checkContentDir(instances, settings, dataDir)

  console.log('P31_CHECK_RESULT ' + JSON.stringify({ ok: true, results }))
  return { ok: true }
}
`

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'qdo-p31-check-'))
  const dataDir = path.join(tempRoot, 'data')
  process.env.QDOQMC_DATA_DIR = dataDir
  console.log(`[p31-check] 临时数据目录: ${dataDir}`)

  console.log('[p31-check] 编译临时 TS（esbuild）…')
  await writeFile(entry, TS_SOURCE, 'utf8')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
    banner: {
      js: "import { createRequire as __qdoCreateRequire } from 'node:module';\nconst require = __qdoCreateRequire(import.meta.url);",
    },
  })
  try {
    const mod = await import(pathToFileURL(outfile).href + '?t=' + Date.now())
    await mod.runP31Check()
  } finally {
    await rm(entry, { force: true })
    await rm(outfile, { force: true })
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    console.log('[p31-check] 临时文件已清理')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[p31-check] 失败:', err)
    process.exitCode = 1
  })
