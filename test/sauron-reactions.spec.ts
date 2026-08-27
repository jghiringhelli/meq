// Interactive human-Sauron reaction Shadow windows (rulebook p.20): during the
// heroes' turns a HUMAN Sauron may play ONE reaction Shadow card per hero turn,
// at four windows (enter-nonhaven, hero-turn, combat-start, hero-defeated). The
// engine PAUSES (pendingShadowReaction) and offers him the affordable matching
// cards plus Pass; the automa still auto-plays the best card with no pause.
import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { raiseShadowReaction, playShadowReaction, sauronAuto } from '../src/engine/sauronmech';
import { resolveShadowReaction } from '../src/engine/game';
import { beginCombat } from '../src/engine/combat';
import { applyAction } from '../src/engine/actions';
import type { GameState } from '../src/engine/types';

const ENTER = 'shadow-his-arm-has-grown-long'; // enter-nonhaven, pool 2
const COMBAT = 'shadow-betrayed';               // combat-start, pool 1
const DEFEAT = 'shadow-evil-wound';             // hero-defeated, pool 7

/** A game where a human plays Sauron with `card` affordable in the Shadow hand. */
function humanSauron(card: string, influence = 12): { s: GameState; heroId: string } {
  const s = freshGame();
  s.humanSide = 'Sauron';
  s.shadowPlayedThisHeroTurn = false;
  s.sauron.shadowHand = [card];
  s.sauron.shadowDiscard = [];
  s.sauron.influence = influence;
  return { s, heroId: s.heroes[0].id };
}

describe('human-Sauron reaction Shadow windows', () => {
  it('raises a pending reaction offering the affordable matching card', () => {
    const { s, heroId } = humanSauron(ENTER);
    const raised = raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId });
    expect(raised).toBe(true);
    expect(s.pendingShadowReaction?.window).toBe('enter-nonhaven');
    expect(s.pendingShadowReaction?.heroId).toBe(heroId);
    expect(s.pendingShadowReaction?.options.map((o) => o.id)).toContain(ENTER);
  });

  it('does not raise when nothing in hand matches the window', () => {
    const { s, heroId } = humanSauron(ENTER);
    // COMBAT-start card cannot be played at the enter window
    s.sauron.shadowHand = [COMBAT];
    expect(raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId })).toBe(false);
    expect(s.pendingShadowReaction).toBeFalsy();
  });

  it('does not raise once a Shadow card was already played this hero turn', () => {
    const { s, heroId } = humanSauron(ENTER);
    s.shadowPlayedThisHeroTurn = true;
    expect(raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId })).toBe(false);
    expect(s.pendingShadowReaction).toBeFalsy();
  });

  it('never raises during the Finale (errata: no Shadow cards)', () => {
    const { s, heroId } = humanSauron(ENTER);
    s.story.finale = true;
    expect(raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId })).toBe(false);
  });

  it('resolving with a card plays it, discards it, and spends the once-per-turn window', () => {
    const { s, heroId } = humanSauron(ENTER);
    raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId });
    const out = resolveShadowReaction(s, cat, ENTER);
    expect(out.pendingShadowReaction).toBeFalsy();
    expect(out.shadowPlayedThisHeroTurn).toBe(true);
    expect(out.sauron.shadowDiscard).toContain(ENTER);
    expect(out.sauron.shadowHand).not.toContain(ENTER);
  });

  it('passing plays nothing and does NOT spend the once-per-turn window', () => {
    const { s, heroId } = humanSauron(ENTER);
    raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId });
    const out = resolveShadowReaction(s, cat, null);
    expect(out.pendingShadowReaction).toBeFalsy();
    expect(out.shadowPlayedThisHeroTurn).toBe(false);
    expect(out.sauron.shadowHand).toContain(ENTER);
  });

  it('rejects a card that was not offered', () => {
    const { s, heroId } = humanSauron(ENTER);
    raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId });
    expect(() => resolveShadowReaction(s, cat, COMBAT)).toThrow();
  });

  it('handles the hero-defeated window (no combat resume)', () => {
    const { s, heroId } = humanSauron(DEFEAT);
    raiseShadowReaction(s, cat, 'hero-defeated', { heroId });
    expect(s.pendingShadowReaction?.window).toBe('hero-defeated');
    const out = resolveShadowReaction(s, cat, DEFEAT);
    expect(out.shadowPlayedThisHeroTurn).toBe(true);
    expect(out.sauron.shadowDiscard).toContain(DEFEAT);
  });

  it('the automa (human plays heroes) auto-plays with NO pause', () => {
    const { s, heroId } = humanSauron(ENTER);
    s.humanSide = 'Hero';
    expect(sauronAuto(s)).toBe(true);
    const played = playShadowReaction(s, cat, 'enter-nonhaven', { heroId });
    expect(played).toBe(true);
    expect(s.pendingShadowReaction).toBeFalsy(); // never pauses the automa
    expect(s.shadowPlayedThisHeroTurn).toBe(true);
  });
});

describe('combat-start reaction pauses combat, then resumes Preparation', () => {
  function combatSetup() {
    const { s, heroId } = humanSauron(COMBAT);
    const loc = s.heroes[0].location;
    const monsterId = Object.keys(cat.monsters)[0];
    (s.map.monstersAt[loc] ||= []).push(monsterId);
    return { s, heroId, loc, monsterId };
  }

  it('beginCombat pauses BEFORE Preparation for a human Sauron', () => {
    const { s, heroId, loc, monsterId } = combatSetup();
    const out = beginCombat(s, cat, heroId, monsterId, loc);
    expect(out.pendingShadowReaction?.window).toBe('combat-start');
    expect(out.pendingShadowReaction?.resumeCombat).toBe(true);
    expect(out.pendingCombat).toBeTruthy();
    expect(out.pendingChoice).toBeFalsy(); // Preparation is deferred until resolved
  });

  it('playing the card resumes into the Preparation/combat step', () => {
    const { s, heroId, loc, monsterId } = combatSetup();
    const paused = beginCombat(s, cat, heroId, monsterId, loc);
    const out = applyAction(paused, cat, { t: 'shadowReaction', cardId: COMBAT });
    expect(out.pendingShadowReaction).toBeFalsy();
    expect(out.shadowPlayedThisHeroTurn).toBe(true);
    expect(out.sauron.shadowDiscard).toContain(COMBAT);
    // combat continues: either the Preparation choice or a combat choice is up
    expect(out.pendingChoice || out.pendingCombat).toBeTruthy();
  });

  it('passing also resumes combat but keeps the card and the window open', () => {
    const { s, heroId, loc, monsterId } = combatSetup();
    const paused = beginCombat(s, cat, heroId, monsterId, loc);
    const out = applyAction(paused, cat, { t: 'shadowReaction', cardId: null });
    expect(out.pendingShadowReaction).toBeFalsy();
    expect(out.shadowPlayedThisHeroTurn).toBe(false);
    expect(out.sauron.shadowHand).toContain(COMBAT);
    expect(out.pendingChoice || out.pendingCombat).toBeTruthy();
  });
});
