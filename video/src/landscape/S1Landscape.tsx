import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {AmbientGlow, GridLayer, Vignette} from '../components/Backdrop';
import {CaptionBar} from '../components/CaptionBar';
import {COLORS} from '../theme';
import {
  clicksInRange,
  cursorAt,
  RECORDINGS,
  type RecordingName,
} from './recEvents';

/**
 * S1 — 144–480 (336 frames / 11.2s), three 112-frame screen-recording beats:
 * home → versions → download. Recordings are real MP4 captures; cursor, click
 * ripples and highlight boxes are drawn from *.events.json.
 */

const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

const CARD = {
  width: 1400,
  height: 800,
  left: (1920 - 1400) / 2,
  top: 25,
};

const SOURCE = {width: 1600, height: 1000};
const COVER_SCALE = Math.max(
  CARD.width / SOURCE.width,
  CARD.height / SOURCE.height,
);
const VIDEO_WIDTH = SOURCE.width * COVER_SCALE;
const VIDEO_HEIGHT = SOURCE.height * COVER_SCALE;
// Anchor the capture to the top of the card so the launcher header is never
// cropped; the footer is the only part lost to the cover crop.
const VIDEO_TOP = 0;
/** Home beat crops to the content-heavy top-left region and zooms 1.25x. */
const HOME_ZOOM = 1.25;

type HighlightBox = {x: number; y: number; w: number; h: number};

type Beat = {
  name: RecordingName;
  /** Source second at which the beat's 3.73s window starts. */
  sourceStart: number;
  /** S1-local frame where the beat starts. */
  segmentStart: number;
  /** S1-local frame where the card mounts. */
  mountAt: number;
  caption: string;
  captionFrom: number;
  captionDuration: number;
  highlights: HighlightBox[];
};

const BEATS: Beat[] = [
  {
    name: 'home',
    sourceStart: 4,
    segmentStart: 0,
    mountAt: 0,
    caption: '一个实例，一套存档、模组、配置',
    captionFrom: 6,
    captionDuration: 101,
    highlights: [{x: 420, y: 506, w: 156, h: 100}],
  },
  {
    name: 'versions',
    sourceStart: 0.435,
    segmentStart: 112,
    mountAt: 112,
    caption: '版本、加载器，随时切换',
    captionFrom: 110,
    captionDuration: 99,
    highlights: [{x: 18, y: 278, w: 1560, h: 36}],
  },
  {
    name: 'download',
    sourceStart: 0.523,
    segmentStart: 224,
    mountAt: 224,
    caption: '选好加载器，点一下它自己下、自己装',
    captionFrom: 212,
    captionDuration: 123,
    highlights: [
      {x: 185, y: 266, w: 158, h: 42},
      {x: 270, y: 145, w: 165, h: 42},
    ],
  },
];

const Cursor: React.FC<{x: number; y: number; opacity: number}> = ({
  x,
  y,
  opacity,
}) => (
  <svg
    width={26}
    height={34}
    viewBox="0 0 26 34"
    style={{
      position: 'absolute',
      left: x - 2,
      top: y - 2,
      zIndex: 40,
      opacity,
      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.55))',
    }}
  >
    <path
      d="M2 2 L2 28 L9 21 L14 32 L19 30 L14 19 L23 19 Z"
      fill={COLORS.white}
      stroke={COLORS.eye}
      strokeWidth={1.6}
      strokeLinejoin="round"
    />
  </svg>
);

const Highlight: React.FC<{
  box: HighlightBox;
  progress: number;
  opacity: number;
  scale: number;
}> = ({box, progress, opacity, scale}) => {
  const w = box.w * scale;
  const h = box.h * scale;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x * scale,
        top: box.y * scale,
        width: w,
        height: h,
        border: '1.5px solid #4ADE80',
        borderRadius: 12,
        backgroundColor: 'transparent',
        opacity: opacity * Math.min(1, progress),
        zIndex: 30,
        pointerEvents: 'none',
      }}
    />
  );
};

