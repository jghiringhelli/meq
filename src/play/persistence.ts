// M12 — localStorage persistence: save/resume the in-progress game, keep a
// completed-game history, and export a full "report a problem" bundle.
import type { GameState } from '../engine/types';

const SAVE_KEY = 'meq.save.v1';
const HISTORY_KEY = 'meq.history.v1';
const NOTES_KEY_PREFIX = 'meq.notes.v1.';
const SCHEMA = 1;

interface SaveEnvelope {
  schema: number;
  seed: number;
  savedAt: string;
  state: GameState;
}

export interface HistoryEntry {
  seed: number;
  winner: string | null;
  winReason?: string;
  round: number;
  turn: number;
  finishedAt: string;
}

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota / disabled */ }
}
function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/** Persist the current in-progress game so it survives a reload. */
export function saveGame(seed: number, state: GameState): void {
  const env: SaveEnvelope = { schema: SCHEMA, seed, savedAt: new Date().toISOString(), state };
  try { safeSet(SAVE_KEY, JSON.stringify(env)); } catch { /* non-serializable — skip */ }
}

/** Load a resumable in-progress game (null if none / unfinished-only). */
export function loadSavedGame(): { seed: number; state: GameState } | null {
  const raw = safeGet(SAVE_KEY);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as SaveEnvelope;
    if (env.schema !== SCHEMA || !env.state) return null;
    return { seed: env.seed, state: env.state };
  } catch { return null; }
}

export function hasSavedGame(): boolean {
  return loadSavedGame() !== null;
}

export function clearSavedGame(): void {
  safeRemove(SAVE_KEY);
}

/** Append a finished game to the persistent history and drop the live save. */
export function recordCompletedGame(seed: number, state: GameState): void {
  const entry: HistoryEntry = {
    seed,
    winner: state.winner ?? null,
    winReason: state.winReason,
    round: state.round,
    turn: state.story?.turn ?? 0,
    finishedAt: new Date().toISOString(),
  };
  const list = loadHistory();
  list.unshift(entry);
  safeSet(HISTORY_KEY, JSON.stringify(list.slice(0, 100)));
  clearSavedGame();
}

export function loadHistory(): HistoryEntry[] {
  const raw = safeGet(HISTORY_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as HistoryEntry[]) : [];
  } catch { return []; }
}

export function clearHistory(): void {
  safeRemove(HISTORY_KEY);
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
function notesKey(seed: number, author = 'me'): string {
  return `${NOTES_KEY_PREFIX}${seed}.${author}`;
}

export function loadNotes(seed: number, author = 'me'): string {
  return safeGet(notesKey(seed, author)) ?? '';
}

export function saveNotes(seed: number, text: string, author = 'me'): void {
  if (text.trim() === '') { safeRemove(notesKey(seed, author)); return; }
  safeSet(notesKey(seed, author), text);
}

export interface CrashInfo {
  message: string;
  stack?: string;
  componentStack?: string;
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
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // Fallback: open the JSON in a new tab if downloads are blocked.
    try {
      const w = window.open('', '_blank');
      if (w) { w.document.write(`<pre>${json.replace(/</g, '&lt;')}</pre>`); }
    } catch { /* ignore */ }
  }
  return filename;
}

/**
 * Stash the most recent uncaught error so a later "Report a problem" click
 * (e.g. from the ErrorBoundary fallback screen, which has no live GameState
 * of its own) can still attach it. Kept out of GameState/network entirely.
 */
const LAST_CRASH_KEY = 'meq.last-crash.v1';

export function recordCrash(crash: CrashInfo): void {
  try { safeSet(LAST_CRASH_KEY, JSON.stringify({ ...crash, at: new Date().toISOString() })); } catch { /* ignore */ }
}

export function loadLastCrash(): (CrashInfo & { at: string }) | null {
  const raw = safeGet(LAST_CRASH_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function clearLastCrash(): void {
  safeRemove(LAST_CRASH_KEY);
}
