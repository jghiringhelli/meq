// Faithful shield-block mechanic (shieldBlock node) — the three printed outcomes
// of "discard any number of cards to reduce the damage by 1 for each shield icon
// (= combat defense) discarded; if reduced to 0, gain the reward":
//
//   1. discard nothing            → full damage, no reward
//   2. discard some, not enough   → adjusted (residual) damage, no reward
//   3. reduce the damage to 0     → no damage, the printed reward
//
// The hero picks WHICH cards to discard, one at a time (per-card agency), which
// is surfaced as an ordinary labelled-option prompt (no bespoke UI needed).
import { describe, it, expect } from 'vitest';
import { cat, freshGame, encounters, perils } from './helpers';
import { applyAtom, planEncounter } from '../src/engine/encounter';
import type { Atom, GameState } from '../src/engine/types';

const heroOf = (s: GameState) => s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];

// Thalin cards with known shield counts (= combat defense): Block 4, Evade 2,
// Parry 1, Sweep 0.
const BLOCK = 'cmb-thalin-block';
const EVADE = 'cmb-thalin-evade';
const PARRY = 'cmb-thalin-parry';
const SWEEP = 'cmb-thalin-sweep';

/** Fresh game with the active hero holding exactly `hand`. */
function setup(hand: string[]) {
  const s = freshGame();
  const h = heroOf(s);
  h.hand = [...hand];
  return { s, h };
}

/** Plan a shield card's tree with the given decisions and apply the atoms. */
function resolve(s: GameState, heroId: string, tree: any, decisions: number[]) {
  const plan = planEncounter(s, cat, heroId, tree, decisions);
  if (plan.complete) for (const a of plan.atoms as Atom[]) applyAtom(s, cat, heroId, a);
  return plan;
}

const deadmensDike = () => encounters.find((c: any) => c.id === 'enc-haven-deadmen-s-dike')! as any;

