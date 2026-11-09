import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Freeze,
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
import {COLORS, FONTS} from '../theme';

/**
 * S4 — 960–1536 (576 frames / 19.2s), five fast AI beats with a common
 * language: cropped screen-recording + code-drawn information layer.
 */

const clamp = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

const CARD = {left: 210, top: 40, width: 1500, height: 840};
const VIDEO_W = 1500;
const VIDEO_H = 937.5;
const VIDEO_TOP = (CARD.height - VIDEO_H) / 2;

const ScreenCard: React.FC<{
  name: 'ai' | 'logs';
  trimBefore: number;
  playbackRate?: number;
  freeze?: boolean;
  transform?: string;
  veil?: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({name, trimBefore, playbackRate, freeze, transform, veil = 0, children, style}) => (
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
      boxShadow:
        '0 40px 120px rgba(0,0,0,0.62), 0 0 90px rgba(74,222,128,0.08), inset 0 0 0 1px rgba(255,255,255,0.04)',
      ...style,
    }}
  >
    <div
      style={{
        position: 'absolute',
        inset: 0,
        transform,
        transformOrigin: '62% 50%',
      }}
    >
      {(() => {
        const video = (
          <OffthreadVideo
            src={staticFile(`rec/${name}.mp4`)}
            trimBefore={trimBefore}
            playbackRate={playbackRate}
            muted
            style={{
              position: 'absolute',
              left: 0,
              top: VIDEO_TOP,
              width: VIDEO_W,
              height: VIDEO_H,
              objectFit: 'cover',
            }}
          />
        );
        return freeze ? <Freeze frame={0}>{video}</Freeze> : video;
      })()}
    </div>
    {veil > 0 ? (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: `rgba(8,14,10,${veil})`,
        }}
      />
    ) : null}
    {children}
  </div>
);

const UserBubble: React.FC<{local: number}> = ({local}) => {
  const {fps} = useVideoConfig();
  const enter = spring({
    fps,
    frame: Math.max(0, local - 38),
    config: {damping: 14, mass: 0.7, stiffness: 130},
  });
  const opacity = interpolate(enter, [0, 0.35], [0, 1], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: 520,
        top: 286,
        maxWidth: 360,
        padding: '14px 20px',
        borderRadius: '16px 16px 4px 16px',
        backgroundColor: '#2f6fed',
        boxShadow: '0 14px 34px rgba(0,0,0,0.38)',
        color: COLORS.white,
        fontFamily: FONTS.text,
        fontSize: 22,
        lineHeight: 1.35,
        opacity,
        transform: `translateY(${(1 - enter) * 12}px)`,
        zIndex: 19,
      }}
    >
      帮我装个钠优化
    </div>
  );
};

const ToolToast: React.FC<{local: number}> = ({local}) => {
  const {fps} = useVideoConfig();
  const enter = spring({
    fps,
    frame: Math.max(0, local - 96),
    config: {damping: 14, mass: 0.7, stiffness: 120},
  });
  const opacity = interpolate(enter, [0, 0.4], [0, 1], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        left: 520,
        top: 390,
        width: 500,
        padding: '20px 24px',
        borderRadius: 18,
        background: 'rgba(9,17,12,0.92)',
        border: '1px solid rgba(74,222,128,0.42)',
        boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
        opacity,
        transform: `translateX(${(1 - enter) * 40}px)`,
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontFamily: FONTS.text,
          color: COLORS.brand,
          fontSize: 24,
          fontWeight: 700,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            width: 30,
            height: 30,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 9,
            backgroundColor: 'rgba(74,222,128,0.16)',
            fontSize: 22,
          }}
        >
          →
        </span>
        调用 search_mods
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: FONTS.text,
          color: COLORS.secondary,
          fontSize: 20,
        }}
      >
        在 3 个来源里找到 3 个优化模组
      </div>
    </div>
  );
};

