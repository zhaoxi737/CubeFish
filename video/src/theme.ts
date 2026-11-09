/**
 * Brand tokens for the CubeFish promo.
 * Colors are copied 1:1 from the launcher brand palette — do not invent new
 * hues for the fish or the background.
 */
export const COLORS = {
  /** Deep ink-green, used as the only background base. */
  background: '#0e1611',
  /** Fish body. */
  body: '#5CB045',
  /** Fish highlight. */
  highlight: '#9CDD6E',
  /** Fish shadow. */
  shadow: '#3A7F2B',
  /** Eye / darkest ink. */
  eye: '#141F0D',
  /** Bottom extrusion layer of every voxel. */
  extrusion: '#26561B',
  /** Primary brand green (accents, particles, glow). */
  brand: '#4ADE80',
  /** Secondary copy. */
  secondary: '#8A9A8E',
  /** Off-white copy. */
  white: '#F2F7F2',
} as const;

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

/** Loaded in src/fonts.ts from public/fonts (Microsoft YaHei, local files). */
export const FONTS = {
  display:
    "'CubeFishDisplay', 'Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  text: "'CubeFishText', 'Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
} as const;

/** Fixed staging values for the 1080x1920 hook. */
export const HOOK_LAYOUT = {
  cellSize: 46,
  /** Fish stage centre: 32% of frame height. */
  fishCenterX: WIDTH / 2,
  fishCenterY: Math.round(HEIGHT * 0.32),
  /** Title block (title + subtitle) is centred on 62% of frame height. */
  titleTop: 1058,
  subtitleTop: 1318,
  /** Caption capsule bottom edge: 260px above the bottom safe area. */
  captionBottom: 260,
} as const;
