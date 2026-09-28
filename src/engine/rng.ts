// Seeded deterministic PRNG (mulberry32). The ONLY randomness source in the
// engine. Cursor is stored in GameState so shuffles are replayable.
// The actual pure PRNG lives in boardgame-kit/rng (shared with other games in
// this workspace); this module just adapts it to meq's mutate-GameState style.
import type { GameState } from './types';
import { nextInt as kitNextInt, shuffle as kitShuffle } from 'boardgame-kit/rng';

export function nextInt(state: GameState, maxExclusive: number): number {
  const r = kitNextInt(state.rngCursor, maxExclusive);
  state.rngCursor = r.cursor;
  return r.value;
}

/** Fisher–Yates using the seeded stream. Returns a new array. */
export function shuffle<T>(state: GameState, arr: readonly T[]): T[] {
  const r = kitShuffle(state.rngCursor, arr);
  state.rngCursor = r.cursor;
  return r.items;
}