const Scene1: React.FC = () => {
  const local = useCurrentFrame();
  return (
    <AbsoluteFill>
      <ScreenCard
        name="ai"
        trimBefore={30}
        playbackRate={1.25}
        transform="translate(-40px, 12px) scale(1.17)"
      >
        <div
          style={{
            position: 'absolute',
            left: 24,
            top: 22,
            padding: '8px 14px',
            borderRadius: 999,
            background: 'rgba(8,14,10,0.7)',
            border: '1px solid rgba(74,222,128,0.25)',
            color: COLORS.brand,
            fontFamily: FONTS.text,
            fontSize: 18,
            letterSpacing: '0.06em',
          }}
        >
          AI 助手 · 工具调用
        </div>
        <UserBubble local={local} />
        <ToolToast local={local} />
      </ScreenCard>
    </AbsoluteFill>
  );
};

const Scene2: React.FC = () => {
  const local = useCurrentFrame();
  const {fps} = useVideoConfig();
  const label = spring({
    fps,
    frame: Math.max(0, local - 42),
    config: {damping: 14, mass: 0.7, stiffness: 110},
  });

  return (
    <AbsoluteFill>
      <ScreenCard name="logs" trimBefore={150} freeze>
        {/* Error row (source y≈270) */}
        <div
          style={{
            position: 'absolute',
            left: 30,
            top: 392,
            width: 1420,
            height: 30,
            backgroundColor: 'rgba(255,92,92,0.10)',
            border: '1.5px solid #ff5c5c',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 1040,
            top: 300,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '16px 24px',
            borderRadius: 16,
            background: 'rgba(9,17,12,0.94)',
            border: '1px solid rgba(74,222,128,0.5)',
            boxShadow: '0 22px 60px rgba(0,0,0,0.5)',
            opacity: label,
            transform: `translateY(${(1 - label) * 18}px)`,
            zIndex: 20,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              backgroundColor: COLORS.brand,
              boxShadow: '0 0 14px rgba(74,222,128,0.8)',
            }}
          />
          <span
            style={{
              fontFamily: FONTS.text,
              fontSize: 26,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            定位：Iris 旧版本残留
          </span>
        </div>
      </ScreenCard>
    </AbsoluteFill>
  );
};

const CODE_LINES = [
  'export default function sodiumPlugin(ctx) {',
  "  ctx.tools.register('search_mods');",
  "  const mod = await ctx.mods.find('sodium');",
  '  return ctx.mods.install(mod);',
  '}',
];

const Scene3: React.FC = () => {
  const local = useCurrentFrame();
  const code = CODE_LINES.join('\n');
  const typed = Math.floor(
    Math.max(0, local - 22) * 2.3,
  );
  const shown = code.slice(0, Math.min(code.length, typed));

  const fly = interpolate(local, [96, 114], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const chipX = 430 + (1250 - 430) * fly;
  const chipY = 380 + (100 - 380) * fly;

  return (
    <AbsoluteFill>
      {/* right: zoomed AI drawer */}
      <div
        style={{
          position: 'absolute',
          left: 980,
          top: 80,
          width: 760,
          height: 780,
          borderRadius: 24,
          border: '1px solid rgba(255,255,255,0.10)',
          overflow: 'hidden',
          background: COLORS.background,
          boxShadow: '0 40px 100px rgba(0,0,0,0.6)',
        }}
      >
        <OffthreadVideo
          src={staticFile('rec/ai.mp4')}
          trimBefore={145}
          muted
          style={{
            position: 'absolute',
            left: -1451,
            top: -300,
            width: 2211,
            height: 1382,
          }}
        />
      </div>

      {/* left: typed plugin code */}
      <div
        style={{
          position: 'absolute',
          left: 150,
          top: 190,
          width: 680,
          height: 420,
          borderRadius: 22,
          background: 'rgba(8,15,11,0.94)',
          border: '1px solid rgba(74,222,128,0.28)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 38,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 18px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor:
                  i === 0 ? 'rgba(255,120,120,0.6)' : 'rgba(74,222,128,0.5)',
              }}
            />
          ))}
          <span
            style={{
              marginLeft: 8,
              fontFamily: 'Consolas, monospace',
              fontSize: 14,
              color: 'rgba(242,247,242,0.45)',
            }}
          >
            sodium-plugin.ts
          </span>
        </div>
        <pre
          style={{
            margin: 0,
            padding: '22px 24px',
            fontFamily: 'Consolas, monospace',
            fontSize: 20,
            lineHeight: 1.7,
            color: '#9CDD6E',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {shown}
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 22,
              marginLeft: 2,
              backgroundColor: COLORS.brand,
              verticalAlign: 'text-bottom',
              opacity: Math.floor(local / 8) % 2 === 0 ? 1 : 0.15,
            }}
          />
        </pre>
      </div>

      {/* "plugin chip" flies to the top bar */}
      <div
        style={{
          position: 'absolute',
          left: chipX,
          top: chipY,
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: COLORS.brand,
          boxShadow: '0 0 28px rgba(74,222,128,0.65)',
          opacity: interpolate(fly, [0, 0.15, 1], [0, 1, 0.9], clamp),
          transform: `scale(${1 - fly * 0.55}) rotate(${fly * 90}deg)`,
          zIndex: 25,
        }}
      />
    </AbsoluteFill>
  );
};

