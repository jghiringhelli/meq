// Peer-to-peer multiplayer transport (WebRTC via PeerJS), specialized from
// the shared boardgame-kit session module (see boardgame-kit/README.md) to
// this game's state/action/role types and PeerJS id namespace.
import type { GameState } from '../engine/types';
import type { Action } from '../engine/actions';
import type { RoleId } from './roles';
import {
  useGameSession as useGameSessionShared,
  newGameCode,
  type SessionCallbacks as SessionCallbacksShared,
  type Net as NetShared,
} from 'boardgame-kit/session';

export { newGameCode };

/** Game ids are short + human-shareable; we prefix to avoid PeerJS id clashes.
 *  Only WebRTC signalling metadata ever reaches the broker — never game state. */
const OPTS = {
  idPrefix: 'meq-',
  identityNamespace: 'meq',
  globalOverrideKey: '__MEQ_PEER__',
  resolvePeerOptions: () => {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
    if (env.VITE_PEER_HOST) {
      return { host: env.VITE_PEER_HOST, port: Number(env.VITE_PEER_PORT) || 9000, path: env.VITE_PEER_PATH ?? '/', secure: env.VITE_PEER_SECURE === 'true' };
    }
    return undefined; // PeerJS default cloud broker
  },
};

export type NetRole = 'off' | 'host' | 'client';
export interface PeerInfo { playerId: string; name: string }
export type SessionCallbacks = SessionCallbacksShared<GameState, Action, RoleId>;
export type Net = Omit<NetShared<GameState, Action, RoleId>, 'claimSeat'> & {
  /** Client → host: (un)claim a role. (Kept as `claimRole` — this game's
   *  established name — rather than the kit's generic `claimSeat`.) */
  claimRole: (role: RoleId, release?: boolean) => void;
};

/**
 * React hook owning the PeerJS session. `cbs` may change every render; the
 * shared implementation reads it through a ref so connection handlers always
 * see the latest callbacks.
 */
export function useGameSession(cbs: SessionCallbacks): Net {
  const { claimSeat, ...rest } = useGameSessionShared<GameState, Action, RoleId>(OPTS, cbs);
  return { ...rest, claimRole: claimSeat };
}
