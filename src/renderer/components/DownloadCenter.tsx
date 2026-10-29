import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ConflictReport,
  ContentPreview,
  ContentUpdate,
  InstalledContent,
  InstanceSummary,
  LoaderAvailability,
  PackInspect,
  SearchHit,
  SettingsShape,
  TaskProgress,
  VersionList,
} from '../../shared/types'
import { ProgressCard } from './ProgressCard'

export type DownloadTab = 'game' | 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'task'

type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge'

const NAV: { id: DownloadTab; label: string; icon: string }[] = [
  { id: 'game', label: '游戏', icon: '🧱' },
  { id: 'mod', label: '模组', icon: '🔧' },
  { id: 'resourcepack', label: '资源包', icon: '🎨' },
  { id: 'shader', label: '光影', icon: '💡' },
  { id: 'modpack', label: '整合包', icon: '📦' },
]

const KIND_LABEL: Record<string, string> = {
  mod: '模组',
  resourcepack: '资源包',
  shader: '光影',
  modpack: '整合包',
}

const KIND_HINT: Record<string, string> = {
  mod: '搜 Modrinth 上的模组，按当前实例的游戏版本和加载器过滤',
  resourcepack: '资源包只跟游戏版本有关，不区分加载器',
  shader: '光影需要 Iris / OptiFine；列表里会显示它支持的游戏版本',
  modpack: '整合包会新建一个独立实例，自动装好对应加载器和全部模组',
}

