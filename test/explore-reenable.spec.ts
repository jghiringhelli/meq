import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { canExplore, heroExplore } from '../src/engine/phases';
import type { GameState } from '../src/engine/types';

/** Single active hero standing on a haven, ready to explore. */
function havenGame(): { s: GameState; loc: string } {
  const s = freshGame();
  const haven = Object.values(cat.locations).find((l) => l.kind === 'haven')!;
  s.phase = 'HeroActions';
  s.activeHeroIndex = 0;
  const h = s.heroes[0];
  h.status = 'active';
  h.actionsRemaining = 1;
  h.location = haven.id;
  h.encounterStepDone = false;
  s.map.monstersAt = {};
  s.map.minionsAt = {};
  return { s, loc: haven.id };
}

describe('explore — Encounter step is per-turn, not once-per-game (fidelity)', () => {
  it('can explore a location again on a later turn after exploring it once', () => {
    const { s } = havenGame();
    expect(canExplore(s, cat, s.heroes[0].id)).toBe(true);
    const s2 = heroExplore(s, cat, s.heroes[0].id);
    // same turn: the Encounter step already ran → cannot explore again now
    expect(canExplore(s2, cat, s2.heroes[0].id)).toBe(false);
    // next turn: the per-turn flag resets → exploring the same spot is legal
    s2.heroes[0].encounterStepDone = false;
    s2.heroes[0].actionsRemaining = 1;
    expect(canExplore(s2, cat, s2.heroes[0].id)).toBe(true);
  });

  it('blocks a second explore within the same turn', () => {
    const { s } = havenGame();
    s.heroes[0].encounterStepDone = true;
    expect(canExplore(s, cat, s.heroes[0].id)).toBe(false);
  });
});
