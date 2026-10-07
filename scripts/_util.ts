import { advance, autoResolvePendingTree, dismissReveal } from '../src/engine/game';
import type { Catalog, GameState } from '../src/engine/types';

/** Run Sauron's opening turn (resolving any event choices it raises) until the first hero acts. */
export function toHeroActions(s: GameState, cat: Catalog): GameState {
  for (let i = 0; i < 60 && s.phase !== 'HeroActions'; i++) {
    if (s.pendingTree) s = autoResolvePendingTree(s, cat);
    else if (s.pendingReveal) s = dismissReveal(s);
    else s = advance(s, cat);
  }
  return s;
}
