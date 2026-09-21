// Regression: the hero-visible log line for a Sauron "Place Influence" or
// "Place Monster Token" command must report only the mechanical fact (where,
// how much) — never the AI's hidden strategic reasoning (which plot it is
// building toward, which route it is guarding, which hero it is targeting).
// That reasoning is Sauron-side secret information in the physical game.
import { describe, it, expect } from 'vitest';
import { freshGame, cat } from './helpers';
import { eyePlaceInfluenceOnce, eyeSpawnMonsterOnce } from '../src/engine/ai';

function collectLogs(fn: (log: (msg: string) => void) => void): string[] {
  const lines: string[] = [];
  fn((msg) => lines.push(msg));
  return lines;
}

describe('Sauron AI hero-visible log hides strategic intent', () => {
  it('eyePlaceInfluenceOnce never mentions a plot name or hero path', () => {
    const s = freshGame();
    const lines = collectLogs((log) => {
      for (let i = 0; i < 5; i++) eyePlaceInfluenceOnce(s, cat, log);
    });
    for (const line of lines) {
      expect(line, line).not.toMatch(/preparing plot|toward .*'s path|perilous road/i);
    }
  });

  it('eyeSpawnMonsterOnce never reveals it is guarding a plot', () => {
    const s = freshGame();
    // Seed an active plot with board influence at a hero-free location so the
    // "guard the plot" branch is reachable.
    const anyLoc = Object.keys(cat.locations)[0];
    s.sauron.activePlots = [{ eventId: 'plot-x', location: anyLoc } as unknown as (typeof s.sauron.activePlots)[number]];
    s.sauron.locationInfluence = { [anyLoc]: 3 };
    const lines = collectLogs((log) => {
      eyeSpawnMonsterOnce(s, cat, log);
    });
    for (const line of lines) {
      expect(line, line).not.toMatch(/guard/i);
    }
  });
});
