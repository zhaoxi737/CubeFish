import { useState } from 'react'
import { FishMascot } from './FishMascot'

interface Props {
  size?: number
  className?: string
  /** 图片缺失时是否回退到内置 SVG 吉祥物 */
  fallback?: boolean
  alt?: string
}

/**
 * 大肥鱼图片吉祥物（ComfyUI 生成的 PNG，放在 out/renderer/assets/mascot-fish.png）。
 * 资源缺失时自动回退到内置 SVG 版本，保证构建/离线状态不出现破图。
 */
export function MascotImage({ size = 32, className, fallback = true, alt = '大肥鱼' }: Props) {
  const [failed, setFailed] = useState(false)
  if (failed) return fallback ? <FishMascot size={size} className={className} /> : null
  return (
    <img
      className={`mascot-img ${className ?? ''}`}
      src="./assets/mascot-fish.png"
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
