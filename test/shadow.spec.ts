// One test per Shadow card: data integrity, a well-formed tree, a classifiable
// play timing window, and auto-resolution (the hero is the target) without
// throwing.
import { describe, it, expect } from 'vitest';
import { shadowCards, freshGame, cat, label, collectTreeProblems } from './helpers';
import { autoResolveTree } from '../src/engine/encounter';
import { shadowWindow } from '../src/engine/sauronmech';

const VALID_WINDOWS = new Set(['combat-start', 'enter-nonhaven', 'hero-defeated', 'hero-turn', 'action']);

describe('shadow cards — data integrity + tree consistency', () => {
  it.each(shadowCards.map((c) => [label(`${c.id} (${c.name})`), c] as const))(
    '%s has valid shadow data and a tree matching its partial flag', (_n, c) => {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.tree, `${c.id}: no tree`).toBeTruthy();
      const problems = collectTreeProblems(c.tree, c.id);
      if (c.partial) {
        expect(problems.length, `${c.id} flagged partial but is fully modeled — clear the flag`).toBeGreaterThan(0);
      } else {
        expect(problems, `${c.id} has raw remainder but is NOT flagged partial: ${problems.join('; ')}`).toEqual([]);
      }
    });

  it('has exactly the known set of partially-modeled shadow cards', () => {
    const partial = shadowCards.filter((c) => c.partial).map((c) => c.id).sort();
    expect(partial.length, `partial shadow: ${partial.join(', ')}`).toBe(0);
  });
});

describe('shadow cards — play timing window is classifiable', () => {
  it.each(shadowCards.map((c) => [label(`${c.id}`), c] as const))(
    '%s maps to a known shadow window', (_n, c) => {
      const w = shadowWindow(c.timing);
      expect(VALID_WINDOWS.has(w), `${c.id}: unclassified window '${w}' from timing '${c.timing}'`).toBe(true);
    });
});

describe('shadow cards — auto-resolve against a fresh game', () => {
  it.each(shadowCards.map((c) => [label(`${c.id}`), c] as const))(
    '%s auto-resolves without throwing', (_n, c) => {
      const s = freshGame();
      const hero = s.heroes[0];
      expect(() => autoResolveTree(s, cat, hero.id, c.tree, `test:${c.id}`)).not.toThrow();
    });
});
