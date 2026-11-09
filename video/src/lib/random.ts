/**
 * Tiny deterministic PRNG helpers.
 *
 * Every animation in this project is a pure function of `frame`; nothing may
 * call Math.random() during render. These hash helpers turn a stable integer
 * seed into the same [0, 1) float on every render and every browser, so the
 * 26 background particles and all 112 fish blocks are reproducible.
 */

/** mulberry32-style integer hash -> float in [0, 1). */
export const hash = (seed: number): number => {
  let t = seed + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Deterministic float in [min, max). */
export const hashRange = (seed: number, min: number, max: number): number =>
  min + hash(seed) * (max - min);
