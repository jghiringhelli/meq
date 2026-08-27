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
import { maybeDrawPeril } from '../src/engine/sauronmech';
import { sauronPlayShadow } from '../src/engine/sauronPlay';
import { sauronResolveEvents } from '../src/engine/game';
import { resolveShadowReaction, resolveTreeDecision, autoResolvePendingTree } from '../src/engine/game';
import { beginCombat } from '../src/engine/combat';
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

describe('Peril "Choose one" is the hero\'s decision', () => {
  const ILL_MET = 'peril-ill-met-company';
  /** A perilous non-Haven location seeded so a hero-choice Peril is drawn. */
  function perilSetup(human: 'Hero' | 'Sauron'): { s: GameState; heroId: string; loc: string } {
    const s = freshGame();
    s.humanSide = human;
    s.sauronReactsAuto = false;
    const heroId = s.heroes[0].id;
    const loc = Object.keys(cat.locations).find((l) => cat.locations[l].kind !== 'haven')!;
    s.sauron.locationInfluence = { [loc]: 99 }; // influence >> wisdom -> perilous
    s.sauron.perilDeck = [ILL_MET, ILL_MET, ILL_MET];
    s.sauron.perilDiscard = [];
    return { s, heroId, loc };
  }

  it('pauses for a HUMAN hero with the two printed options', () => {
    const { s, heroId, loc } = perilSetup('Hero');
    maybeDrawPeril(s, cat, heroId, loc);
    expect(s.pendingTree?.actor).toBe('hero');
    expect(s.pendingTree?.cardId).toBe(ILL_MET);
    expect(s.pendingTree?.options.length).toBe(2);
    const s2 = resolveTreeDecision(s, cat, 0); // "lose 2 favor"
    expect(s2.pendingTree).toBeFalsy();
  });

  it('auto-resolves (no pause) when the hero is AI', () => {
    const { s, heroId, loc } = perilSetup('Sauron');
    maybeDrawPeril(s, cat, heroId, loc);
    expect(s.pendingTree).toBeFalsy();
  });

  it('autoResolvePendingTree clears a paused hero Peril decision', () => {
    const { s, heroId, loc } = perilSetup('Hero');
    maybeDrawPeril(s, cat, heroId, loc);
    expect(s.pendingTree).toBeTruthy();
    const s2 = autoResolvePendingTree(s, cat);
    expect(s2.pendingTree).toBeFalsy();
  });
});

describe('Dark Promises at combat start is the HUMAN hero\'s decision', () => {
  function darkSetup() {
    const s = freshGame();
    s.humanSide = 'Hero';                 // AI Sauron plays the card on a human hero
    s.shadowPlayedThisHeroTurn = false;
    s.sauron.shadowHand = [DARK_PROMISES];
    s.sauron.shadowDiscard = [];
    s.sauron.influence = 12;
    const heroId = s.heroes[0].id;
    const loc = s.heroes[0].location;
    const monsterId = Object.keys(cat.monsters)[0];
    (s.map.monstersAt[loc] ||= []).push(monsterId);
    return { s, heroId, loc, monsterId };
  }

  it('pauses combat for the human hero, owing the Preparation resume', () => {
    const { s, heroId, loc, monsterId } = darkSetup();
    const out = beginCombat(s, cat, heroId, monsterId, loc);
    expect(out.pendingTree?.sourceKind).toBe('shadow');
    expect(out.pendingTree?.actor).toBe('hero');
    expect(out.pendingTree?.cardId).toBe(DARK_PROMISES);
    expect(out.pendingTree?.resumeCombat).toBe(true);
    expect(out.pendingCombat).toBeTruthy();
    expect(out.pendingChoice).toBeFalsy(); // Preparation deferred until the hero chooses
  });

  it('resolving the choice applies it and resumes into the combat step', () => {
    const { s, heroId, loc, monsterId } = darkSetup();
    const paused = beginCombat(s, cat, heroId, monsterId, loc);
    const before = paused.heroes.find((h) => h.id === heroId)!.life;
    const out = resolveTreeDecision(paused, cat, 1); // "be dealt 5 damage"
    expect(out.pendingTree).toBeFalsy();
    expect(out.heroes.find((h) => h.id === heroId)!.life).toBeLessThan(before);
    expect(out.pendingChoice || out.pendingCombat).toBeTruthy();
  });

  it('an AI hero (human plays the Eye) auto-resolves with no pause', () => {
    const { s, heroId, loc, monsterId } = darkSetup();
    s.humanSide = 'Sauron';
    s.sauronReactsAuto = true; // automa Eye
    const out = beginCombat(s, cat, heroId, monsterId, loc);
    expect(out.pendingTree).toBeFalsy();
    expect(out.sauron.shadowDiscard).toContain(DARK_PROMISES);
  });
});

describe('Event "Choose one" is the hero\'s decision', () => {
  const TEMPTED = 'event-t1-tempted-by-power';
  function eventSetup(human: 'Hero' | 'Sauron'): GameState {
    const s = freshGame();
    s.humanSide = human;
    s.phase = 'SauronEvents';
    s.sauron.eventStage = 1; // matches t1 events; skip the deck rebuild
    s.sauron.eventDeck = [TEMPTED, TEMPTED, TEMPTED];
    s.sauron.eventDiscard = [];
    return s;
  }

  it('pauses for a HUMAN hero, after placing tokens and advancing the phase', () => {
    const s2 = sauronResolveEvents(eventSetup('Hero'), cat);
    expect(s2.pendingTree?.sourceKind).toBe('event');
    expect(s2.pendingTree?.actor).toBe('hero');
    expect(s2.pendingTree?.cardId).toBe(TEMPTED);
    // The board placement + phase transition already ran (reordered ahead of the
    // pausing effect), so resuming needs no further continuation.
    expect(s2.phase).toBe('SauronMinions');
    const s3 = resolveTreeDecision(s2, cat, 0);
    expect(s3.pendingTree).toBeFalsy();
  });

  it('auto-resolves the event (no pause) when the hero is AI', () => {
    const s2 = sauronResolveEvents(eventSetup('Sauron'), cat);
    expect(s2.pendingTree).toBeFalsy();
    expect(s2.phase).toBe('SauronMinions');
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
