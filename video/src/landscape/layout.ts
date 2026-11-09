/** Landscape (1920x1080) staging constants plus the shared caption spec. */
export const LANDSCAPE = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 1824,
  /** Main content must stay inside 1680x900, 120px side safe area. */
  safeInset: 120,
  contentWidth: 1680,
  contentHeight: 900,
  fish: {
    /** 18x13 grid at 30px per voxel ≈ 540x390 stage. */
    cellSize: 30,
    centerX: 740,
    centerY: 510,
  },
  copy: {
    left: 1080,
    /** Title + subtitle block is vertically centred here. */
    centerY: 580,
    titleSize: 140,
    titleLineHeight: 1.08,
    subtitleSize: 40,
    subtitleGap: 28,
  },
  caption: {
    bottom: 90,
    fontSize: 40,
    lineHeight: 1.35,
    radius: 18,
    paddingX: 36,
    paddingY: 18,
  },
} as const;

/** 150 BPM segment map — identical boundaries to the portrait cut. */
export const LANDSCAPE_SEGMENTS = [
  {id: 's0', from: 0, duration: 144, title: 'S0 钩子'},
  {id: 's1', from: 144, duration: 336, title: 'S1 核心流程'},
  {id: 's2', from: 480, duration: 96, title: 'S2 轻量化'},
  {id: 's3', from: 576, duration: 384, title: 'S3 四个功能卡'},
  {id: 's4', from: 960, duration: 576, title: 'S4 AI 段'},
  {id: 's5', from: 1536, duration: 288, title: 'S5 结尾'},
] as const;
