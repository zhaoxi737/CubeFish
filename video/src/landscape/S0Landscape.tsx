import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {AmbientGlow, GridLayer, Vignette} from '../components/Backdrop';
import {CaptionBar} from '../components/CaptionBar';
import {FishVoxel} from '../components/FishVoxel';
import {ParticleField} from '../components/ParticleField';
import {COLORS, FONTS} from '../theme';
import {
  LANDSCAPE_FISH_PIECES,
  LANDSCAPE_CELL_SIZE,
} from '../landscape/fishLandscape';
import {LANDSCAPE} from '../landscape/layout';

/**
 * Landscape S0 — 1920x1080, frames 0–143.
 *
 * Left: 112 voxels fly in from four screen edges, lock at frame 70, halo pulse.
 * Right: left-aligned copy block starting at x=1080, 132px title.
 */
export const S0Landscape: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const centerX = LANDSCAPE.fish.centerX;
  const centerY = LANDSCAPE.fish.centerY;

  const pulseScale =
    frame < 70
      ? 0.6
      : interpolate(frame, [70, 100], [0.6, 1.7], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        });
  const pulseOpacity = interpolate(frame, [69, 70, 100], [0, 0.85, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.quad),
  });

  const growth = interpolate(frame, [70, 143], [1, 1.03], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const landingPop =
    frame < 70
      ? 1
      : interpolate(frame, [70, 84], [1.06, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        });
  const fishScale = frame < 70 ? 1 : growth * landingPop;

  const titleSpring = spring({
    fps,
    frame: Math.max(0, frame - 85),
    config: {damping: 13, mass: 0.7, stiffness: 100},
  });
  const titleOpacity = interpolate(titleSpring, [0, 1], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const titleY = (1 - titleSpring) * 40;

  const subtitleProgress = interpolate(frame, [97, 121], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const subtitleY = (1 - subtitleProgress) * 14;

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <AmbientGlow x="38.5%" y="43.5%" />
      <GridLayer />
      <ParticleField
        width={LANDSCAPE.width}
        height={LANDSCAPE.height}
        frame={frame}
        count={20}
      />

      <AbsoluteFill
        style={{
          transform: `scale(${fishScale})`,
          transformOrigin: `${centerX}px ${centerY}px`,
        }}
      >
        {LANDSCAPE_FISH_PIECES.map((piece) => (
          <FishVoxel
            key={piece.key}
            piece={piece}
            frame={frame}
            fps={fps}
            cellSize={LANDSCAPE_CELL_SIZE}
          />
        ))}
      </AbsoluteFill>

      {/* Halo pulse — transparent wrapper, one exact radial gradient, no ring. */}
      <AbsoluteFill style={{pointerEvents: 'none', backgroundColor: 'transparent'}}>
        <div
          style={{
            position: 'absolute',
            left: centerX - 500,
            top: centerY - 500,
            width: 1000,
            height: 1000,
            background:
              'radial-gradient(circle, rgba(74,222,128,0.55) 0%, rgba(74,222,128,0.18) 45%, rgba(74,222,128,0) 70%)',
            transform: `scale(${pulseScale})`,
            opacity: pulseOpacity,
          }}
        />
      </AbsoluteFill>

      {/* Tick per voxel locking in, same delay table as the visual. */}
      {LANDSCAPE_FISH_PIECES.map((piece, index) => (
        <Sequence
          key={`tick-${piece.key}`}
          from={piece.landFrame}
          durationInFrames={10}
        >
          <Audio
            src={staticFile('audio/sfx/tick.wav')}
            volume={0.18}
            playbackRate={0.9 + (index % 10) * 0.028}
          />
        </Sequence>
      ))}

      <Sequence from={22} durationInFrames={48}>
        <Audio src={staticFile('audio/sfx/riser.wav')} volume={0.2} />
      </Sequence>
      <Sequence from={70} durationInFrames={30}>
        <Audio src={staticFile('audio/sfx/thud.wav')} volume={0.35} />
        <Audio src={staticFile('audio/sfx/sparkle.wav')} volume={0.25} />
      </Sequence>

      {/* Right-hand copy block, left aligned at x=1080, vertically centred. */}
      <div
        style={{
          position: 'absolute',
          left: LANDSCAPE.copy.left,
          top: LANDSCAPE.copy.centerY - LANDSCAPE.height / 2,
          height: LANDSCAPE.height,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            fontFamily: FONTS.display,
            fontWeight: 700,
            fontSize: LANDSCAPE.copy.titleSize,
            lineHeight: LANDSCAPE.copy.titleLineHeight,
            letterSpacing: '-0.045em',
            color: COLORS.white,
            textShadow: `4px 4px 0 ${COLORS.extrusion}, 0 0 90px rgba(74,222,128,0.16)`,
            transform: `translateY(${titleY}px)`,
            opacity: titleOpacity,
            whiteSpace: 'nowrap',
          }}
        >
          方块鱼
        </div>

        <div
          style={{
            marginTop: LANDSCAPE.copy.subtitleGap,
            fontFamily: FONTS.text,
            fontSize: LANDSCAPE.copy.subtitleSize,
            fontWeight: 400,
            lineHeight: 1.4,
            letterSpacing: '0.015em',
            color: COLORS.secondary,
            transform: `translateY(${subtitleY}px)`,
            opacity: subtitleProgress,
            whiteSpace: 'nowrap',
          }}
        >
          一个会自己动手的{' '}
          <span style={{color: COLORS.white}}>Minecraft</span> 启动器
        </div>
      </div>

      <CaptionBar text="想和朋友一起玩 Minecraft？" start={10} />
      <Vignette />
    </AbsoluteFill>
  );
};
