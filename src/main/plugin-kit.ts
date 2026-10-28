import type { Context } from '@deepseek-ai/cordis'

/**
 * 启动器插件的最小契约。
 *
 * 设计意图：与 Cordis 的 Plugin 形状保持一致（函数/类/对象插件），
 * 但额外携带一个稳定 name，用于启动顺序、日志与状态展示。
 */
export interface LauncherPlugin<TConfig = void> {
  name: string
  setup: (config: TConfig) => (ctx: Context) => void | Promise<void>
}

export function definePlugin<TConfig = void>(
  name: string,
  setup: (config: TConfig) => (ctx: Context) => void | Promise<void>,
): LauncherPlugin<TConfig> {
  return { name, setup }
}

/** 取服务；缺失时抛带上下文的错误，避免静默 undefined 蔓延。 */
export function use<T>(ctx: Context, serviceName: string): T {
  const value = ctx.get(serviceName)
  if (value === undefined) {
    throw new Error(`服务 "${serviceName}" 不可用（对应插件未成功加载）`)
  }
  return value as T
}

/** 取可选服务。 */
export function tryUse<T>(ctx: Context, serviceName: string): T | undefined {
  return ctx.get(serviceName) as T | undefined
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
