// One test per Monster, Minion and Hero: attribute integrity and a valid combat
// deck reference (so every unit can actually fight).
import { describe, it, expect } from 'vitest';
import { monsters, minions, heroes, cat, label, freshGame } from './helpers';
import { beginCombat } from '../src/engine/combat';

describe('monsters — data integrity', () => {
  it.each(monsters.map((m) => [label(`${m.id} (${m.name})`), m] as const))(
    '%s has valid attributes and a real combat deck', (_n, m) => {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      for (const stat of ['health', 'fortitude', 'strength', 'wisdom'] as const) {
        expect(Number.isFinite(m[stat]), `${m.id}: ${stat} not numeric`).toBe(true);
        expect(m[stat]).toBeGreaterThanOrEqual(0);
      }
      expect(cat.decks[m.deck], `${m.id}: unknown deck '${m.deck}'`).toBeTruthy();
    });

  it('health is tracked as its own stat, independent of fortitude', () => {
    // Per the physical MEQ Monster Reference sheet, a monster's life pool
    // (health/"wounds") and its combat hand size (fortitude) are separate
    // stats — they merely happen to coincide numerically for some monsters
    // (e.g. Cave Troll is 8/8). The important invariant is that at least one
    // monster's values differ, proving they are not silently aliased.
    expect(monsters.some((m) => m.health !== m.fortitude)).toBe(true);
  });

  it('beginCombat sets the monster defender life from health, not fortitude', () => {
    const s = freshGame();
    const hero = s.heroes[0];
    const m = monsters.find((mm) => mm.fortitude !== mm.health)!;
    const after = beginCombat(s, cat, hero.id, m.id, hero.location);
    expect(after.pendingCombat!.defender.life).toBe(m.health);
    expect(after.pendingCombat!.defender.hand.length).toBeLessThanOrEqual(m.fortitude);
  });
});

describe('minions — data integrity', () => {
  it.each(minions.map((m) => [label(`${m.id} (${m.name})`), m] as const))(
    '%s has valid attributes and a real combat deck', (_n, m) => {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      for (const stat of ['health', 'fortitude', 'strength', 'wisdom'] as const) {
        expect(Number.isFinite(m[stat]), `${m.id}: ${stat} not numeric`).toBe(true);
        expect(m[stat]).toBeGreaterThanOrEqual(0);
      }
      expect(cat.decks[m.combatDeck], `${m.id}: unknown combatDeck '${m.combatDeck}'`).toBeTruthy();
      if (m.location) expect(cat.locations[m.location], `${m.id}: unknown location '${m.location}'`).toBeTruthy();
    });
});

describe('heroes — data integrity', () => {
  it.each(heroes.map((h) => [label(`${h.id} (${h.name})`), h] as const))(
    '%s has valid attributes, deck and start location', (_n, h) => {
      for (const stat of ['fortitude', 'strength', 'agility', 'wisdom'] as const) {
        expect(Number.isFinite(h[stat]), `${h.id}: ${stat} not numeric`).toBe(true);
        expect(h[stat]).toBeGreaterThanOrEqual(0);
      }
      expect(cat.decks[h.deck], `${h.id}: unknown deck '${h.deck}'`).toBeTruthy();
      expect(cat.locations[h.startLocation], `${h.id}: unknown startLocation '${h.startLocation}'`).toBeTruthy();
    });
});
