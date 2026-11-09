/**
 * Turns the 18x13 FishGrid into the 112 independently animated voxels used by
 * the hook. Everything here is static data: the only time-dependent value is
 * computed later from `frame` inside HookS0.
 *
 * Timing model (see HookS0):
 * - 112 blocks are launched from the outside in, delays spread over 0–43f.
 * - Each block uses a ~27-frame spring, so the last block locks at frame 70.
 * - landFrame is shared with the tick sound effect so audio and visual agree.
 */
import {
  FISH_GRID,
  FISH_GRID_COLS,
  FISH_GRID_ROWS,
  type FishCellType,
} from './FishGrid';
import {hash, hashRange} from './lib/random';
import {COLORS, HEIGHT, HOOK_LAYOUT, WIDTH} from './theme';

export type FishSide = 'left' | 'right' | 'top' | 'bottom';

export type NonEmptyCell = Exclude<FishCellType, 0>;

export interface FishPiece {
  key: string;
  col: number;
  row: number;
  type: NonEmptyCell;
  /** Resting position of the cell centre, in page pixels. */
  finalX: number;
  finalY: number;
  /** Start position, just outside the 1080x1920 frame. */
  startX: number;
  startY: number;
  /** Start rotation in degrees (±90), springs back to 0. */
  startRotation: number;
  /** Frames to wait before this block launches. */
  delay: number;
  /** Frame where the block is considered locked (drives the tick SFX). */
  landFrame: number;
  /** Deterministic stagger phase for the post-landing +-1.2px breathing. */
  breathPhase: number;
  /** Scale the block grows from while flying in. */
  startScale: number;
}

export const FISH_CELL_SIZE = HOOK_LAYOUT.cellSize;
export const FISH_STAGE_WIDTH = FISH_GRID_COLS * FISH_CELL_SIZE;
export const FISH_STAGE_HEIGHT = FISH_GRID_ROWS * FISH_CELL_SIZE;
export const FISH_STAGE_LEFT = HOOK_LAYOUT.fishCenterX - FISH_STAGE_WIDTH / 2;
export const FISH_STAGE_TOP = HOOK_LAYOUT.fishCenterY - FISH_STAGE_HEIGHT / 2;

/** Last launch + 27-frame spring ≈ frame 70. */
export const LAST_LAND_FRAME = 70;
const LAST_LAUNCH = LAST_LAND_FRAME - 27;

/** Per-type fill + 2px inner stroke, using only brand colors. */
export const CELL_STYLES: Record<
  NonEmptyCell,
  {fill: string; innerStroke: string}
> = {
  1: {fill: COLORS.body, innerStroke: COLORS.shadow},
  2: {fill: COLORS.highlight, innerStroke: COLORS.body},
  3: {fill: COLORS.shadow, innerStroke: COLORS.extrusion},
  4: {fill: COLORS.eye, innerStroke: COLORS.extrusion},
};

const SIDES: FishSide[] = ['left', 'right', 'top', 'bottom'];

interface RawCell {
  col: number;
  row: number;
  type: NonEmptyCell;
  finalX: number;
  finalY: number;
  side: FishSide;
  distance: number;
  seed: number;
}

const rawCells: RawCell[] = [];
const gridCenterCol = (FISH_GRID_COLS - 1) / 2;
const gridCenterRow = (FISH_GRID_ROWS - 1) / 2;
const stageCenterX = FISH_STAGE_LEFT + FISH_STAGE_WIDTH / 2;
const stageCenterY = FISH_STAGE_TOP + FISH_STAGE_HEIGHT / 2;

for (let row = 0; row < FISH_GRID_ROWS; row++) {
  for (let col = 0; col < FISH_GRID_COLS; col++) {
    const type = FISH_GRID[row][col];
    if (type === 0) continue;

    const dx = col - gridCenterCol;
    const dy = row - gridCenterRow;
    // Nearest screen edge: dominant axis wins, so the school arrives from all
    // four sides instead of four diagonal corners.
    const side: FishSide =
      Math.abs(dx) >= Math.abs(dy)
        ? dx < 0
          ? 'left'
          : 'right'
        : dy < 0
          ? 'top'
          : 'bottom';

    const finalX = FISH_STAGE_LEFT + col * FISH_CELL_SIZE + FISH_CELL_SIZE / 2;
    const finalY = FISH_STAGE_TOP + row * FISH_CELL_SIZE + FISH_CELL_SIZE / 2;

    rawCells.push({
      col,
      row,
      type,
      finalX,
      finalY,
      side,
      distance: Math.hypot(finalX - stageCenterX, finalY - stageCenterY),
      seed: (row * FISH_GRID_COLS + col) * 97 + 13,
    });
  }
}

// Launch the silhouette from the outside in; the centre cells close the shape
// last, right before the frame-70 pulse.
rawCells.sort((a, b) => b.distance - a.distance || a.seed - b.seed);

const START_OFFSCREEN = 180;
const total = rawCells.length;

export const FISH_PIECES: FishPiece[] = rawCells.map((cell, index) => {
  const {side, seed} = cell;
  const jitterA = hash(seed + 11);
  const jitterB = hash(seed + 29);
  const rotationSign = hash(seed + 41) < 0.5 ? -1 : 1;

  const delay = (index / (total - 1)) * LAST_LAUNCH;

  let startX = cell.finalX;
  let startY = cell.finalY;

  if (side === 'left' || side === 'right') {
    const dir = side === 'left' ? -1 : 1;
    startX =
      (dir < 0 ? -FISH_CELL_SIZE : WIDTH + FISH_CELL_SIZE) +
      dir * jitterA * START_OFFSCREEN;
    startY = cell.finalY + (jitterB - 0.5) * 260;
  } else {
    const dir = side === 'top' ? -1 : 1;
    startY =
      (dir < 0 ? -FISH_CELL_SIZE : HEIGHT + FISH_CELL_SIZE) +
      dir * jitterA * START_OFFSCREEN;
    startX = cell.finalX + (jitterB - 0.5) * 260;
  }

  return {
    key: `${cell.col}-${cell.row}`,
    col: cell.col,
    row: cell.row,
    type: cell.type,
    finalX: cell.finalX,
    finalY: cell.finalY,
    startX,
    startY,
    startRotation: rotationSign * 90,
    delay,
    landFrame: Math.min(
      LAST_LAND_FRAME,
      Math.round(delay + (LAST_LAND_FRAME - LAST_LAUNCH)),
    ),
    // Position-based phase keeps neighbours from breathing in sync.
    breathPhase: (cell.col * 0.65 + cell.row * 1.35) % (Math.PI * 2),
    startScale: hashRange(seed + 53, 0.35, 0.6),
  };
});

/** Left for readability; group starts are no longer used by the radial order. */
export const FISH_SIDES = SIDES;
