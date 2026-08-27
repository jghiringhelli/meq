import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { moveOptions, validateMovePayment } from '../src/engine/mechanics';
import { heroMove } from '../src/engine/phases';
import type { GameState, Terrain } from '../src/engine/types';

/** Put the single hero, active, on a location with a known mix of cheap and
 *  cost-2 neighbouring paths, with a fully controlled hand. */
function movable(hand: string[], loc = 'blue-mountains'): GameState {
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
    const s = movable([cardOf('woods'), cardOf('woods')]);
    const opts = moveOptions(cat, s.heroes[0]);
    const grey = opts.find((o) => o.to === 'the-grey-havens');
    const harl = opts.find((o) => o.to === 'harlindon');
    // blue-mountains -> the-grey-havens is a cost-1 woods path; hand holds woods.
    expect(grey).toBeTruthy();
    expect(grey!.anyCardCost).toBe(1);
    expect(grey!.terrainPayable).toBe(true);
    // blue-mountains -> harlindon is a cost-2 swamp path; hand has no swamp.
    expect(harl!.anyCardCost).toBe(2);
    expect(harl!.terrainPayable).toBe(false);
  });

  it('accepts one matching-terrain card as a valid payment', () => {
    const woods = cardOf('woods');
    const s = movable([woods, cardOf('plains')]);
    expect(validateMovePayment(cat, s.heroes[0], 'the-grey-havens', [woods])).toBe(true);
  });

  it('requires exactly the printed number of any-cards on a cost-2 path', () => {
    const a = cardOf('plains'); const b = cardOf('hill');
    const s = movable([a, b]);
    // harlindon = cost-2, no swamp in hand: two any-cards pay, one does not.
    expect(validateMovePayment(cat, s.heroes[0], 'harlindon', [a, b])).toBe(true);
    expect(validateMovePayment(cat, s.heroes[0], 'harlindon', [a])).toBe(false);
  });

  it('rejects a selection with cards not in hand', () => {
    const s = movable([cardOf('woods')]);
    expect(validateMovePayment(cat, s.heroes[0], 'the-grey-havens', [cardOf('mountain')])).toBe(false);
  });

  it('heroMove spends exactly the chosen cards and relocates', () => {
    const woods = cardOf('woods');
    const keep = cardOf('plains');
    const s = movable([woods, keep]);
    const s2 = heroMove(s, cat, s.heroes[0].id, 'the-grey-havens', [woods]);
    const h = s2.heroes[0];
    expect(h.location).toBe('the-grey-havens');
    expect(h.hand).toEqual([keep]);
    expect(h.discard).toContain(woods);
  });

  it('heroMove throws on an invalid explicit card selection', () => {
    const a = cardOf('plains');
    const s = movable([a, cardOf('hill')]);
    // one any-card is not enough for the cost-2 harlindon path
    expect(() => heroMove(s, cat, s.heroes[0].id, 'harlindon', [a])).toThrow();
  });
});
