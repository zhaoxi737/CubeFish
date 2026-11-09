import type { ReactNode } from 'react'
import type { InstanceSummary } from '../../shared/types'
import { IconFolder, IconLog, IconPlay } from '../ui/icons'
import { MascotImage } from '../components/MascotImage'

interface Props {
  instance: InstanceSummary | null
  running: { pid?: number } | null
  taskBusy: boolean
  canLaunch: boolean
  onLaunch: () => void
  onStop: () => void
  onOpenFolder: () => void
  onLogs: () => void
  onSwitchInstance: () => void
  children?: ReactNode
}

/**
 * 极简主页：只有「当前实例 + 三个按钮」，其余留白。
 * 启动按钮继续挂 .launch/.launch-main/.launch-sub（smoke 会按这三个类名断言）。
 */
export function HomePage(props: Props) {
  const { instance, running, taskBusy, canLaunch } = props
  const name = instance?.name ?? '还没有实例'
  const meta = instance
    ? [instance.gameVersion ?? instance.versionId ?? '未装版本', instance.loader ?? 'vanilla', `${instance.memoryMb ?? 0} MB`]
    : ['先去「下载」装一个版本']

  return (
    <section className="home">
      <div className="home-main">
        <button type="button" className="home-switch" onClick={props.onSwitchInstance} title="切换实例（打开版本管理）">
          当前实例
        </button>
        <h1 className="home-name">{name}</h1>
        <div className="home-meta">
          {meta.map((item, index) => (
            <span key={item} className="home-meta-item">
              {index > 0 ? <span className="home-meta-dot" /> : null}
              {item}
            </span>
          ))}
        </div>

        <div className="home-actions">
          <button type="button" className="home-btn cf-btn cf-btn--lg" onClick={props.onOpenFolder}>
            <IconFolder size={16} />
            打开游戏目录
          </button>
          <button type="button" className="home-btn cf-btn cf-btn--lg" onClick={props.onLogs}>
            <IconLog size={16} />
            查看日志
          </button>
          <button
            type="button"
            className="launch cf-btn cf-btn--lg cf-btn--primary home-launch"
            onClick={() => (running ? props.onStop() : props.onLaunch())}
            disabled={running ? false : !canLaunch}
          >
            <IconPlay size={17} />
            <span className="launch-main">{running ? '结束游戏' : taskBusy ? '处理中…' : '启动游戏'}</span>
            <span className="launch-sub">
              {running
                ? `PID ${running.pid ?? '?'}`
                : canLaunch
                  ? `${instance?.accountName ?? instance?.playerName ?? 'Player'}`
                  : instance?.installed
                    ? '先结束正在进行的任务'
                    : '先在「下载」里装游戏'}
            </span>
            <MascotImage size={22} className="launch-fish" />
          </button>
        </div>

        <div className="home-hint">回车直接启动</div>
      </div>

      {props.children ? <div className="home-status">{props.children}</div> : null}
    </section>
  )
}