const SegmentCard: React.FC<{beat: Beat; index: number}> = ({beat, index}) => {
  const local = useCurrentFrame();
  const {fps} = useVideoConfig();

  const entry = spring({
    fps,
    frame: local,
    config: {damping: 14, mass: 0.7, stiffness: 110},
  });
  const exitStart = 112;
  const exit =
    index === 2
      ? 0
      : interpolate(local, [exitStart, exitStart + 6], [0, 1], {
          ...clamp,
          easing: Easing.inOut(Easing.cubic),
        });

  const opacity = Math.min(1, Math.max(0, entry)) * (1 - exit);
  const scale = (0.92 + 0.08 * entry) * (1 + 0.05 * exit);
  const rotX = 6 * (1 - entry);
  const rotY = -8 * (1 - entry);

  const segmentLocal = local;
  const trimBefore = Math.round(beat.sourceStart * RECORDINGS[beat.name].fps);
  const sourceTime = (trimBefore + local) / RECORDINGS[beat.name].fps;
  const cursor = cursorAt(RECORDINGS[beat.name].events, sourceTime);
  const cursorOpacity = 1;
  const zoom = beat.name === 'home' ? HOME_ZOOM : 1;
  const pointScale = COVER_SCALE * zoom;
  const mapX = (x: number) => x * pointScale;
  const mapY = (y: number) => y * pointScale;

  const highlightOpacity = interpolate(
    segmentLocal,
    [94, 108],
    [1, 0],
    clamp,
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: CARD.left,
        top: CARD.top,
        width: CARD.width,
        height: CARD.height,
        borderRadius: 24,
        border: '1px solid rgba(255,255,255,0.10)',
        background: COLORS.background,
        overflow: 'hidden',
        transform: `perspective(1600px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${scale})`,
        transformOrigin: '50% 50%',
        opacity,
        zIndex: 10 + index,
        boxShadow:
          '0 40px 120px rgba(0,0,0,0.62), 0 0 90px rgba(74,222,128,0.09), inset 0 0 0 1px rgba(255,255,255,0.04)',
      }}
    >
      <OffthreadVideo
        src={staticFile(RECORDINGS[beat.name].src)}
        trimBefore={trimBefore}
        muted
        style={{
          position: 'absolute',
          left: 0,
          top: VIDEO_TOP,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          objectFit: 'cover',
          filter: 'brightness(1.16) contrast(1.10) saturate(1.12)',
          transform: `scale(${zoom})`,
          transformOrigin: '0% 0%',
        }}
      />

      {beat.highlights.map((box, boxIndex) => {
        const start = 22 + boxIndex * 6;
        const draw = interpolate(
          segmentLocal,
          [start, start + 16],
          [0, 1],
          {...clamp, easing: Easing.inOut(Easing.cubic)},
        );
        return (
          <Highlight
            key={`${beat.name}-highlight-${boxIndex}`}
            box={box}
            progress={draw}
            opacity={highlightOpacity}
            scale={pointScale}
          />
        );
      })}

      {/* click ripples, computed from the same events.json timeline */}
      {clicksInRange(
        RECORDINGS[beat.name].events,
        beat.sourceStart,
        beat.sourceStart + 3.75,
      ).map((click, clickIndex) => {
        const clickLocal = (click.t - beat.sourceStart) * 30;
        return [0, 1, 2].map((ring) => {
          const age = segmentLocal - clickLocal - ring * 4;
          if (age < 0 || age > 26) return null;
          const radius = interpolate(age, [0, 26], [6, 56], clamp);
          const ringOpacity = interpolate(age, [0, 26], [0.7, 0], clamp);
          return (
            <div
              key={`${beat.name}-ripple-${clickIndex}-${ring}`}
              style={{
                position: 'absolute',
                left: mapX(click.x) - radius,
                top: mapY(click.y) - radius,
                width: radius * 2,
                height: radius * 2,
                borderRadius: '50%',
                border: `2px solid rgba(74,222,128,${ringOpacity})`,
                zIndex: 38,
                pointerEvents: 'none',
              }}
            />
          );
        });
      })}

      <Cursor
        x={mapX(cursor.x)}
        y={mapY(cursor.y)}
        opacity={cursor.visible ? cursorOpacity : 0}
      />

    </div>
  );
};

export const S1Landscape: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <AmbientGlow x="50%" y="34%" />
      <GridLayer id="s1-grid" />

      {BEATS.map((beat, index) => (
        <Sequence
          key={beat.name}
          from={beat.mountAt}
          durationInFrames={index === 2 ? 336 - beat.mountAt : 118}
        >
          <SegmentCard beat={beat} index={index} />
        </Sequence>
      ))}

      {/* Cursor click SFX from the events table. */}
      {BEATS.flatMap((beat) =>
        clicksInRange(
          RECORDINGS[beat.name].events,
          beat.sourceStart,
          beat.sourceStart + 3.73,
        ).map((click, i) => (
          <Sequence
            key={`click-${beat.name}-${i}`}
            from={beat.segmentStart + Math.round((click.t - beat.sourceStart) * 30)}
            durationInFrames={15}
          >
            <Audio src={staticFile('audio/sfx/click.wav')} volume={0.15} />
          </Sequence>
        )),
      )}

      <Sequence from={0} durationInFrames={20}>
        <Audio src={staticFile('audio/sfx/whoosh.wav')} volume={0.15} />
      </Sequence>

      {BEATS.map((beat) => (
        <Sequence
          key={`caption-${beat.name}`}
          from={beat.captionFrom}
          durationInFrames={beat.captionDuration}
        >
          <CaptionBar text={beat.caption} start={-8} />
        </Sequence>
      ))}

      <Vignette />
    </AbsoluteFill>
  );
};
