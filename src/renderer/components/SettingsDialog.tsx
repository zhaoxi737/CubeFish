import { useCallback, useEffect, useState } from 'react'
import type { AccountState, DeviceCodeInfo, SettingsPatch, SettingsShape } from '../../shared/types'

interface Props {
  settings: SettingsShape
  onClose: () => void
  onSave: (patch: SettingsPatch) => Promise<void> | void
  onNotify?: (text: string) => void
}

export function SettingsDialog({ settings, onClose, onSave, onNotify }: Props) {
  const [draft, setDraft] = useState<SettingsShape>({ ...settings })
  const [saving, setSaving] = useState(false)
  const [account, setAccount] = useState<AccountState | null>(null)
  const [device, setDevice] = useState<DeviceCodeInfo | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window.qdo === 'undefined') return
    void window.qdo.auth
      .state()
      .then((state) => setAccount(state))
      .catch(() => undefined)
  }, [])

  const loginMicrosoft = useCallback(async () => {
    if (typeof window.qdo === 'undefined') return
    setAuthBusy(true)
    setAuthError(null)
    try {
      const info = await window.qdo.auth.begin()
      setDevice(info)
      const deadline = Date.now() + Math.max(30, info.expiresIn) * 1000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, info.interval) * 1000))
        const status = await window.qdo.auth.complete()
        if (status.status === 'ok' && status.account) {
          setAccount(status.account)
          setDevice(null)
          onNotify?.(`已登录：${status.account.name}`)
          break
        }
        if (status.status === 'error') {
          setAuthError(status.error ?? '登录失败')
          setDevice(null)
          break
        }
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthBusy(false)
    }
  }, [onNotify])

  const logoutMicrosoft = useCallback(async () => {
    const next = await window.qdo.auth.logout()
    setAccount(next)
    onNotify?.('已退出微软账号')
  }, [onNotify])


  const update = <K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const submit = async () => {
    setSaving(true)
    try {
      await onSave({
        updateFeedUrl: draft.updateFeedUrl,
        autoCheckUpdate: draft.autoCheckUpdate,
        telemetry: draft.telemetry,
        memoryMb: draft.memoryMb,
        playerName: draft.playerName,
        apiKey: draft.apiKey,
        llmBaseUrl: draft.llmBaseUrl,
        llmModel: draft.llmModel,
        marketUrl: draft.marketUrl,
        msClientId: draft.msClientId,
        marketPublicKey: draft.marketPublicKey,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>设置</h2>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="dialog-body">
          <label className="field">
            <span className="field-label">更新清单地址（latest.json）</span>
            <input
              value={draft.updateFeedUrl}
              onChange={(event) => update('updateFeedUrl', event.target.value)}
              placeholder="留空 = 离线模式，不联网检查更新"
              spellCheck={false}
            />
            <span className="field-hint">以后换成 CDN 上的静态 JSON 即可启用自动更新（P5 接入下载）。</span>
          </label>

          <label className="field field-inline">
            <input
              type="checkbox"
              checked={draft.autoCheckUpdate}
              onChange={(event) => update('autoCheckUpdate', event.target.checked)}
            />
            <span>启动时自动检查更新</span>
          </label>

          <label className="field">
            <span className="field-label">默认内存分配（MB）</span>
            <input
              type="number"
              min={512}
              max={32768}
              step={512}
              value={draft.memoryMb}
              onChange={(event) => update('memoryMb', Number(event.target.value) || 4096)}
            />
            <span className="field-hint">P1 起按实例生效；P3 会按整合包规模自动建议。</span>
          </label>

          <label className="field">
            <span className="field-label">离线登录玩家名</span>
            <input
              value={draft.playerName}
              onChange={(event) => update('playerName', event.target.value)}
              placeholder="Player"
              spellCheck={false}
            />
            <span className="field-hint">离线模式使用（正版登录在 P2 接入）。</span>
          </label>

          <label className="field">
            <span className="field-label">模型 API Key（只存本地）</span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => update('apiKey', event.target.value)}
              placeholder="sk-... （DeepSeek / 任意 OpenAI 兼容服务）"
              spellCheck={false}
            />
            <span className="field-hint">加密后只存在本机；不会上传、不会随统计上报。</span>
          </label>

          <label className="field">
            <span className="field-label">模型接口地址</span>
            <input
              value={draft.llmBaseUrl}
              onChange={(event) => update('llmBaseUrl', event.target.value)}
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
            />
            <span className="field-hint">任何 OpenAI 兼容的 /chat/completions 端点都可以。</span>
          </label>

          <label className="field">
            <span className="field-label">模型名</span>
            <input
              value={draft.llmModel}
              onChange={(event) => update('llmModel', event.target.value)}
              placeholder="deepseek-chat"
              spellCheck={false}
            />
          </label>

          <label className="field field-inline">
            <input
              type="checkbox"
              checked={draft.telemetry}
              onChange={(event) => update('telemetry', event.target.checked)}
            />
            <span>发送匿名使用统计（设备随机 ID，不含账号与文件路径）</span>
          </label>
          <p className="field-hint">关掉后本地事件仍记录，但不会上传。</p>

          <div className="field">
            <span className="field-label">微软账号（正版登录）</span>
            <div className="account-row">
              <span className={`account-name ${account?.type === 'microsoft' ? 'is-ms' : ''}`}>
                {account ? `${account.type === 'microsoft' ? '微软' : '离线'} · ${account.name}` : '读取中…'}
              </span>
              {account?.type === 'microsoft' ? (
                <button type="button" className="ghost tiny" onClick={() => void logoutMicrosoft()} disabled={authBusy}>
                  退出
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => void loginMicrosoft()} disabled={authBusy}>
                  {authBusy ? '登录中…' : '登录微软账号'}
                </button>
              )}
            </div>
            {device ? (
              <div className="device-code">
                在浏览器打开 <strong>{device.verificationUri}</strong>，输入代码 <strong>{device.userCode}</strong>
              </div>
            ) : null}
            {authError ? <span className="field-hint">{authError}</span> : null}
          </div>

          <label className="field">
            <span className="field-label">微软登录 client_id</span>
            <input
              value={draft.msClientId}
              onChange={(event) => update('msClientId', event.target.value)}
              placeholder="Azure 应用（公共客户端）的 Application ID"
              spellCheck={false}
            />
            <span className="field-hint">留空 = 只能离线登录。令牌只存本机 account.json，不上传。</span>
          </label>

          <label className="field">
            <span className="field-label">插件市场 feed 地址</span>
            <input
              value={draft.marketUrl}
              onChange={(event) => update('marketUrl', event.target.value)}
              placeholder="https://cdn.example.com/qdoqmc/market.json"
              spellCheck={false}
            />
            <span className="field-hint">留空 = 不启用市场。只建议使用你信任的 feed。</span>
          </label>

          <label className="field">
            <span className="field-label">市场公钥（Ed25519 PEM）</span>
            <textarea
              className="field-textarea"
              value={draft.marketPublicKey}
              onChange={(event) => update('marketPublicKey', event.target.value)}
              placeholder="-----BEGIN PUBLIC KEY----- ..."
              spellCheck={false}
            />
            <span className="field-hint">配置后强制验签；留空 = 开发模式（不校验签名）。</span>
          </label>
        </div>

        <div className="dialog-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void submit()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
