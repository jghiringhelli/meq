import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { pendingHeroTasks } from '../src/engine/turnTasks';
import type { GameState } from '../src/engine/types';

/** Active hero in HeroActions with a clean slate: one action, empty hand, no
 *  favor/characters/plots here. Caller mutates to exercise each task. */
function baseGame(): GameState {
  const s = freshGame();
  s.phase = 'HeroActions';
  s.activeHeroIndex = 0;
  const h = s.heroes[0];
  h.status = 'active';
  h.actionsRemaining = 1;
  h.favor = 5;
  h.hand = [];
  h.corruptionCards = [];
  s.map.monstersAt = {};
  s.map.minionsAt = {};
  s.map.favorAt = {};
  s.map.charactersAt = {};
  s.sauron.activePlots = [];
  return s;
}

describe('pendingHeroTasks — smart next-step advisor', () => {
  it('returns no tasks when nothing worthwhile is left and hand is empty', () => {
    const s = baseGame();
    expect(pendingHeroTasks(s, cat)).toEqual([]);
  });

  it('returns nothing outside the HeroActions phase', () => {
    const s = baseGame();
    s.phase = 'SauronMinions';
    s.map.favorAt = { [s.heroes[0].location]: 3 };
    expect(pendingHeroTasks(s, cat)).toEqual([]);
  });

  it('flags uncollected favor on the hero location', () => {
    const s = baseGame();
    s.map.favorAt = { [s.heroes[0].location]: 3 };
    const tasks = pendingHeroTasks(s, cat);
    expect(tasks.some((t) => /Retrieve 3 favor/.test(t))).toBe(true);
  });

  it('flags a counterable plot the hero can afford', () => {
    const s = baseGame();
    const plot = cat.plots.find((p) => (p.favorToCounter ?? 2) >= 2)!;
    s.heroes[0].favor = plot.favorToCounter ?? 2;
    s.sauron.activePlots = [{ eventId: plot.id, location: s.heroes[0].location } as never];
    const tasks = pendingHeroTasks(s, cat);
    expect(tasks.some((t) => /Break the plot here/.test(t))).toBe(true);
  });

  it('does not flag actions once the hero is out of actions', () => {
    const s = baseGame();
    s.map.favorAt = { [s.heroes[0].location]: 3 };
    s.heroes[0].actionsRemaining = 0;
    expect(pendingHeroTasks(s, cat).some((t) => /Retrieve/.test(t))).toBe(false);
  });

  it('warns about ending with cards in hand outside a haven', () => {
    const s = baseGame();
    // move to a non-haven location that still holds cards
    const nonHaven = Object.values(cat.locations).find((l) => l.kind !== 'haven')!;
    s.heroes[0].location = nonHaven.id;
    s.heroes[0].hand = ['x1', 'x2'];
    const tasks = pendingHeroTasks(s, cat);
    expect(tasks.some((t) => /not in a haven/.test(t))).toBe(true);
  });

  it('does not warn about hand exposure inside a haven', () => {
    const s = baseGame();
    const haven = Object.values(cat.locations).find((l) => l.kind === 'haven')!;
    s.heroes[0].location = haven.id;
    s.heroes[0].hand = ['x1'];
    expect(pendingHeroTasks(s, cat).some((t) => /haven/.test(t))).toBe(false);
  });

  it('does not suggest travelling to a haven when no legal move exists (e.g. Hopeless travel cap exhausted)', () => {
    const s = baseGame();
    const nonHaven = Object.values(cat.locations).find((l) => l.kind !== 'haven')!;
    s.heroes[0].location = nonHaven.id;
    s.heroes[0].hand = ['x1', 'x2'];
    // Simulate a turn-travel cap already spent this turn (Hopeless corruption /
    // a restrictMovement encounter effect) — legalMoves() then returns [].
    s.heroes[0].turnTravelCap = 0;
    s.heroes[0].travelStepsThisTurn = 0;
    const tasks = pendingHeroTasks(s, cat);
    expect(tasks.some((t) => /travel to safety/.test(t))).toBe(false);
  });

  it('does not suggest travelling to a haven when the hero is out of actions', () => {
    const s = baseGame();
    const nonHaven = Object.values(cat.locations).find((l) => l.kind !== 'haven')!;
    s.heroes[0].location = nonHaven.id;
    s.heroes[0].hand = ['x1', 'x2'];
    s.heroes[0].actionsRemaining = 0;
    const tasks = pendingHeroTasks(s, cat);
    expect(tasks.some((t) => /travel to safety/.test(t))).toBe(false);
  });
});