const LOADER_META: Record<LoaderKind, { name: string; note: string }> = {
  vanilla: { name: '原版', note: '不装加载器' },
  fabric: { name: 'Fabric', note: '轻量、更新快' },
  forge: { name: 'Forge', note: '老版本模组主用' },
  neoforge: { name: 'NeoForge', note: '1.20.2+ 新分支' },
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

interface Props {
  instance: InstanceSummary
  tab: DownloadTab
  onTab: (tab: DownloadTab) => void
  versions: VersionList | null
  installedVersions: string[]
  settings: SettingsShape | null
  progress: TaskProgress | null
  taskBusy: boolean
  onCancelTask: () => void
  onClose: () => void
  onNotify: (text: string) => void
  onRefresh: () => void
}

export function DownloadCenter({
  instance,
  tab,
  onTab,
  versions,
  installedVersions,
  settings,
  progress,
  taskBusy,
  onCancelTask,
  onClose,
  onNotify,
  onRefresh,
}: Props) {
  // ---------- 游戏 ----------
  const [gameVersion, setGameVersion] = useState(instance.gameVersion ?? instance.versionId ?? '')
  const [showAll, setShowAll] = useState(false)
  const [availability, setAvailability] = useState<LoaderAvailability | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [gameError, setGameError] = useState<string | null>(null)
  const [loaderKind, setLoaderKind] = useState<LoaderKind>((instance.loader as LoaderKind) ?? 'vanilla')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [gameBusy, setGameBusy] = useState(false)

  const versionOptions = useMemo(() => {
    const list = versions?.versions ?? []
    return showAll ? list : list.filter((item) => item.type === 'release')
  }, [showAll, versions])

  const loadAvailability = useCallback(
    async (game: string) => {
      if (!game) return
      setAvailabilityLoading(true)
      setGameError(null)
      try {
        const result = await window.qdo.loaders.available(game)
        setAvailability(result)
        setLoaderKind((current) => {
          if (current === 'vanilla') return current
          const found = result.loaders.find((item) => item.loader === current)
          return found && found.versions.length > 0 ? current : 'vanilla'
        })
      } catch (err) {
        setAvailability(null)
        setGameError(err instanceof Error ? err.message : String(err))
        onNotify(`查询加载器失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setAvailabilityLoading(false)
      }
    },
    [onNotify],
  )

  useEffect(() => {
    if (tab === 'game') void loadAvailability(gameVersion)
  }, [gameVersion, loadAvailability, tab])

  const matching = availability && availability.gameVersion === gameVersion ? availability : null
  const availLoading = availabilityLoading || !matching
  const loaderChoice = matching?.loaders.find((item) => item.loader === loaderKind)
  const loaderVersions = loaderChoice?.versions ?? []
  const effectiveLoaderVersion = loaderVersions.includes(loaderVersion)
    ? loaderVersion
    : (loaderChoice?.recommended ?? loaderVersions[0] ?? '')
  const loaderBlocked = loaderKind !== 'vanilla' && !availLoading && loaderVersions.length === 0

  const runInstall = useCallback(() => {
    if (!gameVersion || gameBusy) return
    setGameBusy(true)
    // 先切到任务页，让用户立刻看到文件清单
    onTab('task')
    void (async () => {
      try {
        const result = await window.qdo.installer.run({
          instanceId: instance.id,
          gameVersion,
          loader: loaderKind,
          loaderVersion: loaderKind === 'vanilla' ? undefined : effectiveLoaderVersion || undefined,
        })
        if (!result.ok) {
          if ((result.error ?? '').includes('已取消')) onNotify('已取消安装，已下载的文件会保留')
          else onNotify(`安装失败：${result.error ?? '未知错误'}`)
        } else {
          const loaderText = result.loader && result.loader !== 'vanilla' ? ` + ${result.loader} ${result.loaderVersion ?? ''}` : '（原版）'
          onNotify(`安装完成：${gameVersion}${loaderText}，已绑定到「${instance.name}」`)
        }
        onRefresh()
      } catch (err) {
        onNotify(`安装失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setGameBusy(false)
      }
    })()
  }, [effectiveLoaderVersion, gameBusy, gameVersion, instance.id, instance.name, loaderKind, onNotify, onRefresh, onTab])

  // ---------- 内容（模组/资源包/光影） ----------
  const contentKind = tab === 'mod' || tab === 'resourcepack' || tab === 'shader' ? (tab as 'mod' | 'resourcepack' | 'shader') : null
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installed, setInstalled] = useState<InstalledContent[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ContentPreview | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [report, setReport] = useState<ConflictReport | null>(null)
  const [updates, setUpdates] = useState<ContentUpdate[] | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)

  const loaderFilter = contentKind === 'mod' && instance.loader && instance.loader !== 'vanilla' ? instance.loader : undefined
  const mcVersion = instance.gameVersion ?? instance.versionId

  const loadInstalled = useCallback(async () => {
    try {
      setInstalled(await window.qdo.content.installed(instance.id))
    } catch {
      setInstalled([])
    }
  }, [instance.id])

  const search = useCallback(
    async (text: string) => {
      if (!contentKind) return
      setSearching(true)
      setError(null)
      try {
        const result = await window.qdo.content.search(text, {
          type: contentKind,
          mcVersion,
          loader: loaderFilter,
          limit: 20,
        })
        setHits(result)
        if (result.length === 0) setError(`没有搜到${KIND_LABEL[contentKind]}（先确认实例已绑定游戏版本）`)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSearching(false)
      }
    },
    [contentKind, loaderFilter, mcVersion],
  )

  useEffect(() => {
    if (!contentKind) return
    setPreview(null)
    setPreviewId(null)
    setUpdates(null)
    void search('')
    void loadInstalled()
  }, [contentKind, loadInstalled, search])

  const installContent = useCallback(
    async (hit: SearchHit) => {
      if (!contentKind) return
      setBusyId(hit.projectId)
      try {
        const result = await window.qdo.content.install(instance.id, hit.projectId, { mcVersion, loader: loaderFilter })
        if (!result.ok) onNotify(`安装失败：${result.error ?? '未知错误'}`)
        else onNotify(`已安装 ${result.title ?? hit.title} ${result.versionNumber ?? ''}`)
        await loadInstalled()
        setReport(null)
      } catch (err) {
        onNotify(`安装失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusyId(null)
      }
    },
    [contentKind, instance.id, loadInstalled, loaderFilter, mcVersion, onNotify],
  )

  const showPreview = useCallback(
    async (hit: SearchHit) => {
      if (!contentKind) return
      setPreviewId(hit.projectId)
      setPreview(null)
      try {
        setPreview(await window.qdo.content.preview(hit.projectId, contentKind))
      } catch (err) {
        onNotify(`预览加载失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [contentKind, onNotify],
  )

  const toggleContent = useCallback(
    async (item: InstalledContent) => {
      const result = await window.qdo.content.toggle(instance.id, item.fileName)
      if (!result.ok) onNotify(`操作失败：${result.error}`)
      else onNotify(`${result.enabled ? '已启用' : '已禁用'} ${item.fileName}`)
      await loadInstalled()
    },
    [instance.id, loadInstalled, onNotify],
  )

  const removeContent = useCallback(
    async (item: InstalledContent) => {
      const result = await window.qdo.content.remove(instance.id, item.fileName)
      if (!result.ok) onNotify(`删除失败：${result.error}`)
      else onNotify(`已删除 ${item.fileName}`)
      await loadInstalled()
      setUpdates(null)
    },
    [instance.id, loadInstalled, onNotify],
  )

  const checkUpdates = useCallback(async () => {
    setCheckingUpdates(true)
    try {
      const list = await window.qdo.content.updates(instance.id)
      setUpdates(list)
      onNotify(list.length === 0 ? '已装模组都是最新版' : `有 ${list.length} 个模组可以更新`)
    } catch (err) {
      onNotify(`检查更新失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCheckingUpdates(false)
    }
  }, [instance.id, onNotify])

  const applyUpdate = useCallback(
    async (item: ContentUpdate) => {
      setBusyId(item.fileName)
      try {
        const result = await window.qdo.content.update(instance.id, item.fileName)
        if (!result.ok) onNotify(`更新失败：${result.error ?? '未知错误'}`)
        else onNotify(`已更新 ${item.title ?? item.fileName} → ${result.version ?? '最新版'}`)
        await loadInstalled()
        setUpdates((prev) => (prev ? prev.filter((entry) => entry.fileName !== item.fileName) : prev))
      } catch (err) {
        onNotify(`更新失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusyId(null)
      }
    },
    [instance.id, loadInstalled, onNotify],
  )

  const checkConflicts = useCallback(async () => {
    try {
      const result = await window.qdo.conflict.analyze(instance.id)
      setReport(result)
      const errors = result.issues.filter((issue) => issue.severity === 'error').length
      onNotify(errors > 0 ? `发现 ${errors} 个冲突问题` : `检查了 ${result.mods.length} 个模组，没有冲突`)
    } catch (err) {
      onNotify(`冲突检查失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [instance.id, onNotify])

  // ---------- 整合包 ----------
  const [packPath, setPackPath] = useState('')
  const [packPreview, setPackPreview] = useState<PackInspect | null>(null)
  const [packBusy, setPackBusy] = useState(false)
  const [packHits, setPackHits] = useState<SearchHit[]>([])
  const [packQuery, setPackQuery] = useState('')

  const searchPacks = useCallback(async (text: string) => {
    setPackBusy(true)
    setError(null)
    try {
      const result = await window.qdo.content.search(text, { type: 'modpack', limit: 20 })
      setPackHits(result)
      if (result.length === 0) setError('没有搜到整合包')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPackBusy(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'modpack') void searchPacks('')
  }, [searchPacks, tab])

  const inspectPack = useCallback(async () => {
    const source = packPath.trim()
    if (!source) {
      onNotify('先选一个 .mrpack / CurseForge .zip 文件')
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

  const installLocalPack = useCallback(async () => {
    const source = packPath.trim()
    if (!source) {
      onNotify('先选一个 .mrpack / CurseForge .zip 文件')
      return
    }
    setPackBusy(true)
    try {
      const result = await window.qdo.content.installPack(source)
      if (!result.ok) onNotify(`整合包安装失败：${result.error ?? '未知错误'}`)
      else {
        onNotify(`已安装「${result.packName}」到新实例（${result.loader} ${result.mcVersion}）`)
        onRefresh()
        onTab('task')
      }
    } catch (err) {
      onNotify(`整合包安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPackBusy(false)
    }
  }, [onNotify, onRefresh, onTab, packPath])

  const installPackProject = useCallback(
    async (hit: SearchHit) => {
      setBusyId(hit.projectId)
      try {
        const result = await window.qdo.content.installModpack(hit.projectId)
        if (!result.ok) onNotify(`整合包安装失败：${result.error ?? '未知错误'}`)
        else {
          onNotify(`「${result.packName}」已装到新实例（${result.files ?? 0} 个文件）`)
          onRefresh()
          onTab('task')
        }
      } catch (err) {
        onNotify(`整合包安装失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusyId(null)
      }
    },
    [onNotify, onRefresh, onTab],
  )

  const installedForKind = contentKind ? installed.filter((item) => item.kind === contentKind) : []

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dc" role="dialog" aria-modal="true">
        <div className="dc-nav">
          <div className="dc-brand">
            <span className="dc-brand-mark">下载</span>
            <span className="dc-brand-sub">资源中心</span>
          </div>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`dc-nav-item ${tab === item.id ? 'is-active' : ''}`}
              onClick={() => onTab(item.id)}
            >
              <span className="dc-nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
          <div className="dc-nav-sep" />
          <button type="button" className={`dc-nav-item ${tab === 'task' ? 'is-active' : ''}`} onClick={() => onTab('task')}>
            <span className="dc-nav-icon">⬇️</span>
            下载任务
            {progress && progress.stage !== 'done' && progress.stage !== 'cancelled' ? <span className="dc-nav-dot" /> : null}
          </button>
          <div className="dc-nav-foot">
            <div className="dc-hint-line">下载源：{settings?.downloadSource === 'bmclapi' ? '国内镜像' : settings?.downloadSource === 'official' ? 'Mojang 官方' : '自动测速'}</div>
            <div className="dc-hint-line">实例：{instance.name}</div>
          </div>
        </div>

        <div className="dc-body">
          <div className="dc-head">
            <h2>
              {tab === 'task' ? '下载任务' : tab === 'game' ? '安装游戏' : KIND_LABEL[tab] ?? '下载'}
            </h2>
            <span className="dc-head-hint">
              {tab === 'task'
                ? '每个文件的状态都在下面，随时可以取消'
                : tab === 'game'
                  ? '选游戏版本 → 选加载器 → 一次装好并绑定当前实例'
                  : KIND_HINT[tab] ?? ''}
            </span>
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>

          {tab === 'game' ? (
            <div className="dc-pane">
              <div className="dc-row">
                <span className="dc-label">游戏版本</span>
                <select value={gameVersion} onChange={(event) => setGameVersion(event.target.value)} disabled={gameBusy}>
                  {versionOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {installedVersions.includes(item.id) ? '✓ ' : ''}
                      {item.id}
                      {item.id === versions?.latest.release ? '（最新正式版）' : ''}
                    </option>
                  ))}
                </select>
                <label className="dc-check">
                  <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
                  含快照/旧版
                </label>
                <span className={`dc-badge ${installedVersions.includes(gameVersion) ? 'is-ok' : ''}`}>
                  {installedVersions.includes(gameVersion) ? '本机已安装' : '未安装'}
                </span>
              </div>

              <div className="dc-loaders">
                {(Object.keys(LOADER_META) as LoaderKind[]).map((kind) => {
                  const meta = LOADER_META[kind]
                  const avail = matching?.loaders.find((item) => item.loader === kind)
                  const unavailable = kind !== 'vanilla' && !availLoading && (avail?.versions.length ?? 0) === 0
                  return (
                    <button
                      key={kind}
                      type="button"
                      className={`dc-loader ${loaderKind === kind ? 'is-active' : ''} ${unavailable ? 'is-off' : ''}`}
                      disabled={unavailable || gameBusy}
                      onClick={() => {
                        setLoaderKind(kind)
                        const picked = matching?.loaders.find((item) => item.loader === kind)
                        setLoaderVersion(picked?.recommended ?? picked?.versions[0] ?? '')
                      }}
                    >
                      <span className="dc-loader-name">
                        {meta.name}
                        {kind !== 'vanilla' && avail?.recommended ? <em>{avail.recommended}</em> : null}
                      </span>
                      <span className="dc-loader-note">
                        {kind === 'vanilla'
                          ? meta.note
                          : availLoading
                            ? '查询中…'
                            : unavailable
                              ? (avail?.note ?? `不支持 ${gameVersion}`)
                              : `${avail?.versions.length ?? 0} 个版本`}
                      </span>
                    </button>
                  )
                })}
              </div>

              {loaderKind !== 'vanilla' && loaderVersions.length > 0 ? (
                <div className="dc-row">
                  <span className="dc-label">{LOADER_META[loaderKind].name} 版本</span>
                  <select value={effectiveLoaderVersion} onChange={(event) => setLoaderVersion(event.target.value)}>
                    {loaderVersions.map((version) => (
                      <option key={version} value={version}>
                        {version}
                        {version === loaderChoice?.recommended ? '（推荐）' : ''}
                      </option>
                    ))}
                  </select>
                  {matching?.javaMajor ? <span className="dc-hint-line">需要 Java {matching.javaMajor}</span> : null}
                </div>
              ) : null}

              <div className="dc-actions">
                <button type="button" className="primary" onClick={runInstall} disabled={gameBusy || loaderBlocked || !gameVersion}>
                  {gameBusy ? '安装中…' : loaderKind === 'vanilla' ? `安装 ${gameVersion} 原版` : `安装 ${gameVersion} + ${LOADER_META[loaderKind].name} ${effectiveLoaderVersion}`}
                </button>
                <span className="dc-hint-line">装完自动绑定到「{instance.name}」</span>
                <button type="button" className="ghost tiny" onClick={() => void loadAvailability(gameVersion)} disabled={availabilityLoading || gameBusy}>
                  {availabilityLoading ? '查询中…' : '重新查询加载器'}
                </button>
                {gameBusy ? (
                  <button type="button" className="ghost" onClick={onCancelTask}>
                    取消
                  </button>
                ) : null}
              </div>
              {gameError ? <div className="dc-error">加载器查询失败：{gameError}（点上面「重新查询加载器」重试）</div> : null}

              <div className="dc-installed">
                <div className="dc-installed-head">本机已装版本（{installedVersions.length}）· 点「选中」直接切过去装加载器</div>
                {installedVersions.length === 0 ? (
                  <div className="dc-preview-empty">本机还没有装过任何游戏版本，直接在上面选一个装吧。</div>
                ) : (
                  installedVersions.map((version) => (
                    <div className="dc-installed-row" key={version}>
                      <span className="dc-installed-name">{version}</span>
                      {version === gameVersion ? <span className="dc-tag is-ok">当前选中</span> : null}
                      <button type="button" className="ghost tiny" onClick={() => setGameVersion(version)}>
                        选中
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {contentKind ? (
            <div className="dc-pane dc-pane-split">
              <div className="dc-list-col">
                <div className="dc-search">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void search(query)
                    }}
                    placeholder={`搜索${KIND_LABEL[contentKind]}…`}
                    spellCheck={false}
                  />
                  <button type="button" className="primary" onClick={() => void search(query)} disabled={searching}>
                    {searching ? '搜索中…' : '搜索'}
                  </button>
                  {contentKind === 'mod' ? (
                    <>
                      <button type="button" className="ghost" onClick={() => void checkUpdates()} disabled={checkingUpdates}>
                        {checkingUpdates ? '检查更新…' : '检查更新'}
                      </button>
                      <button type="button" className="ghost" onClick={() => void checkConflicts()}>
                        冲突检查
                      </button>
                    </>
                  ) : null}
                </div>

                {reportsBlock()}

                <div className="dc-scroll">
                  {hits.map((hit) => {
                    const gameVersions = hit.gameVersions ?? []
                    const hitLoaders = hit.loaders ?? []
                    const versionOk = !mcVersion || gameVersions.length === 0 || gameVersions.includes(mcVersion)
                    const loaderOk = contentKind !== 'mod' || !loaderFilter || hitLoaders.length === 0 || hitLoaders.includes(loaderFilter)
                    const compatible = versionOk && loaderOk
                    // Modrinth 的 versions 是按旧→新排的，这里反过来只展示最新的几个（当前版本排最前）
                    const newest = gameVersions.slice(-4).reverse()
                    const shownVersions = mcVersion && gameVersions.includes(mcVersion) ? [mcVersion, ...newest.filter((v) => v !== mcVersion)] : newest
                    return (
                      <div
                        key={hit.projectId}
                        className={`dc-item ${compatible ? '' : 'is-off'} ${previewId === hit.projectId ? 'is-picked' : ''}`}
                        onClick={() => void showPreview(hit)}
                      >
                        {hit.iconUrl ? <img className="dc-item-icon" src={hit.iconUrl} alt="" /> : <div className="dc-item-icon" />}
                        <div className="dc-item-main">
                          <div className="dc-item-title">
                            {hit.title} <span className="dc-item-slug">{hit.slug}</span>
                          </div>
                          <div className="dc-item-desc">{hit.description}</div>
                          <div className="dc-item-tags">
                            {shownVersions.map((version) => (
                              <span key={`v-${version}`} className={`dc-tag ${version === mcVersion ? 'is-ok' : ''}`}>
                                {version}
                              </span>
                            ))}
                            {hitLoaders.slice(0, 2).map((item) => (
                              <span key={`l-${item}`} className={`dc-tag ${item === loaderFilter ? 'is-ok' : ''}`}>
                                {item}
                              </span>
                            ))}
                            {!compatible ? <span className="dc-tag is-bad">不匹配当前实例</span> : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="primary dc-item-btn"
                          disabled={busyId === hit.projectId || !compatible}
                          onClick={(event) => {
                            event.stopPropagation()
                            void installContent(hit)
                          }}
                        >
                          {busyId === hit.projectId ? '安装中' : compatible ? '安装' : '版本不符'}
                        </button>
                      </div>
                    )
                  })}
                </div>

                {installedForKind.length > 0 ? (
                  <div className="dc-installed">
                    <div className="dc-installed-head">已安装（{installedForKind.length}）</div>
                    {installedForKind.map((item) => (
                      <div className="dc-installed-row" key={item.fileName}>
                        <span className={`dc-installed-name ${item.enabled === false ? 'is-off' : ''}`}>{item.fileName}</span>
                        <span className="dc-installed-ver">{item.versionNumber}</span>
                        <button type="button" className="ghost tiny" onClick={() => void toggleContent(item)}>
                          {item.enabled === false ? '启用' : '禁用'}
                        </button>
                        <button type="button" className="ghost tiny danger" onClick={() => void removeContent(item)}>
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {error ? <div className="dc-error">{error}</div> : null}
              </div>

              <aside className={`dc-preview ${preview ? 'is-open' : ''}`}>
                {preview ? (
                  <>
                    <div className="dc-preview-head">{preview.title}</div>
                    {preview.gallery.length > 0 ? (
                      <img className="dc-preview-img" src={preview.gallery[0]} alt="" />
                    ) : (
                      <div className="dc-preview-empty">这个项目没有图片</div>
                    )}
                    <div className="dc-preview-desc">{preview.description || '（没有描述）'}</div>
                    <div className="dc-preview-meta">
                      {Math.round(preview.downloads / 1000)}k 下载 · {preview.gameVersions.slice(0, 3).join(' / ') || '—'}
                    </div>
                    {preview.gallery.length > 1 ? (
                      <div className="dc-preview-thumbs">
                        {preview.gallery.slice(1, 5).map((url) => (
                          <img key={url} src={url} alt="" />
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="dc-preview-empty">点左边任意一项，在这里看图片预览</div>
                )}
              </aside>
            </div>
          ) : null}

          {tab === 'modpack' ? (
            <div className="dc-pane">
              <div className="dc-row">
                <span className="dc-label">本地整合包</span>
                <input
                  className="dc-input"
                  value={packPath}
                  onChange={(event) => setPackPath(event.target.value)}
                  placeholder=".mrpack 或 CurseForge .zip 的路径"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={async () => {
                    const picked = await window.qdo.dialog.pickFile('pack')
                    if (picked) setPackPath(picked)
                  }}
                >
                  选择文件…
                </button>
                <button type="button" className="ghost" onClick={() => void inspectPack()} disabled={packBusy}>
                  预览
                </button>
                <button type="button" className="primary" onClick={() => void installLocalPack()} disabled={packBusy}>
                  安装
                </button>
              </div>
              {packPreview ? (
                <div className={`dc-pack ${packPreview.ok ? '' : 'is-bad'}`}>
                  {packPreview.ok ? (
                    <>
                      <strong>{packPreview.name ?? '未命名整合包'}</strong>
                      <span>
                        {packPreview.kind === 'curseforge' ? 'CurseForge' : 'Modrinth'} · {packPreview.mcVersion} · {packPreview.loader ?? 'vanilla'}{' '}
                        {packPreview.loaderVersion ?? ''}
                      </span>
                      <span>清单 {packPreview.fileCount ?? 0} 个文件</span>
                      {packPreview.needsApiKey ? <span className="dc-warn">需要 CurseForge API Key</span> : null}
                    </>
                  ) : (
                    <span className="dc-warn">{packPreview.error ?? '无法识别'}</span>
                  )}
                </div>
              ) : null}

              <div className="dc-search">
                <input
                  value={packQuery}
                  onChange={(event) => setPackQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void searchPacks(packQuery)
                  }}
                  placeholder="或者在线搜索整合包（装到新实例）…"
                  spellCheck={false}
                />
                <button type="button" className="primary" onClick={() => void searchPacks(packQuery)} disabled={packBusy}>
                  {packBusy ? '搜索中…' : '搜索'}
                </button>
              </div>
              <div className="dc-scroll">
                {packHits.map((hit) => (
                  <div key={hit.projectId} className="dc-item">
                    {hit.iconUrl ? <img className="dc-item-icon" src={hit.iconUrl} alt="" /> : <div className="dc-item-icon" />}
                    <div className="dc-item-main">
                      <div className="dc-item-title">{hit.title}</div>
                      <div className="dc-item-desc">{hit.description}</div>
                      <div className="dc-item-tags">
                        {(hit.gameVersions ?? []).slice(-4).reverse().map((version) => (
                          <span key={version} className="dc-tag">
                            {version}
                          </span>
                        ))}
                        {(hit.loaders ?? []).slice(0, 2).map((item) => (
                          <span key={item} className="dc-tag">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="primary dc-item-btn"
                      disabled={busyId === hit.projectId}
                      onClick={() => void installPackProject(hit)}
                    >
                      {busyId === hit.projectId ? '安装中' : '安装'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {tab === 'task' ? (
            <div className="dc-pane">
              {progress ? (
                <ProgressCard progress={progress} busy={taskBusy} title={progress.title ?? '下载任务'} onCancel={onCancelTask} />
              ) : (
                <div className="dc-preview-empty">现在没有下载任务。去「游戏」或「整合包」页发起一个吧。</div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )

  function reportsBlock() {
    return (
      <>
        {report ? (
          <div className={`dc-report ${report.issues.some((issue) => issue.severity === 'error') ? 'is-bad' : 'is-ok'}`}>
            冲突检查：{report.mods.length} 个模组 · {report.issues.length} 个问题
            {report.issues.length === 0 ? ' · 没有发现冲突' : ''}
          </div>
        ) : null}
        {updates && updates.length > 0 && contentKind === 'mod' ? (
          <div className="dc-updates">
            <div className="dc-installed-head">可更新的模组（{updates.length}）</div>
            {updates.map((item) => (
              <div className="dc-installed-row" key={item.fileName}>
                <span className="dc-installed-name">{item.title ?? item.fileName}</span>
                <span className="dc-installed-ver">
                  {item.currentVersion ?? '?'} → {item.latestVersion ?? '?'}
                </span>
                <button type="button" className="primary tiny" onClick={() => void applyUpdate(item)} disabled={busyId === item.fileName}>
                  {busyId === item.fileName ? '更新中' : '更新'}
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {updates && updates.length === 0 && contentKind === 'mod' ? <div className="dc-report is-ok">已装模组都是最新版</div> : null}
      </>
    )
  }
}
