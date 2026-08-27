// Role / controller model for multiplayer. Pure and engine-agnostic: the game
// engine never knows who controls a role — the session layer decides who may
// dispatch a given Action and runs the AI for roles nobody has claimed.
//
// A "role" is a hero id or the string 'Sauron'. Each role is controlled by a
// human player, by the AI, or is open (unclaimed → treated as AI at runtime).
import type { GameState } from '../engine/types';
import type { Action } from '../engine/actions';

export const SAURON_ROLE = 'Sauron';
export type RoleId = string; // a heroId, or SAURON_ROLE

export type Controller =
  | { kind: 'human'; playerId: string; name: string }
  | { kind: 'ai' }
  | { kind: 'open' };

export type Roster = Record<RoleId, Controller>;

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
    case 'endHeroActions':
      return 'flow';
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
    case 'choice':
    case 'chooseEncounter':
    case 'revealEncounter':
    case 'dismissReveal':
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
  if (isHost) return true;
  const role = actionRole(state, action);
  if (role === 'flow') return false; // only the host drives phase flow
  const c = roster[role];
  return !!c && c.kind === 'human' && c.playerId === playerId;
}

/** Roles a given player controls right now. */
export function rolesOf(roster: Roster, playerId: string): RoleId[] {
  return Object.entries(roster)
    .filter(([, c]) => c.kind === 'human' && c.playerId === playerId)
    .map(([role]) => role);
}

/** Roles that no human holds → the AI must run them. */
export function aiRoles(roster: Roster): RoleId[] {
  return Object.entries(roster)
    .filter(([, c]) => c.kind !== 'human')
    .map(([role]) => role);
}

/** Assign a role to a controller, returning a new roster (immutable). */
export function assignRole(roster: Roster, role: RoleId, controller: Controller): Roster {
  return { ...roster, [role]: controller };
}

/** Release every role held by a player (e.g. on disconnect/kick) back to open. */
export function releasePlayer(roster: Roster, playerId: string): Roster {
  const next: Roster = { ...roster };
  for (const [role, c] of Object.entries(next)) {
    if (c.kind === 'human' && c.playerId === playerId) next[role] = { kind: 'open' };
  }
  return next;
}
