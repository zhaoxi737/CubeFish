/**
 * 大肥鱼吉祥物（DeepSeek 主题）：纯 SVG，无外部资源，随主题变色。
 */
export function FishMascot({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="大肥鱼"
    >
      <defs>
        <linearGradient id="fish-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c93ff" />
          <stop offset="60%" stopColor="#4d6bfe" />
          <stop offset="100%" stopColor="#2f47c9" />
        </linearGradient>
        <linearGradient id="fish-tail" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4d6bfe" />
          <stop offset="100%" stopColor="#8fa6ff" />
        </linearGradient>
      </defs>
      {/* 尾巴 */}
      <path d="M6 32 L20 20 L20 44 Z" fill="url(#fish-tail)" />
      {/* 身体（胖胖的椭圆） */}
      <ellipse cx="38" cy="32" rx="22" ry="17" fill="url(#fish-body)" />
      {/* 肚皮 */}
      <ellipse cx="40" cy="38" rx="14" ry="8" fill="#b9c6ff" opacity="0.85" />
      {/* 眼睛 */}
      <circle cx="48" cy="27" r="4.5" fill="#0b0f14" />
      <circle cx="49.4" cy="25.6" r="1.6" fill="#ffffff" />
      {/* 嘴 */}
      <path d="M54 34 q4 2 0 4" stroke="#0b0f14" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* 背鳍 */}
      <path d="M36 16 q4 -7 10 -2 q-5 1 -6 4 Z" fill="#8fa6ff" />
    </svg>
  )
}
