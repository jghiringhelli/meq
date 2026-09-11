import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { foeDeckBreakdown, heroKnownDeckBreakdown } from '../src/play/CombatBoard';
import { isTrainedCard } from '../src/engine/mechanics';
import type { Combatant, CardId } from '../src/engine/types';

// QoL request: in combat, show an abstract view of the foe's combat deck —
// easy for monsters/minions since their physical deck composition is fixed
// (unlike a hero's deck, which grows via training and isn't fully known until
// a card is actually revealed).
describe('foeDeckBreakdown — abstract enemy deck panel', () => {
  it('lists every unique card in the foe deck with its full copy count when nothing has been played', () => {
    const rows = foeDeckBreakdown(cat, 'monster-zealot', []);
    expect(rows.length).toBeGreaterThan(0);
    const totalCards = cat.decks['monster-zealot'].length;
    const sumTotals = rows.reduce((n, r) => n + r.total, 0);
    expect(sumTotals).toBe(totalCards);
    for (const r of rows) expect(r.used).toBe(0);
  });

  it('marks a card as used once it has been played this fight, without affecting other cards', () => {
    const deckId = 'monster-zealot';
    const anyCard = cat.decks[deckId][0];
    const rows = foeDeckBreakdown(cat, deckId, [anyCard]);
    const played = rows.find((r) => r.id === anyCard)!;
    expect(played.used).toBe(1);
    expect(played.total - played.used).toBe(played.total - 1);
    const others = rows.filter((r) => r.id !== anyCard);
    for (const r of others) expect(r.used).toBe(0);
  });

  it('returns nothing for an unknown/undefined deck id (no crash)', () => {
    expect(foeDeckBreakdown(cat, undefined, [])).toEqual([]);
    expect(foeDeckBreakdown(cat, 'not-a-real-deck', [])).toEqual([]);
  });
});

// Second QoL request: when a human plays Sauron, show what he legitimately
// knows about the HERO he's fighting via a monster/minion — the hero's
// printed base deck (always public) plus only those Training upgrades whose
// specific card identity has actually been revealed (played/discarded), never
// ones still secretly held.
describe('heroKnownDeckBreakdown — what Sauron knows about a hero deck', () => {
  const s = freshGame();
  const heroId = s.heroes[0].id;
  const baseDeckId = cat.heroes[heroId].deck;
  const skillCard = cat.decks['skills'][0];

  it('sanity: the sample card really is a Skill (trained) card', () => {
    expect(isTrainedCard(cat, skillCard)).toBe(true);
  });

  function makeCombatant(discard: CardId[] = []): Combatant {
    return { kind: 'hero', refId: heroId, name: 'Test Hero', life: 10, strength: 3, strengthSpent: 0,
      exhausted: false, hand: [], deck: [], discard, damagePool: [] };
  }

  it('with no training, shows only the public base deck composition', () => {
    const { rows, unknownTrained } = heroKnownDeckBreakdown(cat, heroId, makeCombatant(), [], 0);
    const totalBase = cat.decks[baseDeckId].length;
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(totalBase);
    expect(unknownTrained).toBe(0);
  });

  it('a trained card Sauron never saw revealed stays an anonymous "unknown" count, not an identified row', () => {
    const { rows, unknownTrained } = heroKnownDeckBreakdown(cat, heroId, makeCombatant(), [], 1);
    expect(unknownTrained).toBe(1);
    expect(rows.some((r) => r.id === skillCard)).toBe(false);
  });

  it('once discarded/played (even mid-fight, before combat ends), the specific trained card becomes known', () => {
    const { rows, unknownTrained } = heroKnownDeckBreakdown(cat, heroId, makeCombatant([skillCard]), [], 1);
    expect(unknownTrained).toBe(0);
    const row = rows.find((r) => r.id === skillCard);
    expect(row).toBeDefined();
    expect(row!.used).toBe(1); // sitting in the discard pile right now — can't reappear until reshuffled
  });

  it('a reveal from a PAST fight survives even after its discard pile was later reshuffled away', () => {
    // Simulates ai.ts's heroIntel high-water mark: the live combatant's
    // discard is empty again (reshuffled), but Sauron still remembers it.
    const { rows, unknownTrained } = heroKnownDeckBreakdown(cat, heroId, makeCombatant([]), [skillCard], 1);
    expect(unknownTrained).toBe(0);
    const row = rows.find((r) => r.id === skillCard);
    expect(row).toBeDefined();
    expect(row!.used).toBe(0); // known to exist, but not currently sitting in the discard
  });
});
