import { describe, it, expect } from 'vitest';
import { freshGame, cat } from './helpers';
import { advance } from '../src/engine/phases';

// Regression test for a bug where the on-board green Hero marker never moved:
// the UI rendered a `story.heroMarker` field that was initialized to 0 and
// never updated anywhere in the engine, while the actual live hero-clock value
// (`story.sauronProgress`, driven by the Story Step and by hero Rest) is what
// determines win conditions. The dead field has been removed; all rendering
// now reads `sauronProgress` directly, so it must move in lockstep with the
// Story Step.
describe('story track hero marker stays in sync with the engine hero clock', () => {
  it('Story Step (turn > 1) advances sauronProgress, the only hero-marker source', () => {
    let s = freshGame();
    s.phase = 'SauronRefresh';
    s.activeSide = 'Sauron';
    s.story.turn = 2;
    const before = s.story.sauronProgress;
    s = advance(s, cat);
    expect(s.story.sauronProgress).toBe(before + 2);
    // No separate `heroMarker` field exists to fall out of sync.
    expect((s.story as any).heroMarker).toBeUndefined();
  });
});
