import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {AmbientGlow, GridLayer, Vignette} from '../components/Backdrop';
import {MiniFish} from '../components/MiniFish';
import {COLORS, FONTS} from '../theme';

/**
 * S5 — 1536–1824 (288 frames / 9.6s).
 * 1536–1620: three UI screenshots fly in as 3D cards (left / centre / right)
 * 1620–1700: cards converge and fade, pixel-fish logo pops in with a halo
 * 1700–1824: title + bottom info bar + GitHub line, final 2% push-in
 */

const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

const CARD_W = 520;
const CARD_H = 325;
const CARD_Y = 470;

const SHOTS = [
  {src: 'review/home_a.png', x: 420, side: 'left' as const},
  {src: 'review/versions_b.png', x: 960, side: 'center' as const},
  {src: 'review/download_b.png', x: 1500, side: 'right' as const},
];

const ShotCard: React.FC<{
  local: number;
  index: number;
  shot: (typeof SHOTS)[number];
}> = ({local, index, shot}) => {
  const {fps} = useVideoConfig();
  const enter = spring({
    fps,
    frame: Math.max(0, local + 16 - index * 4),
    config: {damping: 14, mass: 0.7, stiffness: 90},
  });
  const converge = interpolate(local, [84, 164], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });

  const startX =
    shot.side === 'left' ? -CARD_W - 80 : shot.side === 'right' ? 1920 + 80 : 960;
  const baseX = startX + (shot.x - startX) * enter;
  const x = baseX + (960 - baseX) * converge;
  const y = CARD_Y + (shot.side === 'center' ? (1 - enter) * 140 : 0) + 120 * converge;
  const scale = (0.86 + 0.14 * enter) * (1 - 0.4 * converge);
  const rotateY =
    shot.side === 'left'
      ? 18 * (1 - enter)
      : shot.side === 'right'
        ? -18 * (1 - enter)
        : 0;
  const rotateX = shot.side === 'center' ? 6 * (1 - enter) : 0;
  const opacity = Math.min(1, Math.max(0, enter)) * (1 - converge);

  return (
    <div
      style={{
        position: 'absolute',
        left: x - CARD_W / 2,
        top: y - CARD_H / 2,
        width: CARD_W,
        height: CARD_H,
        borderRadius: 18,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.14)',
        background: '#0b120d',
        opacity,
        transform: `perspective(1400px) rotateY(${rotateY}deg) rotateX(${rotateX}deg) scale(${scale})`,
        transformOrigin: '50% 50%',
        boxShadow:
          '0 30px 80px rgba(0,0,0,0.6), 0 0 60px rgba(74,222,128,0.08)',
      }}
    >
      <Img
        src={staticFile(shot.src)}
        style={{width: '100%', height: '100%', objectFit: 'cover'}}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(14,22,17,0) 55%, rgba(14,22,17,0.38) 100%)',
        }}
      />
    </div>
  );
};

export const S5Landscape: React.FC = () => {
  const local = useCurrentFrame();
  const {fps} = useVideoConfig();

  const logoIn = spring({
    fps,
    frame: Math.max(0, local - 84),
    config: {damping: 11, mass: 0.7, stiffness: 100},
  });
  const logoScale = 0.3 + 0.7 * logoIn;
  const logoOpacity = interpolate(local, [84, 92], [0, 1], clamp);

  const pulseScale =
    local < 84
      ? 0.6
      : interpolate(local, [84, 114], [0.6, 1.6], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        });
  const pulseOpacity = interpolate(local, [83, 84, 114], [0, 0.8, 0], {
    ...clamp,
    easing: Easing.out(Easing.quad),
  });

  const titleIn = spring({
    fps,
    frame: Math.max(0, local - 164),
    config: {damping: 14, mass: 0.7, stiffness: 100},
  });
  const titleOpacity = interpolate(titleIn, [0, 1], [0, 1], clamp);
  const titleY = (1 - titleIn) * 26;

  const infoOpacity = interpolate(local, [164, 184], [0, 1], clamp);
  const githubOpacity = interpolate(local, [228, 244], [0, 1], clamp);
  const finalScale = interpolate(local, [268, 288], [1, 1.02], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <AmbientGlow x="50%" y="38%" />
      <GridLayer id="s5-grid" />

      {SHOTS.map((shot, index) => (
        <ShotCard key={shot.src} local={local} index={index} shot={shot} />
      ))}

      <AbsoluteFill
        style={{
          transform: `scale(${finalScale})`,
          transformOrigin: '50% 45%',
        }}
      >
        {/* logo halo */}
        <div
          style={{
            position: 'absolute',
            left: 960 - 700,
            top: 380 - 700,
            width: 1400,
            height: 1400,
            borderRadius: '50%',
            background:
              'radial-gradient(circle, rgba(74,222,128,0.55) 0%, rgba(74,222,128,0.18) 42%, rgba(74,222,128,0) 70%)',
            transform: `scale(${pulseScale})`,
            opacity: pulseOpacity,
            pointerEvents: 'none',
          }}
        />

        <div
          style={{
            position: 'absolute',
            left: 960 - 216,
            top: 380 - 156,
            transform: `scale(${logoScale})`,
            opacity: logoOpacity,
            transformOrigin: '50% 50%',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 6,
              opacity: 0.9,
            }}
          >
            <MiniFish
              cellSize={24}
              palette={{
                1: COLORS.extrusion,
                2: COLORS.extrusion,
                3: COLORS.extrusion,
                4: COLORS.extrusion,
              }}
            />
          </div>
          <div style={{position: 'relative'}}>
            <MiniFish cellSize={24} radius={0} />
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 562,
            textAlign: 'center',
            fontFamily: FONTS.display,
            fontWeight: 700,
            fontSize: 110,
            lineHeight: 1.05,
            letterSpacing: '-0.04em',
            color: COLORS.white,
            textShadow: `4px 4px 0 ${COLORS.extrusion}, 0 0 90px rgba(74,222,128,0.18)`,
            opacity: titleOpacity,
            transform: `translateY(${titleY}px)`,
          }}
        >
          方块鱼
        </div>
      </AbsoluteFill>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 70,
          textAlign: 'center',
          fontFamily: FONTS.text,
          fontSize: 30,
          letterSpacing: '0.02em',
          color: COLORS.secondary,
          opacity: infoOpacity,
        }}
      >
        免费开源 · GPL-3.0 · Windows 10/11 · v0.2.0
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 112,
          textAlign: 'center',
          fontFamily: FONTS.text,
          fontSize: 28,
          letterSpacing: '0.02em',
          color: COLORS.brand,
          opacity: githubOpacity,
        }}
      >
        github.com/zhaoxi737/CubeFish
      </div>

      <Sequence from={0} durationInFrames={20}>
        <Audio src={staticFile('audio/sfx/hit.wav')} volume={0.3} />
      </Sequence>
      <Sequence from={84} durationInFrames={24}>
        <Audio src={staticFile('audio/sfx/sparkle.wav')} volume={0.2} />
      </Sequence>

      <Vignette />
    </AbsoluteFill>
  );
};
