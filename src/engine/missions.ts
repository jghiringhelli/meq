// Mission win-condition evaluation (M3). Each mission carries a structured
// `condition` (assigned in scripts/build-catalog.py); evalMission() turns it
// into a boolean over the current GameState. Counting helpers are shared with
// checkWin so hero/Sauron victory paths stay consistent.
import type { Catalog, GameState, MissionCondition } from './types';
import { SAURON_STAGE_III } from './types';
import { influenceAt } from './influence';

export function totalCorruption(s: GameState): number {
  return s.heroes.reduce((n, h) => n + h.corruption, 0);
}

export function totalFavor(s: GameState): number {
  return s.heroes.reduce((n, h) => n + h.favor, 0);
}

export function monstersInPlay(s: GameState): number {
  return Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0);
}

export function minionsInPlay(s: GameState): number {
  return Object.values(s.map.minionsAt ?? {}).reduce((n, a) => n + a.length, 0);
}

export function activePlots(s: GameState): number {
  // The "plots in play" are Sauron's persistent plot slots (up to 3), NOT the
  // per-turn event row (`activeEvents`). His Dark Throne counts these.
  return (s.sauron.activePlots ?? []).length;
}

/** Evaluate a mission's win predicate against the current state. A null/absent
 *  condition never fires (source rows we could not classify — documented). */
export function evalMission(cond: MissionCondition | null | undefined, s: GameState, _cat?: Catalog): boolean {
  if (!cond) return false;
  switch (cond.kind) {
    case 'heroCorruptionAtMost': return totalCorruption(s) <= cond.n;
    case 'heroFavorAtLeast': return totalFavor(s) >= cond.n;
    case 'monstersAtMost': return monstersInPlay(s) <= cond.n;
    case 'minionsAtMost': return minionsInPlay(s) <= cond.n;
    case 'activePlotsAtLeast': return activePlots(s) >= cond.n;
    case 'allQuestsComplete':
      return s.heroes.every((h) => h.quests?.startingDone && h.quests?.advancedDone);
    case 'sauronMarkerAtStageIII':
      return (s.story.sauron?.[cond.marker] ?? 0) >= SAURON_STAGE_III;
    case 'sauronInfluenceAtLeast':
      return s.sauron.influence >= cond.n;
    case 'ringwraithsOrShireInfluence': {
      const ringwraithsInPlay = Object.values(s.map.minionsAt ?? {})
        .some((a) => a.some((m) => m === 'minion-ringwraiths'));
      // Influence on The Shire location specifically (not the whole region).
      const shireInfluence = influenceAt(s, 'the-shire');
      return ringwraithsInPlay || shireInfluence >= cond.n;
    }
  }
}
