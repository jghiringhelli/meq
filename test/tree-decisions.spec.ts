// Interactive card-internal decisions (fidelity): the PLAYER who controls a
// card's printed choice makes it when human, instead of the engine auto-picking.
// Increment 1 covers the Eye's OWN choices on Shadow cards played by a HUMAN
// Sauron (A New Power / An Evil Fog / Do not tempt me! own-turn, Morgul-Blade at
// combat start). The automa still auto-resolves with no pause, and a hero-owned
// Shadow choice (Dark Promises) whose hero is AI here also auto-resolves.
import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { treeActor } from '../src/engine/encounter';
import { playSpecificShadow, raiseShadowReaction } from '../src/engine/sauronmech';
import { sauronPlayShadow } from '../src/engine/sauronPlay';
import { resolveShadowReaction, resolveTreeDecision } from '../src/engine/game';
import type { GameState } from '../src/engine/types';

const NEW_POWER = 'shadow-a-new-power-is-rising'; // action, choice, pool 4
const EVIL_FOG = 'shadow-an-evil-fog';            // action, optional, pool 1
const MORGUL = 'shadow-morgul-blade';             // combat-start (minion), choice, pool 6
const DARK_PROMISES = 'shadow-dark-promises';      // combat-start, HERO choice

/** A game where a human plays the Eye with `card` affordable and it is his turn. */
function humanSauron(card: string, influence = 12): { s: GameState; heroId: string } {
  const s = freshGame();
  s.humanSide = 'Sauron';
  s.sauronReactsAuto = false;
  s.phase = 'SauronMinions';
  s.sauronPending = undefined as unknown as GameState['sauronPending'];
  s.shadowPlayedThisSauronTurn = false;
  s.shadowPlayedThisHeroTurn = false;
  s.sauron.shadowHand = [card];
  s.sauron.shadowDiscard = [];
  s.sauron.influence = influence;
  return { s, heroId: s.heroes[0].id };
}

describe('treeActor attribution', () => {
  it('assigns Shadow choices to Sauron, except Dark Promises (hero)', () => {
    expect(treeActor('shadow', NEW_POWER)).toBe('sauron');
    expect(treeActor('shadow', MORGUL)).toBe('sauron');
    expect(treeActor('shadow', 'shadow-dark-promises')).toBe('hero');
    expect(treeActor('shadow', 'shadow-dark-promises-2')).toBe('hero');
  });

  it('assigns Peril/Event choices to the hero, except "Nine for Mortal Men" (Sauron)', () => {
    expect(treeActor('peril', 'peril-ill-met-company')).toBe('hero');
    expect(treeActor('peril', 'peril-nine-for-mortal-men-doomed-to-die')).toBe('sauron');
    expect(treeActor('event', 'event-t1-tempted-by-power')).toBe('hero');
    expect(treeActor('encounter', 'anything')).toBe('hero');
  });
});

describe('human-Sauron own-turn Shadow choices are interactive', () => {
  it('A New Power pauses with the two printed options for the human Eye', () => {
    const { s } = humanSauron(NEW_POWER);
    const s2 = sauronPlayShadow(s, cat, NEW_POWER);
    expect(s2.pendingTree?.actor).toBe('sauron');
    expect(s2.pendingTree?.cardId).toBe(NEW_POWER);
    expect(s2.pendingTree?.options.length).toBe(2);
    expect(s2.pendingTree?.options.every((o) => o.enabled)).toBe(true);
    // The card is committed even while its internal choice is pending.
    expect(s2.shadowPlayedThisSauronTurn).toBe(true);
    expect(s2.sauron.shadowDiscard).toContain(NEW_POWER);
  });

  it('resolving the paused choice applies it and clears the pending decision', () => {
    const { s } = humanSauron(NEW_POWER);
    const s2 = sauronPlayShadow(s, cat, NEW_POWER);
    const s3 = resolveTreeDecision(s2, cat, 1); // "place 2 monster tokens"
    expect(s3.pendingTree).toBeFalsy();
  });

  it('An Evil Fog (optional) offers the effect and a decline option', () => {
    const { s } = humanSauron(EVIL_FOG);
    const s2 = sauronPlayShadow(s, cat, EVIL_FOG);
    expect(s2.pendingTree?.actor).toBe('sauron');
    expect(s2.pendingTree?.options.length).toBe(2); // move-hero + decline
    const s3 = resolveTreeDecision(s2, cat, s2.pendingTree!.options.length - 1); // decline
    expect(s3.pendingTree).toBeFalsy();
  });

  it('rejects an illegal option index', () => {
    const { s } = humanSauron(NEW_POWER);
    const s2 = sauronPlayShadow(s, cat, NEW_POWER);
    expect(() => resolveTreeDecision(s2, cat, 9)).toThrow();
  });
});

describe('Morgul-Blade at combat start is interactive for the human Eye', () => {
  it('pauses carrying the owed combat resume, and applies the chosen effect', () => {
    const { s, heroId } = humanSauron(MORGUL);
    // Give the hero corruption so both branches are meaningful.
    const hero = s.heroes.find((h) => h.id === heroId)!;
    hero.corruption = 1;
    const before = hero.life;
    raiseShadowReaction(s, cat, 'combat-start', { heroId, isMinionCombat: true }, true);
    expect(s.pendingShadowReaction?.options.map((o) => o.id)).toContain(MORGUL);
    const s2 = resolveShadowReaction(s, cat, MORGUL);
    expect(s2.pendingTree?.actor).toBe('sauron');
    expect(s2.pendingTree?.resumeCombat).toBe(true);
    // Pick "3 damage and 1 Corruption" (index 1) and confirm the hero is hit.
    const s3 = resolveTreeDecision(s2, cat, 1);
    expect(s3.pendingTree).toBeFalsy();
    const after = s3.heroes.find((h) => h.id === heroId)!;
    expect(after.life).toBeLessThan(before);
  });
});

describe('the automa and AI-owned choices never pause', () => {
  it('AI Sauron (reactions auto) auto-resolves A New Power with no pending', () => {
    const { s, heroId } = humanSauron(NEW_POWER);
    s.sauronReactsAuto = true;
    const target = s.heroes.find((h) => h.id === heroId)!;
    playSpecificShadow(s, cat, NEW_POWER, target, 'action');
    expect(s.pendingTree).toBeFalsy();
  });

  it('a hero-owned Shadow choice (Dark Promises) auto-resolves when its hero is AI', () => {
    const { s, heroId } = humanSauron(DARK_PROMISES);
    s.shadowPlayedThisHeroTurn = false;
    raiseShadowReaction(s, cat, 'combat-start', { heroId }, false);
    const s2 = resolveShadowReaction(s, cat, DARK_PROMISES);
    expect(s2.pendingTree).toBeFalsy();
  });
});
