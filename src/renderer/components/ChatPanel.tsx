import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatProgressEvent, ChatSessionInfo, ToolCallTrace } from '../../shared/types'

type Message = ChatMessage & { trace?: ToolCallTrace[]; streaming?: boolean }

const WELCOME: Message = {
  role: 'assistant',
  ts: Date.now(),
  text:
    '我是方块鱼（CubeFish）的助手。配好模型 API Key 后可以直接说人话：\n·「装个 sodium」\n·「帮我看下为什么崩了」\n·「最近有什么优化模组」\n·「启动游戏」\n没配 Key 时也能用 /help 看本地命令。',
}

function describeProgress(event: ChatProgressEvent): string | null {
  if (event.type === 'round') return event.round > 1 ? `第 ${event.round} 轮思考…` : '开始思考…'
  if (event.phase === 'start') return `正在调用 ${event.tool}${event.detail ? ` · ${event.detail.slice(0, 80)}` : ''}`
  return `${event.ok ? '✓' : '✕'} ${event.tool}${event.summary ? ` · ${event.summary.slice(0, 90)}` : ''}`
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([WELCOME])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [live, setLive] = useState<string[]>([])
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([])
  const [activeId, setActiveId] = useState('')
  const [replaceMode, setReplaceMode] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef('')

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, live])

  const loadSessions = useCallback(async () => {
    if (typeof window.qdo === 'undefined') return
    try {
      const data = await window.qdo.chat.sessions()
      setSessions(data.sessions)
      setActiveId(data.active)
    } catch {
      /* 忽略 */
    }
  }, [])

  const loadHistory = useCallback(async () => {
    if (typeof window.qdo === 'undefined') return
    try {
      const entries = await window.qdo.chat.history()
      setMessages([WELCOME, ...entries.map((entry, index) => ({ role: entry.role, text: entry.text, ts: Date.now() + index }))])
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    void loadSessions()
    void loadHistory()
  }, [loadHistory, loadSessions])

  // 流式增量
  useEffect(() => {
    if (typeof window.qdo === 'undefined') return
    const off = window.qdo.chat.onDelta((chunk) => {
      streamRef.current += chunk
      const text = streamRef.current
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last?.streaming) return [...prev.slice(0, -1), { ...last, text }]
        return [...prev, { role: 'assistant', text, ts: Date.now(), streaming: true }]
      })
    })
    return off
  }, [])

  // 实时过程（工具调用）
  useEffect(() => {
    if (typeof window.qdo === 'undefined') return
    const off = window.qdo.chat.onProgress((event) => {
      const line = describeProgress(event)
      if (line) setLive((prev) => [...prev.slice(-8), line])
    })
    return off
  }, [])

  // 主进程要求朗读（AI 调 speak_text 时）
  useEffect(() => {
    if (typeof window.qdo === 'undefined') return
    const off = window.qdo.system.onSpeak((text) => {
      try {
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
      } catch {
        /* 忽略 */
      }
    })
    return off
  }, [])

  const speakReply = useCallback((text: string) => {
    try {
      if (window.localStorage.getItem('qdo:speakReplies') !== '1') return
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 800)))
    } catch {
      /* 忽略 */
    }
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    streamRef.current = ''
    setLive([])
    if (replaceMode) {
      // 补充/修改上一条用户消息：本地把最后一条用户消息替换掉
      setMessages((prev) => {
        const out = [...prev]
        for (let i = out.length - 1; i >= 0; i -= 1) {
          if (out[i].role === 'user') {
            out.splice(i, 1)
            break
          }
        }
        out.push({ role: 'user', text, ts: Date.now() })
        return out
      })
      setReplaceMode(false)
    } else {
      setMessages((prev) => [...prev, { role: 'user', text, ts: Date.now() }])
    }
    if (typeof window.qdo === 'undefined') {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: 'IPC 不可用：preload 未加载。请从 Electron 里启动（npm start）。', ts: Date.now() },
      ])
      return
    }
    setSending(true)
    try {
      const reply = await window.qdo.chat.send(text, { replaceLast: replaceMode })
      setMessages((prev) => [
        ...prev.filter((msg) => !msg.streaming),
        { role: reply.ok ? 'assistant' : 'system', text: reply.text, ts: Date.now(), trace: reply.trace },
      ])
      setLive([])
      void loadSessions()
      if (reply.ok) speakReply(reply.text)
    } catch (err) {
      setMessages((prev) => [
        ...prev.filter((msg) => !msg.streaming),
        { role: 'system', text: `请求失败：${err instanceof Error ? err.message : String(err)}`, ts: Date.now() },
      ])
    } finally {
      setSending(false)
    }
  }, [input, loadSessions, replaceMode, sending])

  const stop = useCallback(async () => {
    try {
      await window.qdo.chat.abort()
    } catch {
      /* 忽略 */
    }
  }, [])

  const clear = useCallback(async () => {
    try {
      await window.qdo.chat.clear()
    } catch {
      /* 忽略 */
    }
    streamRef.current = ''
    setLive([])
    setMessages([WELCOME])
  }, [])

  const newChat = useCallback(async () => {
    try {
      await window.qdo.chat.newSession()
      setMessages([WELCOME])
      setLive([])
      await loadSessions()
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'system', text: `新建对话失败：${String(err)}`, ts: Date.now() }])
    }
  }, [loadSessions])

  const switchChat = useCallback(
    async (id: string) => {
      if (!id || id === activeId) return
      try {
        await window.qdo.chat.switchSession(id)
        setMessages([WELCOME])
        setLive([])
        setActiveId(id)
        await loadSessions()
        await loadHistory()
      } catch {
        /* 忽略 */
      }
    },
    [activeId, loadHistory, loadSessions],
  )

  const deleteChat = useCallback(async () => {
    if (!activeId) return
    try {
      await window.qdo.chat.deleteSession(activeId)
      setMessages([WELCOME])
      setLive([])
      await loadSessions()
      await loadHistory()
    } catch {
      /* 忽略 */
    }
  }, [activeId, loadHistory, loadSessions])

  const supplement = useCallback(() => {
    const lastUser = [...messages].reverse().find((msg) => msg.role === 'user')
    if (!lastUser) return
    setInput(lastUser.text)
    setReplaceMode(true)
  }, [messages])

  const working = sending && !messages.some((msg) => msg.streaming)
  const lastUserIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') return index
    }
    return -1
  })()

  return (
    <aside className="chat">
      <div className="chat-head">
        <span className="chat-title">AI 助手</span>
        <select
          className="chat-session-select"
          value={activeId}
          onChange={(event) => void switchChat(event.target.value)}
          title="切换对话"
        >
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}（{item.count}）
            </option>
          ))}
        </select>
        <button type="button" className="ghost tiny" onClick={() => void newChat()} title="新建对话">
          ＋
        </button>
        <button type="button" className="ghost tiny danger" onClick={() => void deleteChat()} title="删除当前对话">
          删
        </button>
        <button type="button" className="chat-clear" onClick={() => void clear()} title="清空当前对话记忆">
          清空
        </button>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.map((msg, index) => (
          <div key={`${msg.ts}-${index}`} className={`bubble bubble-${msg.role}${msg.streaming ? ' bubble-streaming' : ''}`}>
            <pre>{msg.text}</pre>
            {msg.role === 'user' && index === lastUserIndex ? (
              <button type="button" className="bubble-edit" onClick={supplement} title="补充/修改这条消息">
                补充
              </button>
            ) : null}
            {msg.trace && msg.trace.length > 0 ? (
              <div className="trace-list">
                {msg.trace.map((item) => (
                  <div key={item.id} className={`trace-item ${item.ok ? 'trace-ok' : 'trace-bad'}`}>
                    <span className="trace-tool">{item.ok ? '✓' : '✕'} {item.tool}</span>
                    <span className="trace-summary">{item.summary}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {sending && live.length > 0 ? (
          <div className="bubble bubble-assistant bubble-progress">
            <div className="progress-head">正在工作…</div>
            {live.map((line, index) => (
              <div key={index} className="progress-line">
                {line}
              </div>
            ))}
          </div>
        ) : null}
        {working && live.length === 0 ? (
          <div className="bubble bubble-assistant bubble-typing">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
      {replaceMode ? (
        <div className="composer-hint">
          正在补充上一条消息，发送后会替换它 · <button type="button" className="ghost tiny" onClick={() => setReplaceMode(false)}>取消</button>
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={replaceMode ? '补充内容后发送，会替换上一条' : '说人话或输入命令，例如：装个 sodium'}
          spellCheck={false}
        />
        {sending ? (
          <button type="button" className="composer-stop" onClick={() => void stop()}>
            停止
          </button>
        ) : (
          <button type="submit" disabled={input.trim().length === 0}>
            发送
          </button>
        )}
      </form>
      <div className="chat-foot">API Key 只存本地 · 工具调用有审计日志 · 对话记忆保存在本机</div>
    </aside>
  )
}
