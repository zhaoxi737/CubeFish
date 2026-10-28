/**
 * 离线 UUID：和原版启动器一致（MD5("OfflinePlayer:<name>") 后按 UUID v3 规则打版本位）。
 */
import { createHash } from 'node:crypto'

export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`).digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  return hash.toString('hex')
}
