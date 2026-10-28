import { useCallback, useEffect, useState } from 'react'
import type { LogRecord } from '../../shared/types'

interface Props {
  onClose: () => void
}

const LEVEL_LABEL: Record<string, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
}

export function LogDrawer({ onClose }: Props) {
  const [records, setRecords] = useState<LogRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
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

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="overlay overlay-right" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="drawer">
        <div className="dialog-head">
          <h2>结构化日志</h2>
          <div className="drawer-actions">
            <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
              刷新
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div className="log-list">
          {error ? <div className="log-empty">读取失败：{error}</div> : null}
          {!error && records.length === 0 && !loading ? <div className="log-empty">暂无日志</div> : null}
          {records
            .slice()
            .reverse()
            .map((record, index) => (
              <div key={`${record.ts}-${index}`} className={`log-row log-${record.level}`}>
                <span className="log-time">{new Date(record.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className="log-level">{LEVEL_LABEL[record.level] ?? record.level}</span>
                <span className="log-scope">{record.scope}</span>
                <span className="log-msg">{record.message}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
