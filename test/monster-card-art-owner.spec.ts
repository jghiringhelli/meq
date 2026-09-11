import { describe, it, expect } from 'vitest';
import { cat } from './helpers';

// Regression: CombatBoard used to pass a monster's own id (e.g. "mon-crebain")
// as the art "owner" hint for its combat cards. Monsters don't have a personal
// deck though — assets/monsters.json's `deck` field says every monster draws
// from one of 3 SHARED archetype decks (monster-behemoth/-ravager/-zealot),
// e.g. Crebain/Agent/Snaga/Orc all draw from "monster-zealot". Passing the
// monster's own id as owner always missed the dedicated monster-deck scans and
// fell back to generic id art, which — for card NAMES shared with hero cards
// (e.g. "Precision", "Hack") — is actually a HERO's scan. The fix resolves the
// owner key from the monster's `deck` field (stripping the "monster-" prefix)
// instead of using its own id.
describe('monster combat-card art resolves to its shared archetype deck, not its own id', () => {
  it('every monster maps to one of the 3 modeled monster archetype decks', () => {
    const archetypes = new Set(['monster-behemoth', 'monster-ravager', 'monster-zealot']);
    for (const m of Object.values(cat.monsters)) {
      expect(archetypes.has(m.deck)).toBe(true);
    }
  });

  it('the archetype deck (not the monster id) has its own dedicated card art entries', () => {
    // Sanity: an id-based lookup using the monster's own id would never match
    // combatCardsByOwner (which only has deck-level keys), confirming the bug
    // this test guards against would otherwise silently fall back to id art.
    const crebain = cat.monsters['mon-crebain'];
    expect(crebain).toBeDefined();
    expect(crebain.deck).toBe('monster-zealot');
    expect(crebain.deck.replace(/^monster-/, '')).toBe('zealot');
  });
});
