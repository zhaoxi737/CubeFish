import React from 'react';
import {AbsoluteFill} from 'remotion';
import {hashRange} from '../lib/random';
import {COLORS} from '../theme';

const PARTICLE_COLORS = [COLORS.brand, COLORS.body, COLORS.highlight];

/**
 * Deterministic floating green pixel dust. Position is recomputed from `frame`
 * only, so every render is identical.
 */
export const ParticleField: React.FC<{
  width: number;
  height: number;
  frame: number;
  count?: number;
}> = ({width, height, frame, count = 20}) => {
  const range = height + 140;

  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      {Array.from({length: count}, (_, i) => {
        const seed = i * 61 + 7;
        const baseX = hashRange(seed + 1, 0, width);
        const baseY = hashRange(seed + 2, 0, height);
        const size = Math.round(hashRange(seed + 3, 4, 10));
        const rise = hashRange(seed + 4, 0.35, 1.2);
        const drift = hashRange(seed + 5, 3, 10);
        const phase = hashRange(seed + 6, 0, Math.PI * 2);
        const twinkleSpeed = hashRange(seed + 7, 0.05, 0.2);
        const baseOpacity = hashRange(seed + 8, 0.12, 0.3);
        const color =
          PARTICLE_COLORS[
            Math.min(
              PARTICLE_COLORS.length - 1,
              Math.floor(hashRange(seed + 9, 0, PARTICLE_COLORS.length)),
            )
          ];

        const y =
          (((baseY - frame * rise) % range) + range) % range - 70;
        const x = baseX + Math.sin(frame * 0.012 + phase) * drift;
        const twinkle =
          0.5 + 0.5 * Math.sin(frame * twinkleSpeed + phase);
        const opacity = Math.min(
          0.35,
          baseOpacity * (0.35 + 0.65 * twinkle),
        );

        return (
          <div
            key={`particle-${i}`}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: size,
              height: size,
              borderRadius: 2,
              backgroundColor: color,
              opacity,
              boxShadow: '0 0 12px rgba(74,222,128,0.2)',
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
