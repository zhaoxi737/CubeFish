/** Mojang version json 的 rules 求值。规则：命中最后一条生效；有 rules 且无命中 = deny。 */

export type OsName = 'windows' | 'osx' | 'linux'

export interface OsContext {
  name: OsName
  /** x86 | x86_64 | arm64 */
  arch: string
  version: string
  features: Record<string, boolean>
}

export interface Rule {
  action: 'allow' | 'deny'
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}

export function detectOsContext(platform: NodeJS.Platform = process.platform, arch: string = process.arch, release = ''): OsContext {
  const name: OsName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'
  const archName = arch === 'x64' ? 'x86_64' : arch === 'ia32' ? 'x86' : arch === 'arm64' ? 'arm64' : arch
  return { name, arch: archName, version: release, features: {} }
}

function matches(rule: Rule, ctx: OsContext): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== ctx.name) return false
    if (rule.os.arch && rule.os.arch !== ctx.arch) return false
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(ctx.version)) return false
      } catch {
        return false
      }
    }
  }
  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      const actual = ctx.features[key] ?? false
      if (actual !== expected) return false
    }
  }
  return true
}

export function evaluateRules(rules: Rule[] | undefined, ctx: OsContext): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (matches(rule, ctx)) allowed = rule.action === 'allow'
  }
  return allowed
}
