// One test per Plot card: data integrity and application (applyPlotCard) against
// a fresh game without throwing.
import { describe, it, expect } from 'vitest';
import { plots, freshGame, cat, label } from './helpers';
import { applyPlotCard, staticPlotValue } from '../src/engine/sauronmech';

const VALID_MARKER = new Set(['yellow', 'red', 'black']);

describe('plots — data integrity', () => {
  it.each(plots.map((p) => [label(`${p.id} (${p.name})`), p] as const))(
    '%s has valid plot data', (_n, p) => {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      if (p.marker !== undefined) expect(VALID_MARKER.has(p.marker)).toBe(true);
      if (p.advance !== undefined) {
        expect(Number.isFinite(p.advance)).toBe(true);
        expect(p.advance).toBeGreaterThanOrEqual(0);
      }
      expect(Array.isArray(p.track)).toBe(true);
      // staticPlotValue must produce a finite ranking score
      expect(Number.isFinite(staticPlotValue(p))).toBe(true);
    });
});

describe('plots — apply against a fresh game', () => {
  it.each(plots.map((p) => [label(`${p.id}`), p] as const))(
    '%s applyPlotCard runs without throwing', (_n, p) => {
      const s = freshGame();
      expect(() => applyPlotCard(s, cat, p, 0)).not.toThrow();
    });
});
