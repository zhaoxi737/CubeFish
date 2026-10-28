/**
 * 插件市场（P9）：静态 feed + Ed25519 签名校验 + 一键安装到 plugins/。
 *
 * feed 格式：
 * {
 *   "format": "qdoqmc-market/1",
 *   "payload": "<base64(JSON: {generatedAt, plugins:[...]})>",
 *   "signature": "<base64(Ed25519(payload bytes))>"
 * }
 *
 * - 设置了公钥（设置项或 QDOQMC_MARKET_PUBKEY 环境变量）时强制验签，失败即拒绝；
 * - 未设置公钥 = 开发模式，标注 unsigned；
 * - 插件包安装前校验 sha256 + 大小；解压防路径穿越，且必须含 plugin.json。
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { MarketListResult, MarketPlugin } from '../../shared/types'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { PluginHostService } from './plugin-host'
import type { SettingsService } from './settings'
import type { TelemetryService } from './telemetry'

interface MarketFeed {
  format?: string
  payload?: string
  signature?: string
}

export interface MarketService {
  list(force?: boolean): Promise<MarketListResult>
  install(id: string): Promise<{ ok: boolean; pluginId?: string; error?: string }>
}

const CACHE_TTL_MS = 5 * 60 * 1000

function isValidPlugin(raw: unknown): raw is MarketPlugin {
  if (!raw || typeof raw !== 'object') return false
  const item = raw as Record<string, unknown>
  const download = item.download as Record<string, unknown> | undefined
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.version === 'string' &&
    Boolean(download) &&
    typeof download?.url === 'string' &&
    typeof download?.sha256 === 'string' &&
    typeof download?.size === 'number'
  )
}

export function createMarketPlugin(): LauncherPlugin<void> {
  return definePlugin('market', () => (ctx) => {
    const settings = use<SettingsService>(ctx, 'settings')
    const log = use<LogService>(ctx, 'log')
    const paths = use<PathsService>(ctx, 'paths')
    const host = use<PluginHostService>(ctx, 'pluginHost')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')

    let cache: MarketListResult | null = null
    let cachedAt = 0

    const feedUrl = (): string => process.env.QDOQMC_MARKET_URL || settings.get('marketUrl')
    const publicKey = (): string => process.env.QDOQMC_MARKET_PUBKEY || settings.get('marketPublicKey')

    async function fetchFeed(): Promise<MarketListResult> {
      const url = feedUrl()
      if (!url) {
        return { ok: false, plugins: [], source: 'none', error: '未配置插件市场地址（设置 → 市场 feed 地址）' }
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`市场 feed 请求失败：HTTP ${res.status}`)
        const feed = (await res.json()) as MarketFeed
        if (!feed?.payload || !feed.signature) throw new Error('市场 feed 格式不合法（缺 payload/signature）')

        const payloadBytes = Buffer.from(feed.payload, 'base64')
        const key = publicKey()
        if (key) {
          let ok = false
          try {
            ok = verify(null, payloadBytes, createPublicKey(key), Buffer.from(feed.signature, 'base64'))
          } catch (err) {
            throw new Error(`公钥无效：${err instanceof Error ? err.message : String(err)}`)
          }
          if (!ok) throw new Error('市场签名校验失败：feed 可能被篡改')
        }

        const payload = JSON.parse(payloadBytes.toString('utf8')) as { plugins?: unknown[] }
        const plugins = (payload.plugins ?? []).filter(isValidPlugin)
        cache = { ok: true, plugins, source: key ? 'verified' : 'unsigned' }
        cachedAt = Date.now()
        telemetry.record('market:list', { count: plugins.length, source: cache.source })
        log.info('market', '市场 feed 已加载', { count: plugins.length, source: cache.source })
        return cache
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('market', '市场 feed 加载失败', { error: message })
        return { ok: false, plugins: [], source: 'error', error: message }
      }
    }

    async function list(force = false): Promise<MarketListResult> {
      if (!force && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache
      return fetchFeed()
    }

    async function install(id: string): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
      const data = await list()
      const item = data.plugins.find((plugin) => plugin.id === id)
      if (!item) return { ok: false, error: `市场里没有插件 ${id}` }

      try {
        const res = await fetch(item.download.url, { signal: AbortSignal.timeout(60_000) })
        if (!res.ok) throw new Error(`插件包下载失败：HTTP ${res.status}`)
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length !== item.download.size) {
          throw new Error(`插件包大小不符（期望 ${item.download.size}，实际 ${buffer.length}）`)
        }
        const digest = createHash('sha256').update(buffer).digest('hex')
        if (digest.toLowerCase() !== item.download.sha256.toLowerCase()) {
          throw new Error('插件包 sha256 校验失败，已拒绝安装')
        }

        const dest = path.join(host.dir(), item.id)
        rmSync(dest, { recursive: true, force: true })
        mkdirSync(dest, { recursive: true })

        const zip = new AdmZip(buffer)
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          const name = entry.entryName.replace(/\\/g, '/')
          if (name.includes('..')) continue
          const parts = name.split('/').filter(Boolean)
          // 打包时可能带一层 <id>/ 目录，去掉它
          if (parts.length > 1 && parts[0] === item.id) parts.shift()
          if (parts.length === 0) continue
          const target = path.join(dest, ...parts)
          mkdirSync(path.dirname(target), { recursive: true })
          writeFileSync(target, entry.getData())
        }

        if (!existsSync(path.join(dest, 'plugin.json'))) {
          rmSync(dest, { recursive: true, force: true })
          throw new Error('插件包缺少 plugin.json，已回滚')
        }

        telemetry.record('market:install', { id: item.id, version: item.version })
        log.info('market', '插件已从市场安装', { id: item.id, version: item.version, dir: dest })
        // 触发一次扫描，让 UI 的本地列表立即可见
        host.list()
        return { ok: true, pluginId: item.id }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('market', '市场插件安装失败', { id, error: message })
        telemetry.record('market:install:error', { id, error: message })
        return { ok: false, error: message }
      }
    }

    ctx.provide('market', { list, install } satisfies MarketService)
    void paths
  })
}
