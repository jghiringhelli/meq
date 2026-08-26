// Seeded deterministic PRNG (mulberry32). The ONLY randomness source in the
// engine. Cursor is stored in GameState so shuffles are replayable.
import type { GameState } from './types';

export function nextInt(state: GameState, maxExclusive: number): number {
  let t = (state.rngCursor = (state.rngCursor + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return Math.floor(r * maxExclusive);
}

/** Fisher–Yates using the seeded stream. Returns a new array. */
export function shuffle<T>(state: GameState, arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(state, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
