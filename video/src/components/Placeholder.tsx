import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {GridLayer, Vignette} from './Backdrop';
import {COLORS, FONTS} from '../theme';

const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

/**
 * Segment placeholder. The hero composition is 1824 frames long; every section
 * that is not built yet renders this card so the full film always renders.
 */
export const Placeholder: React.FC<{
  title: string;
  from: number;
  duration: number;
}> = ({title, from, duration}) => {
  const frame = useCurrentFrame();
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, duration - 1)));
  const scan = interpolate(
    frame % 96,
    [0, 96],
    [-40, 1040],
    {...clamp, easing: Easing.linear},
  );

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <GridLayer id={`grid-${from}`} />
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: 760,
            padding: '56px 48px 44px',
            borderRadius: 28,
            backgroundColor: 'rgba(14,22,17,0.82)',
            border: '2px solid rgba(74,222,128,0.22)',
            boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: scan,
              width: 40,
              height: '100%',
              background:
                'linear-gradient(90deg, rgba(74,222,128,0) 0%, rgba(74,222,128,0.12) 50%, rgba(74,222,128,0) 100%)',
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginBottom: 26,
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                backgroundColor: COLORS.brand,
                boxShadow: '0 0 16px rgba(74,222,128,0.8)',
              }}
            />
            <span
              style={{
                fontFamily: FONTS.text,
                fontSize: 22,
                letterSpacing: '0.28em',
                color: COLORS.secondary,
              }}
            >
              CUBEFISH · PROMO
            </span>
          </div>

          <div
            style={{
              fontFamily: FONTS.display,
              fontWeight: 700,
              fontSize: 72,
              lineHeight: 1.1,
              letterSpacing: '-0.03em',
              color: COLORS.white,
            }}
          >
            {title}
          </div>

          <div
            style={{
              marginTop: 18,
              fontFamily: FONTS.text,
              fontSize: 30,
              color: COLORS.secondary,
            }}
          >
            段落占位 · 待制作 · 第 {from}–{from + duration - 1} 帧
          </div>

          <div
            style={{
              marginTop: 38,
              height: 4,
              width: '100%',
              borderRadius: 2,
              backgroundColor: 'rgba(242,247,242,0.08)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress * 100}%`,
                height: '100%',
                borderRadius: 2,
                background: `linear-gradient(90deg, ${COLORS.shadow}, ${COLORS.brand})`,
              }}
            />
          </div>
        </div>
      </AbsoluteFill>
      <Vignette />
    </AbsoluteFill>
  );
};
