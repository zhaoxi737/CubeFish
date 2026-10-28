import { useCallback, useEffect, useState } from 'react'
import type { MarketListResult, PluginInfo } from '../../shared/types'

interface Props {
  onClose: () => void
  onNotify: (text: string) => void
}

const PERMISSION_LABEL: Record<string, string> = {
  read: '读取文件',
  net: '联网',
  exec: '执行代码',
}

export function PluginsDialog({ onClose, onNotify }: Props) {
  const [tab, setTab] = useState<'local' | 'market'>('local')
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [market, setMarket] = useState<MarketListResult | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketBusy, setMarketBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPlugins(await window.qdo.plugins.list())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMarket = useCallback(async (force = false) => {
    setMarketLoading(true)
    try {
      setMarket(await window.qdo.market.list(force))
    } catch (err) {
      setMarket({ ok: false, plugins: [], source: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      setMarketLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab === 'market' && !market && !marketLoading) void loadMarket()
  }, [tab, market, marketLoading, loadMarket])

  const toggle = useCallback(
    async (plugin: PluginInfo, granted: boolean) => {
      setBusy(plugin.id)
      try {
        const result = await window.qdo.plugins.setGranted(plugin.id, granted)
        if (result.error) onNotify(`${granted ? '启用' : '禁用'}失败：${result.error}`)
        else onNotify(`${granted ? '已启用' : '已禁用'} ${plugin.name}`)
        await load()
      } catch (err) {
        onNotify(`操作失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [load, onNotify],
  )

  const reload = useCallback(
    async (plugin: PluginInfo) => {
      setBusy(plugin.id)
      try {
        const result = await window.qdo.plugins.reload(plugin.id)
        if (result.error) onNotify(`重载失败：${result.error}`)
        else onNotify(`已重载 ${plugin.name}`)
        await load()
      } catch (err) {
        onNotify(`重载失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [load, onNotify],
  )

  const installFromMarket = useCallback(
    async (id: string, name: string) => {
      setMarketBusy(id)
      try {
        const result = await window.qdo.market.install(id)
        if (!result.ok) onNotify(`安装失败：${result.error ?? '未知错误'}`)
        else {
          onNotify(`已安装 ${name}，去「本地」页启用它`)
          await load()
          setTab('local')
        }
      } catch (err) {
        onNotify(`安装失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setMarketBusy(null)
      }
    },
    [load, onNotify],
  )

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>插件</h2>
          <div className="drawer-actions">
            <button type="button" className="ghost" onClick={() => void (tab === 'local' ? load() : loadMarket(true))} disabled={loading || marketLoading}>
              {loading || marketLoading ? '刷新中…' : '刷新'}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="kind-tabs">
          <button type="button" className={`kind-tab ${tab === 'local' ? 'is-active' : ''}`} onClick={() => setTab('local')}>
            本地插件
          </button>
          <button type="button" className={`kind-tab ${tab === 'market' ? 'is-active' : ''}`} onClick={() => setTab('market')}>
            插件市场
          </button>
        </div>

        {tab === 'local' ? (
          <>
            <div className="plugins-hint">
              把插件文件夹放进 <code>%APPDATA%\QDOQMC\plugins\</code> 后点刷新。插件默认不启用；启用前请确认来源可信
              （插件跑在独立 utilityProcess 沙箱里，崩溃不会拖死启动器，但进程内仍具备 Node 能力）。
            </div>
            {error ? <div className="warn-box">{error}</div> : null}
            {plugins.length === 0 && !loading ? <div className="plugins-empty">还没有插件。</div> : null}
            <div className="plugins-list">
              {plugins.map((plugin) => (
                <div className="plugin-row" key={plugin.id}>
                  <div className="plugin-main">
                    <div className="plugin-title">
                      {plugin.name}
                      <span className="mod-slug">
                        {plugin.id} · v{plugin.version}
                        {plugin.author ? ` · ${plugin.author}` : ''}
                      </span>
                      <span className={`plugin-state ${plugin.loaded ? 'is-on' : plugin.granted ? 'is-warn' : ''}`}>
                        {plugin.loaded ? '已启用' : plugin.granted ? '已授权未加载' : '未启用'}
                      </span>
                      {plugin.sandbox ? (
                        <span className="plugin-sandbox">{plugin.workerPid ? `沙箱 · PID ${plugin.workerPid}` : '沙箱'}</span>
                      ) : null}
                    </div>
                    {plugin.description ? <div className="plugin-desc">{plugin.description}</div> : null}
                    <div className="plugin-meta">
                      {plugin.permissions.length > 0
                        ? `权限：${plugin.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(' / ')}`
                        : '权限：无（仍可执行代码）'}
                      {plugin.tools.length > 0 ? ` · 工具：${plugin.tools.join('、')}` : ''}
                      {plugin.commands.length > 0 ? ` · 命令：/${plugin.commands.join(' /')}` : ''}
                    </div>
                    {plugin.error ? <div className="plugin-error">错误：{plugin.error}</div> : null}
                  </div>
                  <div className="plugin-actions">
                    {plugin.granted ? (
                      <button
                        type="button"
                        className="ghost tiny danger"
                        onClick={() => void toggle(plugin, false)}
                        disabled={busy === plugin.id}
                      >
                        禁用
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void toggle(plugin, true)}
                        disabled={busy === plugin.id}
                      >
                        启用
                      </button>
                    )}
                    <button type="button" className="ghost tiny" onClick={() => void reload(plugin)} disabled={busy === plugin.id}>
                      重载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="plugins-hint">
              {market?.source === 'verified'
                ? '市场 feed 已通过 Ed25519 签名校验。'
                : market?.source === 'unsigned'
                  ? '未配置公钥：开发模式，未校验签名。生产环境请配置市场公钥。'
                  : '从市场安装的插件会先校验 sha256，再解压到本地插件目录。'}
              配置入口：设置 → 插件市场地址 / 市场公钥。
            </div>
            {market && !market.ok ? <div className="warn-box">{market.error ?? '市场不可用'}</div> : null}
            {market?.plugins.length === 0 && market.ok ? <div className="plugins-empty">市场里还没有插件。</div> : null}
            <div className="plugins-list">
              {(market?.plugins ?? []).map((item) => (
                <div className="plugin-row" key={item.id}>
                  <div className="plugin-main">
                    <div className="plugin-title">
                      {item.name}
                      <span className="mod-slug">
                        {item.id} · v{item.version}
                        {item.author ? ` · ${item.author}` : ''}
                      </span>
                    </div>
                    {item.description ? <div className="plugin-desc">{item.description}</div> : null}
                    <div className="plugin-meta">
                      权限：{item.permissions.length > 0 ? item.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(' / ') : '无'}
                      {' · '}大小 {(item.download.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <div className="plugin-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void installFromMarket(item.id, item.name)}
                      disabled={marketBusy === item.id}
                    >
                      {marketBusy === item.id ? '安装中…' : '安装'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="dialog-foot">
          <span className="field-hint">插件可以注册 AI 工具和聊天命令；禁用会撤回全部注册项。</span>
        </div>
      </div>
    </div>
  )
}
