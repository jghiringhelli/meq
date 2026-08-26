// One test per Encounter card: data integrity, a well-formed compiled tree, and
// a real auto-resolution against a fresh game that must not throw.
import { describe, it, expect } from 'vitest';
import { encounters, freshGame, cat, label, collectTreeProblems } from './helpers';
import { autoResolveTree } from '../src/engine/encounter';
import { applyOps } from '../src/engine/noncombat';

const VALID_KIND = new Set(['mechanical', 'flavor', 'empty']);
const KNOWN_OPS = new Set([
  'gainFavor', 'loseFavor', 'gainCorruption', 'removeCorruption',
  'addInfluence', 'removeInfluence', 'damage',
]);

describe('encounters — data integrity', () => {
  it.each(encounters.map((e) => [label(`${e.id} (${e.name})`), e] as const))(
    '%s has valid encounter data', (_n, e) => {
      expect(e.id).toBeTruthy();
      expect(e.name).toBeTruthy();
      expect(VALID_KIND.has(e.effectKind)).toBe(true);
      expect(Array.isArray(e.ops)).toBe(true);
      for (const o of e.ops) {
        expect(KNOWN_OPS.has(o.op), `${e.id}: unknown op '${o.op}'`).toBe(true);
        expect(Number.isInteger(o.n), `${e.id}: op '${o.op}' amount not integer`).toBe(true);
      }
      // mechanical <=> has ops
      if (e.effectKind === 'mechanical') expect(e.ops.length, `${e.id}: mechanical but no ops`).toBeGreaterThan(0);
      if (e.effectKind === 'flavor') expect(e.ops.length, `${e.id}: flavor but has ops`).toBe(0);
    });
});

describe('encounters — compiled tree is well-formed', () => {
  it.each(encounters.map((e) => [label(`${e.id} (${e.name})`), e] as const))(
    '%s has a fully-modeled tree', (_n, e) => {
      expect(e.tree, `${e.id}: no tree`).toBeTruthy();
      const problems = collectTreeProblems(e.tree, e.id);
      expect(problems, problems.join('; ')).toEqual([]);
    });
});

describe('encounters — auto-resolve against a fresh game', () => {
  it.each(encounters.map((e) => [label(`${e.id} (${e.name})`), e] as const))(
    '%s auto-resolves without throwing', (_n, e) => {
      const s = freshGame();
      const hero = s.heroes[0];
      const run = () => autoResolveTree(s, cat, hero.id, e.tree, `test:${e.id}`);
      expect(run, `${e.id} threw during auto-resolve`).not.toThrow();
    });
});

describe('encounters — ops apply without throwing', () => {
  it.each(encounters.filter((e) => e.ops.length).map((e) => [label(`${e.id}`), e] as const))(
    '%s applyOps runs', (_n, e) => {
      const s = freshGame();
      const hero = s.heroes[0];
      expect(() => applyOps(s, cat, hero.id, e.ops, `test:${e.id}`)).not.toThrow();
    });
});
