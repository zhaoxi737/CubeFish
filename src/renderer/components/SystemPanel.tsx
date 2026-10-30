import { useCallback, useEffect, useRef, useState } from 'react'
import type { RecordingItem, SystemInfo } from '../../shared/types'

const SPEAK_KEY = 'qdo:speakReplies'

/** P37：系统对接面板——看系统信息、用麦克风录音、让喇叭说话。 */
export function SystemPanel({ onClose, onNotify }: { onClose: () => void; onNotify: (text: string) => void }) {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [recordings, setRecordings] = useState<RecordingItem[]>([])
  const [recording, setRecording] = useState(false)
  const [speakText, setSpeakText] = useState('你好，我是方块鱼的语音助手。')
  const [busy, setBusy] = useState(false)
  const [speakReplies, setSpeakReplies] = useState(() => {
    try {
      return window.localStorage.getItem(SPEAK_KEY) === '1'
    } catch {
      return false
    }
  })
  const [source, setSource] = useState<{ ok: boolean; repoRoot?: string; dirty: string[]; error?: string } | null>(null)
  const [rollingBack, setRollingBack] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const refresh = useCallback(async () => {
    if (typeof window.qdo === 'undefined') return
    try {
      setInfo(await window.qdo.system.info())
    } catch {
      /* 忽略 */
    }
    try {
      setRecordings(await window.qdo.system.recordings())
    } catch {
      /* 忽略 */
    }
    try {
      setSource(await window.qdo.system.sourceStatus())
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const startRecord = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
          const buffer = await blob.arrayBuffer()
          const result = await window.qdo.system.saveRecording(buffer, 'webm')
          onNotify(result.ok ? `已保存录音：${result.path}` : `保存录音失败：${result.error ?? '未知错误'}`)
          void refresh()
        } finally {
          stream.getTracks().forEach((track) => track.stop())
        }
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
      onNotify('开始录音…再点一次停止')
    } catch (err) {
      onNotify(`无法打开麦克风：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const stopRecord = (): void => {
    recorderRef.current?.stop()
    recorderRef.current = null
    setRecording(false)
  }

  const speak = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.qdo.system.speak(speakText)
      onNotify(result.ok ? `已朗读（${result.how === 'renderer' ? '喇叭' : '系统语音'}）` : `朗读失败：${result.error ?? '未知错误'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>系统对接</h2>
          <div className="drawer-actions">
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div className="system-body">
          <section>
            <h4>这台电脑</h4>
            {info ? (
              <div className="system-grid">
                <span>系统</span>
                <span>
                  {info.platform} {info.release}（{info.arch}）
                </span>
                <span>主机名</span>
                <span>{info.hostname}</span>
                <span>CPU</span>
                <span>
                  {info.cpuModel} ×{info.cpus}
                </span>
                <span>内存</span>
                <span>
                  {info.freeMemMb} / {info.totalMemMb} MB 可用
                </span>
                <span>已开机</span>
                <span>{Math.round(info.uptimeSec / 3600)} 小时</span>
              </div>
            ) : (
              <div className="muted">读取中…</div>
            )}
          </section>

          <section>
            <h4>麦克风</h4>
            <div className="system-row">
              <button type="button" className={recording ? 'composer-stop' : 'primary'} onClick={() => (recording ? stopRecord() : void startRecord())}>
                {recording ? '停止录音' : '开始录音'}
              </button>
              <span className="muted">录完自动保存到启动器 recordings 目录</span>
            </div>
            {recordings.length > 0 ? (
              <div className="rec-rows">
                {recordings.slice(0, 6).map((item) => (
                  <div key={item.name} className="rec-row">
                    <span>{item.name}</span>
                    <span className="muted">{Math.round(item.bytes / 1024)} KB</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">还没有录音</div>
            )}
          </section>

          <section>
            <h4>喇叭</h4>
            <div className="system-row">
              <input value={speakText} onChange={(event) => setSpeakText(event.target.value)} spellCheck={false} />
              <button type="button" className="primary" disabled={busy} onClick={() => void speak()}>
                {busy ? '朗读中…' : '朗读'}
              </button>
            </div>
            <label className="field field-inline">
              <input
                type="checkbox"
                checked={speakReplies}
                onChange={(event) => {
                  setSpeakReplies(event.target.checked)
                  try {
                    window.localStorage.setItem(SPEAK_KEY, event.target.checked ? '1' : '0')
                  } catch {
                    /* 忽略 */
                  }
                }}
              />
              <span>AI 每次回复都朗读出来</span>
            </label>
          </section>
          <section>
            <h4>源码回滚</h4>
            <p className="muted">
              AI 改坏启动器源码 / 构建失败时用：把 <code>src/</code> 回滚到上次 git 提交 → 重新构建 → 自动重启。
            </p>
            {source ? (
              source.ok ? (
                <div className="muted">
                  {source.dirty.length > 0
                    ? `有 ${source.dirty.length} 个文件未提交：${source.dirty
                        .slice(0, 3)
                        .map((line) => line.split(/\s+/).pop())
                        .join('、')}${source.dirty.length > 3 ? ' …' : ''}`
                    : 'src/ 当前没有未提交改动'}
                </div>
              ) : (
                <div className="muted">{source.error}</div>
              )
            ) : (
              <div className="muted">读取中…</div>
            )}
            <div className="system-row">
              <button
                type="button"
                className="composer-stop"
                disabled={rollingBack}
                onClick={async () => {
                  if (!window.confirm('把 src/ 回滚到最后一次提交、重新构建并重启？\n当前未提交的源码改动会丢失（其它目录不受影响）。')) return
                  setRollingBack(true)
                  try {
                    const result = await window.qdo.system.rollback()
                    onNotify(result.message)
                  } catch (err) {
                    onNotify(`回滚失败：${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setRollingBack(false)
                  }
                }}
              >
                {rollingBack ? '回滚中…' : '回滚源码并重启'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
