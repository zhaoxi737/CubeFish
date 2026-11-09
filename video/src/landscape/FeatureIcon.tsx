import React from 'react';
import {COLORS} from '../theme';

export type FeatureIconName = 'instances' | 'download' | 'crash' | 'sandbox';

const common = {
  fill: 'none',
  stroke: COLORS.brand,
  strokeWidth: 3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Four hand-drawn 64x64 line icons for the S3 cards. */
export const FeatureIcon: React.FC<{name: FeatureIconName}> = ({name}) => {
  return (
    <svg width={64} height={64} viewBox="0 0 64 64" aria-hidden="true">
      {name === 'instances' ? (
        <>
          <rect x="8" y="22" width="30" height="30" rx="6" {...common} />
          <rect x="18" y="13" width="30" height="30" rx="6" {...common} />
          <path d="M26 31h14M26 39h9" {...common} />
        </>
      ) : null}

      {name === 'download' ? (
        <>
          <path d="M18 10v20M18 30l-6-6M18 30l6-6" {...common} />
          <path d="M46 10v20M46 30l-6-6M46 30l6-6" {...common} />
          <path d="M10 44v4a6 6 0 0 0 6 6h32a6 6 0 0 0 6-6v-4" {...common} />
        </>
      ) : null}

      {name === 'crash' ? (
        <>
          <path d="M32 8 58 54H6L32 8Z" {...common} />
          <path d="M32 24v14" {...common} />
          <circle cx="32" cy="46" r="2.6" fill={COLORS.brand} />
        </>
      ) : null}

      {name === 'sandbox' ? (
        <>
          <path
            d="M32 6 54 14v18c0 14-9 23-22 27C19 55 10 46 10 32V14L32 6Z"
            {...common}
          />
          <rect x="22" y="24" width="20" height="16" rx="3" {...common} />
          <path d="M32 24v-4M22 32h-4M46 32h-4" {...common} />
        </>
      ) : null}
    </svg>
  );
};
