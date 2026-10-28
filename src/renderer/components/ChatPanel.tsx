import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ToolCallTrace } from '../../shared/types'

type Message = ChatMessage & { trace?: ToolCallTrace[]; streaming?: boolean }

const WELCOME: Message = {
  role: 'assistant',
  ts: Date.now(),
  text:
    '我是 QDOQMC 的助手。配好模型 API Key 后可以直接说人话：\n·「装个 sodium」\n·「帮我看下为什么崩了」\n·「最近有什么优化模组」\n·「启动游戏」\n没配 Key 时也能用 /help 看本地命令。',
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([WELCOME])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef('')

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // 恢复会话记忆（重启后还能接着聊）
  useEffect(() => {
    if (typeof window.qdo === 'undefined') return
    void window.qdo.chat
      .history()
      .then((entries) => {
        if (!entries.length) return
        setMessages((prev) => [
          prev[0],
          ...entries.map((entry, index) => ({
            role: entry.role,
            text: entry.text,
            ts: Date.now() + index,
          })),
        ])
      })
      .catch(() => undefined)
  }, [])

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

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    streamRef.current = ''
    setMessages((prev) => [...prev, { role: 'user', text, ts: Date.now() }])
    if (typeof window.qdo === 'undefined') {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: 'IPC 不可用：preload 未加载。请从 Electron 里启动（npm start）。', ts: Date.now() },
      ])
      return
    }
    setSending(true)
    try {
      const reply = await window.qdo.chat.send(text)
      setMessages((prev) => [
        ...prev.filter((msg) => !msg.streaming),
        {
          role: reply.ok ? 'assistant' : 'system',
          text: reply.text,
          ts: Date.now(),
          trace: reply.trace,
        },
      ])
    } catch (err) {
      setMessages((prev) => [
        ...prev.filter((msg) => !msg.streaming),
        { role: 'system', text: `请求失败：${err instanceof Error ? err.message : String(err)}`, ts: Date.now() },
      ])
    } finally {
      setSending(false)
    }
  }, [input, sending])

  const clear = useCallback(async () => {
    try {
      await window.qdo.chat.clear()
    } catch {
      /* 忽略 */
    }
    streamRef.current = ''
    setMessages([WELCOME])
  }, [])

  return (
    <aside className="chat">
      <div className="chat-head">
        <span className="chat-title">AI 助手</span>
        <span className="chat-badge">工具调用</span>
        <button type="button" className="chat-clear" onClick={() => void clear()} title="清空对话记忆">
          清空
        </button>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.map((msg, index) => (
          <div key={`${msg.ts}-${index}`} className={`bubble bubble-${msg.role}${msg.streaming ? ' bubble-streaming' : ''}`}>
            <pre>{msg.text}</pre>
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
        {sending && !messages.some((msg) => msg.streaming) ? (
          <div className="bubble bubble-assistant bubble-typing">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
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
          placeholder="说人话或输入命令，例如：装个 sodium"
          spellCheck={false}
        />
        <button type="submit" disabled={sending || input.trim().length === 0}>
          发送
        </button>
      </form>
      <div className="chat-foot">API Key 只存本地 · 工具调用有审计日志 · 对话记忆保存在本机</div>
    </aside>
  )
}