const Branch: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  growth: number;
}> = ({x1, y1, x2, y2, growth}) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  return (
    <div
      style={{
        position: 'absolute',
        left: x1,
        top: y1,
        width: length,
        height: 2,
        borderRadius: 1,
        backgroundColor: COLORS.brand,
        transformOrigin: '0 50%',
        transform: `rotate(${angle}deg) scaleX(${growth})`,
        boxShadow: '0 0 10px rgba(74,222,128,0.45)',
      }}
    />
  );
};

const Dot: React.FC<{x: number; y: number; scale: number}> = ({x, y, scale}) => (
  <div
    style={{
      position: 'absolute',
      left: x - 4,
      top: y - 4,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: COLORS.brand,
      transform: `scale(${scale})`,
      boxShadow: '0 0 12px rgba(74,222,128,0.7)',
    }}
  />
);

const Scene4: React.FC = () => {
  const local = useCurrentFrame();
  const g = (start: number) =>
    interpolate(local, [start, start + 10], [0, 1], {
      ...clamp,
      easing: Easing.out(Easing.cubic),
    });

  return (
    <AbsoluteFill>
      <ScreenCard name="ai" trimBefore={205} veil={0.58}>
        <div
          style={{
            position: 'absolute',
            left: 40,
            top: 30,
            fontFamily: FONTS.text,
            fontSize: 18,
            letterSpacing: '0.18em',
            color: 'rgba(242,247,242,0.5)',
          }}
        >
          MEMORY · PARALLEL SUBAGENTS
        </div>

        <Branch x1={750} y1={520} x2={610} y2={385} growth={g(18)} />
        <Branch x1={750} y1={520} x2={890} y2={385} growth={g(22)} />
        <Branch x1={610} y1={385} x2={520} y2={260} growth={g(30)} />
        <Branch x1={610} y1={385} x2={680} y2={260} growth={g(34)} />
        <Branch x1={890} y1={385} x2={820} y2={260} growth={g(38)} />
        <Branch x1={890} y1={385} x2={980} y2={260} growth={g(42)} />

        <Dot x={750} y={520} scale={g(10)} />
        <Dot x={610} y={385} scale={g(26)} />
        <Dot x={890} y={385} scale={g(26)} />
        <Dot x={520} y={260} scale={g(34)} />
        <Dot x={680} y={260} scale={g(38)} />
        <Dot x={820} y={260} scale={g(42)} />
        <Dot x={980} y={260} scale={g(46)} />

        {[
          {x: 500, y: 230, t: '记忆 A'},
          {x: 660, y: 230, t: '记忆 B'},
          {x: 800, y: 230, t: '子助手 1'},
          {x: 960, y: 230, t: '子助手 2'},
        ].map((label, i) => (
          <div
            key={label.t}
            style={{
              position: 'absolute',
              left: label.x,
              top: label.y,
              fontFamily: FONTS.text,
              fontSize: 18,
              color: i < 2 ? 'rgba(242,247,242,0.65)' : COLORS.brand,
              opacity: g(40 + i * 4),
            }}
          >
            {label.t}
          </div>
        ))}
      </ScreenCard>
    </AbsoluteFill>
  );
};

