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

describe('Trust in Friendship — banked favor returns on exploring near a Character', () => {
  it('returns banked favor when a Character occupies the explored location', () => {
    const { s, loc } = havenGame();
    const h = s.heroes[0];
    h.favor = 0;
    h.bankedFavor = 1;
    s.map.charactersAt = { [loc]: ['gandalf'] };
    const s2 = heroExplore(s, cat, h.id);
    const h2 = s2.heroes[0];
    expect(h2.favor).toBe(1);
    expect(h2.bankedFavor).toBe(0);
  });

  it('does NOT return banked favor when the location is empty', () => {
    const { s } = havenGame();
    const h = s.heroes[0];
    h.favor = 0;
    h.bankedFavor = 1;
    s.map.charactersAt = {};
    const s2 = heroExplore(s, cat, h.id);
    expect(s2.heroes[0].bankedFavor).toBe(1);
    expect(s2.heroes[0].favor).toBe(0);
  });
});
