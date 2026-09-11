import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { evalCond, evalMetric } from '../src/engine/encounter';

// User question: at "Ruins of Angmar", with influence on that location AND on
// exactly one neighbor, "A Shadow in the Background of Their Memories" (effect:
// "if wisdom <= adjacent locations containing influence") logged "no effect"
// for a wisdom-3 hero. Is that right, even though TWO locations on the board
// (the hero's own + one neighbor) hold influence?
//
// Yes: the printed card text says ADJACENT locations specifically — the hero's
// own square is a distinct, separate mechanic (isPerilous). This test pins
// down that `adjacentInfluencedLocations` only counts true graph-neighbors, so
// with just 1 qualifying neighbor a wisdom-3 hero correctly sees no effect
// (3 is not <= 1), even while his own location also carries influence.
describe('peril "A Shadow in the Background of Their Memories" — adjacency semantics', () => {
  it('the hero\'s own location does NOT count toward "adjacent locations containing influence"', () => {
    const s = freshGame();
    const hero = s.heroes[0];
    hero.location = 'ruins-of-angmar';
    const neighbors = cat.edges
      .filter((e) => e.a === hero.location || e.b === hero.location)
      .map((e) => (e.a === hero.location ? e.b : e.a));
    expect(neighbors.length).toBeGreaterThan(0);

    // Influence on the hero's OWN location AND on exactly one neighbor.
    s.sauron.locationInfluence = { [hero.location]: 1, [neighbors[0]]: 1 };
    expect(evalMetric(s, cat, hero.id, { count: 'adjacentInfluencedLocations' })).toBe(1);

    const card = cat.perils['peril-a-shadow-in-the-background-of-their-memories'];
    expect(card?.tree).toBeDefined();
    hero.statBonus = { wisdom: 5 }; // force wisdom well above 1, whatever the base hero
    const wisdom = cat.heroes[hero.id].wisdom + (hero.statBonus.wisdom ?? 0);
    // Sanity: this test only means something when wisdom exceeds the 1
    // qualifying adjacent location — i.e. "no effect" is the RIGHT call.
    expect(wisdom).toBeGreaterThanOrEqual(2);
    expect(evalCond(s, cat, hero.id, card!.tree!.cond as never)).toBe(false);
  });
});
