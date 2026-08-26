// One test per Peril card: data integrity, a well-formed tree, region reachability
// (perilAffects), and auto-resolution without throwing.
import { describe, it, expect } from 'vitest';
import { perils, freshGame, cat, label, collectTreeProblems } from './helpers';
import { autoResolveTree } from '../src/engine/encounter';
import { perilAffects } from '../src/engine/sauronmech';

const locationIds = Object.keys(cat.locations);

describe('perils — data integrity + tree consistency', () => {
  it.each(perils.map((p) => [label(`${p.id} (${p.name})`), p] as const))(
    '%s has valid peril data and a tree matching its partial flag', (_n, p) => {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.tree, `${p.id}: no tree`).toBeTruthy();
      const problems = collectTreeProblems(p.tree, p.id);
      if (p.partial) {
        expect(problems.length, `${p.id} flagged partial but is fully modeled — clear the flag`).toBeGreaterThan(0);
      } else {
        expect(problems, `${p.id} has raw remainder but is NOT flagged partial: ${problems.join('; ')}`).toEqual([]);
      }
    });

  it('has exactly the known set of partially-modeled perils', () => {
    const partial = perils.filter((p) => p.partial).map((p) => p.id).sort();
    expect(partial.length, `partial perils: ${partial.join(', ')}`).toBe(0);
  });
});

describe('perils — region reachability', () => {
  it.each(perils.map((p) => [label(`${p.id}`), p] as const))(
    '%s affects at least one location and never throws', (_n, p) => {
      let affectedCount = 0;
      for (const loc of locationIds) {
        let res!: boolean;
        expect(() => { res = perilAffects(cat, p.id, loc); }, `${p.id} @ ${loc} threw`).not.toThrow();
        expect(typeof res).toBe('boolean');
        if (res) affectedCount++;
      }
      expect(affectedCount, `${p.id} affects no location`).toBeGreaterThan(0);
    });
});

describe('perils — auto-resolve against a fresh game', () => {
  it.each(perils.map((p) => [label(`${p.id}`), p] as const))(
    '%s auto-resolves without throwing', (_n, p) => {
      const s = freshGame();
      const hero = s.heroes[0];
      expect(() => autoResolveTree(s, cat, hero.id, p.tree, `test:${p.id}`)).not.toThrow();
    });
});
