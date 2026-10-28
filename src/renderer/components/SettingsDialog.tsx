import { useState } from 'react'
import type { SettingsPatch, SettingsShape } from '../../shared/types'

interface Props {
  settings: SettingsShape
  onClose: () => void
  onSave: (patch: SettingsPatch) => Promise<void> | void
}

export function SettingsDialog({ settings, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<SettingsShape>({ ...settings })
  const [saving, setSaving] = useState(false)

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
        apiKey: draft.apiKey,
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
            <span className="field-label">模型 API Key（只存本地）</span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => update('apiKey', event.target.value)}
              placeholder="P4 接入 AI 后再使用；不会上传"
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
