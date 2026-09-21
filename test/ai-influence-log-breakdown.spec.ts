// Regression: the AI's Place Influence action previously only logged the FIRST
// of several board placements (phases.ts passed `logMsg` only when
// `placed === 0`), so a "6 influence, 2 to pool, 4 on board" action left 3 of
// the 4 board placements invisible in the hero-visible log. Every placement
// must now be logged individually so a player can see exactly where each
// influence point went.
import { describe, it, expect } from 'vitest';
import { freshGame, cat } from './helpers';
import { advance } from '../src/engine/phases';

describe('Sauron AI Place Influence logs every board placement', () => {
  it('logs one line per placed token, not just the first', () => {
    let s = freshGame();
    s.phase = 'SauronMinions';
    // Bias the AI's track scoring toward "influence": push story progress into
    // the 0.5–2/3 band (draw score drops to 34, influence stays at 56) and
    // ensure the Shadow hand already has cards (so draw's "hand<2" bonus is off).
    s.story.length = 10;
    s.story.sauronProgress = 6; // frac = 0.6
    s.sauron.shadowHand = ['shadow-x', 'shadow-y'];
    s.sauron.influence = 4; // pool already at the stage-1 cap (4*1) -> bank = 0, all yield goes to board
    s = advance(s, cat);
    const placementLines = s.log
      .map((e) => e.detail)
      .filter((m) => /^places influence at /.test(m));
    const summaryLines = s.log.map((e) => e.detail).filter((m) => /^Place Influence action/.test(m));
    expect(summaryLines.length, JSON.stringify(s.log.map((e) => e.detail))).toBeGreaterThan(0);
    const totalLaid = summaryLines.reduce((n, m) => n + Number(/laid (\d+) on board/.exec(m)?.[1] ?? 0), 0);
    expect(totalLaid).toBeGreaterThan(1);
    expect(placementLines.length).toBe(totalLaid);
  });
});
