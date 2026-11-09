import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {Placeholder} from './components/Placeholder';
import {COLORS} from './theme';
import {HookS0} from './scenes/HookS0';

/** Segment map for the 1824-frame / 150 BPM cut. */
export const SEGMENTS = [
  {id: 's0', from: 0, duration: 144, title: 'S0 钩子'},
  {id: 's1', from: 144, duration: 336, title: 'S1 核心流程'},
  {id: 's2', from: 480, duration: 96, title: 'S2 轻量化'},
  {id: 's3', from: 576, duration: 384, title: 'S3 四个功能卡'},
  {id: 's4', from: 960, duration: 576, title: 'S4 AI 段'},
  {id: 's5', from: 1536, duration: 288, title: 'S5 结尾'},
] as const;

export const Promo: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      {/* 150 BPM / 60.8s / exactly 1824 frames. BGM peaks at -0.5dB, so 0.8
          leaves headroom for the hook SFX without clipping. */}
      <Audio src={staticFile('audio/bgm.wav')} volume={0.8} />

      <Sequence
        name="S0 钩子 · 方块鱼拼合"
        from={SEGMENTS[0].from}
        durationInFrames={SEGMENTS[0].duration}
      >
        <HookS0 />
      </Sequence>

      {SEGMENTS.slice(1).map((segment) => (
        <Sequence
          key={segment.id}
          name={segment.title}
          from={segment.from}
          durationInFrames={segment.duration}
        >
          <Placeholder
            title={segment.title}
            from={segment.from}
            duration={segment.duration}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
