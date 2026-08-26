// M12 — localStorage persistence: save/resume the in-progress game, keep a
// completed-game history, and export a full "report a problem" bundle.
import type { GameState } from '../engine/types';

const SAVE_KEY = 'meq.save.v1';
const HISTORY_KEY = 'meq.history.v1';
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

/** Trigger a download of the full game state + log for a bug report. */
export function exportProblemReport(seed: number, state: GameState): void {
  const bundle = {
    kind: 'meq-problem-report',
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    seed,
    phase: state.phase,
    round: state.round,
    winner: state.winner ?? null,
    state,
  };
  const json = JSON.stringify(bundle, null, 2);
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meq-report-seed${seed}-round${state.round}.json`;
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
}
