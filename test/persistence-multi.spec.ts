import { describe, it, expect, beforeEach } from 'vitest';
import { saveGame, listSavedGames, loadSavedGame, deleteSavedGame } from '../src/play/persistence';
import { cat } from './helpers';
import { newGame } from '../src/engine/game';

function installStorage(quotaChars = Infinity) {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      const used = [...m.entries()].reduce((n, [key, val]) => (key === k ? n : n + val.length), 0);
      if (used + v.length > quotaChars) throw new Error('QuotaExceededError');
      m.set(k, v);
    },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('multiple saved games', () => {
  beforeEach(() => installStorage());

  it('keeps several games side by side and deletes one at a time', () => {
    saveGame(1, newGame(cat, 1, undefined, 'Hero'));
    saveGame(2, newGame(cat, 2, undefined, 'Sauron', true));
    expect(listSavedGames().map((g) => g.seed).sort()).toEqual([1, 2]);
    expect(listSavedGames().find((g) => g.seed === 2)!.humanSide).toBe('Sauron');
    expect(loadSavedGame(2)!.state.humanSide).toBe('Sauron');
    deleteSavedGame(1);
    expect(listSavedGames().map((g) => g.seed)).toEqual([2]);
  });

  it('evicts the oldest other save instead of silently losing the current one', () => {
    const a = newGame(cat, 1, undefined, 'Hero');
    const size = JSON.stringify({ schema: 1, state: a }).length;
    installStorage(size * 2.5);
    saveGame(1, a);
    saveGame(2, newGame(cat, 2, undefined, 'Hero'));
    expect(saveGame(3, newGame(cat, 3, undefined, 'Sauron', true))).toBe(true);
    expect(loadSavedGame(3)).not.toBeNull();
  });
});
