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
  // `connected` defaults to true when omitted (kept optional for old saves).
  // false means the human still owns/reserves this role (nobody else can
  // claim it and the roster remembers them) but their connection just isn't
  // live right now — see markDisconnected/markReconnected below.
  | { kind: 'human'; playerId: string; name: string; connected?: boolean }
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

/** Release every role held by a player (e.g. a kick, or a reconnection grace
 *  period expiring) back to open. Use markDisconnected for a network drop
 *  that should still give the same player (by persistent id) a chance to
 *  seamlessly resume — this is the hard, permanent release. */
export function releasePlayer(roster: Roster, playerId: string): Roster {
  const next: Roster = { ...roster };
  for (const [role, c] of Object.entries(next)) {
    if (c.kind === 'human' && c.playerId === playerId) next[role] = { kind: 'open' };
  }
  return next;
}

/** A player's connection dropped: keep their role(s) reserved (nobody else can
 *  claim them, no immediate AI takeover) but flag them as offline so the UI
 *  can show it. Pair with a host-side grace-period timer that calls
 *  releasePlayer if they never come back. */
export function markDisconnected(roster: Roster, playerId: string): Roster {
  const next: Roster = { ...roster };
  for (const [role, c] of Object.entries(next)) {
    if (c.kind === 'human' && c.playerId === playerId) next[role] = { ...c, connected: false };
  }
  return next;
}

/** The same persistent playerId reconnected before the grace period elapsed —
 *  seamlessly restore their role(s) to connected, no re-claim needed. */
export function markReconnected(roster: Roster, playerId: string): Roster {
  const next: Roster = { ...roster };
  for (const [role, c] of Object.entries(next)) {
    if (c.kind === 'human' && c.playerId === playerId) next[role] = { ...c, connected: true };
  }
  return next;
}
