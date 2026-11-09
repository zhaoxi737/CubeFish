import React from 'react';
import {AbsoluteFill, useVideoConfig} from 'remotion';

/**
 * 48px square grid, 1px lines at exactly 4% white. Drawn as an SVG pattern so
 * the lines stay crisp at any composition size (portrait 1080x1920 and
 * landscape 1920x1080 both use the same layer).
 */
export const GridLayer: React.FC<{id?: string}> = ({id = 'cube-grid'}) => {
  const {width, height} = useVideoConfig();

  return (
    <AbsoluteFill>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{position: 'absolute', inset: 0}}
      >
        <defs>
          <pattern
            id={id}
            width={48}
            height={48}
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 48 0 L 0 0 0 48"
              fill="none"
              stroke="#ffffff"
              strokeOpacity={0.04}
              strokeWidth={1}
            />
          </pattern>
        </defs>
        <rect width={width} height={height} fill={`url(#${id})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** Very soft green light behind the hero element, adds depth without changing the base color. */
export const AmbientGlow: React.FC<{x?: string; y?: string}> = ({
  x = '50%',
  y = '38%',
}) => {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 72% 42% at ${x} ${y}, rgba(74,222,128,0.10) 0%, rgba(74,222,128,0.035) 46%, rgba(74,222,128,0) 72%)`,
      }}
    />
  );
};

/** Cinematic edge falloff. Kept subtle so the burned-in caption stays legible. */
export const Vignette: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 82% 68% at 50% 44%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.38) 100%)`,
        pointerEvents: 'none',
      }}
    />
  );
};