describe('shieldBlock: Deadmen\'s Dike (4 damage → gain 2 favor + training)', () => {
  it('sanity: the card compiled to a shieldBlock node', () => {
    expect(deadmensDike().tree.k).toBe('shieldBlock');
    expect(deadmensDike().tree.damage).toBe(4);
  });

  it('outcome 1 — discard nothing: takes full 4 damage, no reward', () => {
    const { s, h } = setup([BLOCK, EVADE, PARRY]);
    const favor0 = h.favor, life0 = h.life;
    // Stop immediately: with 3 discardable cards the "take damage" option is index 3.
    const plan = resolve(s, h.id, deadmensDike().tree, [3]);
    expect(plan.complete).toBe(true);
    expect(plan.atoms).toEqual([{ op: 'damage', n: 4 }]);
    expect(h.life).toBe(life0 - 4);
    expect(h.favor).toBe(favor0);            // no reward
    expect(h.hand).toEqual([BLOCK, EVADE, PARRY]); // nothing discarded
  });

  it('outcome 2 — partial block: discard Evade then stop, takes adjusted 2 damage, no reward', () => {
    const { s, h } = setup([BLOCK, EVADE, PARRY]);
    const favor0 = h.favor, life0 = h.life;
    // Discard Evade (index 1, −2). Hand becomes [Block, Parry]; "take damage" is now index 2.
    const plan = resolve(s, h.id, deadmensDike().tree, [1, 2]);
    expect(plan.complete).toBe(true);
    expect(plan.atoms).toEqual([{ op: 'discardCardId', id: EVADE }, { op: 'damage', n: 2 }]);
    expect(h.life).toBe(life0 - 2);          // 4 − 2 shields
    expect(h.favor).toBe(favor0);            // no reward (did not reach 0)
    expect(h.hand).toEqual([BLOCK, PARRY]);
    expect(h.discard).toContain(EVADE);
  });

  it('outcome 3 — full block: discard Block (4 shields) reduces to 0, no damage + reward', () => {
    const { s, h } = setup([BLOCK, EVADE, PARRY]);
    const favor0 = h.favor, life0 = h.life;
    // Discard Block (index 0, −4) → damage 0 → reward (gain 2 favor + training).
    const plan = resolve(s, h.id, deadmensDike().tree, [0]);
    expect(plan.complete).toBe(true);
    expect(plan.atoms).toEqual([
      { op: 'discardCardId', id: BLOCK },
      { op: 'gainFavor', n: 2 },
      { op: 'training', n: 1 },
    ]);
    expect(h.life).toBe(life0);              // no damage
    expect(h.favor).toBe(favor0 + 2);        // reward granted
    expect(h.hand).toEqual([EVADE, PARRY]);
  });

  it('full block can accumulate several smaller cards (Evade+Evade+Parry ≥ 4)', () => {
    const { s, h } = setup([EVADE, EVADE, PARRY]);
    const life0 = h.life, favor0 = h.favor;
    // Evade(2)+Evade(2) = 4 → 0 damage. Two distinct-id options collapse to one
    // "Discard Evade" entry, so discard it twice (index 0 each time).
    const plan = resolve(s, h.id, deadmensDike().tree, [0, 0]);
    expect(plan.complete).toBe(true);
    expect(plan.atoms).toEqual([
      { op: 'discardCardId', id: EVADE },
      { op: 'discardCardId', id: EVADE },
      { op: 'gainFavor', n: 2 },
      { op: 'training', n: 1 },
    ]);
    expect(h.life).toBe(life0);
    expect(h.favor).toBe(favor0 + 2);
  });

  it('no shields in hand → full damage with no prompt', () => {
    const { s, h } = setup([SWEEP]); // Sweep has 0 shields
    const plan = resolve(s, h.id, deadmensDike().tree, []);
    expect(plan.complete).toBe(true);           // resolves without pausing
    expect(plan.atoms).toEqual([{ op: 'damage', n: 4 }]);
    expect(h.hand).toEqual([SWEEP]);            // 0-shield card never discarded
  });

  it('surfaces a per-card labelled prompt (usable by the generic UI)', () => {
    const { s, h } = setup([BLOCK, EVADE, PARRY]);
    const plan = planEncounter(s, cat, h.id, deadmensDike().tree, []);
    expect(plan.complete).toBe(false);
    expect(plan.pending!.options.map((o) => o.label)).toEqual([
      'Discard Block (−4 damage)',
      'Discard Evade (−2 damage)',
      'Discard Parry (−1 damage)',
      'Take the remaining 4 damage',
    ]);
    expect(plan.pending!.options.every((o) => o.enabled)).toBe(true);
  });
});

describe('shieldBlock: Hounds of Sauron peril (6 damage → 1 favor or training)', () => {
  const hounds = () => perils.find((c: any) => c.id === 'peril-the-hounds-of-sauron')! as any;

  it('compiled to a shieldBlock node with a favor/training reward choice', () => {
    expect(hounds().tree.k).toBe('shieldBlock');
    expect(hounds().tree.damage).toBe(6);
    expect(hounds().tree.reward.k).toBe('choice');
  });

  it('full block (Block+Evade = 6) reduces to 0 then offers the reward choice', () => {
    const { s, h } = setup([BLOCK, EVADE, PARRY]);
    const favor0 = h.favor;
    // Discard Block (idx 0, −4): remaining 2. Then Evade — after Block leaves,
    // discardable = [Evade, Parry], so Evade is index 0 → −2 → damage 0.
    // Reward choice: pick "Gain 1 favor" (option 0).
    const plan = resolve(s, h.id, hounds().tree, [0, 0, 0]);
    expect(plan.complete).toBe(true);
    expect(plan.atoms).toEqual([
      { op: 'discardCardId', id: BLOCK },
      { op: 'discardCardId', id: EVADE },
      { op: 'gainFavor', n: 1 },
    ]);
    expect(h.favor).toBe(favor0 + 1);
  });
});
