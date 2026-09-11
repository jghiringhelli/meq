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

/** Serialise the full ordered event log to a JSON string for offline analysis.
 *  `revealSide` controls which side's secret mission is included — omit it (or
 *  pass 'both') for solo/dev use (e.g. bug reports), but when a specific human
 *  viewer's side is known (online multiplayer), pass their side so the export
 *  never divulges the OTHER side's hidden mission through the ordinary "download
 *  log" button. The event log itself never records secret hand contents. */
export function dumpLogJson(
  state: GameState, pretty = true, revealSide: 'Hero' | 'Sauron' | 'both' | 'none' = 'both',
): string {
  const payload = {
    seed: state.seed,
    catalog: state.catalogRef,
    heroMission: (revealSide === 'Hero' || revealSide === 'both') ? state.secretHeroMission : undefined,
    sauronMission: (revealSide === 'Sauron' || revealSide === 'both') ? state.secretSauronMission : undefined,
    winner: state.winner,
    winReason: state.winReason,
    events: state.log,
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}
