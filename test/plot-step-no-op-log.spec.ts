import { describe, it, expect } from 'vitest';
import { freshGame, cat } from './helpers';
import { advancePlots } from '../src/engine/sauronmech';

// Regression: the Plot Step used to be completely silent when no plot could
// be played (e.g. turn 1, before any board requirement has been prepared),
// leaving a hero unable to tell whether the AI even considered playing a plot
// that turn. Now it always logs a mechanical reason (no hidden strategic
// intent — never names which plot or its target) so the step is legible.
describe('Plot Step logs a reason when no plot can be played', () => {
  it('logs "no plot card in hand" when the hand is empty', () => {
    let s = freshGame();
    s.sauron.plotHand = [];
    const msgs: string[] = [];
    const played = advancePlots(s, cat, false, (m) => msgs.push(m));
    expect(played).toBe(false);
    expect(msgs.some((m) => m.includes('no plot card in hand'))).toBe(true);
  });

  it('logs "all 3 plot slots are full" when active plots are maxed out', () => {
    let s = freshGame();
    s.sauron.activePlots = [
      { eventId: 'x1', location: undefined as any },
      { eventId: 'x2', location: undefined as any },
      { eventId: 'x3', location: undefined as any },
    ] as any;
    const msgs: string[] = [];
    const played = advancePlots(s, cat, false, (m) => msgs.push(m));
    expect(played).toBe(false);
    expect(msgs.some((m) => m.includes('slots are full'))).toBe(true);
  });

  it('logs an unplayable-hand breakdown without naming which plot or target', () => {
    let s = freshGame();
    // Give Sauron a hand plot with an unmet board requirement (needs
    // concentrated influence Sauron has not placed yet) and no Shadow Pool.
    const unmet = cat.plots.find((p) => !p.starting && p.condition);
    expect(unmet).toBeDefined();
    s.sauron.plotHand = [unmet!.id];
    s.sauron.influence = 0;
    const msgs: string[] = [];
    const played = advancePlots(s, cat, false, (m) => msgs.push(m));
    expect(played).toBe(false);
    expect(msgs.some((m) => m.includes('none playable yet'))).toBe(true);
    expect(msgs.some((m) => m.includes(unmet!.name))).toBe(false);
  });
});
