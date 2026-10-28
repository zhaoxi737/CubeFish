import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../shared/types'

const WELCOME: ChatMessage = {
  role: 'assistant',
  ts: Date.now(),
  text:
    '我是 QDOQMC 的助手。现在能做的事：/help 看命令，/status 看状态，/java 看本机 Java，/mod search <关键词> 搜模组，/mod install <slug> 直接装，/instance 看隔离目录。\n装 Fabric、装模组、启动游戏都已打通；P4 起这里接入真正的 AI 工具调用（自然语言直接触发这些能力）。',
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
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
      setMessages((prev) => [...prev, { role: reply.ok ? 'assistant' : 'system', text: reply.text, ts: Date.now() }])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'system', text: `请求失败：${err instanceof Error ? err.message : String(err)}`, ts: Date.now() },
      ])
    } finally {
      setSending(false)
    }
  }, [input, sending])

  return (
    <aside className="chat">
      <div className="chat-head">
        <span className="chat-title">AI 助手</span>
        <span className="chat-badge">本地命令模式</span>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.map((msg, index) => (
          <div key={`${msg.ts}-${index}`} className={`bubble bubble-${msg.role}`}>
            <pre>{msg.text}</pre>
          </div>
        ))}
        {sending ? (
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
          placeholder="输入命令或问题，例如 /status"
          spellCheck={false}
        />
        <button type="submit" disabled={sending || input.trim().length === 0}>
          发送
        </button>
      </form>
      <div className="chat-foot">API Key 只存本地 · 不随统计上报</div>
    </aside>
  )
}
