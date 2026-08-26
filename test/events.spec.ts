// One test per Event card: data integrity, op validity, and application without
// throwing. Events carry a parsed `ops` list (applied in the Event Step) and,
// where a richer effect was compiled, a `tree`.
import { describe, it, expect } from 'vitest';
import { events, freshGame, cat, label, collectTreeProblems } from './helpers';
import { autoResolveTree } from '../src/engine/encounter';
import { applyOps } from '../src/engine/noncombat';

const VALID_KIND = new Set(['mechanical', 'flavor', 'empty']);
const KNOWN_OPS = new Set([
  'gainFavor', 'loseFavor', 'gainCorruption', 'removeCorruption',
  'addInfluence', 'removeInfluence', 'damage',
]);

describe('events — data integrity', () => {
  it.each(events.map((e) => [label(`${e.id} (${e.name})`), e] as const))(
    '%s has valid event data', (_n, e) => {
      expect(e.id).toBeTruthy();
      expect(e.name).toBeTruthy();
      expect(VALID_KIND.has(e.effectKind)).toBe(true);
      expect(Array.isArray(e.ops)).toBe(true);
      for (const o of e.ops) {
        expect(KNOWN_OPS.has(o.op), `${e.id}: unknown op '${o.op}'`).toBe(true);
        expect(Number.isInteger(o.n), `${e.id}: op '${o.op}' amount not integer`).toBe(true);
      }
      if (e.effectKind === 'mechanical') expect(e.ops.length, `${e.id}: mechanical but no ops`).toBeGreaterThan(0);
      if (e.effectKind === 'flavor') expect(e.ops.length, `${e.id}: flavor but has ops`).toBe(0);
    });
});

describe('events — ops apply without throwing', () => {
  it.each(events.filter((e) => e.ops.length).map((e) => [label(`${e.id}`), e] as const))(
    '%s applyOps runs', (_n, e) => {
      const s = freshGame();
      const hero = s.heroes[0];
      expect(() => applyOps(s, cat, hero.id, e.ops, `test:${e.id}`)).not.toThrow();
    });
});

describe('events — compiled tree (when present) is consistent and resolves', () => {
  it.each(events.filter((e) => e.tree).map((e) => [label(`${e.id}`), e] as const))(
    '%s tree matches its partial flag and auto-resolves', (_n, e) => {
      const problems = collectTreeProblems(e.tree, e.id);
      if (e.partial) {
        // A flagged-partial card is a known modeling gap: it MUST still contain
        // an unmodeled remainder (else the flag is stale).
        expect(problems.length, `${e.id} flagged partial but is fully modeled — clear the flag`).toBeGreaterThan(0);
      } else {
        expect(problems, `${e.id} has raw remainder but is NOT flagged partial: ${problems.join('; ')}`).toEqual([]);
      }
      const s = freshGame();
      const hero = s.heroes[0];
      expect(() => autoResolveTree(s, cat, hero.id, e.tree, `test:${e.id}`)).not.toThrow();
    });

  // Pin the known-partial backlog so it can only shrink, never silently grow.
  it('has exactly the known set of partially-modeled events', () => {
    const partial = events.filter((e) => e.partial).map((e) => e.id).sort();
    expect(partial.length, `partial events: ${partial.join(', ')}`).toBe(0);
  });
});
