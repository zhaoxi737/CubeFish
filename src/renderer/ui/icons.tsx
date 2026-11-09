/**
 * 线性图标集（20px 网格、1.5px 描边、currentColor）。
 * 全部用内联 SVG，不依赖图标字体或 emoji，跨系统渲染一致。
 */
type Props = { size?: number; className?: string }

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
  'aria-hidden': true,
})

export function IconHome({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="M3.2 8.4 10 3l6.8 5.4V16a.9.9 0 0 1-.9.9h-3.6v-4.6H7.7v4.6H4.1a.9.9 0 0 1-.9-.9z" />
    </svg>
  )
}

export function IconLayers({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="m10 3 6.6 3.3L10 9.6 3.4 6.3z" />
      <path d="m3.4 10.2 6.6 3.3 6.6-3.3" />
      <path d="m3.4 13.9 6.6 3.3 6.6-3.3" />
    </svg>
  )
}

export function IconDownload({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="M10 3v9.2" />
      <path d="m6.2 8.9 3.8 3.8 3.8-3.8" />
      <path d="M3.6 15.4h12.8" />
    </svg>
  )
}

export function IconPlugin({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 3.2h4v2.1a1.6 1.6 0 1 0 3.2 0V3.2h1.6v4h-2.1a1.6 1.6 0 1 0 0 3.2h2.1v4h-4v-2.1a1.6 1.6 0 1 0-3.2 0v2.1H5.4v-4h2.1a1.6 1.6 0 1 0 0-3.2H5.4v-4H8z" />
    </svg>
  )
}

export function IconRefresh({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="M15.8 8.4a6 6 0 1 0 .2 3" />
      <path d="M16.4 3.6v4.8h-4.8" />
    </svg>
  )
}

export function IconLog({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="M5 3.4h7l3 3v10.2H5z" />
      <path d="M12 3.4v3h3" />
      <path d="M7.4 10h5.2M7.4 12.8h5.2" />
    </svg>
  )
}

export function IconSettings({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.8v2.1M10 15.1v2.1M17.2 10h-2.1M4.9 10H2.8M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5M15.1 15.1l-1.5-1.5M6.4 6.4 4.9 4.9" />
    </svg>
  )
}

export function IconSystem({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <rect x="2.8" y="4" width="14.4" height="9.4" rx="1.2" />
      <path d="M7.6 16.4h4.8" />
    </svg>
  )
}

export function IconSpark({ size = 16, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="M10 3.2 11.5 8l4.8 1.5-4.8 1.5L10 15.8 8.5 11 3.7 9.5 8.5 8z" />
    </svg>
  )
}

export function IconFolder({ size = 18, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="M3.2 6.2a1 1 0 0 1 1-1h3.1l1.4 1.6h6.2a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function IconPlay({ size = 20, className }: Props) {
  return (
    <svg {...base(size, className)} fill="currentColor" stroke="none">
      <path d="M6.4 3.6 16 10 6.4 16.4z" />
    </svg>
  )
}

export function IconClose({ size = 16, className }: Props) {
  return (
    <svg {...base(size, className)}>
      <path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6" />
    </svg>
  )
}
