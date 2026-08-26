// Pure host-authoritative reducer helpers. The host is the referee: it applies
// every action (its own and remote), enforcing per-role ownership, and owns the
// canonical (game, roster) pair. Kept transport-free so it can be unit-tested
// and reused by App without duplicating the rules.
import type { Catalog, GameState } from '../engine/types';
import type { Action } from '../engine/actions';
import { applyAction } from '../engine/actions';
import {
  mayDispatch, assignRole, emptyRoster, releasePlayer, type Roster, type RoleId,
} from './roles';

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
  const base = roster ?? emptyRoster(game);
  return assignRole(base, role, release ? { kind: 'open' } : { kind: 'human', playerId, name });
}

/** Free every role a departing/kicked player held (they revert to open → AI). */
export function dropPlayer(roster: Roster | null, playerId: string): Roster | null {
  return roster ? releasePlayer(roster, playerId) : roster;
}
