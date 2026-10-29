import { useMemo, useState } from 'react'
import type { LoaderAvailability, VersionList } from '../../shared/types'

export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge'

const LOADER_META: Record<LoaderKind, { name: string; short: string; note: string }> = {
  vanilla: { name: '原版', short: 'Vanilla', note: '不装加载器，不能加模组' },
  fabric: { name: 'Fabric', short: 'Fabric', note: '轻量、更新快，适合优化模组和大多数整合包' },
  forge: { name: 'Forge', short: 'Forge', note: '老牌加载器，1.20.1 及更早版本的模组几乎都靠它' },
  neoforge: { name: 'NeoForge', short: 'NeoForge', note: 'Forge 的社区分支，1.20.2 之后的新版本主流' },
}

interface Props {
  /** 当前实例名，显示在安装按钮上 */
  instanceName: string
  versions: VersionList | null
  installed: string[]
  selected: string
  onSelect: (gameVersion: string) => void
  availability: LoaderAvailability | null
  availabilityLoading: boolean
  choice: LoaderKind
  onChoice: (kind: LoaderKind) => void
  loaderVersion: string
  onLoaderVersion: (version: string) => void
  /** 当前实例已经装的版本+加载器，用于显示"已是最新配置" */
  currentVersionId?: string
  currentLoader?: string
  busy: boolean
  onInstall: () => void
  onRetry: () => void
  downloadSource?: string
}

export function VersionPicker({
  instanceName,
  versions,
  installed,
  selected,
  onSelect,
  availability,
  availabilityLoading,
  choice,
  onChoice,
  loaderVersion,
  onLoaderVersion,
  currentVersionId,
  currentLoader,
  busy,
  onInstall,
  onRetry,
  downloadSource,
}: Props) {
  const [showAll, setShowAll] = useState(false)

  const options = useMemo(() => {
    const list = versions?.versions ?? []
    return showAll ? list : list.filter((item) => item.type === 'release')
  }, [showAll, versions])

  const current = options.find((item) => item.id === selected)
  const isInstalled = installed.includes(selected)
  const choiceMeta = LOADER_META[choice]
  // 只认「和当前选中版本匹配」的查询结果，否则会把上一个版本的加载器版本显示出来
  const matching = availability && availability.gameVersion === selected ? availability : null
  const loading = availabilityLoading || !matching
  const loaderChoice = matching?.loaders.find((item) => item.loader === choice)
  const loaderOptions = loaderChoice?.versions ?? []
  // 选中的加载器版本不在列表里时，用 recommended 兜底（避免 select 显示空白）
  const effectiveLoaderVersion = loaderOptions.includes(loaderVersion)
    ? loaderVersion
    : (loaderChoice?.recommended ?? loaderOptions[0] ?? '')

  const loaderBlocked = choice !== 'vanilla' && !loading && loaderOptions.length === 0
  const canInstall = Boolean(selected) && !busy && !loaderBlocked && !loading
  const currentText = currentVersionId
    ? `当前实例：${currentVersionId}${currentLoader && currentLoader !== 'vanilla' ? `（${currentLoader}）` : '（原版）'}`
    : '当前实例还没绑定版本'

  return (
    <div className="dl-panel">
      <div className="dl-panel-head">
        <span className="dl-panel-title">下载游戏</span>
        <span className="dl-panel-sub">
          选一个游戏版本，再选要不要装模组加载器；点一次安装，原版和加载器都装好并绑定到当前实例
        </span>
      </div>

      <div className="dl-row">
        <span className="dl-label">游戏版本</span>
        <select
          className="dl-select"
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          disabled={busy || !versions}
        >
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {installed.includes(item.id) ? '✓ ' : ''}
              {item.id}
              {item.id === versions?.latest.release ? '（最新正式版）' : ''}
              {item.type !== 'release' ? `（${item.type === 'snapshot' ? '快照' : '旧版本'}）` : ''}
            </option>
          ))}
        </select>
        <label className="dl-check">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} disabled={busy} />
          含快照/旧版
        </label>
        <span className={`dl-badge ${isInstalled ? 'is-ok' : ''}`}>{isInstalled ? '已安装到本机' : '未安装（安装时自动下载）'}</span>
      </div>

      <div className="dl-row dl-row-top">
        <span className="dl-label">模组加载器</span>
        <div className="dl-loaders">
          {(Object.keys(LOADER_META) as LoaderKind[]).map((kind) => {
            const meta = LOADER_META[kind]
            const avail = matching?.loaders.find((item) => item.loader === kind)
            const unavailable = kind !== 'vanilla' && !loading && (avail?.versions.length ?? 0) === 0
            const active = choice === kind
            return (
              <button
                key={kind}
                type="button"
                className={`dl-loader ${active ? 'is-active' : ''} ${unavailable ? 'is-off' : ''}`}
                onClick={() => !unavailable && onChoice(kind)}
                disabled={busy || unavailable}
                title={avail?.note ?? meta.note}
              >
                <span className="dl-loader-name">
                  {meta.name}
                  {kind !== 'vanilla' && avail?.recommended ? <em>{avail.recommended}</em> : null}
                </span>
                <span className="dl-loader-note">
                  {kind === 'vanilla'
                    ? '不加模组'
                    : loading
                      ? '查询中…'
                      : unavailable
                        ? (avail?.note ?? `不支持 ${selected}`)
                        : `${avail?.versions.length ?? 0} 个版本可选`}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {choice !== 'vanilla' ? (
        <div className="dl-row">
          <span className="dl-label">{choiceMeta.name} 版本</span>
          {loaderOptions.length > 0 ? (
            <select
              className="dl-select dl-select-narrow"
              value={effectiveLoaderVersion}
              onChange={(event) => onLoaderVersion(event.target.value)}
              disabled={busy}
            >
              {loaderOptions.map((version) => (
                <option key={version} value={version}>
                  {version}
                  {version === loaderChoice?.recommended ? '（推荐）' : ''}
                  {version === loaderVersion && version !== loaderChoice?.recommended ? '（已选）' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="dl-badge is-warn">
              {loading ? '正在查询可用版本…' : `${choiceMeta.name} 没有适配 ${selected} 的版本`}
            </span>
          )}
          {matching?.javaMajor ? <span className="dl-hint">这个版本需要 Java {matching.javaMajor}</span> : null}
          <button type="button" className="ghost tiny" onClick={onRetry} disabled={loading || busy}>
            重新查询
          </button>
        </div>
      ) : null}

      <div className="dl-foot">
        <button type="button" className="primary dl-go" onClick={onInstall} disabled={!canInstall}>
          {busy
            ? '处理中…'
            : choice === 'vanilla'
              ? `安装 ${selected || '…'} 原版`
              : `安装 ${selected || '…'} + ${choiceMeta.name} ${effectiveLoaderVersion}`}
        </button>
        <span className="dl-hint">
          装到实例「{instanceName}」· {currentText}
        </span>
        <span className="dl-hint dl-hint-right">下载源：{downloadSource === 'bmclapi' ? '国内镜像' : downloadSource === 'official' ? 'Mojang 官方' : '自动测速'}（设置里可改）</span>
      </div>
      {current && current.type !== 'release' ? <div className="dl-warn">这是 {current.type} 版本，可能不稳定，装模组也可能没有适配版本。</div> : null}
    </div>
  )
}
