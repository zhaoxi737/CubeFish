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
import {
  CELL_STYLES,
  FISH_CELL_SIZE,
  FISH_PIECES,
  type FishPiece,
} from '../fishPieces';
import {hashRange} from '../lib/random';
import {COLORS, FONTS, HEIGHT, HOOK_LAYOUT, WIDTH} from '../theme';

/**
 * S0 — opening hook, frames 0–143 (4.8s at 30fps).
 *
 * 0–70   112 voxels fly in from the four screen edges and lock into the fish
 *        (radial launch order, ~27f spring, last block lands on frame 70)
 * 70–100 one radial halo pulse; the fish gets a 1.06 -> 1 landing pop
 * 70–143 gentle life: fish group grows to 1.03, every voxel breathes ±1.2px
 * 85–143 title 方块鱼 rises 40px with a spring, subtitle follows 12f later
 * 10–143 caption capsule is burned in 260px above the bottom edge
 *
 * Every visual value below is a pure function of `frame`; no clocks, no
 * random(). The deterministic PRNG lives in src/lib/random.ts.
 */

const T = {
  fish: {
    pulseStart: 70,
    pulseEnd: 100,
  },
  title: {
    start: 85,
  },
  subtitle: {
    start: 97, // 12 frames after the title
  },
  caption: {
    start: 10,
    settle: 32,
  },
} as const;

const SPRING_CONFIG = {
  // Slower than the first cut: visible travel lasts ~26–30 frames, so the
  // silhouette is still closing at frame 60 and locks exactly at 70.
  damping: 13,
  mass: 0.8,
  stiffness: 48,
};

const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

const PARTICLE_COUNT = 26;
const PARTICLE_RANGE = HEIGHT + 140;

interface Particle {
  baseX: number;
  baseY: number;
  size: number;
  rise: number;
  drift: number;
  phase: number;
  twinkle: number;
  opacity: number;
  color: string;
}

const PARTICLE_COLORS = [COLORS.brand, COLORS.body, COLORS.highlight];

const PARTICLES: Particle[] = Array.from({length: PARTICLE_COUNT}, (_, i) => {
  const seed = i * 61 + 7;
  return {
    baseX: hashRange(seed + 1, 0, WIDTH),
    baseY: hashRange(seed + 2, 0, HEIGHT),
    size: Math.round(hashRange(seed + 3, 4, 13)),
    rise: hashRange(seed + 4, 0.35, 1.3),
    drift: hashRange(seed + 5, 3, 11),
    phase: hashRange(seed + 6, 0, Math.PI * 2),
    twinkle: hashRange(seed + 7, 0.05, 0.2),
    opacity: hashRange(seed + 8, 0.16, 0.46),
    color:
      PARTICLE_COLORS[
        Math.min(
          PARTICLE_COLORS.length - 1,
          Math.floor(hashRange(seed + 9, 0, PARTICLE_COLORS.length)),
        )
      ],
  };
});

