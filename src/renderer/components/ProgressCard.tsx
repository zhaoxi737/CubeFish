import type { TaskProgress } from '../../shared/types'

const STAGE_ICON: Record<string, string> = {
  done: '✓',
  running: '▶',
  pending: '○',
}

const STAGE_HINT: Record<string, string> = {
  version: '拿到这个版本需要下载哪些文件',
  libraries: '游戏运行需要的库（Java 依赖）',
  assets: '贴图、音效、语言文件等游戏资源',
  logging: '崩溃日志的格式化配置',
  content: '模组 / 资源包文件',
}

function mb(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 MB'
  const value = bytes / 1048576
  if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`
  if (value >= 100) return `${value.toFixed(0)} MB`
  return `${value.toFixed(1)} MB`
}

function speedText(bytesPerSec: number | undefined): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '—'
  const value = bytesPerSec / 1048576
  if (value >= 1) return `${value.toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`
}

function etaText(etaMs: number | undefined): string {
  if (etaMs === undefined || !Number.isFinite(etaMs) || etaMs <= 0) return '计算中…'
  const total = Math.round(etaMs / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function sourceText(source: string | undefined): string {
  if (source === 'bmclapi') return '国内镜像 BMCLAPI'
  if (source === 'official') return 'Mojang 官方源'
  return '自动选择最快源'
}

interface Props {
  progress: TaskProgress
  /** 任务是否还在跑（false 时展示结束状态） */
  busy: boolean
  title?: string
  onCancel?: () => void
}

/**
 * PCL 式下载进度卡：分阶段清单 + 总百分比 + 速度 + 已下/总量 + 剩余时间 + 当前文件。
 * 数据全部来自后端 TaskProgress（见 docs/P28-SPEC.md）。
 */
export function ProgressCard({ progress, busy, title, onCancel }: Props) {
  const cancelled = progress.stage === 'cancelled'
  const done = progress.stage === 'done' || (!busy && !cancelled)
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? (progress.total > 0 ? (progress.done / progress.total) * 100 : 0))))

  const stages = progress.stages ?? []
  const bytesTotal = progress.bytesTotal ?? 0
  const bytes = progress.bytes ?? 0
  const currentStage = progress.stage

  return (
    <div className={`progress-card ${done ? 'is-done' : ''} ${cancelled ? 'is-cancelled' : ''}`}>
      <div className="progress-head">
        <span className="progress-title">
          {cancelled ? '已取消' : done ? '安装完成' : (title ?? '正在安装')}
        </span>
        <span className="progress-pct">{cancelled ? '—' : `${percent}%`}</span>
      </div>

      <div className="progress-bar">
        <div
          className={`progress-fill ${done ? 'is-done' : ''}`}
          style={{ width: `${Math.max(2, cancelled ? 100 : percent)}%` }}
        />
      </div>

      <div className="progress-facts">
        {done ? (
          <>
            <span>已下载 {mb(bytesTotal || bytes)}</span>
            {progress.filesTotal ? (
              <>
                <span className="sep">·</span>
                <span>文件 {progress.filesTotal} 个</span>
              </>
            ) : null}
            <span className="sep">·</span>
            <span className="progress-source">{sourceText(progress.source)}</span>
          </>
        ) : (
          <>
            <span>已下载 {mb(bytes)}{bytesTotal > 0 ? ` / ${mb(bytesTotal)}` : ''}</span>
            <span className="sep">·</span>
            <span>{speedText(progress.speed)}</span>
            <span className="sep">·</span>
            <span>剩余 {cancelled ? '—' : etaText(progress.etaMs)}</span>
            {progress.filesTotal ? (
              <>
                <span className="sep">·</span>
                <span>
                  文件 {progress.filesDone ?? progress.done}/{progress.filesTotal}
                </span>
              </>
            ) : null}
            <span className="sep">·</span>
            <span className="progress-source">{sourceText(progress.source)}</span>
          </>
        )}
      </div>

      {progress.currentFile && !done && !cancelled ? (
        <div className="progress-current" title={progress.currentFile}>
          <span className="progress-current-label">正在下载</span>
          <code>{progress.currentFile}</code>
        </div>
      ) : null}

      {stages.length > 0 ? (
        <ul className="progress-stages">
          {stages.map((stage) => {
            const state = stage.state ?? (stage.stage === currentStage ? 'running' : 'pending')
            return (
              <li key={stage.stage} className={`progress-stage stage-${state}`}>
                <span className="stage-icon">{STAGE_ICON[state] ?? '○'}</span>
                <span className="stage-name">{stage.label}</span>
                <span className="stage-detail">
                  {stage.total > 0 ? `${stage.done}/${stage.total}` : ''}
                  {stage.bytesTotal > 0 ? ` · ${mb(stage.bytes)}/${mb(stage.bytesTotal)}` : ''}
                </span>
                <span className="stage-hint">{STAGE_HINT[stage.stage] ?? ''}</span>
              </li>
            )
          })}
        </ul>
      ) : null}

      {busy && onCancel ? (
        <div className="progress-actions">
          <button type="button" className="ghost tiny" onClick={onCancel}>
            取消下载
          </button>
          <span className="field-hint">取消后已下载的文件会保留，下次安装自动续传</span>
        </div>
      ) : null}
      {progress.message && !stages.length ? <div className="progress-detail">{progress.message}</div> : null}
    </div>
  )
}
