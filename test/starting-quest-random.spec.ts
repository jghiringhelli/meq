import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame } from '../src/engine/game';

// Regression: assignStartingQuest() used to derive its 1-of-2 pick from
// `state.rngCursor ^ hash(heroId)` WITHOUT drawing from the rng stream. Because
// rngCursor's low bit was correlated with hash's low bit across every seed
// (both were always odd for Beravor at that setup point), Beravor ALWAYS got
// "Spies in Mithlond" and never "Guarding the Dimrill Stair" — reported by a
// player after "several" games in a row. Fixed by drawing an index via the
// shared seeded rng stream (nextInt), same as every other random setup choice.
describe('starting quest assignment is actually randomized', () => {
  it('Beravor gets both of his two Starting Quests across many seeds', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) {
      const s = newGame(cat, seed, ['beravor', 'thalin']);
      const hero = s.heroes.find((h) => h.id === 'beravor')!;
      seen.add(hero.quests?.startingQuestId ?? 'none');
    }
    expect(seen).toEqual(new Set(['quest-beravor-guarding-the-dimrill-stair', 'quest-beravor-spies-in-mithlond']));
  });
});
