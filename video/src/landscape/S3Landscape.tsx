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
import {COLORS, FONTS} from '../theme';
import {FeatureIcon, type FeatureIconName} from './FeatureIcon';

const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

const CARD_WIDTH = 380;
const CARD_HEIGHT = 460;
const CARD_GAP = 40;
const ROW_WIDTH = CARD_WIDTH * 4 + CARD_GAP * 3;
const ROW_LEFT = (1920 - ROW_WIDTH) / 2; // 140
const ROW_TOP = 270; // card row centre y = 500

const CARD_ENTRANCE_STAGGER = 36; // 0, 36, 72, 108 → all in by ~130

const CARDS: {
  title: string;
  description: string;
  icon: FeatureIconName;
}[] = [
  {
    title: '实例隔离',
    description: '每个实例一套 mods、\n存档、配置',
    icon: 'instances',
  },
  {
    title: '双源下载',
    description: 'Modrinth + CurseForge\n一次搜完',
    icon: 'download',
  },
  {
    title: '崩溃归因',
    description: '报错不用自己看日志',
    icon: 'crash',
  },
  {
    title: '插件沙箱',
    description: '插件隔进程跑，\n崩了自动回滚',
    icon: 'sandbox',
  },
];

const CAPTIONS = [
  '每个实例一套 mods、存档、配置',
  'Modrinth + CurseForge 一次搜完',
  '报错不用自己看日志',
  '插件隔进程跑，崩了自动回滚',
];

const STAB_FRAMES = [0, 96, 192, 288];

/** 0..1 highlight for card i, aligned to the caption beat at local 0/96/192/288. */
const highlightAt = (local: number, i: number): number => {
  if (i === 0) {
    return interpolate(local, [0, 96, 102], [1, 1, 0], clamp);
  }
  if (i === 3) {
    return interpolate(local, [288, 294, 384], [0, 1, 1], clamp);
  }
  const start = i * 96;
  const end = start + 96;
  return interpolate(
    local,
    [start, start + 6, end, end + 6],
    [0, 1, 1, 0],
    clamp,
  );
};

const FeatureCard: React.FC<{
  index: number;
  title: string;
  description: string;
  icon: FeatureIconName;
  local: number;
  fps: number;
}> = ({index, title, description, icon, local, fps}) => {
  const delay = index * CARD_ENTRANCE_STAGGER;
  const entry = spring({
    fps,
    frame: Math.max(0, local - delay),
    config: {damping: 14, mass: 0.7, stiffness: 110},
  });
  const entryOpacity = interpolate(entry, [0, 0.35], [0, 1], clamp);
  const highlight = highlightAt(local, index);

  const opacity = entryOpacity * (0.62 + 0.38 * highlight);
  const scale = (0.92 + 0.08 * entry) * (0.97 + 0.03 * highlight);
  const translateY = (1 - entry) * 80;

  return (
    <div
      style={{
        position: 'relative',
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        borderRadius: 24,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow:
          'inset 0 0 46px rgba(74,222,128,0.055), 0 24px 60px rgba(0,0,0,0.35)',
        overflow: 'hidden',
        opacity,
        transform: `translateY(${translateY}px) scale(${scale})`,
        transformOrigin: '50% 50%',
      }}
    >
      {/* Card-top 12-column pixel flip wipe, staggered 2 frames per column. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: 22,
          display: 'flex',
          gap: 2,
          padding: '0 1px',
          zIndex: 4,
        }}
      >
        {Array.from({length: 12}, (_, col) => {
          const start = delay + 4 + col * 2;
          const wipeIn = interpolate(local, [start, start + 7], [0, 1], {
            ...clamp,
            easing: Easing.out(Easing.cubic),
          });
          const wipeOut = interpolate(
            local,
            [delay + 30, delay + 42],
            [1, 0],
            clamp,
          );
          const scaleY = wipeIn * wipeOut;
          return (
            <div
              key={`wipe-${col}`}
              style={{
                flex: 1,
                height: 22,
                borderRadius: '0 0 3px 3px',
                backgroundColor: COLORS.brand,
                opacity: 0.9,
                transform: `scaleY(${scaleY})`,
                transformOrigin: '50% 0%',
              }}
            />
          );
        })}
      </div>

      {/* Active-card green ring (1.5px) layered over the base 1px border. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 24,
          border: '1.5px solid rgba(74,222,128,1)',
          opacity: highlight,
          boxShadow:
            '0 0 44px rgba(74,222,128,0.2), inset 0 0 46px rgba(74,222,128,0.1)',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'relative',
          height: '100%',
          padding: '40px 38px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: 24,
            backgroundColor: 'rgba(74,222,128,0.075)',
            border: '1px solid rgba(74,222,128,0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'inset 0 0 24px rgba(74,222,128,0.08)',
          }}
        >
          <FeatureIcon name={icon} />
        </div>

        <div
          style={{
            marginTop: 30,
            fontFamily: FONTS.display,
            fontWeight: 700,
            fontSize: 34,
            lineHeight: 1.2,
            letterSpacing: '-0.01em',
            color: COLORS.white,
            textShadow: `0 0 18px rgba(74,222,128,${(0.4 * highlight).toFixed(3)})`,
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>

        <div
          style={{
            marginTop: 16,
            width: 300,
            fontFamily: FONTS.text,
            fontWeight: 400,
            fontSize: 24,
            lineHeight: 1.55,
            color: COLORS.secondary,
            whiteSpace: 'pre-line',
          }}
        >
          {description}
        </div>

        <div
          style={{
            position: 'absolute',
            left: 40,
            bottom: 30,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            style={{
              width: 34,
              height: 2,
              borderRadius: 1,
              backgroundColor: COLORS.brand,
              opacity: 0.55,
            }}
          />
          <span
            style={{
              fontFamily: FONTS.text,
              fontSize: 18,
              letterSpacing: '0.18em',
              color: 'rgba(242,247,242,0.28)',
            }}
          >
            0{index + 1}
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * S3 — 576–960 (384 frames / 12.8s). Four cards enter between local 0–130 and
 * then stay fixed; only the card matching the current caption is highlighted.
 */
export const S3Landscape: React.FC = () => {
  const local = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <AmbientGlow x="50%" y="46%" />
      <GridLayer id="s3-grid" />

      <div
        style={{
          position: 'absolute',
          left: ROW_LEFT,
          top: ROW_TOP,
          width: ROW_WIDTH,
          height: CARD_HEIGHT,
          display: 'flex',
          gap: CARD_GAP,
        }}
      >
        {CARDS.map((card, i) => (
          <FeatureCard
            key={card.title}
            index={i}
            title={card.title}
            description={card.description}
            icon={card.icon}
            local={local}
            fps={fps}
          />
        ))}
      </div>

      {/* One caption per 96-frame card beat; captions cut on the beat. */}
      {CAPTIONS.map((text, i) => (
        <Sequence key={text} from={i * 96} durationInFrames={96}>
          <CaptionBar text={text} start={-8} />
        </Sequence>
      ))}

      {/* Very light stab on every card beat (BGM already has a stab). */}
      {STAB_FRAMES.map((from) => (
        <Sequence key={`stab-${from}`} from={from} durationInFrames={20}>
          <Audio src={staticFile('audio/sfx/stab.wav')} volume={0.12} />
        </Sequence>
      ))}

      <Vignette />
    </AbsoluteFill>
  );
};
