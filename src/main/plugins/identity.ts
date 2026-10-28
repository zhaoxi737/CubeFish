import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { StorageService } from './storage'

/**
 * 身份服务（统一身份的缝）。
 *
 * P0 只有匿名 install_id：随机 UUID，用于去重统计。
 * 未来升级为正式账号时，只需在 subject 之上加 accountId，
 * 订单/授权/云存档都挂同一个 subject，不需要重建数据。
 */
export interface IdentityService {
  readonly installId: string
  readonly createdAt: number
  subject(): { installId: string; createdAt: number }
}

interface IdentityFile {
  installId: string
  createdAt: number
}

export function createIdentityPlugin(): LauncherPlugin<void> {
  return definePlugin('identity', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const storage = use<StorageService>(ctx, 'storage')
    const log = use<LogService>(ctx, 'log')
    const file = path.join(paths.data, 'identity.json')

    let data = storage.readJson<IdentityFile>(file, { installId: '', createdAt: 0 })
    if (!data.installId) {
      data = { installId: randomUUID(), createdAt: Date.now() }
      storage.writeJson(file, data)
      log.info('identity', '已生成匿名设备标识', { installId: data.installId })
    }

    const svc: IdentityService = {
      installId: data.installId,
      createdAt: data.createdAt,
      subject: () => ({ installId: data.installId, createdAt: data.createdAt }),
    }
    ctx.provide('identity', svc)
  })
}
