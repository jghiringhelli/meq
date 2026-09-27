// Role / controller model for multiplayer, specialized from the shared
// boardgame-kit roles module (see boardgame-kit/README.md) to this game's
// role type (a hero id or the string 'Sauron') and action shape.
import type { GameState } from '../engine/types';
import type { Action } from '../engine/actions';
import {
  mayDispatch as mayDispatchShared, seatsOf as seatsOfShared, aiSeats as aiSeatsShared,
  assignSeat as assignSeatShared, releasePlayer as releasePlayerShared,
  markDisconnected as markDisconnectedShared, markReconnected as markReconnectedShared,
  type Roster as RosterShared, type Controller,
} from 'boardgame-kit/roles';

export const SAURON_ROLE = 'Sauron';
export type RoleId = string; // a heroId, or SAURON_ROLE
export type { Controller };
export type Roster = RosterShared<RoleId>;

/** Every claimable role in the current game: one per hero, plus Sauron. */
export function allRoles(state: GameState): RoleId[] {
  return [...state.heroes.map((h) => h.id), SAURON_ROLE];
}

/** A fresh roster with every role open. */
export function emptyRoster(state: GameState): Roster {
  const r: Roster = {};
  for (const role of allRoles(state)) r[role] = { kind: 'open' };
  return r;
}

/** The role that currently holds the initiative (for flow/shared actions). */
export function activeRole(state: GameState): RoleId {
  if (state.activeSide === 'Sauron') return SAURON_ROLE;
  const hero = state.heroes[state.activeHeroIndex];
  return hero ? hero.id : SAURON_ROLE;
}

/** Which role an Action belongs to. Hero actions map to their hero; shared
 *  flow (choices, encounters, reveals) maps to whoever holds initiative;
 *  phase advancement is game-flow, reserved to the host. */
export function actionRole(state: GameState, action: Action): RoleId | 'flow' {
  switch (action.t) {
    case 'advance':
      return 'flow';
    case 'endHeroActions':
      // Ending YOUR hero's turn is a per-hero decision, not shared game flow —
      // the active hero's own controller may end it themselves (a remote
      // hero-role player must be able to finish their turn without asking the
      // host to do it for them). Only actually-shared phase transitions
      // ('advance') stay host-only.
      return activeRole(state);
    case 'move':
    case 'rest':
    case 'engage':
    case 'explore':
    case 'darkPath':
    case 'retrieveFavor':
    case 'consult':
    case 'completeQuest':
    case 'discardPlot':
    case 'cleanse':
    case 'tradeFavor':
    case 'survey':
      return action.heroId;
    case 'combatOrPeril':
      return SAURON_ROLE;
    case 'shadowReaction':
      return SAURON_ROLE;
    case 'sauronStoryStep':
    case 'sauronPlayPlot':
    case 'sauronResolveEvents':
    case 'sauronBeginAction':
    case 'sauronPlaceInfluence':
    case 'sauronSpawnMonster':
    case 'sauronDeployMinion':
    case 'sauronMoveFigure':
    case 'sauronHealMinion':
    case 'sauronPlayShadow':
    case 'sauronEndActionStep':
      return SAURON_ROLE;
    case 'treeDecision':
      // The player who owns the paused card decision: Sauron for his own cards,
      // otherwise the affected hero.
      return state.pendingTree?.actor === 'hero'
        ? (state.pendingTree.heroId as RoleId)
        : SAURON_ROLE;
    case 'choice':
    case 'chooseEncounter':
    case 'revealEncounter':
    case 'dismissReveal':
    case 'dismissCombatSummary':
    case 'resolveEncounter':
      return activeRole(state);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** May this player perform this action? The host may do anything (it is the
 *  referee); otherwise the player must own the role the action belongs to. */
export function mayDispatch(
  roster: Roster, playerId: string, isHost: boolean, state: GameState, action: Action,
): boolean {
  return mayDispatchShared(roster, playerId, isHost, actionRole(state, action));
}

/** Roles a given player controls right now. */
export function rolesOf(roster: Roster, playerId: string): RoleId[] {
  return seatsOfShared(roster, playerId);
}

/** Roles that no human holds → the AI must run them. */
export function aiRoles(roster: Roster): RoleId[] {
  return aiSeatsShared(roster);
}

/** Assign a role to a controller, returning a new roster (immutable). */
export function assignRole(roster: Roster, role: RoleId, controller: Controller): Roster {
  return assignSeatShared(roster, role, controller);
}

/** Release every role held by a player (e.g. a kick, or a reconnection grace
 *  period expiring) back to open. Use markDisconnected for a network drop
 *  that should still give the same player (by persistent id) a chance to
 *  seamlessly resume — this is the hard, permanent release. */
export function releasePlayer(roster: Roster, playerId: string): Roster {
  return releasePlayerShared(roster, playerId);
}

/** A player's connection dropped: keep their role(s) reserved (nobody else can
 *  claim them, no immediate AI takeover) but flag them as offline so the UI
 *  can show it. Pair with a host-side grace-period timer that calls
 *  releasePlayer if they never come back. */
export function markDisconnected(roster: Roster, playerId: string): Roster {
  return markDisconnectedShared(roster, playerId);
}

/** The same persistent playerId reconnected before the grace period elapsed —
 *  seamlessly restore their role(s) to connected, no re-claim needed. */
export function markReconnected(roster: Roster, playerId: string): Roster {
  return markReconnectedShared(roster, playerId);
}
