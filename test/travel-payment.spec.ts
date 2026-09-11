import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { moveOptions, validateMovePayment } from '../src/engine/mechanics';
import { heroMove } from '../src/engine/phases';
import type { GameState, Terrain } from '../src/engine/types';

/** Put the single hero, active, on a location with a known mix of cheap and
 *  cost-2 neighbouring paths, with a fully controlled hand. */
function movable(hand: string[], loc = 'bree'): GameState {
  const s = freshGame();
  s.phase = 'HeroActions';
  s.activeHeroIndex = 0;
  const h = s.heroes[0];
  h.status = 'active';
  h.actionsRemaining = 1;
  h.location = loc;
  h.hand = [...hand];
  h.items = [];
  h.travelStepsThisTurn = 0;
  s.map.monstersAt = {};
  s.map.minionsAt = {};
  s.map.rumorsAt = {};
  return s;
}

/** First combat-card id of a given terrain. */
function cardOf(terrain: Terrain): string {
  const id = Object.values(cat.combatCards).find((c) => c.terrain === terrain)?.id;
  if (!id) throw new Error(`no combat card of terrain ${terrain}`);
  return id;
}

describe('interactive Travel payment model', () => {
  it('exposes both payment routes per neighbouring path', () => {
    const s = movable([cardOf('hill'), cardOf('hill')]);
    const opts = moveOptions(cat, s.heroes[0]);
    const of = opts.find((o) => o.to === 'old-forest');
    const th = opts.find((o) => o.to === 'tharbad');
    // bree -> old-forest is a cost-1 "any card" path (no terrain icon); the empty
    // terrain is never matchable, so terrainPayable is false and anyCardCost is 1.
    expect(of).toBeTruthy();
    expect(of!.anyCardCost).toBe(1);
    expect(of!.terrainPayable).toBe(false);
    // bree -> tharbad is a cost-2 hill path; hand holds hill.
    expect(th!.anyCardCost).toBe(2);
    expect(th!.terrainPayable).toBe(true);
  });

  it('accepts one matching-terrain card as a valid payment', () => {
    const hill = cardOf('hill');
    const s = movable([hill, cardOf('plains')]);
    expect(validateMovePayment(cat, s.heroes[0], 'tharbad', [hill])).toBe(true);
  });

  it('requires exactly the printed number of any-cards on a cost-2 path', () => {
    const a = cardOf('plains'); const b = cardOf('woods');
    const s = movable([a, b]);
    // tharbad = cost-2 hill, no hill in hand: two any-cards pay, one does not.
    expect(validateMovePayment(cat, s.heroes[0], 'tharbad', [a, b])).toBe(true);
    expect(validateMovePayment(cat, s.heroes[0], 'tharbad', [a])).toBe(false);
  });

  it('rejects a selection with cards not in hand', () => {
    const s = movable([cardOf('hill')]);
    expect(validateMovePayment(cat, s.heroes[0], 'tharbad', [cardOf('mountain')])).toBe(false);
  });

  it('heroMove spends exactly the chosen cards and relocates', () => {
    const hill = cardOf('hill');
    const keep = cardOf('plains');
    const s = movable([hill, keep]);
    const s2 = heroMove(s, cat, s.heroes[0].id, 'tharbad', [hill]);
    const h = s2.heroes[0];
    expect(h.location).toBe('tharbad');
    expect(h.hand).toEqual([keep]);
    expect(h.discard).toContain(hill);
  });

  it('heroMove throws on an invalid explicit card selection', () => {
    const a = cardOf('plains');
    const s = movable([a, cardOf('woods')]);
    // one any-card is not enough for the cost-2 tharbad path
    expect(() => heroMove(s, cat, s.heroes[0].id, 'tharbad', [a])).toThrow();
  });
});

describe('Boat on a water path (fidelity): High Pass ↔ Gladden Fields', () => {
  // This path is printed cost-3 "mountain" but is ALSO a water crossing (per
  // the physical board, same as Gladden Fields ↔ Lothlórien) — Boat always
  // reduces a water path to a single any-card, terrain irrelevant, regardless
  // of whether the hero happens to also hold a matching-terrain card.
  it('costs exactly 1 any-card with a Boat, even holding zero mountain cards', () => {
    const s = movable([cardOf('plains'), cardOf('woods')], 'high-pass');
    s.heroes[0].items = ['item-boat'];
    const opts = moveOptions(cat, s.heroes[0]);
    const gf = opts.find((o) => o.to === 'gladden-fields');
    expect(gf).toBeTruthy();
    expect(gf!.water).toBe(true);
    expect(gf!.anyCardCost).toBe(1);
    expect(gf!.terrainPayable).toBe(false); // Boat's water route is always "any card"
  });

  it('still costs the printed 3-card fallback without a Boat', () => {
    const s = movable([cardOf('plains'), cardOf('woods'), cardOf('hill')], 'high-pass');
    const opts = moveOptions(cat, s.heroes[0]);
    const gf = opts.find((o) => o.to === 'gladden-fields');
    expect(gf!.anyCardCost).toBe(3);
  });

  it('Boat takes the water route even when the hero holds a matching mountain card', () => {
    const mountain = cardOf('mountain');
    const s = movable([mountain], 'high-pass');
    s.heroes[0].items = ['item-boat'];
    const s2 = heroMove(s, cat, s.heroes[0].id, 'gladden-fields');
    // Only 1 card spent (the Boat's any-card water cost), not the printed cost-3
    // fallback, and the mountain card wasn't required to make the terrain match.
    expect(s2.heroes[0].location).toBe('gladden-fields');
    expect(s2.heroes[0].discard.length).toBe(1);
  });
});
