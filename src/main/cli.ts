/**
 * CLI 模式：无窗口跑安装 / 启动联调，用于自动化验证与排障。
 *   electron . --install=1.21.11
 *   electron . --launch=default --wait=60000
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Kernel } from './kernel'
import type { ConflictService } from './plugins/conflict'
import type { ContentService } from './plugins/content'
import type { DiagnoseService } from './plugins/diagnose'
import type { InstancesService } from './plugins/instances'
import type { LaunchService } from './plugins/launch'
import type { LoadersService } from './plugins/loaders'
import type { MojangService } from './plugins/mojang'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runInstallCli(kernel: Kernel, versionId: string): Promise<number> {
  const mojang = kernel.ctx.get('mojang') as MojangService
  let lastStage = ''
  let lastEmit = 0
  mojang.setProgressSink((p) => {
    const now = Date.now()
    const shouldLog = p.stage !== lastStage || now - lastEmit > 5000 || p.stage === 'done'
    if (!shouldLog) return
    lastStage = p.stage
    lastEmit = now
    console.log(`[install] ${p.stage} ${p.done}/${p.total} ${(p.bytes / 1048576).toFixed(1)}MB ${p.message ?? ''}`)
  })
  const result = await mojang.install(versionId, `cli-install-${Date.now()}`)
  if (result.ok) {
    const instances = kernel.ctx.get('instances') as InstancesService
    instances.setVersion('default', versionId, versionId)
  }
  console.log(`INSTALL_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}

export async function runFabricCli(kernel: Kernel, gameVersion: string): Promise<number> {
  const loaders = kernel.ctx.get('loaders') as LoadersService
  const instances = kernel.ctx.get('instances') as InstancesService
  loaders.setProgressSink((p) => console.log(`[fabric] ${p.stage} ${p.done}/${p.total} ${p.message ?? ''}`))
  const result = await loaders.installFabric(gameVersion)
  if (result.ok && result.versionId) {
    instances.setVersion('default', result.versionId, gameVersion, gameVersion, 'fabric')
  }
  console.log(`FABRIC_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}

export async function runModCli(kernel: Kernel, slug: string): Promise<number> {
  const content = kernel.ctx.get('content') as ContentService
  const instances = kernel.ctx.get('instances') as InstancesService
  const instance = instances.get('default')
  const result = await content.install('default', slug, {
    mcVersion: instance?.gameVersion ?? undefined,
    loader: instance?.loader === 'fabric' ? 'fabric' : undefined,
  })
  console.log(`MOD_RESULT ${JSON.stringify(result)}`)
  const list = await content.installed('default')
  console.log(`MOD_LIST ${JSON.stringify(list)}`)
  return result.ok ? 0 : 1
}

export async function runAnalyzeCli(kernel: Kernel): Promise<number> {
  const conflict = kernel.ctx.get('conflict') as ConflictService
  const report = conflict.analyze('default')
  console.log(`CONFLICT_RESULT ${JSON.stringify(report)}`)
  return report.issues.filter((issue) => issue.severity === 'error').length > 0 ? 1 : 0
}

export async function runDiagnoseCli(kernel: Kernel): Promise<number> {
  const diagnose = kernel.ctx.get('diagnose') as DiagnoseService
  const result = await diagnose.run('default')
  console.log(`DIAG_RESULT ${JSON.stringify(result)}`)
  return result.found ? 1 : 0
}

export async function runLaunchTest(kernel: Kernel, instanceId: string, waitMs: number): Promise<number> {
  const launch = kernel.ctx.get('launch') as LaunchService
  const instances = kernel.ctx.get('instances') as InstancesService
  const instance = instances.get(instanceId)
  if (!instance) {
    console.log(`LAUNCH_RESULT ${JSON.stringify({ ok: false, error: `实例不存在: ${instanceId}` })}`)
    return 1
  }

  const started = await launch.start(instanceId)
  console.log(`LAUNCH_START ${JSON.stringify(started)}`)
  if (!started.ok) {
    console.log(`LAUNCH_RESULT ${JSON.stringify({ ok: false, error: started.error })}`)
    return 1
  }

  await sleep(waitMs)
  const running = launch.current()
  const gameDir = instance.gameDir
  const latestLog = path.join(gameDir, 'logs', 'latest.log')
  const content = existsSync(latestLog) ? readFileSync(latestLog, 'utf8') : ''
  const markers = [
    'Setting user',
    'LWJGL',
    'OpenAL initialized',
    'Reloading ResourceManager',
    'Sound engine started',
    'Created: 1024x',
    'Backend library',
  ].filter((marker) => content.includes(marker))
  const crashDir = path.join(gameDir, 'crash-reports')
  const crashReports = existsSync(crashDir)
    ? readdirSync(crashDir)
        .map((file) => ({ file, mtime: statSync(path.join(crashDir, file)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 2)
    : []

  const tail = content.split(/\r?\n/).filter(Boolean).slice(-25)
  console.log(
    `LAUNCH_RESULT ${JSON.stringify({
      ok: Boolean(running),
      pid: running?.pid,
      java: started.javaPath,
      player: started.playerName,
      version: started.versionId,
      markers,
      crashReports: crashReports.map((c) => c.file),
      latestLogTail: tail,
    })}`,
  )

  await launch.stop()
  await sleep(1500)
  return running ? 0 : 1
}
