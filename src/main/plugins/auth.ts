/**
 * 账号服务（P17 → P18）：微软正版登录（OAuth 2.0 设备码）+ 多账号 + 令牌加密。
 *
 * 流程：
 *   1. 请求 device code → 用户浏览器打开 verification_uri 输入 user_code
 *   2. 轮询 token endpoint 拿 MSA token
 *   3. Xbox Live (user.auth) → XSTS → Minecraft Services login_with_xbox
 *   4. 拉 /minecraft/profile 拿 UUID 与名字，写入 accounts.json（token 用 safeStorage 加密）
 *
 * 存储：%APPDATA%/QDOQMC/accounts.json
 *   { active: "<uuid>", accounts: [{ uuid, name, accessToken: "enc1:...", refreshToken, expiresAt }] }
 *
 * 测试可用 QDOQMC_MS_BASE / QDOQMC_XBL_BASE / QDOQMC_XSTS_BASE / QDOQMC_MC_BASE 指向 mock。
 */
import path from 'node:path'
import type { AccountState, AccountSummary, DeviceCodeInfo, LoginStatus } from '../../shared/types'
import { offlineUuid } from '../lib/offline'
import { decryptSecret, encryptSecret, secretKind } from '../lib/secrets'
import { definePlugin, use, type LauncherPlugin } from '../plugin-kit'
import type { LogService } from './logger'
import type { PathsService } from './paths'
import type { SettingsService } from './settings'
import type { StorageService } from './storage'
import type { TelemetryService } from './telemetry'

const AUTH_BASE = () => (process.env.QDOQMC_MS_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '')
const XBL_BASE = () => (process.env.QDOQMC_XBL_BASE || 'https://user.auth.xboxlive.com').replace(/\/+$/, '')
const XSTS_BASE = () => (process.env.QDOQMC_XSTS_BASE || 'https://xsts.auth.xboxlive.com').replace(/\/+$/, '')
const MC_BASE = () => (process.env.QDOQMC_MC_BASE || 'https://api.minecraftservices.com').replace(/\/+$/, '')

interface StoredAccount {
  uuid: string
  name: string
  /** enc1:... / raw:... */
  accessToken: string
  refreshToken?: string
  expiresAt: number
  addedAt: number
}

interface AccountsFile {
  active: string
  accounts: StoredAccount[]
}

export interface AuthService {
  /** 当前展示用账号（同步：有激活账号则微软，否则离线） */
  account(): AccountState
  /** 账号列表（多账号切换用） */
  accounts(): AccountSummary[]
  /** 启动前调用：过期则用 refresh_token 续期 */
  ensureAccount(): Promise<AccountState>
  isMicrosoft(): boolean
  clientId(): string
  beginLogin(): Promise<DeviceCodeInfo>
  completeLogin(): Promise<LoginStatus>
  switchAccount(uuid: string): AccountState
  removeAccount(uuid: string): AccountState
  logout(): AccountState
}