const ParticleField: React.FC<{frame: number}> = ({frame}) => {
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      {PARTICLES.map((p, i) => {
        const y =
          (((p.baseY - frame * p.rise) % PARTICLE_RANGE) + PARTICLE_RANGE) %
            PARTICLE_RANGE -
          70;
        const x = p.baseX + Math.sin(frame * 0.012 + p.phase) * p.drift;
        const twinkle = 0.5 + 0.5 * Math.sin(frame * p.twinkle + p.phase);
        const opacity = p.opacity * (0.35 + 0.65 * twinkle);

        return (
          <div
            key={`particle-${i}`}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: p.size,
              height: p.size,
              borderRadius: 2,
              backgroundColor: p.color,
              opacity,
              boxShadow: '0 0 12px rgba(74,222,128,0.32)',
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const FishPieceView: React.FC<{piece: FishPiece; frame: number; fps: number}> = ({
  piece,
  frame,
  fps,
}) => {
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
    config: SPRING_CONFIG,
  });
  // The 70-frame beat is a hard edit point: clamp the last ~1% of the spring so
  // every voxel is exactly on its final pixel at frame 70 (the pulse covers the
  // few px of snap). Before 70 the same blocks are still visibly en route.
  const progress = frame >= 70 ? 1 : rawProgress;

  const opacity = interpolate(frame, [delay, delay + 8], [0, 1], clamp);

  // After landing, every voxel keeps a tiny ±1.2px breathing offset; the phase
  // comes from its grid position so neighbours never move in lockstep.
  const breathFade = interpolate(frame, [70, 84], [0, 1], clamp);
  const breath =
    Math.sin(((frame - 70) / 40) * Math.PI * 2 + breathPhase) *
    1.2 *
    breathFade;

  const style = CELL_STYLES[type];

  const tx = (1 - progress) * (startX - finalX);
  const ty = (1 - progress) * (startY - finalY) + breath;
  const rotation = (1 - progress) * startRotation;
  const scale = startScale + (1 - startScale) * progress;
  const inner = FISH_CELL_SIZE - 2;

  return (
    <div
      style={{
        position: 'absolute',
        left: finalX - FISH_CELL_SIZE / 2,
        top: finalY - FISH_CELL_SIZE / 2,
        width: FISH_CELL_SIZE,
        height: FISH_CELL_SIZE,
        transform: `translate3d(${tx}px, ${ty}px, 0) rotate(${rotation}deg) scale(${scale})`,
        transformOrigin: '50% 50%',
        opacity,
        zIndex: 20 + piece.row,
      }}
    >
      {/* Extruded bottom face, 4px down, gives each voxel physical depth. */}
      <div
        style={{
          position: 'absolute',
          left: 1,
          top: 1,
          width: inner,
          height: inner,
          borderRadius: 7,
          backgroundColor: COLORS.extrusion,
          transform: 'translateY(4px)',
        }}
      />
      {/* Top face: 2px inner stroke + 1px white top highlight. */}
      <div
        style={{
          position: 'absolute',
          left: 1,
          top: 1,
          width: inner,
          height: inner,
          borderRadius: 7,
          backgroundColor: style.fill,
          boxShadow: `inset 0 0 0 2px ${style.innerStroke}`,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 3,
            right: 3,
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

export const HookS0: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // One clean radial pulse. The wrapper is transparent: no border, no shadow,
  // no full-frame overlay (the previous white flash was the grey rectangle bug).
  const pulseScale =
    frame < T.fish.pulseStart
      ? 0.6
      : interpolate(
          frame,
          [T.fish.pulseStart, T.fish.pulseEnd],
          [0.6, 1.7],
          {...clamp, easing: Easing.out(Easing.cubic)},
        );
  const pulseOpacity = interpolate(
    frame,
    [T.fish.pulseStart - 1, T.fish.pulseStart, T.fish.pulseEnd],
    [0, 0.85, 0],
    {...clamp, easing: Easing.out(Easing.quad)},
  );

  // Continuous life after the lock-up: slow 1 -> 1.03 growth plus a 1.06 -> 1
  // landing pop on frame 70.
  const growth = interpolate(frame, [70, 143], [1, 1.03], clamp);
  const landingPop =
    frame < 70
      ? 1
      : interpolate(frame, [70, 84], [1.06, 1], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        });
  const fishScale = frame < 70 ? 1 : growth * landingPop;

  const titleSpring = spring({
    fps,
    frame: Math.max(0, frame - T.title.start),
    config: {damping: 13, mass: 0.7, stiffness: 100},
  });
  const titleOpacity = interpolate(titleSpring, [0, 1], [0, 1], clamp);
  const titleY = (1 - titleSpring) * 40;

  const subtitleProgress = interpolate(
    frame,
    [T.subtitle.start, T.subtitle.start + 24],
    [0, 1],
    {...clamp, easing: Easing.out(Easing.cubic)},
  );
  const subtitleY = (1 - subtitleProgress) * 14;

  const captionProgress = interpolate(
    frame,
    [T.caption.start, T.caption.settle],
    [0, 1],
    {...clamp, easing: Easing.out(Easing.cubic)},
  );
  const captionY = (1 - captionProgress) * 16;

  const centerX = HOOK_LAYOUT.fishCenterX;
  const centerY = HOOK_LAYOUT.fishCenterY;

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <AmbientGlow />
      <GridLayer />
      <ParticleField frame={frame} />

      {/* Fish: 112 independently sprung voxels. */}
      <AbsoluteFill
        style={{
          transform: `scale(${fishScale})`,
          transformOrigin: `${centerX}px ${centerY}px`,
        }}
      >
        {FISH_PIECES.map((piece) => (
          <FishPieceView
            key={piece.key}
            piece={piece}
            frame={frame}
            fps={fps}
          />
        ))}
      </AbsoluteFill>

      {/* Halo pulse: a transparent wrapper holding exactly one radial-gradient
          div (scale 0.6 -> 1.7, opacity 0.85 -> 0 over 30 frames). */}
      <AbsoluteFill style={{pointerEvents: 'none', backgroundColor: 'transparent'}}>
        <div
          style={{
            position: 'absolute',
            left: centerX - 700,
            top: centerY - 700,
            width: 1400,
            height: 1400,
            background:
              'radial-gradient(circle, rgba(74,222,128,0.55) 0%, rgba(74,222,128,0.18) 45%, rgba(74,222,128,0) 70%)',
            transform: `scale(${pulseScale})`,
            opacity: pulseOpacity,
          }}
        />
      </AbsoluteFill>

      {/* SFX: one tick per voxel landing, using the same delay/landFrame table
          as the visual. playbackRate varies 0.90–1.15 by block index. */}
      {FISH_PIECES.map((piece, index) => (
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

      {/* Riser: 1.6s, ending on the frame-70 impact (starts at frame 22). */}
      <Sequence from={22} durationInFrames={48}>
        <Audio src={staticFile('audio/sfx/riser.wav')} volume={0.2} />
      </Sequence>

      {/* Frame-70 impact. */}
      <Sequence from={70} durationInFrames={30}>
        <Audio src={staticFile('audio/sfx/thud.wav')} volume={0.35} />
        <Audio src={staticFile('audio/sfx/sparkle.wav')} volume={0.25} />
      </Sequence>

      {/* Title / subtitle */}
      <div
        style={{
          position: 'absolute',
          top: HOOK_LAYOUT.titleTop,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            fontFamily: FONTS.display,
            fontWeight: 700,
            fontSize: 176,
            lineHeight: 1.02,
            letterSpacing: '-0.04em',
            color: COLORS.white,
            textShadow: `0 10px 0 ${COLORS.extrusion}, 0 0 80px rgba(74,222,128,0.18)`,
            transform: `translateY(${titleY}px)`,
            opacity: titleOpacity,
            whiteSpace: 'nowrap',
          }}
        >
          方块鱼
        </div>

        <div
          style={{
            marginTop: 30,
            fontFamily: FONTS.text,
            fontSize: 39,
            fontWeight: 400,
            lineHeight: 1.4,
            letterSpacing: '0.02em',
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

      {/* Burned-in caption capsule, 260px above the bottom edge. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: HOOK_LAYOUT.captionBottom,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '18px 42px',
            borderRadius: 999,
            backgroundColor: 'rgba(5,10,7,0.74)',
            border: '1.5px solid rgba(242,247,242,0.10)',
            boxShadow:
              '0 18px 44px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.06)',
            backdropFilter: 'blur(6px)',
            opacity: captionProgress,
            transform: `translateY(${captionY}px)`,
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              flexShrink: 0,
              borderRadius: 3,
              backgroundColor: COLORS.brand,
              boxShadow: '0 0 14px rgba(74,222,128,0.75)',
            }}
          />
          <span
            style={{
              fontFamily: FONTS.text,
              fontSize: 44,
              fontWeight: 500,
              lineHeight: 1.2,
              color: COLORS.white,
              letterSpacing: '0.01em',
              WebkitTextStroke: '1px rgba(0,0,0,0.55)',
              textShadow: '0 2px 3px rgba(0,0,0,0.5)',
              whiteSpace: 'nowrap',
            }}
          >
            想和朋友一起玩 Minecraft？
          </span>
        </div>
      </div>

      <Vignette />
    </AbsoluteFill>
  );
};
