import { useCallback, useEffect, useState } from 'react'
import type { AccountState, AccountSummary, DeviceCodeInfo, SettingsPatch, SettingsShape } from '../../shared/types'

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
  const [accounts, setAccounts] = useState<AccountSummary[]>([])

  const refreshAccounts = useCallback(async () => {
    if (typeof window.qdo === 'undefined') return
    try {
      const [list, state] = await Promise.all([window.qdo.auth.accounts(), window.qdo.auth.state()])
      setAccounts(list)
      setAccount(state)
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    if (typeof window.qdo === 'undefined') return
    void window.qdo.auth
      .state()
      .then((state) => setAccount(state))
      .catch(() => undefined)
    void refreshAccounts()
  }, [refreshAccounts])

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
          await refreshAccounts()
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
  }, [onNotify, refreshAccounts])

  const switchAccount = useCallback(async (uuid: string) => {
    const next = await window.qdo.auth.switchAccount(uuid)
    setAccount(next)
    await refreshAccounts()
    onNotify?.(`已切换到 ${next.name}`)
  }, [onNotify, refreshAccounts])

  const removeAccount = useCallback(async (uuid: string) => {
    const next = await window.qdo.auth.removeAccount(uuid)
    setAccount(next)
    await refreshAccounts()
    onNotify?.('已移除账号')
  }, [onNotify, refreshAccounts])


  const update = <K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const submit = async () => {
    setSaving(true)
    try {
      await onSave({
        updateFeedUrl: draft.updateFeedUrl,
        autoCheckUpdate: draft.autoCheckUpdate,
        downloadSource: draft.downloadSource,
        downloadThreads: draft.downloadThreads,
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
          <div className="settings-intro">
            <strong>不填也能用：</strong>装游戏、装模组、查冲突、修崩溃全部离线可用。<br />
            想用满两个能力再填：<strong>模型 API Key</strong>（AI 对话）和<strong>微软 client_id</strong>（正版登录）。
          </div>
          <div className="settings-group-title">更新与网络</div>
          <label className="field">
            <span className="field-label">更新清单地址（latest.json）</span>
            <input
              value={draft.updateFeedUrl}
              onChange={(event) => update('updateFeedUrl', event.target.value)}
              placeholder="留空 = 不联网检查更新"
              spellCheck={false}
            />
            <span className="field-hint">填你自己的 latest.json 地址即可启用自动更新：下载校验 sha256 后，退出时自动替换并重启。</span>
          </label>

          <label className="field field-inline">
            <input
              type="checkbox"
              checked={draft.autoCheckUpdate}
              onChange={(event) => update('autoCheckUpdate', event.target.checked)}
            />
            <span>启动时自动检查更新</span>
          </label>

          <div className="settings-group-title">下载</div>
          <label className="field">
            <span className="field-label">下载源</span>
            <select
              value={draft.downloadSource}
              onChange={(event) => update('downloadSource', event.target.value as SettingsShape['downloadSource'])}
            >
              <option value="auto">自动（推荐：先测速，再选快的那个）</option>
              <option value="bmclapi">国内镜像 BMCLAPI（国内网络明显更快）</option>
              <option value="official">Mojang 官方源（海外网络更快）</option>
            </select>
            <span className="field-hint">
              游戏本体、库文件、贴图音效都从这里下。PCL 下载快，很大一部分就是默认走国内镜像 + 多线程分片——这里也是同样的做法。
            </span>
          </label>

          <label className="field">
            <span className="field-label">单文件分片线程数</span>
            <input
              type="number"
              min={1}
              max={16}
              value={draft.downloadThreads}
              onChange={(event) => update('downloadThreads', Math.max(1, Math.min(16, Number(event.target.value) || 4)))}
            />
            <span className="field-hint">大文件会切成几段同时下。1–2 省带宽，4–8 更快；网络差或镜像限速时调小。</span>
          </label>

          <div className="settings-group-title">游戏与启动</div>
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
            <span className="field-hint">每个版本可以单独调整；整合包建议 4–8 GB，原版 2–4 GB 就够。</span>
          </label>

          <label className="field">
            <span className="field-label">离线登录玩家名</span>
            <input
              value={draft.playerName}
              onChange={(event) => update('playerName', event.target.value)}
              placeholder="Player"
              spellCheck={false}
            />
            <span className="field-hint">离线进游戏时显示的名字。登录微软账号后会自动改用正版 ID。</span>
          </label>

          <div className="settings-group-title">AI 助手</div>
          <label className="field">
            <span className="field-label">模型 API Key（只存本地）</span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => update('apiKey', event.target.value)}
              placeholder="sk-... （DeepSeek / 任意 OpenAI 兼容服务）"
              spellCheck={false}
            />
            <span className="field-hint">只保存在本机，不会上传。没填也能装游戏、修崩溃，只是 AI 对话框不能说话。</span>
          </label>

          <label className="field">
            <span className="field-label">模型接口地址</span>
            <input
              value={draft.llmBaseUrl}
              onChange={(event) => update('llmBaseUrl', event.target.value)}
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
            />
            <span className="field-hint">默认是 DeepSeek；任何 OpenAI 兼容的 /chat/completions 地址都行。</span>
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

          <div className="settings-group-title">隐私与统计</div>
          <label className="field field-inline">
            <input
              type="checkbox"
              checked={draft.telemetry}
              onChange={(event) => update('telemetry', event.target.checked)}
            />
            <span>发送匿名使用统计（设备随机 ID，不含账号与文件路径）</span>
          </label>
          <p className="field-hint">关掉后本地事件仍记录，但不会上传。</p>

          <div className="settings-group-title">微软账号（正版登录）</div>
          <div className="field">
            <span className="field-label">微软账号（正版登录）</span>
            {accounts.length > 0 ? (
              <div className="account-list">
                {accounts.map((entry) => (
                  <div className="account-item" key={entry.uuid}>
                    <span className={`account-name ${entry.active ? 'is-ms' : ''}`}>
                      {entry.name}
                      <small>
                        {entry.active ? ' · 当前' : ''}
                        {entry.tokenStorage === 'encrypted' ? ' · 令牌已加密' : ' · 令牌未加密'}
                      </small>
                    </span>
                    <div className="account-actions">
                      {!entry.active ? (
                        <button type="button" className="ghost tiny" onClick={() => void switchAccount(entry.uuid)} disabled={authBusy}>
                          切换
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost tiny danger"
                        onClick={() => void removeAccount(entry.uuid)}
                        disabled={authBusy}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="account-row">
                <span className="account-name">离线 · {draft.playerName || 'Player'}</span>
              </div>
            )}
            <div className="account-row">
              <button type="button" className="primary" onClick={() => void loginMicrosoft()} disabled={authBusy}>
                {authBusy ? '登录中…' : '登录微软账号（添加）'}
              </button>
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
            <span className="field-hint">留空 = 只能离线登录。登录后的令牌用 Windows DPAPI 加密，只存本机。</span>
          </label>

          <div className="settings-group-title">内容与插件市场</div>
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