const Scene5: React.FC = () => {
  const local = useCurrentFrame();
  return (
    <AbsoluteFill>
      <ScreenCard name="ai" trimBefore={255} veil={0.5} transform="scale(1.05)">
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 620,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 20,
            zIndex: 20,
          }}
        >
          {[0, 1, 2, 3, 4].map((i) => {
            const h =
              24 +
              Math.abs(Math.sin(local * 0.4 + i * 0.9)) * 56 *
                interpolate(local, [0, 12], [0, 1], clamp);
            return (
              <div
                key={i}
                style={{
                  width: 26,
                  height: h,
                  borderRadius: 13,
                  background: `linear-gradient(180deg, ${COLORS.brand}, ${COLORS.body})`,
                  boxShadow: '0 0 26px rgba(74,222,128,0.38)',
                }}
              />
            );
          })}
        </div>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 730,
            textAlign: 'center',
            fontFamily: FONTS.text,
            fontSize: 22,
            letterSpacing: '0.16em',
            color: 'rgba(242,247,242,0.55)',
          }}
        >
          VOICE IN · VOICE OUT
        </div>
      </ScreenCard>
    </AbsoluteFill>
  );
};

const WipeOverlay: React.FC = () => {
  const local = useCurrentFrame();
  return (
    <>
      {[120, 240, 360, 480].map((boundary) => {
        const t = local - boundary;
        if (t < -4 || t > 4) return null;
        const cover = t <= 0 ? (t + 4) / 4 : 1 - t / 4;
        return (
          <div
            key={boundary}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 90,
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                backgroundColor: `rgba(9,15,11,${0.72 * cover})`,
              }}
            />
            {Array.from({length: 8}, (_, i) => {
              const s = Math.max(0, cover - i * 0.012);
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: i * 240,
                    top: 0,
                    width: 240,
                    height: 1080,
                    transform: `scaleY(${s})`,
                    transformOrigin: '50% 50%',
                    backgroundColor: '#0e1611',
                    borderLeft: '1px solid rgba(74,222,128,0.18)',
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
};

const CAPTIONS = [
  {text: '说一句「装个钠优化」，它自己找、自己装', from: 4, duration: 112},
  {text: '崩了？它读日志、定位、直接修', from: 124, duration: 112},
  {text: '没有的功能，它自己写插件补上', from: 244, duration: 112},
  {text: '记得住你，也能开子助手并行', from: 364, duration: 112},
  {text: '能听你说话，也能开口', from: 484, duration: 88},
];

export const S4Landscape: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <AmbientGlow x="50%" y="40%" />
      <GridLayer id="s4-grid" />

      <Sequence from={0} durationInFrames={120}>
        <Scene1 />
      </Sequence>
      <Sequence from={120} durationInFrames={120}>
        <Scene2 />
      </Sequence>
      <Sequence from={240} durationInFrames={120}>
        <Scene3 />
      </Sequence>
      <Sequence from={360} durationInFrames={120}>
        <Scene4 />
      </Sequence>
      <Sequence from={480} durationInFrames={96}>
        <Scene5 />
      </Sequence>

      <WipeOverlay />

      {CAPTIONS.map((caption) => (
        <Sequence
          key={caption.text}
          from={caption.from}
          durationInFrames={caption.duration}
        >
          <CaptionBar text={caption.text} start={-8} />
        </Sequence>
      ))}

      <Sequence from={0} durationInFrames={20}>
        <Audio src={staticFile('audio/sfx/riser.wav')} volume={0.18} />
      </Sequence>
      {[120, 240, 360, 480].map((boundary) => (
        <Sequence key={`wipe-${boundary}`} from={boundary} durationInFrames={16}>
          <Audio src={staticFile('audio/sfx/whoosh.wav')} volume={0.12} />
        </Sequence>
      ))}
      {Array.from({length: 30}, (_, i) => {
        const from = 260 + i * 3;
        if (from > 350) return null;
        return (
          <Sequence key={`type-${from}`} from={from} durationInFrames={8}>
            <Audio src={staticFile('audio/sfx/type.wav')} volume={0.1} />
          </Sequence>
        );
      })}

      <Vignette />
    </AbsoluteFill>
  );
};
