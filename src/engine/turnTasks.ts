// Smart "next step" advisor: given the current game state, work out whether the
// active player still has meaningful, legal actions available before they end
// the current step. The UI uses this to (a) glow the smart-next button when
// nothing is left to do and (b) raise a Yes/No warning listing what would be
// skipped if the player advances anyway.
//
// This module never changes rules — it only surfaces actions that the existing
// economy/phase predicates already report as legal right now.
import type { Catalog, GameState } from './types';
import { ambushPending, legalMoves } from './mechanics';
import {
  favorHere, charactersHere, canDiscardPlot, plotCounterCost, canCleanse,
  canCompleteQuest,
} from './economy';

/** Meaningful actions the active hero could still take this turn. Empty => the
 *  hero is "ready" to end the turn with nothing worthwhile left undone. */
export function pendingHeroTasks(state: GameState, cat: Catalog): string[] {
  if (state.phase !== 'HeroActions') return [];
  const hero = state.heroes[state.activeHeroIndex];
  if (!hero || hero.status !== 'active') return [];
  const tasks: string[] = [];

  // An unresolved ambush must be fought before the turn can end cleanly.
  if (ambushPending(state, hero, cat)) {
    tasks.push('Fight the foe ambushing you here');
    return tasks;
  }

  // Action-budget tasks (each costs one hero action).
  if (hero.actionsRemaining > 0) {
    const f = favorHere(state, hero.id);
    if (f > 0) tasks.push(`Retrieve ${f} favor waiting on this location`);
    const chars = charactersHere(state, hero.id);
    if (chars.length) tasks.push(`Consult ${chars.join(', ')} (favor or ability)`);
    if (canDiscardPlot(state, cat, hero.id)) {
      tasks.push(`Break the plot here (${plotCounterCost(state, cat, hero.id) ?? 2} favor)`);
    }
    if (canCompleteQuest(state, cat, hero.id)) tasks.push('Complete a quest here');
    if (canCleanse(state, cat, hero.id)) tasks.push('Cleanse corruption');

    // Exposure: ending the turn holding cards outside a haven leaves them open
    // to Sauron. Faithful play ends in a haven or spends the hand travelling —
    // but travelling costs an action AND a legal path (enough/matching cards,
    // and any Hopeless/restrictMovement travel cap not yet exhausted), so this
    // only applies when a move is actually still possible; otherwise the hint
    // would falsely tell a stuck hero they "could" travel to safety.
    if (
      hero.hand.length > 0 && cat.locations[hero.location]?.kind !== 'haven'
      && legalMoves(cat, hero).length > 0
    ) {
      tasks.push(`${hero.hand.length} card(s) in hand and not in a haven — you could travel to safety`);
    }
  }

  return tasks;
}

/** Meaningful actions Sauron could still take before ending the action step. */
export function pendingSauronTasks(state: GameState): string[] {
  const tasks: string[] = [];
  if (state.phase === 'SauronMinions' && (state.sauronActionsLeft ?? 0) > 0) {
    tasks.push(`${state.sauronActionsLeft} Eye action(s) unspent`);
  }
  return tasks;
}
