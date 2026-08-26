// The single decision surface. requestChoice suspends the engine on a choice;
// resolveChoice (in game.ts) resumes it. Kept pure/tiny to avoid import cycles.
import type { GameState, Choice } from './types';

export function requestChoice(state: GameState, choice: Choice): GameState {
  state.pendingChoice = choice;
  return state;
}

export function clearChoice(state: GameState): void {
  state.pendingChoice = null;
}
