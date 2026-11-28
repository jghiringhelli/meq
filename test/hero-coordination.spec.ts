import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame } from '../src/engine/game';
import { coordinatedPlotTarget, missionAware } from '../src/engine/heroAI';
import type { GameState } from '../src/engine/types';

// Two-hero coordination: heroes split affordable plots across the party and
// converge to pool favor on an urgent break none can solo-afford.
function twoHeroGame(): GameState {
  const s = newGame(cat, 1, ['thalin', 'argalad']);
  s.story.sauron = { yellow: 6, red: 8, black: 4 };
  // Put the two heroes at two distinct, far-apart locations.
  s.heroes[0].location = 'fornost';
  s.heroes[1].location = 'edoras';
  return s;
}

const has = (set: Set<string> | null, loc: string) => !!set && set.has(loc);

describe('hero AI coordination (coordinatedPlotTarget)', () => {
  it('splits two affordable plots across the two heroes (no double-teaming)', () => {
    const s = twoHeroGame();
    s.heroes[0].favor = 3;
    s.heroes[1].favor = 3;
    // A plot at each hero's location; both affordable.
    s.sauron.activePlots = [
      { eventId: 'gollum-is-captured', location: 'fornost' } as any,
      { eventId: 'a-promise-of-rings', location: 'edoras' } as any,
    ];
    const st = s.story.sauron;
    const t0 = coordinatedPlotTarget(s, cat, s.heroes[0], st);
    const t1 = coordinatedPlotTarget(s, cat, s.heroes[1], st);
    // Each hero covers the plot nearest to them, and they cover DIFFERENT plots.
    expect(has(t0, 'fornost')).toBe(true);
    expect(has(t1, 'edoras')).toBe(true);
    expect(has(t0, 'edoras')).toBe(false);
    expect(has(t1, 'fornost')).toBe(false);
  });

  it('converges both heroes to pool favor on a plot neither can solo-afford', () => {
    const s = twoHeroGame();
    // Cost-5 plot; each hero has 3 favor (no solo break) but 6 pooled covers it.
    s.heroes[0].favor = 3;
    s.heroes[1].favor = 3;
    s.sauron.activePlots = [
      { eventId: 'saruman-falls-to-corruption', location: 'fornost' } as any,
    ];
    const st = s.story.sauron;
    const t0 = coordinatedPlotTarget(s, cat, s.heroes[0], st);
    const t1 = coordinatedPlotTarget(s, cat, s.heroes[1], st);
    expect(has(t0, 'fornost')).toBe(true);
    expect(has(t1, 'fornost')).toBe(true);
  });

  it('banks favor (no target) when even pooled favor cannot break the plot', () => {
    const s = twoHeroGame();
    s.heroes[0].favor = 1;
    s.heroes[1].favor = 1; // pooled 2 < cost 5
    s.sauron.activePlots = [
      { eventId: 'saruman-falls-to-corruption', location: 'fornost' } as any,
    ];
    const st = s.story.sauron;
    expect(coordinatedPlotTarget(s, cat, s.heroes[0], st)).toBeNull();
    expect(coordinatedPlotTarget(s, cat, s.heroes[1], st)).toBeNull();
  });
});

describe('hero AI plot priorities', () => {
  it('ignores a 1/turn plot: no target, nothing worth chasing or paying for', () => {
    const s = twoHeroGame();
    s.heroes[0].favor = 5;
    s.heroes[1].favor = 5;
    s.sauron.activePlots = [{ eventId: 's-monsters-in-the-east', location: 'fornost' } as any];
    expect(coordinatedPlotTarget(s, cat, s.heroes[0], s.story.sauron)).toBeNull();
    expect(coordinatedPlotTarget(s, cat, s.heroes[1], s.story.sauron)).toBeNull();
  });

  it('chases a 1/turn plot only when one more tick reaches the Finale', () => {
    const s = twoHeroGame();
    s.heroes[0].favor = 5;
    s.story.sauron = { yellow: 6, red: 17, black: 4 };
    s.sauron.activePlots = [{ eventId: 's-monsters-in-the-east', location: 'fornost' } as any];
    expect(has(coordinatedPlotTarget(s, cat, s.heroes[0], s.story.sauron), 'fornost')).toBe(true);
  });

  it('breaks the critical 3/turn plot before a 2/turn plot when only one is affordable', () => {
    const s = twoHeroGame();
    s.heroes[0].favor = 4;
    s.heroes[1].favor = 0;
    s.heroes[0].location = 'edoras';
    s.heroes[1].location = 'edoras';
    s.sauron.activePlots = [
      { eventId: 'gollum-is-captured', location: 'edoras' } as any,
      { eventId: 'rise-of-the-uruk-hai', location: 'fornost' } as any,
    ];
    const t = coordinatedPlotTarget(s, cat, s.heroes[0], s.story.sauron);
    expect(has(t, 'fornost')).toBe(true);
  });
});
describe('hero AI commitment', () => {
  it('keeps heading to the plot he set out for even when another becomes more attractive', () => {
    const s = twoHeroGame();
    s.heroes[0].favor = 3;
    s.heroes[1].favor = 0;
    s.sauron.activePlots = [
      { eventId: 'gollum-is-captured', location: 'edoras' } as any,
      { eventId: 'a-promise-of-rings', location: 'fornost' } as any,
    ];
    const hero = s.heroes[0];
    hero.location = 'rivendell';
    hero.aiPlan = { key: 'edoras', targets: ['edoras'] };
    const act = missionAware.heroAction(s, cat, hero.id, () => 0.5);
    if (act.kind === 'move') expect(act.plan?.key).toBe('edoras');
  });

  it('sits out once in a Haven with nothing to do, but never twice in a row', () => {
    const s = newGame(cat, 1, ['argalad']);
    s.sauron.activePlots = [];
    const hero = s.heroes[0];
    hero.location = 'rivendell';
    hero.damagePool = []; hero.discard = []; hero.corruptionCards = []; hero.corruption = 0;
    hero.hasMovedThisTurn = true; // already in the zone logic's "no drift" case
    hero.idleStreak = 1;
    const act = missionAware.heroAction(s, cat, hero.id, () => 0.5);
    expect(act.kind === 'end' && act.idle).not.toBe(true);
  });
});