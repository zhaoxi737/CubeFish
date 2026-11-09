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
import {MiniFish} from '../components/MiniFish';
import {COLORS, FONTS} from '../theme';

/**
 * S2 — 480–576 (96 frames / 3.2s), "一个压缩包就够了".
 * All artwork is CSS/SVG; nothing is a bitmap.
 */

const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

const ZIP = {x: 680, y: 500, w: 248, h: 300};
const EXE = {x: 1300, y: 470, size: 170};
const FILE_COUNT = 7;
const FILE_SIZE = {w: 58, h: 68};

const dashedLineFrom = 820;
const dashedLineTo = 1110;

const fileTarget = (i: number) => ({
  x: 1160,
  y: 320 + i * 60,
});

const fileIndexLabel = (i: number) =>
  ['mods', 'saves', 'config', 'jar', 'cfg', 'log', 'dat'][i] ?? 'file';

export const S2Landscape: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // 0–24: archive drops in from below.
  const zipIn = spring({
    fps,
    frame,
    config: {damping: 14, mass: 0.7, stiffness: 120},
  });
  const zipScale = interpolate(zipIn, [0, 1], [0.75, 1]);
  const zipY = (1 - zipIn) * 60;
  const zipOpacity = interpolate(frame, [0, 8], [0, 1], clamp);

  // 12–36: zipper dashes vanish top→bottom, lid flips open.
  const open = interpolate(frame, [12, 36], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const lidRotation = -78 * open;
  const lidLift = -10 * open;

  // 56–76: files merge into the exe.
  const exeIn = spring({
    fps,
    frame: Math.max(0, frame - 56),
    config: {damping: 11, mass: 0.6, stiffness: 130},
  });
  const exeScale = interpolate(exeIn, [0, 1], [0.55, 1]);
  const exeOpacity = interpolate(frame, [56, 63], [0, 1], clamp);

  // 72–96: idle float + glow breathing.
  const idleFade = interpolate(frame, [72, 82], [0, 1], clamp);
  const exeFloat = Math.sin((frame - 72) * 0.12) * 4 * idleFade;
  const glowPulse = 0.36 + 0.14 * Math.sin((frame - 72) * 0.16);

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <AmbientGlow x="52%" y="47%" />
      <GridLayer id="s2-grid" />

      {/* Subtle narrative track between the archive and the executable. */}
      <div
        style={{
          position: 'absolute',
          left: dashedLineFrom,
          top: ZIP.y - 1,
          width: dashedLineTo - dashedLineFrom,
          borderTop: '2px dashed rgba(74,222,128,0.18)',
          opacity: interpolate(frame, [8, 28], [0, 1], clamp),
        }}
      />

      {/* ---------------- ZIP archive (left) ---------------- */}
      <div
        style={{
          position: 'absolute',
          left: ZIP.x - ZIP.w / 2,
          top: ZIP.y - ZIP.h / 2,
          width: ZIP.w,
          height: ZIP.h,
          transform: `translateY(${zipY}px) scale(${zipScale})`,
          opacity: zipOpacity,
        }}
      >
        {/* body */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 24,
            background: 'linear-gradient(160deg, #1c2f22 0%, #0d1711 100%)',
            border: '1px solid rgba(255,255,255,0.14)',
            boxShadow:
              '0 30px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
        />
        {/* interior glow revealed by the lid */}
        <div
          style={{
            position: 'absolute',
            left: 18,
            right: 18,
            top: 18,
            height: 150,
            borderRadius: 18,
            background:
              'radial-gradient(ellipse at 50% 100%, rgba(74,222,128,0.38), rgba(74,222,128,0) 70%)',
            opacity: open,
          }}
        />
        {/* zipper dashes, disappearing from top to bottom */}
        {Array.from({length: 8}, (_, i) => {
          const dashStart = 12 + i * 2.2;
          const hide = interpolate(
            frame,
            [dashStart, dashStart + 4],
            [1, 0],
            clamp,
          );
          return (
            <div
              key={`zip-dash-${i}`}
              style={{
                position: 'absolute',
                left: ZIP.w / 2 - 2,
                top: 152 + i * 17,
                width: 4,
                height: 12,
                borderRadius: 2,
                backgroundColor: 'rgba(242,247,242,0.55)',
                opacity: hide,
                transform: `scaleY(${hide})`,
              }}
            />
          );
        })}
        {/* zipper pull */}
        <div
          style={{
            position: 'absolute',
            left: ZIP.w / 2 - 13,
            top: 282,
            width: 26,
            height: 14,
            borderRadius: 6,
            border: '2px solid rgba(242,247,242,0.45)',
            opacity: 1 - open * 0.8,
          }}
        />
        {/* lid, flips open around its bottom edge */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: ZIP.w,
            height: 146,
            borderRadius: '22px 22px 8px 8px',
            background: 'linear-gradient(160deg, #294233 0%, #16251b 100%)',
            border: '1px solid rgba(255,255,255,0.16)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
            transformOrigin: '50% 100%',
            transform: `perspective(900px) rotateX(${lidRotation}deg) translateY(${lidLift}px)`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 24,
              top: 24,
              fontFamily: FONTS.display,
              fontWeight: 700,
              fontSize: 24,
              letterSpacing: '0.22em',
              color: 'rgba(242,247,242,0.55)',
            }}
          >
            ZIP
          </div>
          <div
            style={{
              position: 'absolute',
              left: 22,
              bottom: 18,
              width: 70,
              height: 4,
              borderRadius: 2,
              backgroundColor: COLORS.brand,
              opacity: 0.8,
            }}
          />
        </div>

        <div
          style={{
            position: 'absolute',
            top: ZIP.h + 24,
            left: 0,
            width: ZIP.w,
            textAlign: 'center',
            fontFamily: FONTS.display,
            fontWeight: 700,
            fontSize: 24,
            letterSpacing: '0.03em',
            color: 'rgba(242,247,242,0.62)',
          }}
        >
          CubeFish.zip
        </div>
      </div>

      {/* ---------------- Files (arc into a column) ---------------- */}
      {Array.from({length: FILE_COUNT}, (_, i) => {
        const delay = 30 + i * 1.5;
        const fileIn = spring({
          fps,
          frame: Math.max(0, frame - delay),
          config: {damping: 14, mass: 0.7, stiffness: 80},
        });
        const target = fileTarget(i);
        const sx = ZIP.x;
        const sy = ZIP.y - 20;
        const cx = 960;
        const cy = Math.min(sy, target.y) - 130 - i * 6;

        const bx =
          Math.pow(1 - fileIn, 2) * sx +
          2 * (1 - fileIn) * fileIn * cx +
          Math.pow(fileIn, 2) * target.x;
        const by =
          Math.pow(1 - fileIn, 2) * sy +
          2 * (1 - fileIn) * fileIn * cy +
          Math.pow(fileIn, 2) * target.y;

        const mergeStart = 56 + i * 0.8;
        const merge = interpolate(
          frame,
          [mergeStart, mergeStart + 16],
          [0, 1],
          {...clamp, easing: Easing.inOut(Easing.cubic)},
        );

        const x = bx + (EXE.x - bx) * merge;
        const y = by + (EXE.y - by) * merge;
        const scale = (0.5 + 0.5 * fileIn) * (1 - merge * 0.8);
        const rotate =
          (1 - fileIn) * ((i % 2 === 0 ? -1 : 1) * (18 + i * 2)) +
          merge * 90;
        const fileOpacity =
          interpolate(frame, [delay, delay + 5], [0, 1], clamp) *
          (1 - merge * 0.95);

        return (
          <div
            key={`file-${i}`}
            style={{
              position: 'absolute',
              left: x - FILE_SIZE.w / 2,
              top: y - FILE_SIZE.h / 2,
              width: FILE_SIZE.w,
              height: FILE_SIZE.h,
              borderRadius: 9,
              backgroundColor: '#E6F0E2',
              border: '1px solid rgba(20,31,13,0.35)',
              boxShadow: '0 14px 30px rgba(0,0,0,0.4)',
              transform: `rotate(${rotate}deg) scale(${scale})`,
              opacity: fileOpacity,
              overflow: 'hidden',
              zIndex: 6,
            }}
          >
            <div
              style={{
                height: 12,
                backgroundColor: COLORS.body,
                opacity: 0.9,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 9,
                top: 22,
                right: 9,
                fontFamily: FONTS.text,
                fontSize: 10,
                lineHeight: '11px',
                color: '#1a2a1e',
                fontWeight: 700,
                letterSpacing: '0.02em',
              }}
            >
              {fileIndexLabel(i)}
            </div>
            {[0, 1, 2].map((line) => (
              <div
                key={line}
                style={{
                  position: 'absolute',
                  left: 9,
                  right: 12 - line * 6,
                  top: 40 + line * 8,
                  height: 2,
                  borderRadius: 1,
                  backgroundColor: 'rgba(20,31,13,0.28)',
                }}
              />
            ))}
          </div>
        );
      })}

      {/* ---------------- CubeFish.exe (right) ---------------- */}
      <div
        style={{
          position: 'absolute',
          left: EXE.x - EXE.size / 2,
          top: EXE.y - EXE.size / 2,
          width: EXE.size,
          height: EXE.size,
          transform: `translateY(${exeFloat}px) scale(${exeScale})`,
          opacity: exeOpacity,
        }}
      >
        {/* breathing glow behind the executable */}
        <div
          style={{
            position: 'absolute',
            left: -130,
            top: -130,
            width: EXE.size + 260,
            height: EXE.size + 260,
            borderRadius: '50%',
            background:
              'radial-gradient(circle, rgba(74,222,128,0.34) 0%, rgba(74,222,128,0.12) 42%, rgba(74,222,128,0) 70%)',
            opacity: glowPulse,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 22,
            background: 'linear-gradient(145deg, #5CB045 0%, #26561B 100%)',
            border: '2px solid rgba(156,221,110,0.65)',
            boxShadow:
              '0 24px 55px rgba(0,0,0,0.55), 0 8px 18px rgba(0,0,0,0.4), inset 0 2px 0 rgba(255,255,255,0.24), inset 0 -10px 18px rgba(0,0,0,0.22)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 6,
              right: 6,
              top: 5,
              height: '42%',
              borderRadius: '14px 14px 48% 48%',
              background:
                'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.03) 60%, rgba(255,255,255,0) 100%)',
              pointerEvents: 'none',
            }}
          />
          <MiniFish
            cellSize={6}
            palette={{
              1: '#0e1611',
              2: '#26561B',
              3: '#0e1611',
              4: '#F2F7F2',
            }}
          />
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          top: EXE.y + EXE.size / 2 + 22,
          left: EXE.x - 160,
          width: 320,
          textAlign: 'center',
          fontFamily: FONTS.display,
          fontWeight: 700,
          fontSize: 26,
          letterSpacing: '0.02em',
          color: COLORS.white,
          opacity: interpolate(frame, [78, 86], [0, 1], clamp),
        }}
      >
        CubeFish.exe
      </div>

      <Sequence from={0} durationInFrames={20}>
        <Audio src={staticFile('audio/sfx/whoosh.wav')} volume={0.15} />
      </Sequence>
      <Sequence from={56} durationInFrames={30}>
        <Audio src={staticFile('audio/sfx/thud.wav')} volume={0.25} />
        <Audio src={staticFile('audio/sfx/sparkle.wav')} volume={0.2} />
      </Sequence>

      <CaptionBar text="一个压缩包，双击就跑" start={0} />
      <Vignette />
    </AbsoluteFill>
  );
};
