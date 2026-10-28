import { useCallback, useEffect, useState } from 'react'
import type {
  AppInfo,
  EventSummary,
  InstanceSummary,
  LaunchDryRun,
  SettingsPatch,
  SettingsShape,
  UpdateState,
} from '../shared/types'
import { ChatPanel } from './components/ChatPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { LogDrawer } from './components/LogDrawer'

const FALLBACK_INFO: AppInfo = {
  name: 'QDOQMC',
  version: '0.1.0',
  electron: '-',
  chrome: '-',
  node: '-',
  platform: '-',
  arch: '-',
  isSmoke: false,
  bootedAt: Date.now(),
  installId: 'qqqqqqqq',
  dataDir: '',
  logsDir: '',
  plugins: [],
  failedPlugins: [],
}

function updateLabel(state: UpdateState): string {
  switch (state.status) {
    case 'idle':
      return '未检查更新'
    case 'checking':
      return '检查更新中…'
    case 'uptodate':
      return `已是最新 v${state.current}`
    case 'available':
      return `发现新版本 v${state.latest ?? '?'}`
    case 'offline':
      return '离线模式'
    case 'error':
      return '更新检查失败'
    default:
      return '未知状态'
  }
}

export function App() {
  const [info, setInfo] = useState<AppInfo>(FALLBACK_INFO)
  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [instance, setInstance] = useState<InstanceSummary | null>(null)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', current: FALLBACK_INFO.version })
  const [events, setEvents] = useState<EventSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [launch, setLaunch] = useState<LaunchDryRun | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showLogs, setShowLogs] = useState(false)

  const hasApi = typeof window !== 'undefined' && typeof window.qdo !== 'undefined'

  const notify = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 5200)
  }, [])

  const checkUpdate = useCallback(async () => {
    if (!hasApi) return
    setUpdate((prev) => ({ ...prev, status: 'checking' }))
    try {
      const state = await window.qdo.update.check()
      setUpdate(state)
    } catch (err) {
      setUpdate({ status: 'error', current: info.version, message: String(err) })
    }
  }, [hasApi, info.version])

  useEffect(() => {
    if (!hasApi) return
    let cancelled = false
    void (async () => {
      try {
        const [appInfo, appSettings, instances] = await Promise.all([
          window.qdo.info(),
          window.qdo.settings.all(),
          window.qdo.instances.list(),
        ])
        if (cancelled) return
        setInfo(appInfo)
        setSettings(appSettings)
        setInstance(instances[0] ?? null)
        setUpdate((prev) => ({ ...prev, current: appInfo.version }))
        if (appSettings.autoCheckUpdate) void checkUpdate()
        try {
          const summary = await window.qdo.events.summary()
          if (!cancelled) setEvents(summary)
        } catch {
          /* 统计失败不影响主流程 */
        }
      } catch (err) {
        notify(`初始化失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hasApi, checkUpdate, notify])

  const onLaunch = useCallback(async () => {
    if (!hasApi || busy) return
    setBusy(true)
    try {
      const result = await window.qdo.launch.dryRun(instance?.id)
      setLaunch(result)
      setInstance(result.instance)
      notify(result.hint)
    } catch (err) {
      notify(`启动预检失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, hasApi, instance?.id, notify])

  const onSaveSettings = useCallback(
    async (patch: SettingsPatch) => {
      if (!hasApi) return
      const next = await window.qdo.settings.patch(patch)
      setSettings(next)
      setShowSettings(false)
      notify('设置已保存')
    },
    [hasApi, notify],
  )

  const failed = info.failedPlugins

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">QDOQMC</span>
          <span className="brand-version">v{info.version}</span>
          <span className="brand-tag">P0 骨架</span>
        </div>
        <div className="titlebar-actions">
          <button type="button" className="ghost" onClick={() => setShowLogs(true)}>
            日志
          </button>
          <button type="button" className="ghost" onClick={() => setShowSettings(true)}>
            设置
          </button>
        </div>
      </header>

      <main className="main">
        <section className="stage">
          <div className="instances-line">
            <span className="instance-name">{instance?.name ?? '默认实例'}</span>
            <span className="chip">{instance?.mcVersion || '未安装版本'}</span>
            <span className="chip">{instance?.loader ?? 'vanilla'}</span>
            <span className="chip">{instance?.memoryMb ?? 0} MB</span>
            <span className="chip subtle">版本隔离</span>
          </div>

          <button type="button" className="launch" onClick={onLaunch} disabled={busy || !hasApi}>
            <span className="launch-main">{busy ? '预检中…' : '启动游戏'}</span>
            <span className="launch-sub">P0 · 启动链路预检（真实启动在 P1 接入）</span>
          </button>

          {launch ? (
            <ul className="steps">
              {launch.steps.map((step) => (
                <li key={step.step} className={`step step-${step.status}`}>
                  <span className="step-dot" />
                  <span className="step-name">{step.step}</span>
                  <span className="step-detail">{step.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="stage-hint">
              说一句话让它干活：右侧输入 <code>/help</code> 查看当前可用命令。
            </p>
          )}

          {failed.length > 0 ? (
            <div className="warn-box">
              有 {failed.length} 个插件加载失败：{failed.map((f) => f.name).join('、')}（详情见日志）
            </div>
          ) : null}
        </section>

        <ChatPanel />
      </main>

      <footer className="statusbar">
        <span className={`status-dot status-${update.status}`} />
        <span>{updateLabel(update)}</span>
        <span className="sep">·</span>
        <span>设备 {info.installId.slice(0, 8)}</span>
        <span className="spacer" />
        <span>今日事件 {events?.today ?? 0}</span>
        <span className="sep">·</span>
        <span>插件 {info.plugins.length}</span>
        <span className="sep">·</span>
        <span>
          Electron {info.electron} · Node {info.node}
        </span>
      </footer>

      {toast ? <div className="toast">{toast}</div> : null}
      {showSettings && settings ? (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSave={onSaveSettings} />
      ) : null}
      {showLogs ? <LogDrawer onClose={() => setShowLogs(false)} /> : null}
    </div>
  )
}
