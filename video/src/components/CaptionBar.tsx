import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {COLORS, FONTS} from '../theme';
import {LANDSCAPE} from '../landscape/layout';

/**
 * Landscape burned-in caption: 90px above the bottom edge, 40px bold, 18px
 * radius capsule. `start` is relative to the parent sequence.
 */
export const CaptionBar: React.FC<{
  text: string;
  start?: number;
}> = ({text, start = 0}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [start, start + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: LANDSCAPE.caption.bottom,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: `${LANDSCAPE.caption.paddingY}px ${LANDSCAPE.caption.paddingX}px`,
            borderRadius: LANDSCAPE.caption.radius,
            backgroundColor: 'rgba(0,0,0,0.56)',
            border: '1px solid rgba(255,255,255,0.12)',
            boxShadow:
              '0 16px 40px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.05)',
            backdropFilter: 'blur(6px)',
            opacity: progress,
            transform: `translateY(${(1 - progress) * 14}px)`,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              flexShrink: 0,
              backgroundColor: COLORS.brand,
              boxShadow: '0 0 12px rgba(74,222,128,0.7)',
            }}
          />
          <span
            style={{
              fontFamily: FONTS.display,
              fontWeight: 700,
              fontSize: LANDSCAPE.caption.fontSize,
              lineHeight: LANDSCAPE.caption.lineHeight,
              color: COLORS.white,
              letterSpacing: '0.01em',
              textShadow: '0 2px 4px rgba(0,0,0,0.5)',
              whiteSpace: 'nowrap',
            }}
          >
            {text}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
