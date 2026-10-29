import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  Diagnosis,
  EventSummary,
  FixAction,
  GameStateEvent,
  InstanceSummary,
  LoaderAvailability,
  SettingsPatch,
  SettingsShape,
  TaskProgress,
  UpdateState,
  VersionList,
} from '../shared/types'
import { ChatPanel } from './components/ChatPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { SystemPanel } from './components/SystemPanel'
import { LogDrawer } from './components/LogDrawer'
import { VersionManager } from './components/VersionManager'
import { MascotImage } from './components/MascotImage'
import { PluginsDialog } from './components/PluginsDialog'
import { PluginButtons } from './components/PluginButtons'
import { DownloadCenter, type DownloadTab } from './components/DownloadCenter'

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

const LOADER_BADGE: Record<string, string> = {
  vanilla: 'V',
  fabric: 'F',
  forge: 'G',
  neoforge: 'N',
}

const STAGE_LABEL: Record<string, string> = {
  version: '解析版本 JSON',
  libraries: '下载库文件',
  assets: '下载游戏资源',
  legacy: '物化旧版资源',
  logging: '日志配置',
  download: '下载更新包',
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
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [downloadTab, setDownloadTab] = useState<DownloadTab>('game')
  const [running, setRunning] = useState<{ pid?: number } | null>(null)
  const [exited, setExited] = useState<GameStateEvent | null>(null)
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null)
  const [fixes, setFixes] = useState<FixAction[]>([])
  const [fixBusy, setFixBusy] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', current: FALLBACK_INFO.version })
  const [events, setEvents] = useState<EventSummary | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showSystem, setShowSystem] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [instances, setInstances] = useState<InstanceSummary[]>([])
  const [newInstanceOpen, setNewInstanceOpen] = useState(false)
  const [newInstanceName, setNewInstanceName] = useState('')
  const [importPath, setImportPath] = useState('')
  const activeIdRef = useRef('default')
  const listening = useRef(false)

  const hasApi = typeof window !== 'undefined' && typeof window.qdo !== 'undefined'

  const notify = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 7000)
  }, [])

  const refreshInstalled = useCallback(async () => {
    if (!hasApi) return
    try {
      const [list, all] = await Promise.all([window.qdo.versions.installed(), window.qdo.instances.list()])
      setInstalled(list)
      setInstances(all)
      const next =
        all.find((item) => item.id === activeIdRef.current) ??
        all.find((item) => item.id === 'default') ??
        all[0] ??
        null
      if (next) {
        activeIdRef.current = next.id
        setInstance(next)
      } else {
        setInstance(null)
      }
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
          const exitedInstance = state.instanceId ?? 'default'
          void window.qdo
            .diagnose.run(exitedInstance)
            .then((result) => setDiagnosis(result))
            .catch(() => undefined)
          void window.qdo
            .diagnose.fixes(exitedInstance)
            .then((list) => setFixes(list))
            .catch(() => setFixes([]))
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
        setInstances(instances)
        activeIdRef.current = appSettings.activeInstance || 'default'
        const active = instances.find((item) => item.id === activeIdRef.current) ?? instances[0] ?? null
        setInstance(active)
        setUpdate((prev) => ({ ...prev, current: appInfo.version }))
        if (appSettings.autoCheckUpdate) void checkUpdate()

        try {
          const [list, installedList] = await Promise.all([window.qdo.versions.list(), window.qdo.versions.installed()])
          if (cancelled) return
          setVersions(list)
          setInstalled(installedList)
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

  const switchInstance = useCallback(
    async (id: string) => {
      if (!hasApi || !id || id === activeIdRef.current) return
      try {
        const summary = await window.qdo.instances.activate(id)
        activeIdRef.current = summary.id
        setInstance(summary)
        await refreshInstalled()
        notify(`已切换到「${summary.name}」`)
      } catch (err) {
        notify(`切换实例失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [hasApi, notify, refreshInstalled],
  )

  const createInstance = useCallback(async () => {
    const name = newInstanceName.trim()
    if (!hasApi || !name) return
    try {
      const created = await window.qdo.instances.create(name)
      await window.qdo.instances.activate(created.id)
      activeIdRef.current = created.id
      setNewInstanceOpen(false)
      setNewInstanceName('')
      await refreshInstalled()
      notify(`已创建实例「${created.name}」，先选个版本安装吧`)
    } catch (err) {
      notify(`创建实例失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [hasApi, newInstanceName, notify, refreshInstalled])

  const openFolder = useCallback(async (id: string) => {
    try {
      const result = await window.qdo.instances.openFolder(id, 'game')
      if (!result.ok) notify(`打开失败：${result.error ?? '未知错误'}`)
      else notify(`已在资源管理器打开：${result.path}`)
    } catch (err) {
      notify(`打开失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [notify])

  const exportInstance = useCallback(async () => {
    if (!hasApi || !instance) return
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dest = await window.qdo.dialog.pickSave(`${instance.id}-${stamp}.zip`)
      if (!dest) return
      const result = await window.qdo.instances.export(instance.id, dest)
      if (!result.ok) notify(`导出失败：${result.error ?? '未知错误'}`)
      else notify(`已导出到 ${result.path}（${result.files} 个文件，${Math.round((result.bytes ?? 0) / 1024)} KB）`)
    } catch (err) {
      notify(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [hasApi, instance, notify])

  const importInstance = useCallback(async () => {
    const source = importPath.trim()
    if (!hasApi || !source) return
    try {
      const result = await window.qdo.instances.import(source, newInstanceName.trim() || undefined)
      if (!result.ok || !result.instance) {
        notify(`导入失败：${result.error ?? '未知错误'}`)
        return
      }
      setNewInstanceOpen(false)
      setNewInstanceName('')
      setImportPath('')
      await refreshInstalled()
      notify(`已导入实例「${result.instance.name}」`)
    } catch (err) {
      notify(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [hasApi, importPath, newInstanceName, notify, refreshInstalled])

  const deleteInstance = useCallback(
    async (id: string) => {
      if (!hasApi) return
      if (!window.confirm('删除这个实例？里面的存档、模组、配置会一起删除，不可恢复。')) return
      try {
        const result = await window.qdo.instances.remove(id)
        if (!result.ok) {
          notify(`删除失败：${result.error ?? '未知错误'}`)
          return
        }
        activeIdRef.current = 'default'
        await refreshInstalled()
        notify('已删除实例')
      } catch (err) {
        notify(`删除失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [hasApi, notify, refreshInstalled],
  )

  // 有任务在跑（安装/更新），主按钮和启动按钮据此禁用
  const taskBusy = Boolean(progress && progress.stage !== 'done' && progress.stage !== 'cancelled' && progress.stage !== 'failed')

  // 任务结束（完成/取消/失败）后自动收起进度卡，避免旧的安装结果一直挂在新操作下面
  // P31：个性化（标题 / 主题色 / 背景图）应用到窗口与 CSS 变量
  useEffect(() => {
    if (!settings) return
    document.title = settings.titleText?.trim() || 'QDOQMC'
    const root = document.documentElement
    root.style.setProperty('--p31-accent', /^#[0-9a-fA-F]{6}$/.test(settings.themeAccent) ? settings.themeAccent : '#4d6bfe')
    const custom = settings.customBackground?.trim()
    if (custom) {
      const file = custom.replace(/\\/g, '/')
      root.style.setProperty('--app-bg', `url("file:///${file}")`)
    } else {
      root.style.setProperty('--app-bg', "url('./assets/bg-user.jpg')")
    }
  }, [settings])

  useEffect(() => {
    if (!progress || (progress.stage !== 'done' && progress.stage !== 'cancelled' && progress.stage !== 'failed')) return
    const timer = window.setTimeout(
      () =>
        setProgress((current) =>
          current && (current.stage === 'done' || current.stage === 'cancelled' || current.stage === 'failed') ? null : current,
        ),
      6000,
    )
    return () => window.clearTimeout(timer)
  }, [progress])

  const cancelInstall = useCallback(async () => {
    if (!hasApi) return
    try {
      const result = await window.qdo.versions.cancel()
      notify(result.cancelled ? '已取消下载（已下载的文件会保留，下次续传）' : '没有正在进行的下载任务')
    } catch (err) {
      notify(`取消失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [hasApi, notify])

  const launch = useCallback(async () => {
    if (!hasApi || running || taskBusy) return
    if (!instance?.installed) {
      notify('还没有安装游戏版本，请先在上方选择并安装。')
      return
    }
    setExited(null)
    setDiagnosis(null)
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
  }, [hasApi, taskBusy, instance?.id, instance?.installed, notify, running])

  const stop = useCallback(async () => {
    if (!hasApi) return
    const result = await window.qdo.launch.stop()
    notify(result.forced ? '已强制结束游戏进程' : '已请求结束游戏')
  }, [hasApi, notify])

  const downloadUpdate = useCallback(async () => {
    if (!hasApi) return
    notify('开始下载更新…')
    try {
      const state = await window.qdo.update.download()
      setUpdate(state)
      if (state.status === 'ready') notify('更新包已下载，点击「重启并更新」完成安装')
      else notify(`更新下载失败：${state.message ?? '未知错误'}`)
    } catch (err) {
      notify(`更新下载失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setProgress(null)
    }
  }, [hasApi, notify])

  const applyUpdate = useCallback(async () => {
    if (!hasApi) return
    try {
      const result = await window.qdo.update.apply()
      if (!result.ok) notify(`更新失败：${result.error ?? '未知错误'}`)
      else notify('正在重启并安装更新…')
    } catch (err) {
      notify(`更新失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [hasApi, notify])

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

  const applyFix = useCallback(
    async (fix: FixAction) => {
      if (!hasApi || fixBusy) return
      const instanceId = instance?.id ?? 'default'
      setFixBusy(fix.id)
      try {
        const result = await window.qdo.diagnose.applyFix(instanceId, fix.id)
        notify(result.message)
        await refreshInstalled()
        const [nextDiagnosis, nextFixes] = await Promise.all([
          window.qdo.diagnose.run(instanceId),
          window.qdo.diagnose.fixes(instanceId),
        ])
        setDiagnosis(nextDiagnosis)
        setFixes(nextFixes)
      } catch (err) {
        notify(`修复失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setFixBusy(null)
      }
    },
    [fixBusy, hasApi, instance?.id, notify, refreshInstalled],
  )

  const canLaunch = Boolean(instance?.installed) && !running && !taskBusy
  const failed = info.failedPlugins

  return (
    <div className="app">
      <MascotImage size={230} className="app-companion" fallback={false} />
      <header className="titlebar">
        <div className="brand">
          <MascotImage size={34} className="brand-fish" />
          <span className="brand-mark">{settings?.titleText?.trim() || 'QDOQMC'}</span>
          <span className="brand-sub">大肥鱼开服</span>
          <span className="brand-version">v{info.version}</span>
          <span className="brand-tag">P34 · 自扩展</span>
        </div>
        <div className="titlebar-actions">
          <PluginButtons onNotify={notify} />
          <button
            type="button"
            className="ghost nav-strong"
            onClick={() => {
              setDownloadTab('game')
              setDownloadOpen(true)
            }}
          >
            下载
          </button>
          <button type="button" className="ghost" onClick={() => setShowPlugins(true)}>
            插件
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
          <button type="button" className="ghost" onClick={() => setShowSystem(true)} title="对接这台电脑：麦克风 / 喇叭 / 系统信息">
            系统
          </button>
        </div>
      </header>

      <main className={`main ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
        <aside className="version-sidebar">
          <div className="sidebar-head">
            {!leftCollapsed ? <span className="sidebar-title">版本</span> : null}
            <button type="button" className="ghost tiny sidebar-toggle" onClick={() => setLeftCollapsed((value) => !value)} title={leftCollapsed ? '展开版本栏' : '收起版本栏'}>
              {leftCollapsed ? '▶' : '◀'}
            </button>
            {!leftCollapsed ? (
              <button type="button" className="ghost tiny" onClick={() => setNewInstanceOpen(true)} disabled={Boolean(running)}>
                + 新建
              </button>
            ) : null}
          </div>

          {!leftCollapsed ? (
            <>
              <div className="sidebar-list">
                {instances.map((item) => {
                  const active = item.id === (instance?.id ?? '')
                  return (
                    <div
                      key={item.id}
                      className={`ver-card ${active ? 'is-active' : ''}`}
                      onClick={() => {
                        if (!running) void switchInstance(item.id)
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !running) void switchInstance(item.id)
                      }}
                    >
                      <span className={`ver-icon ver-icon-${item.loader ?? 'vanilla'}`}>{LOADER_BADGE[item.loader ?? 'vanilla'] ?? 'V'}</span>
                      <div className="ver-card-main">
                        <div className="ver-card-name">{item.name}</div>
                        <div className="ver-card-meta">
                          {item.gameVersion ?? item.versionId ?? '未装版本'} · {item.loader ?? 'vanilla'}
                        </div>
                      </div>
                      <div className="ver-card-tools" onClick={(event) => event.stopPropagation()}>
                        <button type="button" onClick={() => void openFolder(item.id)} title="打开游戏目录">
                          📂
                        </button>
                        <button type="button" onClick={() => setShowVersions(true)} title="版本管理">
                          ⋯
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="sidebar-foot">
                <button type="button" className="ghost tiny" onClick={() => setShowVersions(true)}>
                  版本管理
                </button>
              </div>

              <div className="side-launch">
                <div className="side-hero">
                  <span className={`ver-icon ver-icon-${instance?.loader ?? 'vanilla'}`}>{LOADER_BADGE[instance?.loader ?? 'vanilla'] ?? 'V'}</span>
                  <div className="side-hero-meta">
                    <div className="side-hero-name">{instance?.name ?? '没有实例'}</div>
                    <div className="side-hero-sub">
                      {instance?.gameVersion ?? instance?.versionId ?? '未装版本'} · {instance?.loader ?? 'vanilla'} · {instance?.memoryMb ?? 0} MB
                    </div>
                  </div>
                </div>
                <button type="button" className="launch" onClick={() => void launch()} disabled={!canLaunch}>
                  <span className="launch-main">{running ? '游戏运行中' : taskBusy ? '处理中…' : '启动游戏'}</span>
                  <span className="launch-sub">
                    {running
                      ? `PID ${running.pid ?? '?'} · 点「结束游戏」`
                      : canLaunch
                        ? `${instance?.accountName ?? instance?.playerName ?? 'Player'}`
                        : instance?.installed
                          ? '先结束正在进行的任务'
                          : '先在「下载」里装游戏'}
                  </span>
                  <MascotImage size={24} className="launch-fish" />
                </button>
                {running ? (
                  <button type="button" className="ghost stop-btn" onClick={() => void stop()}>
                    结束游戏
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </aside>

        <section className="stage">
          {update.status === 'available' || update.status === 'downloading' || update.status === 'ready' ? (
            <div className={`update-banner update-${update.status}`}>
              <div className="update-text">
                发现新版本 v{update.latest ?? '?'}
                {update.mustUpdate ? <span className="update-must">必须更新</span> : null}
                {update.notes ? <span className="update-note">{update.notes}</span> : null}
              </div>
              {update.status === 'available' ? (
                <button type="button" className="primary" onClick={() => void downloadUpdate()}>
                  下载更新
                </button>
              ) : null}
              {update.status === 'downloading' ? <span className="update-progress">下载中…</span> : null}
              {update.status === 'ready' ? (
                <button type="button" className="primary" onClick={() => void applyUpdate()}>
                  重启并更新
                </button>
              ) : null}
            </div>
          ) : null}

          {exited ? (
            <div className={`exit-card ${exited.crashReport ? 'exit-bad' : ''}`}>
              <div>
                退出码 {exited.exitCode ?? '—'} · {exited.hint ?? '已退出'}
                {exited.uptimeMs ? ` · 运行 ${Math.round(exited.uptimeMs / 1000)}s` : ''}
              </div>
              {exited.crashReport ? <code>{exited.crashReport}</code> : null}
              {diagnosis?.found ? (
                <div className="diag-block">
                  <div className="diag-summary">诊断：{diagnosis.summary}</div>
                  <ul className="diag-suggestions">
                    {diagnosis.suggestions.slice(0, 3).map((suggestion) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                  {fixes.length > 0 ? (
                    <div className="fix-actions">
                      {fixes.slice(0, 4).map((fix) => (
                        <button
                          key={fix.id}
                          type="button"
                          className="ghost tiny"
                          title={fix.description}
                          disabled={fixBusy === fix.id}
                          onClick={() => void applyFix(fix)}
                        >
                          {fixBusy === fix.id ? '修复中…' : `一键修复：${fix.label}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {failed.length > 0 ? (
            <div className="warn-box">
              有 {failed.length} 个插件加载失败：{failed.map((f) => f.name).join('、')}（详情见日志）
            </div>
          ) : null}
        </section>

        <aside className={`chat-side ${rightCollapsed ? 'is-collapsed' : ''}`}>
          {rightCollapsed ? (
            <button type="button" className="chat-side-tab" onClick={() => setRightCollapsed(false)} title="展开 AI 助手">
              AI
            </button>
          ) : (
            <>
              <button type="button" className="chat-side-collapse" onClick={() => setRightCollapsed(true)} title="收起 AI 助手">
                ▶
              </button>
              <ChatPanel />
            </>
          )}
        </aside>
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
      {newInstanceOpen ? (
        <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && setNewInstanceOpen(false)}>
          <div className="dialog dialog-narrow" role="dialog" aria-modal="true">
            <div className="dialog-head">
              <h2>新建实例</h2>
              <button type="button" className="ghost" onClick={() => setNewInstanceOpen(false)}>
                关闭
              </button>
            </div>
            <div className="dialog-body">
              <label className="field">
                <span className="field-label">实例名称</span>
                <input
                  value={newInstanceName}
                  onChange={(event) => setNewInstanceName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void createInstance()
                  }}
                  placeholder="例如：1.21 生存 / 整合包测试"
                  maxLength={32}
                  spellCheck={false}
                  autoFocus
                />
                <span className="field-hint">每个实例有独立的 mods / 存档 / 配置，但共享游戏资源与 Java。</span>
              </label>
              <label className="field">
                <span className="field-label">或从导出包导入</span>
                <div className="pack-row">
                  <input
                    value={importPath}
                    onChange={(event) => setImportPath(event.target.value)}
                    placeholder="粘贴 .zip 路径（上面名称留空则用包内实例名）"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="ghost"
                    onClick={async () => {
                      const picked = await window.qdo.dialog.pickFile('zip')
                      if (picked) setImportPath(picked)
                    }}
                  >
                    选择…
                  </button>
                </div>
              </label>
            </div>
            <div className="dialog-foot">
              <button type="button" className="ghost" onClick={() => setNewInstanceOpen(false)}>
                取消
              </button>
              <button type="button" className="ghost" onClick={() => void importInstance()} disabled={!importPath.trim()}>
                导入
              </button>
              <button type="button" className="primary" onClick={() => void createInstance()} disabled={!newInstanceName.trim()}>
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showVersions ? (
        <VersionManager
          instances={instances}
          activeId={instance?.id ?? 'default'}
          onClose={() => setShowVersions(false)}
          onActivate={(id) => {
            void switchInstance(id)
            setShowVersions(false)
          }}
          onRefresh={refreshInstalled}
          onNotify={notify}
          onCreate={() => {
            setShowVersions(false)
            setNewInstanceOpen(true)
          }}
          onOpenMods={(id) => {
            void (async () => {
              await switchInstance(id)
              setShowVersions(false)
              setDownloadTab('mod')
              setDownloadOpen(true)
            })()
          }}
        />
      ) : null}
      {downloadOpen && instance ? (
        <DownloadCenter
          instance={instance}
          tab={downloadTab}
          onTab={setDownloadTab}
          versions={versions}
          installedVersions={installed}
          settings={settings}
          progress={progress}
          taskBusy={taskBusy}
          onCancelTask={() => void cancelInstall()}
          onClose={() => setDownloadOpen(false)}
          onNotify={notify}
          onRefresh={() => {
            void refreshInstalled()
            void window.qdo.versions.installed().then(setInstalled).catch(() => undefined)
          }}
        />
      ) : null}
      {showPlugins ? <PluginsDialog onClose={() => setShowPlugins(false)} onNotify={notify} /> : null}
      {showSystem ? <SystemPanel onClose={() => setShowSystem(false)} onNotify={notify} /> : null}
      {showSettings && settings ? (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSave={onSaveSettings} onNotify={notify} />
      ) : null}
      {showLogs ? <LogDrawer onClose={() => setShowLogs(false)} instanceId={instance?.id} /> : null}
    </div>
  )
}
