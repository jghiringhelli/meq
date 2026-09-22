import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { shadowScoreFor } from '../src/engine/sauronmech';

// Regression: shadowScoreFor used to apply the "hold a hand-dump card while
// the target isn't hoarding" timing penalty to EVERY Shadow card with a
// discardHand op, including conditional/fixed discards (An Evil Fog's "1 per
// Corruption card", Betrayed's flat "discard 2") that have no hoarding upside
// to wait for — their impact only ever grows as the game progresses. This
// silently starved the Eye of its only cheap (poolRequirement 1) action-step
// play, "An Evil Fog", for the entire early game whenever the target hero
// held 0-1 Corruption cards (a near-universal early-game state), making it
// look like the AI "never plays Shadow cards". Only a true "discard down to
// N" hoard-stripper (a card with a printed `toHand` cap, e.g. Storms of
// Mordor) should still be held for a hoarding hero.
describe('Sauron Shadow AI: conditional discards are not penalised like hoard-strippers', () => {
  it('An Evil Fog scores non-negative even against a hero with 0 Corruption cards', () => {
    const card = cat.shadow['shadow-an-evil-fog'];
    expect(card).toBeDefined();
    const score = shadowScoreFor(card, { hand: ['a', 'b', 'c'], corruptionCards: [] }, 'balanced');
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('Storms of Mordor (a true hoard-stripper) scores much lower against a small hand than a hoarding one', () => {
    const card = cat.shadow['shadow-storms-of-mordor'];
    // Target hand already at/below the toHand cap (5) — stripping it now gains nothing.
    const smallHandScore = shadowScoreFor(card, { hand: ['a', 'b'], corruptionCards: [] }, 'balanced');
    const hoardingScore = shadowScoreFor(card, { hand: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], corruptionCards: [] }, 'balanced');
    expect(smallHandScore).toBeLessThan(hoardingScore);
  });

  it('Storms of Mordor scores well against a genuinely hoarding hand', () => {
    const card = cat.shadow['shadow-storms-of-mordor'];
    const score = shadowScoreFor(card, { hand: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], corruptionCards: [] }, 'balanced');
    expect(score).toBeGreaterThan(0);
  });
});
