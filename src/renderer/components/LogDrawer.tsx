import { useCallback, useEffect, useState } from 'react'
import type { LogRecord } from '../../shared/types'

interface Props {
  onClose: () => void
  /** 游戏日志看哪个实例（默认当前实例） */
  instanceId?: string
}

const LEVEL_LABEL: Record<string, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
}

interface GameLogState {
  file?: string
  lines: string[]
  error?: string
}

export function LogDrawer({ onClose, instanceId = 'default' }: Props) {
  const [tab, setTab] = useState<'launcher' | 'game'>('launcher')
  const [records, setRecords] = useState<LogRecord[]>([])
  const [gameLog, setGameLog] = useState<GameLogState>({ lines: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadLauncher = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (typeof window.qdo === 'undefined') {
        setError('IPC 不可用')
        return
      }
      setRecords(await window.qdo.logs.tail(300))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadGame = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (typeof window.qdo === 'undefined') {
        setError('IPC 不可用')
        return
      }
      setGameLog(await window.qdo.diagnose.gameLog(instanceId, 400))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [instanceId])

  useEffect(() => {
    if (tab === 'launcher') void loadLauncher()
    else void loadGame()
  }, [tab, loadLauncher, loadGame])

  // 游戏日志每 2 秒自动刷新（游戏运行时能实时看）
  useEffect(() => {
    if (tab !== 'game') return
    const timer = setInterval(() => {
      void loadGame()
    }, 2000)
    return () => clearInterval(timer)
  }, [tab, loadGame])

  return (
    <div className="overlay overlay-right" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="drawer">
        <div className="dialog-head">
          <h2>{tab === 'launcher' ? '结构化日志' : '游戏日志'}</h2>
          <div className="drawer-actions">
            <button type="button" className="ghost" onClick={() => void (tab === 'launcher' ? loadLauncher() : loadGame())} disabled={loading}>
              {loading ? '读取中…' : '刷新'}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="kind-tabs">
          <button type="button" className={`kind-tab ${tab === 'launcher' ? 'is-active' : ''}`} onClick={() => setTab('launcher')}>
            启动器日志
          </button>
          <button type="button" className={`kind-tab ${tab === 'game' ? 'is-active' : ''}`} onClick={() => setTab('game')}>
            游戏日志
          </button>
        </div>

        {tab === 'game' ? (
          <div className="log-gamebar">
            <span>{gameLog.file ?? '未找到日志文件'}</span>
            <span className="log-gamebar-hint">每 2 秒自动刷新 · 实例 {instanceId}</span>
          </div>
        ) : null}

        <div className="log-list">
          {error ? <div className="log-empty">读取失败：{error}</div> : null}
          {!error && tab === 'launcher' && records.length === 0 && !loading ? <div className="log-empty">暂无日志</div> : null}
          {!error && tab === 'game' && gameLog.lines.length === 0 && !loading ? (
            <div className="log-empty">{gameLog.error ?? '暂无游戏日志（先启动一次游戏）'}</div>
          ) : null}

          {tab === 'launcher'
            ? records
                .slice()
                .reverse()
                .map((record, index) => (
                  <div key={`${record.ts}-${index}`} className={`log-row log-${record.level}`}>
                    <span className="log-time">{new Date(record.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    <span className="log-level">{LEVEL_LABEL[record.level] ?? record.level}</span>
                    <span className="log-scope">{record.scope}</span>
                    <span className="log-msg">{record.message}</span>
                  </div>
                ))
            : gameLog.lines.map((line, index) => {
                const level = /\b(ERROR|FATAL|Exception|Caused by)\b/.test(line)
                  ? 'error'
                  : /\bWARN\b/.test(line)
                    ? 'warn'
                    : 'info'
                return (
                  <div key={`${index}-${line.slice(0, 24)}`} className={`log-row log-${level} log-game`}>
                    <span className="log-msg">{line || ' '}</span>
                  </div>
                )
              })}
        </div>
      </div>
    </div>
  )
}
