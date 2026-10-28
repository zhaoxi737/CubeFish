import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  EventSummary,
  GameStateEvent,
  InstanceSummary,
  SettingsPatch,
  SettingsShape,
  TaskProgress,
  UpdateState,
  VersionList,
} from '../shared/types'
import { ChatPanel } from './components/ChatPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { LogDrawer } from './components/LogDrawer'
import { ModsDialog } from './components/ModsDialog'

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

const STAGE_LABEL: Record<string, string> = {
  version: '解析版本 JSON',
  libraries: '下载库文件',
  assets: '下载游戏资源',
  legacy: '物化旧版资源',
  logging: '日志配置',
  done: '安装完成',
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
  const [versions, setVersions] = useState<VersionList | null>(null)
  const [installed, setInstalled] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [running, setRunning] = useState<{ pid?: number } | null>(null)
  const [exited, setExited] = useState<GameStateEvent | null>(null)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', current: FALLBACK_INFO.version })
  const [events, setEvents] = useState<EventSummary | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showMods, setShowMods] = useState(false)
  const [fabricBusy, setFabricBusy] = useState(false)
  const listening = useRef(false)

  const hasApi = typeof window !== 'undefined' && typeof window.qdo !== 'undefined'

  const notify = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 7000)
  }, [])

  const refreshInstalled = useCallback(async () => {
    if (!hasApi) return
    try {
      const [list, instances] = await Promise.all([window.qdo.versions.installed(), window.qdo.instances.list()])
      setInstalled(list)
      setInstance(instances[0] ?? null)
    } catch (err) {
      notify(`读取实例失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [hasApi, notify])

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
    if (!listening.current) {
      listening.current = true
      window.qdo.onProgress((p) => setProgress(p))
      window.qdo.onGameState((state) => {
        if (state.state === 'running') {
          setRunning({ pid: state.pid })
          setExited(null)
          notify(`游戏已启动：${state.versionId ?? ''}${state.pid ? `（PID ${state.pid}）` : ''}`)
        } else {
          setRunning(null)
          setExited(state)
          notify(`游戏已退出：${state.hint ?? ''}${state.crashReport ? '（已生成崩溃报告）' : ''}`)
          void refreshInstalled()
        }
      })
    }

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
          const [list, installedList] = await Promise.all([window.qdo.versions.list(), window.qdo.versions.installed()])
          if (cancelled) return
          setVersions(list)
          setInstalled(installedList)
          const bound = instances[0]?.gameVersion ?? instances[0]?.versionId
          const preferred = bound && list.versions.some((v) => v.id === bound) ? bound : list.latest.release
          setSelected(preferred)
        } catch (err) {
          if (!cancelled) notify(`版本清单获取失败：${err instanceof Error ? err.message : String(err)}`)
        }

        try {
          const summary = await window.qdo.events.summary()
          if (!cancelled) setEvents(summary)
        } catch {
          /* 统计失败不影响主流程 */
        }
      } catch (err) {
        if (!cancelled) notify(`初始化失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [checkUpdate, hasApi, notify, refreshInstalled])

  const install = useCallback(async () => {
    if (!hasApi || !selected || installing) return
    setInstalling(true)
    setExited(null)
    setProgress({ taskId: 'local', kind: 'install', stage: 'version', done: 0, total: 1, bytes: 0, message: '开始' })
    try {
      const result = await window.qdo.versions.install(selected)
      if (!result.ok) {
        notify(`安装失败：${result.error ?? '未知错误'}`)
      } else {
        notify(`安装完成：${result.versionId}（Java ${result.javaMajor}，${Math.round(result.ms / 1000)}s）`)
      }
      await refreshInstalled()
      setSelected(selected)
    } catch (err) {
      notify(`安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setInstalling(false)
      setProgress(null)
    }
  }, [hasApi, installing, notify, refreshInstalled, selected])

  const launch = useCallback(async () => {
    if (!hasApi || running || installing) return
    if (!instance?.installed) {
      notify('还没有安装游戏版本，请先在上方选择并安装。')
      return
    }
    setExited(null)
    try {
      const result = await window.qdo.launch.start(instance.id)
      if (!result.ok) notify(`启动失败：${result.error ?? '未知错误'}`)
      else {
        setRunning({ pid: result.pid })
        notify(`已启动 ${result.versionId} · 玩家 ${result.playerName} · Java ${result.javaPath ? '已匹配' : ''}`)
      }
    } catch (err) {
      notify(`启动失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [hasApi, installing, instance?.id, instance?.installed, notify, running])

  const stop = useCallback(async () => {
    if (!hasApi) return
    const result = await window.qdo.launch.stop()
    notify(result.forced ? '已强制结束游戏进程' : '已请求结束游戏')
  }, [hasApi, notify])

  const installFabric = useCallback(async () => {
    if (!hasApi || fabricBusy) return
    const gameVersion = instance?.gameVersion ?? selected
    if (!gameVersion || !installed.includes(gameVersion)) {
      notify('先安装对应的原版版本，再装 Fabric')
      return
    }
    setFabricBusy(true)
    try {
      const result = await window.qdo.loaders.fabric(gameVersion)
      if (!result.ok) notify(`Fabric 安装失败：${result.error ?? '未知错误'}`)
      else notify(`Fabric ${result.loaderVersion} 已安装（${result.libraries} 个库）`)
      await refreshInstalled()
    } catch (err) {
      notify(`Fabric 安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setFabricBusy(false)
      setProgress(null)
    }
  }, [fabricBusy, hasApi, instance?.gameVersion, installed, notify, refreshInstalled, selected])

  const onSaveSettings = useCallback(
    async (patch: SettingsPatch) => {
      if (!hasApi) return
      const next = await window.qdo.settings.patch(patch)
      setSettings(next)
      setShowSettings(false)
      await refreshInstalled()
      notify('设置已保存')
    },
    [hasApi, notify, refreshInstalled],
  )

  const canLaunch = Boolean(instance?.installed) && !running && !installing
  const progressPct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  const failed = info.failedPlugins

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">QDOQMC</span>
          <span className="brand-version">v{info.version}</span>
          <span className="brand-tag">P2 · 能装</span>
        </div>
        <div className="titlebar-actions">
          <button type="button" className="ghost" onClick={() => setShowMods(true)} disabled={!instance}>
            模组
          </button>
          <button type="button" className="ghost" onClick={() => void checkUpdate()}>
            检查更新
          </button>
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
            <span className="chip">{instance?.gameVersion ?? instance?.versionId ?? '未选版本'}</span>
            <span className="chip">{instance?.loader ?? 'vanilla'}</span>
            <span className="chip">{instance?.memoryMb ?? 0} MB</span>
            <span className="chip">{instance?.playerName ?? 'Player'}</span>
            <span className="chip subtle">版本隔离</span>
          </div>

          <div className="version-row">
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={installing || Boolean(running) || !versions}
            >
              {(versions?.versions ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {installed.includes(v.id) ? '✓ ' : ''}
                  {v.id}
                  {v.id === versions?.latest.release ? '（最新正式版）' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost"
              onClick={() => void install()}
              disabled={installing || !selected || installed.includes(selected)}
            >
              {installing ? '安装中…' : installed.includes(selected) ? '已安装' : '安装选定版本'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void installFabric()}
              disabled={fabricBusy || installing || !selected || !installed.includes(selected)}
            >
              {fabricBusy ? '装 Fabric…' : instance?.loader === 'fabric' ? 'Fabric 已装' : '装 Fabric'}
            </button>
          </div>

          {progress && (installing || progress.stage !== 'done') ? (
            <div className="progress-card">
              <div className="progress-head">
                <span>{STAGE_LABEL[progress.stage] ?? progress.stage}</span>
                <span>
                  {progress.total > 0 ? `${progress.done}/${progress.total} · ` : ''}
                  {progressPct}%
                </span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.max(2, progressPct)}%` }} />
              </div>
              <div className="progress-detail">
                {(progress.bytes / 1048576).toFixed(1)} MB {progress.message ? `· ${progress.message}` : ''}
              </div>
            </div>
          ) : null}

          <button type="button" className="launch" onClick={() => void launch()} disabled={!canLaunch}>
            <span className="launch-main">{running ? '游戏运行中' : installing ? '安装中…' : '启动游戏'}</span>
            <span className="launch-sub">
              {running
                ? `PID ${running.pid ?? '?'} · 点击右侧按钮结束`
                : canLaunch
                  ? `${instance?.versionId} · 离线登录 · ${instance?.playerName}`
                  : '先安装一个游戏版本'}
            </span>
          </button>

          {running ? (
            <button type="button" className="ghost stop-btn" onClick={() => void stop()}>
              结束游戏
            </button>
          ) : null}

          {exited ? (
            <div className={`exit-card ${exited.crashReport ? 'exit-bad' : ''}`}>
              <div>
                退出码 {exited.exitCode ?? '—'} · {exited.hint ?? '已退出'}
                {exited.uptimeMs ? ` · 运行 ${Math.round(exited.uptimeMs / 1000)}s` : ''}
              </div>
              {exited.crashReport ? <code>{exited.crashReport}</code> : null}
            </div>
          ) : null}

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
      {showMods && instance ? (
        <ModsDialog instance={instance} onClose={() => setShowMods(false)} onNotify={notify} />
      ) : null}
      {showSettings && settings ? (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSave={onSaveSettings} />
      ) : null}
      {showLogs ? <LogDrawer onClose={() => setShowLogs(false)} /> : null}
    </div>
  )
}
