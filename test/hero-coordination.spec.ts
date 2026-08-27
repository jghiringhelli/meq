import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame } from '../src/engine/game';
import { coordinatedPlotTarget, worthFightingForCards } from '../src/engine/heroAI';
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
      { eventId: 's-monsters-in-the-east', location: 'fornost' } as any,
      { eventId: 's-sauron-hunts-for-the-ring', location: 'edoras' } as any,
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
      { eventId: 'a-dark-messenger', location: 'fornost' } as any,
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
      { eventId: 'a-dark-messenger', location: 'fornost' } as any,
    ];
    const st = s.story.sauron;
    expect(coordinatedPlotTarget(s, cat, s.heroes[0], st)).toBeNull();
    expect(coordinatedPlotTarget(s, cat, s.heroes[1], st)).toBeNull();
  });
});

describe('opportunistic card-gain fight (worthFightingForCards)', () => {
  function heroVsMonster(monsterId: string) {
    const s = newGame(cat, 2, ['argalad']);
    s.heroes[0].statBonus = { agility: 5, strength: 3 } as any; // high-agility, card-drawing hero
    s.heroes[0].hand = ['x1', 'x2'] as any; // card-poor
    s.heroes[0].corruption = 0;
    s.heroes[0].damagePool = [] as any;
    s.sauron.activePlots = [{ eventId: 's-monsters-in-the-east', location: 'fornost' } as any];
    return { s, mon: monsterId };
  }

  it('fights a genuinely weak, non-corrupting foe when card-poor with a plot to chase', () => {
    const { s, mon } = heroVsMonster('mon-snaga'); // F6 S3, no corruption
    expect(worthFightingForCards(s, cat, s.heroes[0], mon)).toBe(true);
  });

  it('does NOT fight a tough foe', () => {
    const { s, mon } = heroVsMonster('mon-balrog'); // F9 S12
    expect(worthFightingForCards(s, cat, s.heroes[0], mon)).toBe(false);
  });

  it('does NOT fight a corruption-dealing foe even if statistically weak', () => {
    const { s, mon } = heroVsMonster('mon-agent'); // F5 S3 but inflicts Corruption
    expect(worthFightingForCards(s, cat, s.heroes[0], mon)).toBe(false);
  });

  it('does NOT bother when already card-rich', () => {
    const { s, mon } = heroVsMonster('mon-snaga');
    s.heroes[0].hand = ['a', 'b', 'c', 'd', 'e'] as any; // 5 cards
    expect(worthFightingForCards(s, cat, s.heroes[0], mon)).toBe(false);
  });

  it('does NOT bother when there is no plot race on', () => {
    const { s, mon } = heroVsMonster('mon-snaga');
    s.sauron.activePlots = [];
    expect(worthFightingForCards(s, cat, s.heroes[0], mon)).toBe(false);
  });
});
