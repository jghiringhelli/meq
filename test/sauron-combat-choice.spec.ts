// A human Sauron plays the foe's combat cards himself (same flow as a hero);
// the Lidless Eye automa still picks automatically.
import { describe, it, expect } from 'vitest';
import { monsters, minions, cat, freshGame } from './helpers';
import { beginCombat } from '../src/engine/combat';
import { resolveChoice } from '../src/engine/game';
import type { GameState } from '../src/engine/types';

function toSauronChoice(foeId: string, humanSauron: boolean): GameState {
  let s = freshGame();
  s.humanSide = humanSauron ? 'Sauron' : 'Hero';
  const hero = s.heroes[0];
  s = beginCombat(s, cat, hero.id, foeId, hero.location);
  if (s.pendingChoice?.kind === 'combat-prep') s = resolveChoice(s, cat, s.pendingChoice.options[0].id);
  return s;
}

describe('human Sauron plays the foe combat cards', () => {
  it.each(monsters.map((m) => [m.id, m] as const))('%s: hand drawn by fortitude, Sauron chooses', (_id, m) => {
    let s = toSauronChoice(m.id, true);
    const handSize = s.pendingCombat!.defender.hand.length;
    expect(handSize).toBe(Math.min(Math.max(1, m.fortitude), cat.decks[m.deck].length));
    s = resolveChoice(s, cat, s.pendingChoice!.options[0].id); // hero picks first
    if (s.pendingCombat && s.pendingChoice?.kind === 'combat-defender') {
      expect(s.pendingChoice.seat).toBe('sauron');
      expect(s.pendingChoice.options).toHaveLength(s.pendingCombat.defender.hand.length + 1);
      expect(s.pendingCombat.reveal.defender).toBeUndefined();
      const pick = s.pendingChoice.options[0].id;
      s = resolveChoice(s, cat, pick);
      expect(s.pendingCombat?.report.length ?? 1).toBeGreaterThan(0);
    }
  });

  it('minions are also played by the human Sauron', () => {
    const m = minions[0];
    let s = toSauronChoice(m.id, true);
    s = resolveChoice(s, cat, s.pendingChoice!.options[0].id);
    expect(s.pendingChoice?.kind).toBe('combat-defender');
  });

  it('declaring exhaustion stops the foe from playing cards', () => {
    let s = toSauronChoice(monsters[0].id, true);
    s = resolveChoice(s, cat, s.pendingChoice!.options[0].id);
    s = resolveChoice(s, cat, '__exhaust__');
    expect(s.pendingCombat?.defender.exhausted ?? true).toBe(true);
  });

  it('the automa picks the foe card without asking', () => {
    let s = toSauronChoice(monsters[0].id, false);
    s = resolveChoice(s, cat, s.pendingChoice!.options[0].id);
    expect(s.pendingChoice?.kind).not.toBe('combat-defender');
  });
});
