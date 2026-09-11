// One test per Plot card: data integrity and application (applyPlotCard) against
// a fresh game without throwing.
import { describe, it, expect } from 'vitest';
import { plots, freshGame, cat, label } from './helpers';
import { applyPlotCard, staticPlotValue } from '../src/engine/sauronmech';
import { targetablePlot, canDiscardPlot } from '../src/engine/economy';
import type { LocationId } from '../src/engine/types';

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

describe('plots — location resolution fallback (regression)', () => {
  it('a plot with only affectsText (no affects id) still resolves to its real board location', () => {
    // gollum-is-captured is a real regression case: its data now carries
    // affects: "sea-of-udun" directly, but the fallback path (affectsText ->
    // locByName) is what plots relying solely on affectsText (e.g.
    // s-monsters-in-the-east, orcs-in-the-mountains, gollum-is-tortured) need.
    const p = plots.find((x) => x.id === 'gollum-is-tortured')!;
    expect(p.affects).toBeFalsy();
    expect(p.affectsText).toBeTruthy();
    const s = freshGame();
    applyPlotCard(s, cat, p, 0);
    const placed = s.sauron.activePlots!.find((e) => e.eventId === p.id)!;
    expect(placed.location).toBe('barad-dur');
  });

  it('gollum-is-captured resolves to Sea of Udun, not an undefined/garbled location', () => {
    const p = plots.find((x) => x.id === 'gollum-is-captured')!;
    const s = freshGame();
    applyPlotCard(s, cat, p, 0);
    const placed = s.sauron.activePlots!.find((e) => e.eventId === p.id)!;
    expect(placed.location).toBe('sea-of-udun');
  });

  it('a hero cannot counter a plot from an unrelated plot-slot location', () => {
    const p = plots.find((x) => x.id === 'gollum-is-captured')!;
    const s = freshGame();
    applyPlotCard(s, cat, p, 0);
    // Lothlorien is a plot-slot location, but not where this plot is placed.
    const hero = s.heroes[s.activeHeroIndex];
    hero.location = 'lothl-rien' as LocationId;
    expect(targetablePlot(s, cat, hero.id)).toBeUndefined();
    expect(canDiscardPlot(s, cat, hero.id)).toBe(false);
    // ...but it IS targetable from its real location, Sea of Udun.
    hero.location = 'sea-of-udun' as LocationId;
    expect(targetablePlot(s, cat, hero.id)?.eventId).toBe(p.id);
  });
});
