import React from 'react';
import {
  FISH_GRID,
  FISH_GRID_COLS,
  FISH_GRID_ROWS,
  type FishCellType,
} from '../FishGrid';
import {COLORS} from '../theme';

const DEFAULT_PALETTE: Record<Exclude<FishCellType, 0>, string> = {
  1: COLORS.body,
  2: COLORS.highlight,
  3: COLORS.shadow,
  4: COLORS.eye,
};

/** Tiny CSS-only version of the fish mark, used inside the CubeFish.exe icon. */
export const MiniFish: React.FC<{
  cellSize: number;
  palette?: Partial<Record<Exclude<FishCellType, 0>, string>>;
  radius?: number;
}> = ({cellSize, palette, radius}) => {
  const colors = {...DEFAULT_PALETTE, ...palette};

  return (
    <div
      style={{
        position: 'relative',
        width: FISH_GRID_COLS * cellSize,
        height: FISH_GRID_ROWS * cellSize,
      }}
    >
      {FISH_GRID.flatMap((row, y) =>
        row.map((type, x) => {
          if (type === 0) return null;
          return (
            <div
              key={`${x}-${y}`}
              style={{
                position: 'absolute',
                left: x * cellSize,
                top: y * cellSize,
                width: cellSize,
                height: cellSize,
                backgroundColor: colors[type],
                borderRadius: radius ?? Math.max(1, Math.floor(cellSize * 0.14)),
              }}
            />
          );
        }),
      )}
    </div>
  );
};
