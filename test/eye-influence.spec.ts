import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame } from '../src/engine/setup';
import { eyePlaceInfluenceOnce } from '../src/engine/ai';

// Locks the Lidless Eye's "perilous road" influence policy (the real automa
// entry point used by eyeTakeBestAction): it must build ACTUAL perilous nodes
// (influence exceeding a low-wisdom hero's wisdom) on non-Haven, hero-free
// locations — the corridor-corruption lever against combat-strong heroes.
describe('eye influence (perilous road)', () => {
  it('places influence and builds a node perilous for a low-wisdom hero', () => {
    const s = newGame(cat, 5, ['thalin']); // Thalin: wisdom 1 (cheap to perilise)
    s.sauron.influence = 30;
    let placed = 0;
    for (let i = 0; i < 16; i++) if (eyePlaceInfluenceOnce(s, cat)) placed++;
    expect(placed).toBeGreaterThan(0);
    // A non-Haven node now EXCEEDS Thalin's wisdom (1) => genuinely perilous.
    const perilous = Object.entries(s.sauron.locationInfluence ?? {})
      .some(([loc, inf]) => (inf ?? 0) > 1 && cat.locations[loc]?.kind !== 'haven');
    expect(perilous).toBe(true);
  });

  it('never seats influence on a Haven or a hero-occupied location', () => {
    const s = newGame(cat, 9, ['eometh']);
    s.sauron.influence = 20;
    for (let i = 0; i < 12; i++) eyePlaceInfluenceOnce(s, cat);
    for (const [loc, inf] of Object.entries(s.sauron.locationInfluence ?? {})) {
      if ((inf ?? 0) <= 0) continue;
      expect(cat.locations[loc]?.kind).not.toBe('haven');
      expect(s.map.heroesAt[loc]?.length ?? 0).toBe(0);
    }
  });
});