export function createAuthPlugin(): LauncherPlugin<void> {
  return definePlugin('auth', () => (ctx) => {
    const paths = use<PathsService>(ctx, 'paths')
    const storage = use<StorageService>(ctx, 'storage')
    const settings = use<SettingsService>(ctx, 'settings')
    const log = use<LogService>(ctx, 'log')
    const telemetry = use<TelemetryService>(ctx, 'telemetry')
    const file = path.join(paths.data, 'accounts.json')
    const legacyFile = path.join(paths.data, 'account.json')

    let pending: { deviceCode: string; interval: number; deadline: number } | null = null

    const emptyFile = (): AccountsFile => ({ active: '', accounts: [] })

    const load = (): AccountsFile => {
      const data = storage.readJson<AccountsFile | undefined>(file, undefined)
      if (data && Array.isArray(data.accounts)) return { active: data.active ?? '', accounts: data.accounts }
      return emptyFile()
    }

    const save = (data: AccountsFile): void => {
      storage.writeJson(file, data)
    }

    // P17 → P18 迁移：老的 account.json 是明文单账号，导入后删除
    const migrateLegacy = (): void => {
      if (!storage.exists(legacyFile)) return
      const legacy = storage.readJson<{ type?: string; name?: string; uuid?: string; accessToken?: string; refreshToken?: string; expiresAt?: number } | undefined>(legacyFile, undefined)
      if (legacy?.type === 'microsoft' && legacy.uuid && legacy.name && legacy.accessToken) {
        const data = load()
        if (!data.accounts.some((account) => account.uuid === legacy.uuid)) {
          data.accounts.push({
            uuid: legacy.uuid,
            name: legacy.name,
            accessToken: encryptSecret(legacy.accessToken),
            refreshToken: legacy.refreshToken ? encryptSecret(legacy.refreshToken) : undefined,
            expiresAt: legacy.expiresAt ?? 0,
            addedAt: Date.now(),
          })
          data.active = legacy.uuid
          save(data)
          log.info('auth', '已把旧版明文账号迁移为加密账号', { name: legacy.name, tokenStorage: secretKind(data.accounts[data.accounts.length - 1].accessToken) })
        }
      }
      try {
        storage.writeText(legacyFile, '')
        storage.writeJson(legacyFile, {})
      } catch {
        /* 忽略 */
      }
    }

    migrateLegacy()

    const activeAccount = (data = load()): StoredAccount | undefined =>
      data.accounts.find((account) => account.uuid === data.active) ?? data.accounts[0]

    const offline = (): AccountState => {
      const name = settings.get('playerName') || 'Player'
      return { type: 'offline', name, uuid: offlineUuid(name) }
    }

    const toState = (stored: StoredAccount): AccountState => {
      const token = decryptSecret(stored.accessToken)
      return {
        type: 'microsoft',
        name: stored.name,
        uuid: stored.uuid,
        accessToken: token,
        expiresAt: stored.expiresAt,
      }
    }

    const account = (): AccountState => {
      const stored = activeAccount()
      return stored ? toState(stored) : offline()
    }

    const accounts = (): AccountSummary[] => {
      const data = load()
      const active = activeAccount(data)?.uuid
      return data.accounts.map((entry) => ({
        uuid: entry.uuid,
        name: entry.name,
        active: entry.uuid === active,
        expiresAt: entry.expiresAt,
        tokenStorage: secretKind(entry.accessToken),
      }))
    }

    const clientId = (): string => process.env.QDOQMC_MS_CLIENT_ID || settings.get('msClientId') || ''

    async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
      const text = await res.text()
      let data: unknown = undefined
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { raw: text.slice(0, 300) }
      }
      if (!res.ok) {
        const detail =
          (data as { error_description?: string; error?: string })?.error_description ??
          (data as { error?: string })?.error ??
          `HTTP ${res.status}`
        throw new Error(`授权失败：${detail}`)
      }
      return data as T
    }

    /** MSA token → Xbox Live → XSTS → Minecraft，返回账号（加密落盘） */
    async function finishMicrosoft(msaToken: string, refreshToken?: string): Promise<AccountState> {
      const xbl = await jsonFetch<{ Token: string; DisplayClaims: { xui: { uhs: string }[] } }>(
        `${XBL_BASE()}/user/authenticate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaToken}` },
            RelyingParty: 'http://auth.xboxlive.com',
            TokenType: 'JWT',
          }),
        },
      )
      const uhs = xbl.DisplayClaims?.xui?.[0]?.uhs
      if (!xbl.Token || !uhs) throw new Error('Xbox Live 认证失败：返回数据不完整')

      const xsts = await jsonFetch<{ Token: string; DisplayClaims: { xui: { uhs: string }[] } }>(
        `${XSTS_BASE()}/xsts/authorize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT',
          }),
        },
      )
      const xstsUhs = xsts.DisplayClaims?.xui?.[0]?.uhs ?? uhs

      const mc = await jsonFetch<{ access_token: string; expires_in: number }>(`${MC_BASE()}/authentication/login_with_xbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ identityToken: `XBL3.0 x=${xstsUhs};${xsts.Token}` }),
      })
      if (!mc.access_token) throw new Error('Minecraft 登录失败：没有拿到 access_token')

      const profile = await jsonFetch<{ id: string; name: string }>(`${MC_BASE()}/minecraft/profile`, {
        headers: { authorization: `Bearer ${mc.access_token}`, accept: 'application/json' },
      })
      if (!profile?.id) throw new Error('该账号没有 Minecraft: Java 版（或档案读取失败）')

      const data = load()
      const stored: StoredAccount = {
        uuid: profile.id,
        name: profile.name,
        accessToken: encryptSecret(mc.access_token),
        refreshToken: refreshToken ? encryptSecret(refreshToken) : undefined,
        expiresAt: Date.now() + Math.max(60, mc.expires_in ?? 3600) * 1000,
        addedAt: Date.now(),
      }
      const index = data.accounts.findIndex((entry) => entry.uuid === stored.uuid)
      if (index >= 0) data.accounts[index] = { ...data.accounts[index], ...stored }
      else data.accounts.push(stored)
      data.active = stored.uuid
      save(data)
      telemetry.record('auth:login', { name: stored.name, uuid: stored.uuid, tokenStorage: secretKind(stored.accessToken) })
      log.info('auth', '微软账号登录成功', {
        name: stored.name,
        uuid: stored.uuid,
        tokenStorage: secretKind(stored.accessToken),
        accounts: data.accounts.length,
      })
      return toState(stored)
    }

    async function ensureAccount(): Promise<AccountState> {
      const data = load()
      const stored = activeAccount(data)
      if (!stored) return offline()
      const token = decryptSecret(stored.accessToken)
      if (!token) {
        log.warn('auth', '账号令牌解密失败（可能换了 Windows 用户）', { name: stored.name })
        return offline()
      }
      if (stored.expiresAt > Date.now() + 60_000) return { type: 'microsoft', name: stored.name, uuid: stored.uuid, accessToken: token, expiresAt: stored.expiresAt }
      const refreshToken = decryptSecret(stored.refreshToken)
      if (!refreshToken || !clientId()) {
        return { type: 'microsoft', name: stored.name, uuid: stored.uuid, accessToken: token, expiresAt: stored.expiresAt }
      }
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId(),
          scope: 'XboxLive.signin offline_access',
        })
        const refreshed = await jsonFetch<{ access_token?: string; refresh_token?: string }>(
          `${AUTH_BASE()}/consumers/oauth2/v2.0/token`,
          { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
        )
        if (!refreshed.access_token) return toState(stored)
        log.info('auth', '已刷新微软令牌', { name: stored.name })
        return await finishMicrosoft(refreshed.access_token, refreshed.refresh_token ?? refreshToken)
      } catch (err) {
        log.warn('auth', '刷新令牌失败，继续用旧令牌', { error: err instanceof Error ? err.message : String(err) })
        return toState(stored)
      }
    }

    async function beginLogin(): Promise<DeviceCodeInfo> {
      const id = clientId()
      if (!id) throw new Error('还没有配置微软登录的 client_id（设置 → 微软 client_id）')
      const body = new URLSearchParams({ client_id: id, scope: 'XboxLive.signin offline_access' })
      const data = await jsonFetch<{
        device_code: string
        user_code: string
        verification_uri: string
        expires_in: number
        interval: number
      }>(`${AUTH_BASE()}/consumers/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      pending = {
        deviceCode: data.device_code,
        interval: Math.max(1, data.interval ?? 5),
        deadline: Date.now() + (data.expires_in ?? 900) * 1000,
      }
      telemetry.record('auth:device-code', { verificationUri: data.verification_uri })
      log.info('auth', '已请求设备码', { userCode: data.user_code, verificationUri: data.verification_uri })
      return {
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: data.expires_in ?? 900,
        interval: pending.interval,
      }
    }

    async function completeLogin(): Promise<LoginStatus> {
      if (!pending) return { status: 'error', error: '还没有发起登录（先 beginLogin）' }
      if (Date.now() > pending.deadline) {
        pending = null
        return { status: 'error', error: '设备码已过期，重新发起登录' }
      }
      const id = clientId()
      try {
        const body = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: pending.deviceCode,
          client_id: id,
        })
        const res = await fetch(`${AUTH_BASE()}/consumers/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(30_000),
        })
        const data = (await res.json().catch(() => ({}))) as {
          access_token?: string
          refresh_token?: string
          error?: string
          error_description?: string
        }
        if (!res.ok) {
          if (data.error === 'authorization_pending' || data.error === 'slow_down') return { status: 'pending' }
          pending = null
          return { status: 'error', error: data.error_description ?? data.error ?? `HTTP ${res.status}` }
        }
        if (!data.access_token) return { status: 'error', error: '授权服务器没有返回 access_token' }
        const state = await finishMicrosoft(data.access_token, data.refresh_token)
        pending = null
        return { status: 'ok', account: state }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { status: 'error', error: message }
      }
    }

    function switchAccount(uuid: string): AccountState {
      const data = load()
      const target = data.accounts.find((entry) => entry.uuid === uuid)
      if (!target) return offline()
      data.active = target.uuid
      save(data)
      telemetry.record('auth:switch', { uuid })
      log.info('auth', '已切换账号', { name: target.name, uuid })
      return toState(target)
    }

    function removeAccount(uuid: string): AccountState {
      const data = load()
      const target = data.accounts.find((entry) => entry.uuid === uuid)
      data.accounts = data.accounts.filter((entry) => entry.uuid !== uuid)
      if (data.active === uuid) data.active = data.accounts[0]?.uuid ?? ''
      save(data)
      if (target) {
        telemetry.record('auth:logout', { uuid })
        log.info('auth', '已移除账号', { name: target.name, uuid })
      }
      pending = null
      const next = activeAccount(data)
      return next ? toState(next) : offline()
    }

    function logout(): AccountState {
      const current = activeAccount()
      if (!current) return offline()
      return removeAccount(current.uuid)
    }

    ctx.provide('auth', {
      account,
      accounts,
      ensureAccount,
      isMicrosoft: () => Boolean(activeAccount()),
      clientId,
      beginLogin,
      completeLogin,
      switchAccount,
      removeAccount,
      logout,
    } satisfies AuthService)
  })
}
