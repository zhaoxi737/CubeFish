import type { ReactNode } from 'react'
import { IconLog, IconPlugin, IconRefresh, IconSettings, IconSystem } from './icons'

export type PageKey = 'home' | 'versions' | 'download'

interface Props {
  page: PageKey
  title: string
  version: string
  updateText: string
  updateTone: 'ok' | 'busy' | 'warn' | 'idle'
  onPage: (page: PageKey) => void
  onDownload: () => void
  onVersions: () => void
  onCheckUpdate: () => void
  onLogs: () => void
  onPlugins: () => void
  onSettings: () => void
  onSystem: () => void
  children?: ReactNode
}

/**
 * 顶栏：品牌 + 胶囊导航 + 右侧图标区。
 *
 * 注意（DOM 契约）：`npm run smoke` 会按「精确文案」在 `.titlebar-actions button` 里找
 * 下载 / 插件 / 检查更新 / 日志 / 设置 / 系统，所以导航与图标按钮都放在这个容器内，
 * 图标按钮用 `.cf-sr` 保留精确文案。
 */
export function TopBar(props: Props) {
  const { page, title, version, updateText, updateTone } = props

  return (
    <header className="titlebar cf-topbar">
      <div className="brand cf-brand">
        <div className="cf-brand-logo">
          <img src="./assets/logo-fish.svg" width="26" height="19" alt="" />
        </div>
        <div className="cf-brand-text">
          <span className="cf-brand-name">{title}</span>
          <span className="cf-brand-sub">CubeFish Launcher · v{version}</span>
        </div>
      </div>

      <div className="titlebar-actions cf-topbar-actions">
        <nav className="cf-nav" aria-label="主导航">
          <button
            type="button"
            className={`cf-tab${page === 'home' ? ' is-active' : ''}`}
            aria-current={page === 'home' ? 'page' : undefined}
            onClick={() => props.onPage('home')}
          >
            主页
          </button>
          <button
            type="button"
            className={`cf-tab${page === 'versions' ? ' is-active' : ''}`}
            aria-current={page === 'versions' ? 'page' : undefined}
            onClick={() => {
              props.onPage('versions')
              props.onVersions()
            }}
          >
            版本
          </button>
          <button
            type="button"
            className={`cf-tab${page === 'download' ? ' is-active' : ''}`}
            aria-current={page === 'download' ? 'page' : undefined}
            onClick={() => {
              props.onPage('download')
              props.onDownload()
            }}
          >
            下载
          </button>
        </nav>

        <div className="cf-topbar-tools">
          {props.children}
          <span className={`cf-status-pill cf-status-${updateTone}`} title={updateText}>
            <span className="cf-status-dot" />
            {updateText}
          </span>
          <button type="button" className="cf-icon-btn" title="检查更新" onClick={props.onCheckUpdate}>
            <IconRefresh />
            <span className="cf-sr">检查更新</span>
          </button>
          <button type="button" className="cf-icon-btn" title="日志" onClick={props.onLogs}>
            <IconLog />
            <span className="cf-sr">日志</span>
          </button>
          <button type="button" className="cf-icon-btn" title="插件" onClick={props.onPlugins}>
            <IconPlugin />
            <span className="cf-sr">插件</span>
          </button>
          <button type="button" className="cf-icon-btn" title="系统" onClick={props.onSystem}>
            <IconSystem />
            <span className="cf-sr">系统</span>
          </button>
          <button type="button" className="cf-icon-btn" title="设置" onClick={props.onSettings}>
            <IconSettings />
            <span className="cf-sr">设置</span>
          </button>
        </div>
      </div>
    </header>
  )
}
