import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {COLORS, FPS} from './theme';
import {LANDSCAPE} from './landscape/layout';
import {S0Landscape} from './landscape/S0Landscape';
import {S1Landscape} from './landscape/S1Landscape';
import {S2Landscape} from './landscape/S2Landscape';
import {S3Landscape} from './landscape/S3Landscape';
import {S4Landscape} from './landscape/S4Landscape';
import {S5Landscape} from './landscape/S5Landscape';

/**
 * 1920x1080 master cut: S0 hook, S1 workflow, S2 portability, S3 features,
 * S4 AI, S5 outro.
 */
export const PromoLandscape: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: COLORS.background}}>
      <Audio src={staticFile('audio/bgm.wav')} volume={0.8} />

      <Sequence name="S0 钩子 · 方块鱼拼合" from={0} durationInFrames={144}>
        <S0Landscape />
      </Sequence>

      <Sequence name="S1 核心流程" from={144} durationInFrames={336}>
        <S1Landscape />
      </Sequence>

      <Sequence name="S2 轻量化" from={480} durationInFrames={96}>
        <S2Landscape />
      </Sequence>

      <Sequence name="S3 四个功能卡" from={576} durationInFrames={384}>
        <S3Landscape />
      </Sequence>

      <Sequence name="S4 AI 段" from={960} durationInFrames={576}>
        <S4Landscape />
      </Sequence>

      <Sequence name="S5 结尾" from={1536} durationInFrames={288}>
        <S5Landscape />
      </Sequence>
    </AbsoluteFill>
  );
};

export const LANDSCAPE_COMPOSITION = {
  id: 'Promo1920x1080',
  component: PromoLandscape,
  durationInFrames: LANDSCAPE.durationInFrames,
  fps: FPS,
  width: LANDSCAPE.width,
  height: LANDSCAPE.height,
} as const;
