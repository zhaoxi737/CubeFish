/**
 * CLI 模式：无窗口跑安装 / 启动联调，用于自动化验证与排障。
 *   electron . --install=1.21.11
 *   electron . --launch=default --wait=60000
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Kernel } from './kernel'
import type { ChatService } from './plugins/chat'
import type { ConflictService } from './plugins/conflict'
import type { ContentService } from './plugins/content'
import type { DiagnoseService } from './plugins/diagnose'
import type { InstancesService } from './plugins/instances'
import type { LaunchService } from './plugins/launch'
import type { LlmService } from './plugins/llm'
import type { AuthService } from './plugins/auth'
import type { LoadersService } from './plugins/loaders'
import type { MarketService } from './plugins/market'
import type { MojangService } from './plugins/mojang'
import type { PluginHostService } from './plugins/plugin-host'
import type { ToolsService } from './plugins/tools'
import type { UpdaterService } from './plugins/updater'

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
  const instance = instances.active()
  const result = await content.install(instance.id, slug, {
    mcVersion: instance.gameVersion ?? undefined,
    loader: instance.loader === 'fabric' ? 'fabric' : undefined,
  })
  console.log(`MOD_RESULT ${JSON.stringify(result)}`)
  const list = await content.installed(instance.id)
  console.log(`MOD_LIST ${JSON.stringify(list)}`)
  return result.ok ? 0 : 1
}

export async function runContentCli(kernel: Kernel, slug: string): Promise<number> {
  const content = kernel.ctx.get('content') as ContentService
  const instances = kernel.ctx.get('instances') as InstancesService
  const instance = instances.active()
  const result = await content.install(instance.id, slug, {
    mcVersion: instance.gameVersion ?? undefined,
    loader: instance.loader === 'fabric' ? 'fabric' : undefined,
  })
  console.log(`CONTENT_RESULT ${JSON.stringify({ instance: instance.id, ...result })}`)
  const list = await content.installed(instance.id)
  console.log(`CONTENT_LIST ${JSON.stringify(list)}`)
  return result.ok ? 0 : 1
}

export async function runActivateInstanceCli(kernel: Kernel, id: string): Promise<number> {
  const instances = kernel.ctx.get('instances') as InstancesService
  const active = instances.setActive(id)
  console.log(`INSTANCE_ACTIVE ${JSON.stringify(active)}`)
  return 0
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

export async function runChatCli(kernel: Kernel, text: string): Promise<number> {
  const chat = kernel.ctx.get('chat') as ChatService
  const llm = kernel.ctx.get('llm') as LlmService
  console.log(
    `CHAT_CONFIG ${JSON.stringify({ available: llm.available(), baseUrl: llm.baseUrl(), model: llm.model() })}`,
  )
  let deltas = 0
  let streamedText = ''
  chat.setStreamSink((chunk) => {
    deltas += 1
    streamedText += chunk
  })
  const reply = await chat.send(text)
  chat.setStreamSink(null)
  console.log(`CHAT_STREAM ${JSON.stringify({ deltas, streamedLength: streamedText.length })}`)
  console.log(`CHAT_RESULT ${JSON.stringify(reply)}`)
  return reply.ok ? 0 : 1
}

export async function runPluginsCli(kernel: Kernel): Promise<number> {
  const host = kernel.ctx.get('pluginHost') as PluginHostService
  console.log(`PLUGINS_RESULT ${JSON.stringify({ dir: host.dir(), plugins: host.list() })}`)
  return 0
}

export async function runInstancesCli(kernel: Kernel): Promise<number> {
  const instances = kernel.ctx.get('instances') as InstancesService
  console.log(`INSTANCES_RESULT ${JSON.stringify({ active: instances.active().id, instances: instances.list() })}`)
  return 0
}

export async function runCreateInstanceCli(kernel: Kernel, name: string): Promise<number> {
  const instances = kernel.ctx.get('instances') as InstancesService
  const created = instances.create(name)
  instances.setActive(created.id)
  console.log(`INSTANCE_CREATE ${JSON.stringify(created)}`)
  return 0
}

export async function runPluginToggleCli(kernel: Kernel, id: string, granted: boolean): Promise<number> {
  const host = kernel.ctx.get('pluginHost') as PluginHostService
  const info = await host.setGranted(id, granted)
  console.log(`PLUGIN_TOGGLE ${JSON.stringify(info)}`)
  return info.error ? 1 : 0
}

export async function runToolsCli(kernel: Kernel): Promise<number> {
  const tools = kernel.ctx.get('tools') as ToolsService
  console.log(`TOOLS_RESULT ${JSON.stringify({ count: tools.names().length, names: tools.names() })}`)
  return 0
}

export async function runMarketCli(kernel: Kernel): Promise<number> {
  const market = kernel.ctx.get('market') as MarketService
  const result = await market.list(true)
  console.log(`MARKET_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}

export async function runMarketInstallCli(kernel: Kernel, id: string): Promise<number> {
  const market = kernel.ctx.get('market') as MarketService
  const result = await market.install(id)
  console.log(`MARKET_INSTALL ${JSON.stringify(result)}`)
  const host = kernel.ctx.get('pluginHost') as PluginHostService
  console.log(`PLUGINS_AFTER ${JSON.stringify(host.list().map((p) => ({ id: p.id, granted: p.granted })))}`)
  return result.ok ? 0 : 1
}

export async function runNeoForgeCli(kernel: Kernel, mcVersion: string): Promise<number> {
  const loaders = kernel.ctx.get('loaders') as LoadersService
  const instances = kernel.ctx.get('instances') as InstancesService
  loaders.setProgressSink((progress) => {
    console.log(`[neoforge] ${progress.stage} ${progress.done}/${progress.total} ${progress.message ?? ''}`)
  })
  const result = await loaders.installNeoForge(mcVersion)
  if (result.ok && result.versionId) {
    instances.setVersion(instances.active().id, result.versionId, mcVersion, mcVersion, 'neoforge')
  }
  console.log(`NEOFORGE_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}

export async function runModpackCli(kernel: Kernel, source: string): Promise<number> {
  const content = kernel.ctx.get('content') as ContentService
  const inspect = await content.inspectModpack(source)
  if (!inspect.ok && !/^https?:\/\//i.test(source) && !source.endsWith('.mrpack')) {
    // 当作 Modrinth slug
    const result = await content.installModpackProject(source)
    console.log(`MODPACK_RESULT ${JSON.stringify({ source, ...result })}`)
    return result.ok ? 0 : 1
  }
  const result = await content.installModpack(source)
  console.log(`MODPACK_RESULT ${JSON.stringify({ source, ...result })}`)
  return result.ok ? 0 : 1
}

export async function runInspectModpackCli(kernel: Kernel, source: string): Promise<number> {
  const content = kernel.ctx.get('content') as ContentService
  let result = await content.inspectModpack(source)
  if (!result.ok && !/^https?:\/\//i.test(source)) {
    const version = await content.pickVersion(source)
    if (version?.fileUrl) result = await content.inspectModpack(version.fileUrl)
  }
  console.log(`INSPECT_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}

export async function runForgeCli(kernel: Kernel, mcVersion: string): Promise<number> {
  const loaders = kernel.ctx.get('loaders') as LoadersService
  const instances = kernel.ctx.get('instances') as InstancesService
  loaders.setProgressSink((progress) => {
    console.log(`[forge] ${progress.stage} ${progress.done}/${progress.total} ${progress.message ?? ''}`)
  })
  const result = await loaders.installForge(mcVersion)
  if (result.ok && result.versionId) {
    instances.setVersion(instances.active().id, result.versionId, mcVersion, mcVersion, 'forge')
  }
  console.log(`FORGE_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}


export async function runAccountCli(kernel: Kernel): Promise<number> {
  const auth = kernel.ctx.get('auth') as AuthService
  console.log(`ACCOUNT_RESULT ${JSON.stringify(auth.account())}`)
  return 0
}

export async function runLoginMsCli(kernel: Kernel): Promise<number> {
  const auth = kernel.ctx.get('auth') as AuthService
  try {
    const info = await auth.beginLogin()
    console.log(`DEVICE_CODE ${JSON.stringify(info)}`)
    const deadline = Date.now() + Math.max(30, info.expiresIn) * 1000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, info.interval) * 1000))
      const status = await auth.completeLogin()
      console.log(`LOGIN_STATUS ${status.status}`)
      if (status.status === 'ok') {
        console.log(`ACCOUNT_RESULT ${JSON.stringify(status.account)}`)
        return 0
      }
      if (status.status === 'error') {
        console.log(`LOGIN_ERROR ${status.error}`)
        return 1
      }
    }
    console.log('LOGIN_ERROR 设备码超时')
    return 1
  } catch (err) {
    console.log(`LOGIN_ERROR ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

export async function runLogoutCli(kernel: Kernel): Promise<number> {
  const auth = kernel.ctx.get('auth') as AuthService
  const account = auth.logout()
  console.log(`ACCOUNT_RESULT ${JSON.stringify(account)}`)
  return 0
}


export async function runAccountsCli(kernel: Kernel): Promise<number> {
  const auth = kernel.ctx.get('auth') as AuthService
  console.log(`ACCOUNTS_RESULT ${JSON.stringify({ account: auth.account(), accounts: auth.accounts() })}`)
  return 0
}

export async function runSwitchAccountCli(kernel: Kernel, uuid: string): Promise<number> {
  const auth = kernel.ctx.get('auth') as AuthService
  const account = auth.switchAccount(uuid)
  console.log(`ACCOUNT_RESULT ${JSON.stringify(account)}`)
  return 0
}

export async function runRemoveAccountCli(kernel: Kernel, uuid: string): Promise<number> {
  const auth = kernel.ctx.get('auth') as AuthService
  const account = auth.removeAccount(uuid)
  console.log(`ACCOUNT_RESULT ${JSON.stringify(account)}`)
  return 0
}


export async function runCursePackCli(kernel: Kernel, source: string): Promise<number> {
  const content = kernel.ctx.get('content') as ContentService
  const result = await content.installCursePack(source)
  console.log(`CURSE_PACK_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}

export async function runInspectCursePackCli(kernel: Kernel, source: string): Promise<number> {
  const content = kernel.ctx.get('content') as ContentService
  const result = await content.inspectCursePack(source)
  console.log(`CURSE_INSPECT_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}


export async function runGameLogCli(kernel: Kernel, instanceId?: string): Promise<number> {
  const diagnose = kernel.ctx.get('diagnose') as DiagnoseService
  const instances = kernel.ctx.get('instances') as InstancesService
  const target = instanceId || instances.active().id
  const result = diagnose.gameLog(target, 200)
  console.log(`GAME_LOG_RESULT ${JSON.stringify({ instanceId: target, file: result.file, lineCount: result.lines.length, error: result.error, tail: result.lines.slice(-5) })}`)
  return result.error ? 1 : 0
}


export async function runExportInstanceCli(kernel: Kernel, id: string, dest?: string): Promise<number> {
  const instances = kernel.ctx.get('instances') as InstancesService
  const result = await instances.exportInstance(id, dest)
  console.log(`EXPORT_RESULT ${JSON.stringify({ id, ...result })}`)
  return result.ok ? 0 : 1
}

export async function runImportInstanceCli(kernel: Kernel, zipPath: string): Promise<number> {
  const instances = kernel.ctx.get('instances') as InstancesService
  const result = await instances.importInstance(zipPath)
  console.log(`IMPORT_RESULT ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
}


export async function runBindAccountCli(kernel: Kernel, accountId: string | undefined, instanceId?: string): Promise<number> {
  const instances = kernel.ctx.get('instances') as InstancesService
  const auth = kernel.ctx.get('auth') as AuthService
  const target = instanceId || instances.active().id
  if (!accountId) {
    instances.setAccount(target)
    console.log(`BIND_RESULT ${JSON.stringify({ instanceId: target, accountId: null, instance: instances.get(target) })}`)
    return 0
  }
  const account = auth.accountById(accountId)
  if (!account) {
    console.log(`BIND_RESULT ${JSON.stringify({ ok: false, error: `账号不存在：${accountId}` })}`)
    return 1
  }
  instances.setAccount(target, account.uuid, account.name)
  console.log(`BIND_RESULT ${JSON.stringify({ instanceId: target, accountId: account.uuid, accountName: account.name, instance: instances.get(target) })}`)
  return 0
}

export async function runCallToolCli(kernel: Kernel, spec: string): Promise<number> {
  const tools = kernel.ctx.get('tools') as ToolsService
  const [name, ...rest] = spec.split('::')
  let args: Record<string, unknown> = {}
  if (rest.length > 0) {
    try {
      args = JSON.parse(rest.join('::')) as Record<string, unknown>
    } catch {
      args = {}
    }
  }
  const result = await tools.call(name, args)
  console.log(`TOOL_RESULT ${JSON.stringify({ name, args, ...result })}`)
  return result.ok ? 0 : 1
}

export async function runFixesCli(kernel: Kernel): Promise<number> {
  const diagnose = kernel.ctx.get('diagnose') as DiagnoseService
  const instances = kernel.ctx.get('instances') as InstancesService
  const instanceId = instances.active().id
  const [diagnosis, fixes] = await Promise.all([diagnose.run(instanceId), diagnose.fixes(instanceId)])
  console.log(`DIAG_RESULT ${JSON.stringify({ instanceId, diagnosis })}`)
  console.log(`FIXES_RESULT ${JSON.stringify({ instanceId, fixes })}`)
  return 0
}

export async function runApplyFixCli(kernel: Kernel, fixId: string): Promise<number> {
  const diagnose = kernel.ctx.get('diagnose') as DiagnoseService
  const instances = kernel.ctx.get('instances') as InstancesService
  const instanceId = instances.active().id
  const result = await diagnose.applyFix(instanceId, fixId)
  console.log(`FIX_RESULT ${JSON.stringify({ instanceId, fixId, ...result })}`)
  return result.ok ? 0 : 1
}

export async function runUpdateDownloadCli(kernel: Kernel): Promise<number> {
  const updater = kernel.ctx.get('updater') as UpdaterService
  let lastPct = -1
  updater.setProgressSink((p) => {
    const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct
      console.log(`[update] ${pct}% ${(p.done / 1048576).toFixed(1)}MB / ${(p.total / 1048576).toFixed(1)}MB`)
    }
  })
  const checked = await updater.check('manual')
  console.log(`UPDATE_CHECK ${JSON.stringify(checked)}`)
  if (checked.status === 'ready') {
    console.log(`UPDATE_DOWNLOAD ${JSON.stringify(checked)}`)
    return 0
  }
  if (checked.status !== 'available') return 0
  const result = await updater.download()
  console.log(`UPDATE_DOWNLOAD ${JSON.stringify(result)}`)
  return result.status === 'ready' ? 0 : 1
}

export async function runUpdateApplyCli(kernel: Kernel): Promise<number> {
  const updater = kernel.ctx.get('updater') as UpdaterService
  const result = await updater.apply()
  console.log(`UPDATE_APPLY ${JSON.stringify(result)}`)
  return result.ok ? 0 : 1
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
