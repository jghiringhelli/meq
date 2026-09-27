// Thin game-specific wrapper over the shared boardgame-kit identity module
// (see boardgame-kit/README.md — extracted from near-identical duplication
// across this workspace's boardgame ports).
import { getLocalPlayerId as getLocalPlayerIdShared } from 'boardgame-kit/identity';

export function getLocalPlayerId(): string {
  return getLocalPlayerIdShared('meq');
}
