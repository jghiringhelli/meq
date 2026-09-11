// Serializable action layer: the single seam that turns UI intents into
// engine calls. Every action is plain-JSON (no functions/closures), so it can
// be logged, replayed, and — crucially — sent over the wire for multiplayer.
//
// applyAction is a pure (GameState, Catalog, Action) -> GameState reducer that
// delegates to the existing pure engine functions. The App and any future
// network/session layer should route ALL player intents through here.
import type { Catalog, GameState, HeroId, MonsterId, LocationId, CardId } from './types';
import {
  advance, heroMove, heroRest, heroEngage, endHeroActions, resolveChoice,
  heroExplore, resolveEncounter, chooseEncounter, revealEncounter, dismissReveal,
  dismissCombatSummary,
  heroDarkPath, heroRetrieveFavor, heroConsultCharacter, heroCompleteQuest,
  heroDiscardPlot, heroCleanseCorruption, heroTradeFavor, heroSurvey, resolveCombatOrPeril,
  resolveShadowReaction, resolveTreeDecision,
} from './game';

/** A serializable player intent. `t` is the discriminant tag. */
export type Action =
  | { t: 'advance' }
  | { t: 'endHeroActions' }
  | { t: 'move'; heroId: HeroId; to: LocationId; cards?: CardId[] }
  | { t: 'rest'; heroId: HeroId; beravorTrain?: boolean }
  | { t: 'engage'; heroId: HeroId; monsterId: MonsterId }
  | { t: 'explore'; heroId: HeroId }
  | { t: 'choice'; optionId: string }
  | { t: 'chooseEncounter'; index: number }
  | { t: 'revealEncounter'; cardId?: CardId }
  | { t: 'dismissReveal' }
  | { t: 'dismissCombatSummary' }
  | { t: 'resolveEncounter' }
  | { t: 'darkPath'; heroId: HeroId }
  | { t: 'retrieveFavor'; heroId: HeroId }
  | { t: 'consult'; heroId: HeroId; character: string; choice: 'favor' | 'ability' }
  | { t: 'completeQuest'; heroId: HeroId }
  | { t: 'discardPlot'; heroId: HeroId }
  | { t: 'cleanse'; heroId: HeroId }
  | { t: 'tradeFavor'; heroId: HeroId; toId: HeroId; n: number }
  | { t: 'survey'; heroId: HeroId }
  | { t: 'combatOrPeril'; choice: 'combat' | 'peril' }
  | { t: 'shadowReaction'; cardId: CardId | null }
  | { t: 'treeDecision'; optionIndex: number };

export type ActionType = Action['t'];

/** Apply a serializable action to the state, returning the next state. Pure. */
export function applyAction(state: GameState, cat: Catalog, action: Action): GameState {
  switch (action.t) {
    case 'advance': return advance(state, cat);
    case 'endHeroActions': return endHeroActions(state, cat);
    case 'move': return heroMove(state, cat, action.heroId, action.to, action.cards);
    case 'rest': return heroRest(state, cat, action.heroId, { beravorTrain: action.beravorTrain });
    case 'engage': return heroEngage(state, cat, action.heroId, action.monsterId);
    case 'explore': return heroExplore(state, cat, action.heroId);
    case 'choice': return resolveChoice(state, cat, action.optionId);
    case 'chooseEncounter': return chooseEncounter(state, cat, action.index);
    case 'revealEncounter': return revealEncounter(state, cat, action.cardId);
    case 'dismissReveal': return dismissReveal(state);
    case 'dismissCombatSummary': return dismissCombatSummary(state);
    case 'resolveEncounter': return resolveEncounter(state, cat);
    case 'darkPath': return heroDarkPath(state, cat, action.heroId);
    case 'retrieveFavor': return heroRetrieveFavor(state, cat, action.heroId);
    case 'consult': return heroConsultCharacter(state, cat, action.heroId, action.character, action.choice);
    case 'completeQuest': return heroCompleteQuest(state, cat, action.heroId);
    case 'discardPlot': return heroDiscardPlot(state, cat, action.heroId);
    case 'cleanse': return heroCleanseCorruption(state, cat, action.heroId);
    case 'tradeFavor': return heroTradeFavor(state, cat, action.heroId, action.toId, action.n);
    case 'survey': return heroSurvey(state, cat, action.heroId);
    case 'combatOrPeril': return resolveCombatOrPeril(state, cat, action.choice);
    case 'shadowReaction': return resolveShadowReaction(state, cat, action.cardId);
    case 'treeDecision': return resolveTreeDecision(state, cat, action.optionIndex);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
