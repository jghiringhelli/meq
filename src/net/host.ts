// Pure host-authoritative reducer helpers, specialized from the shared
// boardgame-kit host module (see boardgame-kit/README.md) to this game's
// state/action/role types and reducer.
import type { Catalog, GameState } from '../engine/types';
import type { Action } from '../engine/actions';
import { applyAction } from '../engine/actions';
import {
  claimSeat as claimSeatShared,
  dropPlayer as dropPlayerShared,
} from 'boardgame-kit/host';
import { mayDispatch, allRoles, type Roster, type RoleId } from './roles';

/**
 * Apply an action a client submitted. Returns the next game state, or the
 * unchanged state if the player does not own the role the action belongs to.
 */
export function applyRemoteAction(
  game: GameState, roster: Roster | null, cat: Catalog, playerId: string, action: Action,
): GameState {
  if (roster && !mayDispatch(roster, playerId, false, game, action)) return game;
  return applyAction(game, cat, action);
}

/** Claim or release a role, returning the next roster (immutable). */
export function claimRole(
  roster: Roster | null, game: GameState, playerId: string, name: string, role: RoleId, release: boolean,
): Roster {
  return claimSeatShared(roster, allRoles(game), playerId, name, role, release);
}

/** Free every role a departing/kicked player held (they revert to open → AI). */
export function dropPlayer(roster: Roster | null, playerId: string): Roster | null {
  return dropPlayerShared(roster, playerId);
}
