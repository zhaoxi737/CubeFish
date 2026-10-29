import { useCallback, useState } from 'react'
import type { InstanceSummary } from '../../shared/types'

interface Props {
  instances: InstanceSummary[]
  activeId: string
  onClose: () => void
  onActivate: (id: string) => void
  onRefresh: () => Promise<void>
  onNotify: (text: string) => void
  onCreate: () => void
  onOpenMods: (id: string) => void
}

const KIND_LABEL: { kind: 'root' | 'game' | 'mods' | 'logs'; label: string }[] = [
  { kind: 'root', label: '实例目录' },
  { kind: 'game', label: '游戏目录' },
  { kind: 'mods', label: 'mods' },
  { kind: 'logs', label: '日志' },
]

export function VersionManager({ instances, activeId, onClose, onActivate, onRefresh, onNotify, onCreate, onOpenMods }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const openFolder = useCallback(
    async (id: string, kind: 'root' | 'game' | 'mods' | 'logs') => {
      try {
        const result = await window.qdo.instances.openFolder(id, kind)
        if (!result.ok) onNotify(`打开失败：${result.error ?? '未知错误'}`)
        else onNotify(`已在资源管理器打开：${result.path}`)
      } catch (err) {
        onNotify(`打开失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [onNotify],
  )

  const doRename = useCallback(
    async (id: string) => {
      const name = renameValue.trim()
      if (!name) {
        onNotify('名称不能为空')
        return
      }
      setBusy(id)
      try {
        await window.qdo.instances.rename(id, name)
        setRenaming(null)
        await onRefresh()
        onNotify(`已重命名为「${name}」`)
      } catch (err) {
        onNotify(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [onNotify, onRefresh, renameValue],
  )

  const remove = useCallback(
    async (item: InstanceSummary) => {
      const isDefault = item.id === 'default'
      const hint = isDefault
        ? `删除默认实例「${item.name}」？里面的 mods、存档、配置会一起删除；删除后会自动重建一个空白默认实例。\n（游戏本体文件不受影响，可在下载中心里单独卸载）`
        : `删除实例「${item.name}」？里面的 mods、存档、配置会一起删除。\n（游戏本体文件不受影响，可在下载中心里单独卸载）`
      if (!window.confirm(hint)) return
      setBusy(item.id)
      try {
        const result = await window.qdo.instances.remove(item.id)
        if (!result.ok) onNotify(`删除失败：${result.error ?? '未知错误'}`)
        else {
          await onRefresh()
          onNotify(isDefault ? '已删除默认实例（已重建空白默认实例）' : `已删除「${item.name}」`)
        }
      } catch (err) {
        onNotify(`删除失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [onNotify, onRefresh],
  )

  const exportOne = useCallback(
    async (item: InstanceSummary) => {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const dest = await window.qdo.dialog.pickSave(`${item.id}-${stamp}.zip`)
        if (!dest) return
        const result = await window.qdo.instances.export(item.id, dest)
        if (!result.ok) onNotify(`导出失败：${result.error ?? '未知错误'}`)
        else onNotify(`已导出到 ${result.path}（${result.files} 个文件）`)
      } catch (err) {
        onNotify(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [onNotify],
  )

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog dialog-wide vm-dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>版本管理</h2>
          <div className="drawer-actions">
            <button type="button" className="ghost" onClick={onCreate}>
              + 新建版本
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="vm-table">
          <div className="vm-head">
            <span>版本</span>
            <span>游戏 / 加载器</span>
            <span>内存</span>
            <span>账号</span>
            <span>文件夹</span>
            <span>操作</span>
          </div>
          {instances.map((item) => {
            const active = item.id === activeId
            return (
              <div className={`vm-row ${active ? 'is-active' : ''}`} key={item.id}>
                <span className="vm-name">
                  {renaming === item.id ? (
                    <span className="vm-rename">
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void doRename(item.id)
                          if (event.key === 'Escape') setRenaming(null)
                        }}
                        maxLength={32}
                        autoFocus
                      />
                      <button type="button" className="ghost tiny" onClick={() => void doRename(item.id)} disabled={busy === item.id}>
                        保存
                      </button>
                      <button type="button" className="ghost tiny" onClick={() => setRenaming(null)}>
                        取消
                      </button>
                    </span>
                  ) : (
                    <>
                      {active ? <span className="vm-dot" /> : null}
                      {item.name}
                    </>
                  )}
                </span>
                <span className="vm-meta">
                  {item.gameVersion ?? item.versionId ?? '未装版本'} · {item.loader}
                  {item.installed ? '' : ' · 未安装'}
                </span>
                <span className="vm-meta">
                  <input
                    key={`${item.id}-${item.memoryMb}`}
                    type="number"
                    className="vm-mem-input"
                    min={512}
                    max={32768}
                    step={512}
                    defaultValue={item.memoryMb}
                    title="内存（MB），回车或失焦保存"
                    onBlur={(event) => {
                      const value = Number(event.target.value)
                      if (!Number.isFinite(value) || value < 512 || value > 32768 || value === item.memoryMb) return
                      void window.qdo.instances
                        .setMemory(item.id, Math.round(value))
                        .then(() => onRefresh())
                        .then(() => onNotify(`已把「${item.name}」内存设为 ${Math.round(value)} MB`))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                  />
                </span>
                <span className="vm-meta">{item.accountName ?? item.playerName ?? '离线'}</span>
                <span className="vm-folders">
                  {KIND_LABEL.map((entry) => (
                    <button
                      type="button"
                      key={entry.kind}
                      className="ghost tiny link"
                      onClick={() => void openFolder(item.id, entry.kind)}
                      title={entry.label}
                    >
                      {entry.label}
                    </button>
                  ))}
                </span>
                <span className="vm-actions">
                  {!active ? (
                    <button type="button" className="primary tiny" onClick={() => onActivate(item.id)}>
                      切换
                    </button>
                  ) : (
                    <span className="vm-badge">当前</span>
                  )}
                  <button type="button" className="ghost tiny" onClick={() => onOpenMods(item.id)}>
                    模组
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      setRenaming(item.id)
                      setRenameValue(item.name)
                    }}
                  >
                    重命名
                  </button>
                  <button type="button" className="ghost tiny" onClick={() => void exportOne(item)}>
                    导出
                  </button>
                  <button type="button" className="ghost tiny danger" onClick={() => void remove(item)} disabled={busy === item.id}>
                    删除
                  </button>
                </span>
              </div>
            )
          })}
        </div>

        <div className="dialog-foot">
          <span className="field-hint">
            每个版本有独立的 mods / 存档 / 配置；文件夹按钮直接用资源管理器打开对应目录。
          </span>
        </div>
      </div>
    </div>
  )
}
