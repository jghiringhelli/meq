// Append-only structured event log (the audit trail — SPEC §5).
// Every game event is captured as an ordered, structured record so a whole
// session can be dumped to JSON and analysed later (see dumpLogJson).
import type { GameState, LogEvent } from './types';

export function log(
  state: GameState,
  type: string,
  actor: string,
  detail: string,
  data?: Record<string, unknown>,
): void {
  const e: LogEvent = {
    seq: state.log.length,
    turn: state.story?.turn ?? 0,
    round: state.round,
    phase: state.phase,
    side: state.activeSide,
    type,
    actor,
    detail,
    ...(data ? { data } : {}),
  };
  state.log.push(e);
}

/** Serialise the full ordered event log to a JSON string for offline analysis. */
export function dumpLogJson(state: GameState, pretty = true): string {
  const payload = {
    seed: state.seed,
    catalog: state.catalogRef,
    heroMission: state.secretHeroMission,
    sauronMission: state.secretSauronMission,
    winner: state.winner,
    winReason: state.winReason,
    events: state.log,
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}
