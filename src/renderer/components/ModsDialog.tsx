import { useCallback, useEffect, useState } from 'react'
import type { InstanceSummary, InstalledContent, SearchHit } from '../../shared/types'

interface Props {
  instance: InstanceSummary
  onClose: () => void
  onNotify: (text: string) => void
}

export function ModsDialog({ instance, onClose, onNotify }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [installed, setInstalled] = useState<InstalledContent[]>([])

  const loader = instance.loader === 'fabric' ? 'fabric' : undefined
  const mcVersion = instance.gameVersion

  const loadInstalled = useCallback(async () => {
    try {
      setInstalled(await window.qdo.content.installed(instance.id))
    } catch {
      /* 没有 content.json 属正常 */
    }
  }, [instance.id])

  const search = useCallback(
    async (text: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = await window.qdo.content.search(text, { type: 'mod', mcVersion, loader, limit: 12 })
        setHits(result)
        if (result.length === 0) setError('没有找到匹配的模组（先确认实例已绑定游戏版本 / 已装 Fabric）')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [loader, mcVersion],
  )

  useEffect(() => {
    void search('')
    void loadInstalled()
  }, [loadInstalled, search])

  const install = useCallback(
    async (hit: SearchHit) => {
      setBusy(hit.projectId)
      try {
        const result = await window.qdo.content.install(instance.id, hit.projectId, { mcVersion, loader })
        if (!result.ok) onNotify(`安装失败：${result.error ?? '未知错误'}`)
        else onNotify(`已安装 ${result.title ?? hit.title} ${result.versionNumber ?? ''}`)
        await loadInstalled()
      } catch (err) {
        onNotify(`安装失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [instance.id, loader, mcVersion, onNotify, loadInstalled],
  )

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>
            模组 · {mcVersion ?? '未绑定版本'} · {loader ?? 'vanilla'}
          </h2>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="mods-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void search(query)
            }}
            placeholder="搜索模组，例如 sodium、fabric api、jei"
            spellCheck={false}
          />
          <button type="button" className="primary" onClick={() => void search(query)} disabled={loading}>
            {loading ? '搜索中…' : '搜索'}
          </button>
        </div>

        {installed.length > 0 ? (
          <div className="mods-installed">
            已安装 {installed.length} 个：{installed.map((item) => item.fileName).join('、')}
          </div>
        ) : null}

        {error ? <div className="warn-box">{error}</div> : null}

        <div className="mods-list">
          {hits.map((hit) => (
            <div className="mod-row" key={hit.projectId}>
              {hit.iconUrl ? <img className="mod-icon" src={hit.iconUrl} alt="" /> : <div className="mod-icon" />}
              <div className="mod-info">
                <div className="mod-title">
                  {hit.title} <span className="mod-slug">{hit.slug}</span>
                </div>
                <div className="mod-desc">{hit.description}</div>
                <div className="mod-meta">
                  {Math.round(hit.downloads / 1000)}k 下载
                  {hit.categories.length > 0 ? ` · ${hit.categories.slice(0, 3).join(' / ')}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="primary"
                onClick={() => void install(hit)}
                disabled={busy === hit.projectId || !mcVersion}
              >
                {busy === hit.projectId ? '安装中…' : '安装'}
              </button>
            </div>
          ))}
        </div>

        <div className="dialog-foot">
          <span className="field-hint">只显示与当前实例（{mcVersion ?? '未知版本'} / {loader ?? 'vanilla'}）匹配的最新版本</span>
        </div>
      </div>
    </div>
  )
}
