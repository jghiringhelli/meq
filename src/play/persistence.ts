// M12 — localStorage persistence: save/resume the in-progress game, keep a
// completed-game history, and export a full "report a problem" bundle.
// The generic localStorage plumbing (safe get/set/remove, save-slot,
// capped-history, per-author-notes, last-crash stash) lives in
// boardgame-kit/storage (shared with other games); this module wires it up
// to meq's own GameState/HistoryEntry shapes and adds the meq-specific
// "report a problem" bundle export.
import type { GameState } from '../engine/types';
import {
  storage, createSaveSlot, createHistoryStore, createNotesStore, createCrashStore,
  type CrashInfo,
} from 'boardgame-kit/storage';
import { downloadText } from 'boardgame-kit/download';

const SCHEMA = 1;
const NAMESPACE = 'meq';

export type { CrashInfo };

export interface HistoryEntry {
  seed: number;
  winner: string | null;
  winReason?: string;
  round: number;
  turn: number;
  finishedAt: string;
}

const saveSlot = createSaveSlot<GameState>(NAMESPACE, SCHEMA);
const history = createHistoryStore<HistoryEntry>(NAMESPACE);
const notes = createNotesStore(NAMESPACE);
const crashes = createCrashStore(NAMESPACE);

/** Persist the current in-progress game so it survives a reload. */
export function saveGame(_seed: number, state: GameState): void {
  saveSlot.save(state);
}

/** Load a resumable in-progress game (null if none / unfinished-only). */
export function loadSavedGame(): { seed: number; state: GameState } | null {
  const loaded = saveSlot.load();
  return loaded ? { seed: loaded.state.seed, state: loaded.state } : null;
}

export function hasSavedGame(): boolean {
  return saveSlot.has();
}

export function clearSavedGame(): void {
  saveSlot.clear();
}

/** Append a finished game to the persistent history and drop the live save. */
export function recordCompletedGame(seed: number, state: GameState): void {
  history.record({
    seed,
    winner: state.winner ?? null,
    winReason: state.winReason,
    round: state.round,
    turn: state.story?.turn ?? 0,
    finishedAt: new Date().toISOString(),
  });
  clearSavedGame();
}

export function loadHistory(): HistoryEntry[] {
  return history.load();
}

export function clearHistory(): void {
  history.clear();
}

/**
 * Personal notes, kept ONLY in this browser's localStorage — never part of
 * `GameState`, never sent over the network, so they can never leak to (or be
 * overwritten by) another player, even in an online multiplayer game. Keyed
 * per game (`seed`) and, for a shared device where more than one local
 * player might take notes (e.g. hotseat), per author name — defaults to a
 * single shared slot ('me') which is all that's needed on separate devices,
 * since each remote player's notes already live in their own browser.
 */
export function loadNotes(seed: number, author = 'me'): string {
  return notes.load(seed, author);
}

export function saveNotes(seed: number, text: string, author = 'me'): void {
  notes.save(seed, text, author);
}

/**
 * Trigger a download of the full game state + log for a bug report. `description`
 * is the player's own account of what went wrong (from the in-app report form);
 * `crash` is populated automatically when this is called from the global error
 * handler / ErrorBoundary after an uncaught exception.
 */
export function exportProblemReport(
  seed: number,
  state: GameState | null,
  description?: string,
  crash?: CrashInfo,
): string {
  const bundle = {
    kind: 'meq-problem-report',
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    description: description ?? '',
    crash: crash ?? null,
    seed,
    phase: state?.phase ?? null,
    round: state?.round ?? null,
    winner: state?.winner ?? null,
    state,
  };
  const json = JSON.stringify(bundle, null, 2);
  const filename = `meq-report-seed${seed}-round${state?.round ?? 0}.json`;
  downloadText(filename, json, 'application/json');
  return filename;
}

/**
 * Stash the most recent uncaught error so a later "Report a problem" click
 * (e.g. from the ErrorBoundary fallback screen, which has no live GameState
 * of its own) can still attach it. Kept out of GameState/network entirely.
 */
export function recordCrash(crash: CrashInfo): void {
  crashes.record(crash);
}

export function loadLastCrash(): (CrashInfo & { at: string }) | null {
  return crashes.load();
}

export function clearLastCrash(): void {
  crashes.clear();
}

// Re-exported so callers that only need the raw safe-localStorage primitives
// (rather than one of the higher-level stores above) don't need their own
// try/catch wrappers either.
export const { safeGet, safeSet, safeRemove } = storage;
