// "The Steadfast Defender" lets the hero spend 2 favor to raise ONE attribute of
// their choosing (fortitude, strength, agility, or wisdom) — the manual gives no
// hint that it must be Wisdom. Previously the interpreter hard-coded the pick to
// Wisdom regardless of what the player wanted; the card's tree must now expose a
// nested choice so the player picks the exact stat raised.
import { describe, it, expect } from 'vitest';
import { cat, freshGame, encounters } from './helpers';
import { applyAtom, planEncounter } from '../src/engine/encounter';
import type { Atom, GameState } from '../src/engine/types';

const heroOf = (s: GameState) => s.heroes.find((h) => h.status === 'active') ?? s.heroes[0];

const steadfastDefender = () =>
  encounters.find((c: any) => c.id === 'enc-haven-the-steadfast-defender')! as any;

function resolve(s: GameState, heroId: string, tree: any, decisions: number[]) {
  const plan = planEncounter(s, cat, heroId, tree, decisions);
  if (plan.complete) for (const a of plan.atoms as Atom[]) applyAtom(s, cat, heroId, a);
  return plan;
}

describe('The Steadfast Defender lets the hero choose which attribute to raise', () => {
  it('choosing "spend favor" pauses on a stat-choice prompt naming all four attributes', () => {
    const s = freshGame();
    const h = heroOf(s);
    const tree = steadfastDefender().tree;
    // decisions[0]=1 picks the second top-level option ("spend 2 favor...").
    const plan = resolve(s, h.id, tree, [1]);
    expect(plan.complete).toBe(false);
    expect(plan.pending?.prompt).toMatch(/attribute/i);
    const labels = plan.pending!.options.map((o: any) => o.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Fortitude', 'Strength', 'Agility', 'Wisdom']),
    );
  });

  it.each([
    [0, 'fortitude'],
    [1, 'strength'],
    [2, 'agility'],
    [3, 'wisdom'],
  ] as const)('picking option %i raises %s (not always wisdom) and charges 2 favor', (idx, stat) => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 5;
    const beforeLevels = { ...(h.levels ?? {}) } as Record<string, number>;
    const tree = steadfastDefender().tree;
    const plan = resolve(s, h.id, tree, [1, idx]);
    expect(plan.complete).toBe(true);
    expect(h.favor).toBe(3); // paid the 2-favor cost
    for (const key of ['fortitude', 'strength', 'agility', 'wisdom'] as const) {
      const expected = (beforeLevels[key] ?? 0) + (key === stat ? 1 : 0);
      expect(h.levels?.[key] ?? 0).toBe(expected);
    }
  });

  it('choosing "remove influence from the Shadow Pool" does not touch any attribute or favor', () => {
    const s = freshGame();
    const h = heroOf(s);
    h.favor = 5;
    s.sauron.influence = 3;
    const beforeLevels = { ...(h.levels ?? {}) } as Record<string, number>;
    const tree = steadfastDefender().tree;
    const plan = resolve(s, h.id, tree, [0]);
    expect(plan.complete).toBe(true);
    expect(h.favor).toBe(5);
    expect(s.sauron.influence).toBe(2);
    for (const key of ['fortitude', 'strength', 'agility', 'wisdom'] as const) {
      expect(h.levels?.[key] ?? 0).toBe(beforeLevels[key] ?? 0);
    }
  });
});
