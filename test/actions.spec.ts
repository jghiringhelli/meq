import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { applyAction, type Action } from '../src/engine/actions';
import {
  advance, heroMove, heroRest, heroExplore, endHeroActions, dismissReveal,
} from '../src/engine/game';
import { legalMoves } from '../src/engine/mechanics';

const activeHero = (s: ReturnType<typeof freshGame>) =>
  s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];

const json = (s: unknown) => JSON.stringify(s);

/** Deterministic game advanced into the HeroActions phase (seed fixed). */
function heroTurnGame(): ReturnType<typeof freshGame> {
  let s = freshGame();
  for (let i = 0; i < 50 && s.phase !== 'HeroActions'; i++) s = advance(s, cat);
  return s;
}

describe('serializable action layer (applyAction)', () => {
  it('advance via applyAction matches the direct engine call', () => {
    const a = applyAction(freshGame(), cat, { t: 'advance' });
    const b = advance(freshGame(), cat);
    expect(json(a)).toBe(json(b));
  });

  it('endHeroActions via applyAction matches the direct call', () => {
    const a = applyAction(heroTurnGame(), cat, { t: 'endHeroActions' });
    const b = endHeroActions(heroTurnGame(), cat);
    expect(json(a)).toBe(json(b));
  });

  it('move via applyAction matches the direct call', () => {
    const s = heroTurnGame();
    const h = activeHero(s);
    const dest = legalMoves(cat, h)[0].to;
    expect(dest).toBeTruthy();
    const a = applyAction(heroTurnGame(), cat, { t: 'move', heroId: h.id, to: dest });
    const b = heroMove(heroTurnGame(), cat, h.id, dest);
    expect(json(a)).toBe(json(b));
  });

  it('rest via applyAction matches the direct call', () => {
    const h = activeHero(heroTurnGame());
    const a = applyAction(heroTurnGame(), cat, { t: 'rest', heroId: h.id });
    const b = heroRest(heroTurnGame(), cat, h.id);
    expect(json(a)).toBe(json(b));
  });

  it('explore via applyAction matches the direct call', () => {
    const h = activeHero(heroTurnGame());
    const a = applyAction(heroTurnGame(), cat, { t: 'explore', heroId: h.id });
    const b = heroExplore(heroTurnGame(), cat, h.id);
    expect(json(a)).toBe(json(b));
  });

  it('dismissReveal via applyAction matches the direct call', () => {
    const a = applyAction(freshGame(), cat, { t: 'dismissReveal' });
    const b = dismissReveal(freshGame());
    expect(json(a)).toBe(json(b));
  });

  it('actions are plain-JSON (no functions) so they survive the wire', () => {
    const actions: Action[] = [
      { t: 'advance' },
      { t: 'move', heroId: 'aragorn', to: 'bree' },
      { t: 'engage', heroId: 'aragorn', monsterId: 'orc' },
      { t: 'consult', heroId: 'aragorn', character: 'gandalf', choice: 'favor' },
      { t: 'tradeFavor', heroId: 'aragorn', toId: 'gandalf', n: 1 },
    ];
    for (const act of actions) {
      expect(JSON.parse(JSON.stringify(act))).toEqual(act);
    }
  });

  it('a round-tripped (serialized) action applies identically', () => {
    const h = activeHero(heroTurnGame());
    const act: Action = { t: 'move', heroId: h.id, to: legalMoves(cat, h)[0].to };
    const wire = JSON.parse(JSON.stringify(act)) as Action;
    const a = applyAction(heroTurnGame(), cat, act);
    const b = applyAction(heroTurnGame(), cat, wire);
    expect(json(a)).toBe(json(b));
  });
});
