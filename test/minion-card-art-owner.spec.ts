import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { combatantOwnerKey } from '../src/play/CombatBoard';

// Regression: named elite minions (Mouth of Sauron, Black Serpent, Gothmog,
// Ringwraiths, Witch-king) have NO personal combat deck either — like generic
// monsters, assets/minions.json's `combatDeck` field says they draw from one
// of the 3 shared archetype decks. `combatantOwnerKey` only checked
// `cat.monsters[refId]?.deck`, which is always undefined for a minion id, so
// it silently fell back to the minion's own (non-existent-as-art-owner) id —
// missing the dedicated monster-archetype scans and rendering the generic
// id art, which for shared card names (e.g. "Hack", "Precision") is actually
// a HERO's scan. That made minions/monsters visibly show a hero's card
// border in combat. Fixed by also checking `cat.minions[refId]?.combatDeck`.
describe('minion combat-card art resolves to its shared archetype deck, not the hero fallback', () => {
  it('every minion maps to one of the 3 modeled monster archetype decks via combatDeck', () => {
    const archetypes = new Set(['monster-behemoth', 'monster-ravager', 'monster-zealot']);
    for (const m of Object.values(cat.minions)) {
      expect(archetypes.has(m.combatDeck)).toBe(true);
    }
  });

  it('combatantOwnerKey resolves a minion id to its archetype deck name, not the hero-scan fallback', () => {
    const mouth = Object.keys(cat.minions).find((id) => cat.minions[id].combatDeck === 'monster-zealot');
    expect(mouth).toBeDefined();
    expect(combatantOwnerKey(cat, mouth!)).toBe('zealot');
  });
});
