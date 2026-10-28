/**
 * 敏感字符串落盘加密（P18）。
 *
 * Windows 上走 Electron `safeStorage`（DPAPI，绑定当前用户）；
 * 不可用时退化为 base64 并显式标记 `raw:`，方便诊断，但不会伪装成加密。
 *
 * 格式：
 *   enc1:<base64>   safeStorage 加密
 *   raw:<base64>    未加密（仅 base64，不是安全边界）
 */
import { safeStorage } from 'electron'

export function encryptSecret(text: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc1:${safeStorage.encryptString(text).toString('base64')}`
    }
  } catch {
    /* 退化到 raw */
  }
  return `raw:${Buffer.from(text, 'utf8').toString('base64')}`
}

export function decryptSecret(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith('enc1:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'))
    } catch {
      return undefined
    }
  }
  if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'base64').toString('utf8')
  return undefined
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function secretKind(value: string | undefined): 'encrypted' | 'plain' | 'none' {
  if (!value) return 'none'
  return value.startsWith('enc1:') ? 'encrypted' : 'plain'
}
