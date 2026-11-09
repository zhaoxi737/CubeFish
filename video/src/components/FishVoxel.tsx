import React from 'react';
import {interpolate, spring} from 'remotion';
import {CELL_STYLES, type FishPiece} from '../fishPieces';
import {COLORS} from '../theme';

/**
 * One voxel of the pixel fish. Shared by the landscape hook; the portrait cut
 * has its own copy. All timing is a pure function of `frame`.
 */
export const FishVoxel: React.FC<{
  piece: FishPiece;
  frame: number;
  fps: number;
  cellSize: number;
}> = ({piece, frame, fps, cellSize}) => {
  const {
    type,
    finalX,
    finalY,
    startX,
    startY,
    startRotation,
    delay,
    startScale,
    breathPhase,
  } = piece;

  const rawProgress = spring({
    fps,
    frame: Math.max(0, frame - delay),
    config: {damping: 13, mass: 0.8, stiffness: 48},
  });
  // Hard 70-frame beat: clamp the final ~1% so the fish is exactly locked.
  const progress = frame >= 70 ? 1 : rawProgress;

  const opacity = interpolate(frame, [delay, delay + 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const breathFade = interpolate(frame, [70, 84], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const breath =
    Math.sin(((frame - 70) / 40) * Math.PI * 2 + breathPhase) *
    1.2 *
    breathFade;

  const style = CELL_STYLES[type];
  const inner = cellSize - 2;
  const radius = Math.max(3, Math.round(cellSize * 0.16));
  const extrusion = cellSize >= 40 ? 4 : 3;

  const tx = (1 - progress) * (startX - finalX);
  const ty = (1 - progress) * (startY - finalY) + breath;
  const rotation = (1 - progress) * startRotation;
  const scale = startScale + (1 - startScale) * progress;

  return (
    <div
      style={{
        position: 'absolute',
        left: finalX - cellSize / 2,
        top: finalY - cellSize / 2,
        width: cellSize,
        height: cellSize,
        transform: `translate3d(${tx}px, ${ty}px, 0) rotate(${rotation}deg) scale(${scale})`,
        transformOrigin: '50% 50%',
        opacity,
        zIndex: 20 + piece.row,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 1,
          top: 1,
          width: inner,
          height: inner,
          borderRadius: radius,
          backgroundColor: COLORS.extrusion,
          transform: `translateY(${extrusion}px)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 1,
          top: 1,
          width: inner,
          height: inner,
          borderRadius: radius,
          backgroundColor: style.fill,
          boxShadow: `inset 0 0 0 2px ${style.innerStroke}`,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 2,
            right: 2,
            top: 2,
            height: 1,
            borderRadius: 1,
            backgroundColor: 'rgba(255,255,255,0.12)',
          }}
        />
      </div>
    </div>
  );
};
