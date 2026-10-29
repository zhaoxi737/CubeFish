import { useCallback, useEffect, useState } from 'react'
import type { PluginUiButton } from '../../shared/types'

/**
 * P34：把插件注册的按钮渲染到顶栏。
 * 插件通过 api.registerButton() 声明，点击后执行插件里的 run()，结果用 toast 显示。
 */
export function PluginButtons({ onNotify }: { onNotify: (text: string) => void }) {
  const [buttons, setButtons] = useState<PluginUiButton[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setButtons(await window.qdo.plugins.buttons())
    } catch {
      /* 插件宿主未就绪时忽略 */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const press = useCallback(
    async (button: PluginUiButton) => {
      const key = `${button.pluginId}:${button.id}`
      setBusy(key)
      try {
        const result = await window.qdo.plugins.press(button.pluginId, button.id)
        onNotify(result.ok ? result.summary || `${button.label} 完成` : `${button.label} 失败：${result.summary}`)
      } catch (err) {
        onNotify(`${button.label} 失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [onNotify],
  )

  if (buttons.length === 0) return null

  return (
    <>
      {buttons.map((button) => (
        <button
          key={`${button.pluginId}:${button.id}`}
          type="button"
          className="ghost plugin-btn"
          title={button.description || `来自插件：${button.pluginName}`}
          disabled={busy === `${button.pluginId}:${button.id}`}
          onClick={() => void press(button)}
        >
          {button.label}
        </button>
      ))}
    </>
  )
}
