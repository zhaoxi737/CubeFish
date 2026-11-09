/**
 * Landscape rebuild of the 18x13 voxel fish for the 1920x1080 hook.
 *
 * Same 112 blocks, same radial "outside-in" launch order, same 0–43f delays and
 * 70-frame lock as the portrait cut — only the grid scale (30px) and stage
 * centre (740, 470) change.
 */
import {
  FISH_GRID,
  FISH_GRID_COLS,
  FISH_GRID_ROWS,
  type FishCellType,
} from '../FishGrid';
import type {FishPiece} from '../fishPieces';
import {hash, hashRange} from '../lib/random';
import {LANDSCAPE} from './layout';

export type LandscapeSide = 'left' | 'right' | 'top' | 'bottom';
type NonEmptyCell = Exclude<FishCellType, 0>;

export const LANDSCAPE_CELL_SIZE = LANDSCAPE.fish.cellSize;
export const LANDSCAPE_STAGE_WIDTH = FISH_GRID_COLS * LANDSCAPE_CELL_SIZE;
export const LANDSCAPE_STAGE_HEIGHT = FISH_GRID_ROWS * LANDSCAPE_CELL_SIZE;
export const LANDSCAPE_STAGE_LEFT =
  LANDSCAPE.fish.centerX - LANDSCAPE_STAGE_WIDTH / 2;
export const LANDSCAPE_STAGE_TOP =
  LANDSCAPE.fish.centerY - LANDSCAPE_STAGE_HEIGHT / 2;

const LAST_LAND_FRAME = 70;
const LAST_LAUNCH = LAST_LAND_FRAME - 27;
const START_OFFSCREEN = 220;

interface RawCell {
  col: number;
  row: number;
  type: NonEmptyCell;
  finalX: number;
  finalY: number;
  side: LandscapeSide;
  distance: number;
  seed: number;
}

const rawCells: RawCell[] = [];
const gridCenterCol = (FISH_GRID_COLS - 1) / 2;
const gridCenterRow = (FISH_GRID_ROWS - 1) / 2;
const stageCenterX = LANDSCAPE_STAGE_LEFT + LANDSCAPE_STAGE_WIDTH / 2;
const stageCenterY = LANDSCAPE_STAGE_TOP + LANDSCAPE_STAGE_HEIGHT / 2;

for (let row = 0; row < FISH_GRID_ROWS; row++) {
  for (let col = 0; col < FISH_GRID_COLS; col++) {
    const type = FISH_GRID[row][col];
    if (type === 0) continue;

    const dx = col - gridCenterCol;
    const dy = row - gridCenterRow;
    const side: LandscapeSide =
      Math.abs(dx) >= Math.abs(dy)
        ? dx < 0
          ? 'left'
          : 'right'
        : dy < 0
          ? 'top'
          : 'bottom';

    const finalX =
      LANDSCAPE_STAGE_LEFT + col * LANDSCAPE_CELL_SIZE + LANDSCAPE_CELL_SIZE / 2;
    const finalY =
      LANDSCAPE_STAGE_TOP + row * LANDSCAPE_CELL_SIZE + LANDSCAPE_CELL_SIZE / 2;

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

rawCells.sort((a, b) => b.distance - a.distance || a.seed - b.seed);

const total = rawCells.length;

export const LANDSCAPE_FISH_PIECES: FishPiece[] = rawCells.map((cell, index) => {
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
      (dir < 0 ? -LANDSCAPE_CELL_SIZE : LANDSCAPE.width + LANDSCAPE_CELL_SIZE) +
      dir * jitterA * START_OFFSCREEN;
    startY = cell.finalY + (jitterB - 0.5) * 280;
  } else {
    const dir = side === 'top' ? -1 : 1;
    startY =
      (dir < 0 ? -LANDSCAPE_CELL_SIZE : LANDSCAPE.height + LANDSCAPE_CELL_SIZE) +
      dir * jitterA * START_OFFSCREEN;
    startX = cell.finalX + (jitterB - 0.5) * 280;
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
    breathPhase: (cell.col * 0.65 + cell.row * 1.35) % (Math.PI * 2),
    startScale: hashRange(seed + 53, 0.35, 0.6),
  };
});
