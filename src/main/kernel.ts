import { Context } from '@deepseek-ai/cordis'
import { errorMessage, type LauncherPlugin } from './plugin-kit'
import { createAppPlugin } from './plugins/app'
import { createChatPlugin } from './plugins/chat'
import { createCloudPlugin } from './plugins/cloud'
import { createEntitlementPlugin } from './plugins/entitlement'
import { createIdentityPlugin } from './plugins/identity'
import { createInstancesPlugin } from './plugins/instances'
import { createIpcPlugin, type WindowProvider } from './plugins/ipc'
import { createLoggerPlugin, type LogService } from './plugins/logger'
import { createPathsPlugin } from './plugins/paths'
import { createSettingsPlugin } from './plugins/settings'
import { createStoragePlugin } from './plugins/storage'
import { createTelemetryPlugin, type TelemetryService } from './plugins/telemetry'
import { createUpdaterPlugin } from './plugins/updater'

export interface BootSummary {
  plugins: string[]
  failed: { name: string; error: string }[]
}

export interface KernelOptions {
  dataDir: string
  appName: string
  appVersion: string
  isSmoke: boolean
  getWindow: WindowProvider
}

export interface Kernel {
  ctx: Context
  summary: BootSummary
  bootedAt: number
  appVersion: string
  dispose(): Promise<void>
}

/**
 * 内核：Cordis 容器 + 启动器插件装配。
 *
 * 顺序即依赖顺序（P0 用显式顺序保证确定性；P4 的插件宿主会换成注入式按需激活）。
 * 任何插件加载失败都不会阻塞其它插件，失败项通过 AppInfo 暴露给 UI 与日志。
 */
export async function bootKernel(options: KernelOptions): Promise<Kernel> {
  const ctx = new Context()
  const bootedAt = Date.now()
  const summary: BootSummary = { plugins: [], failed: [] }
  const disposers: (() => Promise<void>)[] = []

  const plugins: LauncherPlugin<void>[] = [
    createAppPlugin({
      name: options.appName,
      version: options.appVersion,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      isSmoke: options.isSmoke,
    }),
    createPathsPlugin({ dataDir: options.dataDir }),
    createLoggerPlugin(),
    createSettingsPlugin(),
    createStoragePlugin(),
    createIdentityPlugin(),
    createEntitlementPlugin(),
    createCloudPlugin(),
    createTelemetryPlugin(),
    createUpdaterPlugin(),
    createInstancesPlugin(),
    createChatPlugin(),
    createIpcPlugin({ getWindow: options.getWindow, summary }),
  ]

  for (const plugin of plugins) {
    try {
      const fiber = ctx.plugin(plugin.setup(undefined))
      await fiber
      summary.plugins.push(plugin.name)
      disposers.push(() => Promise.resolve(fiber.dispose()).then(() => undefined))
    } catch (err) {
      const message = errorMessage(err)
      summary.failed.push({ name: plugin.name, error: message })
      console.error(`[kernel] 插件加载失败: ${plugin.name}: ${message}`)
    }
  }

  const log = ctx.get('log') as LogService | undefined
  log?.info('kernel', '内核启动完成', {
    ms: Date.now() - bootedAt,
    plugins: summary.plugins,
    failed: summary.failed,
  })
  if (summary.failed.length > 0) {
    log?.warn('kernel', '存在加载失败的插件', { failed: summary.failed })
  }

  const telemetry = ctx.get('telemetry') as TelemetryService | undefined
  telemetry?.record('kernel:ready', {
    ms: Date.now() - bootedAt,
    plugins: summary.plugins.length,
    failed: summary.failed.length,
  })

  return {
    ctx,
    summary,
    bootedAt,
    appVersion: options.appVersion,
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch (err) {
          console.error('[kernel] 插件卸载失败:', err)
        }
      }
    },
  }
}
