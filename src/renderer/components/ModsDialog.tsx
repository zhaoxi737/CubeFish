import { useCallback, useEffect, useState } from 'react'
import type { ConflictReport, InstanceSummary, InstalledContent, PackInspect, SearchHit } from '../../shared/types'

interface Props {
  instance: InstanceSummary
  onClose: () => void
  onNotify: (text: string) => void
  /** 整合包安装会新建实例，通知外层刷新 */
  onRefresh?: () => void
}

const KIND_LABEL: Record<string, string> = {
  mod: '模组',
  resourcepack: '资源包',
  shader: '光影',
  modpack: '整合包',
}

const KIND_PLACEHOLDER: Record<string, string> = {
  mod: 'sodium',
  resourcepack: 'faithful',
  shader: 'bsl',
  modpack: 'adrenaline',
}

export function ModsDialog({ instance, onClose, onNotify, onRefresh }: Props) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'mod' | 'resourcepack' | 'shader' | 'modpack'>('mod')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [installed, setInstalled] = useState<InstalledContent[]>([])
  const [report, setReport] = useState<ConflictReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [packPath, setPackPath] = useState('')
  const [packPreview, setPackPreview] = useState<PackInspect | null>(null)
  const [packBusy, setPackBusy] = useState(false)

  const previewPack = useCallback(async () => {
    const source = packPath.trim()
    if (!source) {
      onNotify('先粘贴整合包路径')
      return
    }
    setPackBusy(true)
    try {
      setPackPreview(await window.qdo.content.inspectPack(source))
    } catch (err) {
      setPackPreview({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setPackBusy(false)
    }
  }, [onNotify, packPath])

  const installPack = useCallback(async () => {
    const source = packPath.trim()
    if (!source) {
      onNotify('先粘贴整合包路径')
      return
    }
    setPackBusy(true)
    try {
      const result = await window.qdo.content.installPack(source)
      if (!result.ok) onNotify(`整合包安装失败：${result.error ?? '未知错误'}`)
      else {
        const count = result.kind === 'curseforge' ? (result.resolved ?? 0) + (result.bundled ?? 0) : result.files ?? 0
        onNotify(`已安装「${result.packName}」到新实例（${result.loader} ${result.mcVersion}，${count} 个文件）`)
        onRefresh?.()
        setPackPreview(null)
      }
    } catch (err) {
      onNotify(`整合包安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPackBusy(false)
    }
  }, [onNotify, onRefresh, packPath])

  const loader = instance.loader === 'fabric' ? 'fabric' : undefined
  const mcVersion = instance.gameVersion
  // 资源包/光影/整合包的版本没有 loader 维度，传 loader 反而会把结果过滤没
  const loaderFilter = kind === 'mod' ? loader : undefined

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
        const result = await window.qdo.content.search(text, { type: kind, mcVersion, loader: loaderFilter, limit: 12 })
        setHits(result)
        if (result.length === 0) setError(`没有找到匹配的${KIND_LABEL[kind]}（先确认实例已绑定游戏版本）`)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [kind, loaderFilter, mcVersion],
  )

  useEffect(() => {
    void search('')
    void loadInstalled()
  }, [loadInstalled, search])

  const install = useCallback(
    async (hit: SearchHit) => {
      setBusy(hit.projectId)
      try {
        if (kind === 'modpack') {
          const result = await window.qdo.content.installModpack(hit.projectId)
          if (!result.ok) onNotify(`整合包安装失败：${result.error ?? '未知错误'}`)
          else {
            onNotify(`整合包「${result.packName}」已装到新实例（${result.files} 个文件，${result.loader} ${result.mcVersion}）`)
            onRefresh?.()
          }
        } else {
          const result = await window.qdo.content.install(instance.id, hit.projectId, { mcVersion, loader: loaderFilter })
          if (!result.ok) onNotify(`安装失败：${result.error ?? '未知错误'}`)
          else onNotify(`已安装 ${result.title ?? hit.title} ${result.versionNumber ?? ''}`)
          await loadInstalled()
        }
        setReport(null)
      } catch (err) {
        onNotify(`安装失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [instance.id, kind, loaderFilter, mcVersion, onNotify, loadInstalled, onRefresh],
  )

  const toggle = useCallback(
    async (item: InstalledContent) => {
      const result = await window.qdo.content.toggle(instance.id, item.fileName)
      if (!result.ok) onNotify(`操作失败：${result.error}`)
      else onNotify(`${result.enabled ? '已启用' : '已禁用'} ${item.fileName}`)
      await loadInstalled()
      setReport(null)
    },
    [instance.id, onNotify, loadInstalled],
  )

  const remove = useCallback(
    async (item: InstalledContent) => {
      const result = await window.qdo.content.remove(instance.id, item.fileName)
      if (!result.ok) onNotify(`删除失败：${result.error}`)
      else onNotify(`已删除 ${item.fileName}`)
      await loadInstalled()
      setReport(null)
    },
    [instance.id, onNotify, loadInstalled],
  )

  const checkConflicts = useCallback(async () => {
    setChecking(true)
    try {
      const result = await window.qdo.conflict.analyze(instance.id)
      setReport(result)
      const errors = result.issues.filter((issue) => issue.severity === 'error').length
      onNotify(errors > 0 ? `发现 ${errors} 个冲突问题` : `检查了 ${result.mods.length} 个模组，没有冲突`)
    } catch (err) {
      onNotify(`冲突检查失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setChecking(false)
    }
  }, [instance.id, onNotify])

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>
            {KIND_LABEL[kind]} · {mcVersion ?? '未绑定版本'} · {loader ?? 'vanilla'}
          </h2>
          <div className="drawer-actions">
            <button type="button" className="ghost" onClick={() => void checkConflicts()} disabled={checking}>
              {checking ? '检查中…' : '冲突检查'}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="kind-tabs">
          {(['mod', 'resourcepack', 'shader', 'modpack'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`kind-tab ${kind === item ? 'is-active' : ''}`}
              onClick={() => setKind(item)}
            >
              {KIND_LABEL[item]}
            </button>
          ))}
        </div>

        {kind === 'modpack' ? (
          <div className="pack-local">
            <div className="pack-row">
              <input
                value={packPath}
                onChange={(event) => setPackPath(event.target.value)}
                placeholder="粘贴本机整合包路径（.mrpack / CurseForge .zip）"
                spellCheck={false}
              />
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  const picked = await window.qdo.dialog.pickFile('pack')
                  if (picked) setPackPath(picked)
                }}
                disabled={packBusy}
              >
                选择文件…
              </button>
              <button type="button" className="ghost" onClick={() => void previewPack()} disabled={packBusy}>
                {packBusy ? '处理中…' : '预览'}
              </button>
              <button type="button" className="primary" onClick={() => void installPack()} disabled={packBusy}>
                安装
              </button>
            </div>
            {packPreview ? (
              <div className={`pack-preview ${packPreview.ok ? '' : 'is-bad'}`}>
                {packPreview.ok ? (
                  <>
                    <strong>{packPreview.name ?? '未命名整合包'}</strong>
                    <span>
                      {packPreview.kind === 'curseforge' ? 'CurseForge' : 'Modrinth'} · {packPreview.mcVersion} ·{' '}
                      {packPreview.loader ?? 'vanilla'} {packPreview.loaderVersion ?? ''}
                    </span>
                    <span>
                      清单 {packPreview.fileCount ?? 0} 个文件
                      {packPreview.bundledMods ? ` · 自带 ${packPreview.bundledMods} 个` : ''}
                    </span>
                    {packPreview.needsApiKey ? <span className="pack-warn">需要 CurseForge API Key</span> : null}
                  </>
                ) : (
                  <span className="pack-warn">{packPreview.error ?? '无法识别'}</span>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mods-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void search(query)
            }}
            placeholder={`搜索${KIND_LABEL[kind]}，例如 ${KIND_PLACEHOLDER[kind]}`}
            spellCheck={false}
          />
          <button type="button" className="primary" onClick={() => void search(query)} disabled={loading}>
            {loading ? '搜索中…' : '搜索'}
          </button>
        </div>

        {report ? (
          <div className="conflict-report">
            <div className="conflict-head">
              冲突检查：{report.mods.length} 个模组 · {report.issues.length} 个问题
            </div>
            {report.issues.length === 0 ? (
              <div className="conflict-ok">没有发现冲突（前置、版本、加载器、重复 modid 均正常）</div>
            ) : (
              <ul className="conflict-list">
                {report.issues.map((issue, index) => (
                  <li key={`${issue.kind}-${index}`} className={`conflict-item conflict-${issue.severity}`}>
                    <div className="conflict-message">{issue.message}</div>
                    <div className="conflict-suggestion">→ {issue.suggestion}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {installed.filter((item) => item.kind === kind).length > 0 ? (
          <div className="installed-list">
            {installed
              .filter((item) => item.kind === kind)
              .map((item) => (
                <div className="installed-row" key={item.fileName}>
                  <span className={`installed-name ${item.enabled === false ? 'is-disabled' : ''}`}>{item.fileName}</span>
                  <span className="installed-meta">{item.versionNumber}</span>
                  <button type="button" className="ghost tiny" onClick={() => void toggle(item)}>
                    {item.enabled === false ? '启用' : '禁用'}
                  </button>
                  <button type="button" className="ghost tiny danger" onClick={() => void remove(item)}>
                    删除
                  </button>
                </div>
              ))}
          </div>
        ) : null}

        {error ? <div className="warn-box">{error}</div> : null}

        <div className="mods-list">
          {hits.map((hit) => {
            const gameVersions = hit.gameVersions ?? []
            const hitLoaders = hit.loaders ?? []
            const versionOk = !mcVersion || gameVersions.length === 0 || gameVersions.includes(mcVersion)
            const loaderOk = kind !== 'mod' || !loader || hitLoaders.length === 0 || hitLoaders.includes(loader)
            const compatible = versionOk && loaderOk
            const reason = !versionOk
              ? `它不支持 ${mcVersion}（支持 ${gameVersions.slice(0, 4).join(' / ')}）`
              : !loaderOk
                ? `它需要 ${hitLoaders.join(' / ')}，当前实例是 ${loader ?? 'vanilla'}`
                : ''
            return (
              <div className={`mod-row ${compatible ? '' : 'is-incompatible'}`} key={hit.projectId}>
                {hit.iconUrl ? <img className="mod-icon" src={hit.iconUrl} alt="" /> : <div className="mod-icon" />}
                <div className="mod-info">
                  <div className="mod-title">
                    {hit.title} <span className="mod-slug">{hit.slug}</span>
                  </div>
                  <div className="mod-desc">{hit.description}</div>
                  <div className="mod-compat">
                    {gameVersions.slice(0, 5).map((version) => (
                      <span key={`v-${version}`} className={`mini-chip ${version === mcVersion ? 'is-ok' : ''}`}>
                        {version}
                      </span>
                    ))}
                    {hitLoaders.slice(0, 3).map((item) => (
                      <span key={`l-${item}`} className={`mini-chip ${item === loader ? 'is-ok' : ''}`}>
                        {item}
                      </span>
                    ))}
                    {!compatible ? <span className="mini-chip is-bad">不匹配当前实例</span> : null}
                  </div>
                  <div className="mod-meta">
                    {Math.round(hit.downloads / 1000)}k 下载
                    {hit.categories.length > 0 ? ` · ${hit.categories.slice(0, 3).join(' / ')}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="primary"
                  title={reason || '安装与当前实例版本匹配的最新文件'}
                  onClick={() => void install(hit)}
                  disabled={busy === hit.projectId || !mcVersion || !compatible}
                >
                  {busy === hit.projectId ? '安装中…' : !compatible ? '版本不符' : '安装'}
                </button>
              </div>
            )
          })}
        </div>

        <div className="dialog-foot">
          <span className="field-hint">
            {kind === 'modpack'
              ? '安装整合包会自动新建实例，并装好对应版本的 Fabric 与全部模组/配置'
              : `只显示与当前实例（${mcVersion ?? '未知版本'} / ${kind === 'mod' ? loader ?? 'vanilla' : KIND_LABEL[kind]}）匹配的最新版本`}
          </span>
        </div>
      </div>
    </div>
  )
}
