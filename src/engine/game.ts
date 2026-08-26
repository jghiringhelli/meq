// Orchestrator: the public engine surface tying phases + combat + choices.
import type { Catalog, GameState, HeroId, MonsterId } from './types';
import { beginCombat, resolveCombatChoice, resolvePreparation } from './combat';
import { spendActionForCombat } from './phases';
import { resolveQuestRewardChoice } from './quests';
import { resolveSurveyChoice } from './economy';
import { clone } from './mechanics';

export { newGame } from './setup';
export {
  heroMove, heroRest, endHeroActions, advance, engageableMonsters, checkWin,
  heroExplore, resolveEncounter, canExplore, chooseEncounter, encounterPlan, revealEncounter, dismissReveal,
  sauronStoryStep, sauronResolveEvents, sauronEndActionStep, resolveCombatOrPeril,
} from './phases';
export {
  sauronPlayPlot, sauronPlaceInfluence, sauronSpawnMonster, sauronDeployMinion,
  sauronMoveFigure, sauronHealMinion, sauronPlayShadow,
  playablePlots, playableShadow, reserveMinions, woundedMinions, boardFigures,
  moveTargets, adjacentLocations,
} from './sauronPlay';
export { legalMoves } from './mechanics';
export {
  heroDarkPath, heroRetrieveFavor, heroConsultCharacter, heroCompleteQuest,
  heroDiscardPlot, heroTradeFavor, heroTradeItem, heroCleanseCorruption,
  favorHere, charactersHere, plotHere, targetablePlot, canCleanse, canDarkPath, canCompleteQuest, otherHeroesHere,
  canDiscardPlot, plotCounterCost,
  heroSurvey, canSurvey,
} from './economy';

/** Spend an action and open combat vs a monster at the hero's location. */
export function heroEngage(
  state: GameState, cat: Catalog, heroId: HeroId, monsterId: MonsterId,
): GameState {
  const hero = state.heroes.find((h) => h.id === heroId)!;
  const s1 = spendActionForCombat(state, heroId);
  return beginCombat(s1, cat, heroId, monsterId, hero.location);
}

/** Answer the pending choice. Dispatches by kind. */
export function resolveChoice(state: GameState, cat: Catalog, optionId: string): GameState {
  const ch = state.pendingChoice;
  if (!ch) throw new Error('No pending choice');
  const cleared = { ...state, pendingChoice: null };
  switch (ch.kind) {
    case 'combat-prep': {
      const draw = optionId.startsWith('prep-') ? parseInt(optionId.slice(5), 10) || 0 : 0;
      return resolvePreparation(cleared, cat, draw);
    }
    case 'combat-card':
      return resolveCombatChoice(cleared, cat, optionId);
    case 'quest-reward': {
      const s = clone(cleared);
      resolveQuestRewardChoice(s, cat, optionId);
      return s;
    }
    case 'survey': {
      const s = clone(cleared);
      resolveSurveyChoice(s, cat, optionId);
      return s;
    }
    default:
      throw new Error(`Unknown choice kind '${ch.kind}'`);
  }
}
