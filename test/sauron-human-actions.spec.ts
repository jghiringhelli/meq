// X-1 — the interactive (human) Sauron plays by the SAME Eye Action Track rules
// as the automa: pool influence and card draws are NOT free — they cost one of the
// turn's actions on the Place Influence (6/5/4) and Draw (2/2/1) tracks; Command
// (3/2/1) issues several commands per action (rulebook pp.16-19).
import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import {
  sauronBeginAction, sauronActionYields, sauronPlaceInfluence, sauronDeployMinion,
  sauronPlayShadow, playableShadow, reserveMinions,
} from '../src/engine/game';
import { shadowWindow } from '../src/engine/sauronmech';
import { placementTargets, influenceAt } from '../src/engine/influence';
import type { GameState } from '../src/engine/types';

/** Put a fresh game into a human-Sauron Action Step with a clean Eye and `n` actions. */
function actionStep(n = 3): GameState {
  const s = freshGame();
  s.humanSide = 'Sauron';
  s.phase = 'SauronMinions';
  s.sauronActionsLeft = n;
  s.sauronPending = undefined;
  s.sauron.eye = { influence: 0, draw: 0, command: 0 };
  return s;
}

describe('X-1 — human Sauron Action Step uses the Eye Action Tracks', () => {
  it('exposes the first-space yields 6 / 2 / 3', () => {
    const y = sauronActionYields(actionStep());
    expect(y.influence).toBe(6);
    expect(y.draw).toBe(2);
    expect(y.command).toBe(3);
  });

  it('a Draw action costs one action and draws Shadow & Plot cards', () => {
    const s = actionStep();
    s.sauron.shadowHand = []; // drawShadow fills the hand up to the yield (2)
    const plotHandBefore = (s.sauron.plotHand ?? []).length;
    const out = sauronBeginAction(s, cat, 'draw');
    expect(out.sauronActionsLeft).toBe(2); // one action spent
    expect(out.sauron.shadowHand.length).toBe(2); // filled to the Draw yield
    expect((out.sauron.plotHand ?? []).length).toBe(plotHandBefore + 1); // draw 2 plots, keep the best 1
    expect(out.sauronPending).toBeUndefined(); // Draw resolves fully at once
  });

  it('a Place Influence action banks at most 2 to the pool and owes the rest to the board', () => {
    const s = actionStep();
    s.sauron.influence = 0;
    const out = sauronBeginAction(s, cat, 'influence');
    expect(out.sauronActionsLeft).toBe(2);
    expect(out.sauron.influence).toBe(2); // banked exactly 2 (yield 6, cap 2)
    expect(out.sauronPending).toEqual({ track: 'influence', remaining: 4 });
    // The remaining 4 tokens go onto the board, one placement at a time.
    const loc = placementTargets(out, cat)[0];
    const before = influenceAt(out, loc);
    const laid = sauronPlaceInfluence(out, cat, loc);
    expect(influenceAt(laid, loc)).toBe(before + 1);
    expect(laid.sauronPending?.remaining).toBe(3);
    expect(laid.sauron.influence).toBe(2); // pool never changes while laying board tokens
  });

  it('never banks past the 4× stage pool cap', () => {
    const s = actionStep();
    s.sauron.influence = 4; // stage 1 cap is 4 — no room to bank
    const out = sauronBeginAction(s, cat, 'influence');
    expect(out.sauron.influence).toBe(4);
    expect(out.sauronPending).toEqual({ track: 'influence', remaining: 6 });
  });

  it('a Command action costs one action and issues up to its yield in commands', () => {
    const s = actionStep();
    const out = sauronBeginAction(s, cat, 'command');
    expect(out.sauronActionsLeft).toBe(2);
    expect(out.sauronPending).toEqual({ track: 'command', remaining: 3 });
    const mid = reserveMinions(out, cat)[0];
    const loc = out.heroes[0].location;
    const deployed = sauronDeployMinion(out, cat, mid, loc);
    expect(deployed.sauronPending?.remaining).toBe(2); // one command spent, no new action
    expect(deployed.sauronActionsLeft).toBe(2);
  });

  it('cannot begin a new action while one still owes sub-effects', () => {
    const s = actionStep();
    const cmd = sauronBeginAction(s, cat, 'command'); // pending command
    const blocked = sauronBeginAction(cmd, cat, 'draw');
    expect(blocked).toBe(cmd); // no-op: an action is already in progress
  });

  it('a full track can no longer be chosen', () => {
    const s = actionStep(9);
    s.sauron.eye = { influence: 3, draw: 0, command: 0 }; // influence track filled
    expect(sauronActionYields(s).influence).toBeNull();
    const out = sauronBeginAction(s, cat, 'influence');
    expect(out).toBe(s); // no-op
  });

  it('plays at most ONE own-turn Shadow card, for free (no Eye action), action-window only', () => {
    const s = actionStep();
    const actionCard = Object.values(cat.shadow).find((c) => shadowWindow(c.timing) === 'action')!;
    s.sauron.shadowHand = [actionCard.id];
    s.sauron.influence = Number(actionCard.poolRequirement) || 0;
    expect(playableShadow(s, cat)).toEqual([actionCard.id]);
    const out = sauronPlayShadow(s, cat, actionCard.id);
    expect(out.shadowPlayedThisSauronTurn).toBe(true);
    expect(out.sauronActionsLeft).toBe(s.sauronActionsLeft); // free — no action spent
    expect(out.sauron.shadowHand).not.toContain(actionCard.id);
    expect(playableShadow(out, cat)).toEqual([]); // the one own-turn play is used up
  });

  it('refuses a reaction-window Shadow card during the Action Step', () => {
    const reaction = Object.values(cat.shadow).find((c) => shadowWindow(c.timing) !== 'action');
    if (!reaction) return;
    const s = actionStep();
    s.sauron.shadowHand = [reaction.id];
    s.sauron.influence = Number(reaction.poolRequirement) || 0;
    expect(playableShadow(s, cat)).toEqual([]);
    expect(sauronPlayShadow(s, cat, reaction.id)).toBe(s); // no-op: waits for its window
  });
});
