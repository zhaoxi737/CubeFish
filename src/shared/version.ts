/** 不依赖任何第三方库的版本号比较。支持 x.y.z 与 -pre 后缀。 */
export function parseVersion(input: string): number[] {
  const clean = String(input ?? '').trim().replace(/^v/i, '').split('-')[0]
  const parts = clean.split('.').map((n) => {
    const v = Number.parseInt(n, 10)
    return Number.isFinite(v) ? v : 0
  })
  while (parts.length < 3) parts.push(0)
  return parts
}

/** a > b 返回 1，a < b 返回 -1，相等返回 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}
