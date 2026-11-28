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

// ---- Multiple saved games -------------------------------------------------
// Each game (keyed by its seed) lives in its own localStorage entry, with a
// small index of metadata for the "Saved games" list. Saves are compacted (the
// event log is capped) and, if the browser quota is hit, the oldest OTHER saves
// are evicted until the current one fits — it is never silently dropped.
const INDEX_KEY = `${NAMESPACE}.games.v2`;
const GAME_KEY = (seed: number) => `${NAMESPACE}.game.v2.${seed}`;
const MAX_SAVES = 12;
const LOG_KEEP = 400;

export interface SavedGameMeta {
  seed: number;
  savedAt: string;
  round: number;
  turn: number;
  /** Which side a human plays: 'Hero', 'Sauron' or 'AI' (nobody — all AI). */
  humanSide: string;
  heroes: string[];
}

function readIndex(): SavedGameMeta[] {
  const raw = storage.safeGet(INDEX_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as SavedGameMeta[];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function writeIndex(list: SavedGameMeta[]): void {
  storage.safeSet(INDEX_KEY, JSON.stringify(list));
}

/** One-time import of the old single-slot save. */
function migrateLegacy(): void {
  const legacy = saveSlot.load();
  if (!legacy) return;
  saveGame(legacy.state.seed, legacy.state);
  saveSlot.clear();
}

function trySet(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

/** Persist the in-progress game so it survives a reload. Returns false if it could not be stored. */
export function saveGame(seed: number, state: GameState): boolean {
  const compact: GameState = state.log && state.log.length > LOG_KEEP
    ? { ...state, log: state.log.slice(-LOG_KEEP) } : state;
  let json: string;
  try { json = JSON.stringify({ schema: SCHEMA, state: compact }); } catch { return false; }
  const meta: SavedGameMeta = {
    seed, savedAt: new Date().toISOString(), round: state.round, turn: state.story?.turn ?? 0,
    humanSide: state.humanSide ?? 'AI', heroes: state.heroes.map((h) => h.id),
  };
  let list = readIndex().filter((m) => m.seed !== seed);
  let ok = trySet(GAME_KEY(seed), json);
  // Quota: free the oldest other saves until this one fits.
  while (!ok && list.length) {
    const oldest = list.reduce((a, b) => (a.savedAt < b.savedAt ? a : b));
    storage.safeRemove(GAME_KEY(oldest.seed));
    list = list.filter((m) => m.seed !== oldest.seed);
    ok = trySet(GAME_KEY(seed), json);
  }
  if (!ok) return false;
  list.unshift(meta);
  for (const m of list.splice(MAX_SAVES)) storage.safeRemove(GAME_KEY(m.seed));
  writeIndex(list);
  return true;
}

/** All saved games, most recently played first. */
export function listSavedGames(): SavedGameMeta[] {
  migrateLegacy();
  const list = readIndex().filter((m) => storage.safeGet(GAME_KEY(m.seed)) !== null);
  return list.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/** Load a saved game by seed (default: the most recent one). */
export function loadSavedGame(seed?: number): { seed: number; state: GameState } | null {
  const target = seed ?? listSavedGames()[0]?.seed;
  if (target === undefined) return null;
  const raw = storage.safeGet(GAME_KEY(target));
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as { schema: number; state: GameState };
    if (env.schema !== SCHEMA || !env.state) return null;
    return { seed: target, state: env.state };
  } catch { return null; }
}

export function hasSavedGame(): boolean {
  return listSavedGames().length > 0;
}

/** Delete one saved game. */
export function deleteSavedGame(seed: number): void {
  storage.safeRemove(GAME_KEY(seed));
  writeIndex(readIndex().filter((m) => m.seed !== seed));
}

/** Append a finished game to the persistent history and drop ITS live save. */
export function recordCompletedGame(seed: number, state: GameState): void {
  history.record({
    seed,
    winner: state.winner ?? null,
    winReason: state.winReason,
    round: state.round,
    turn: state.story?.turn ?? 0,
    finishedAt: new Date().toISOString(),
  });
  deleteSavedGame(seed);
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
