import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame } from '../src/engine/game';

// Regression: drawShadow() (sauronmech.ts), and several other "pick a random
// card from a small pool" call sites (Saruman's ability, quest/encounter
// "discard random Shadow card(s)", encounter "spawn random monster"), computed
// their index with `(state.rngCursor + offset) % pool.length` directly, WITHOUT
// ever drawing from — or advancing — the seeded rng stream. Because
// `state.rngCursor` only ever changes by a fixed additive step per nextInt()
// call, this raw formula clustered hard: across many different seeds, the
// Shadow deck's opening hand came up as one of just 3 cards 296/300 times.
// Since the Shadow deck drives Sauron's whole game, this made Shadow draws
// feel repetitive across many separate games. Fixed by drawing through
// nextInt() (the same generator every other shuffle/pick in the engine uses).
describe('shadow hand draw is actually randomized', () => {
  it('the opening Shadow hand is not dominated by a handful of cards across many seeds', () => {
    const firstCard: Record<string, number> = {};
    for (let seed = 1; seed <= 200; seed++) {
      const s = newGame(cat, seed, ['beravor', 'thalin']);
      const first = s.sauron.shadowHand[0] ?? 'none';
      firstCard[first] = (firstCard[first] ?? 0) + 1;
    }
    const distinct = Object.keys(firstCard).length;
    const maxShare = Math.max(...Object.values(firstCard)) / 200;
    // Healthy spread: many distinct opening cards, no single card dominating.
    expect(distinct).toBeGreaterThan(10);
    expect(maxShare).toBeLessThan(0.2);
  });
});
