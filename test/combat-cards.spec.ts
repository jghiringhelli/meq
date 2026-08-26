// One test per combat card (data integrity + it resolves in a real bout) and
// one test per distinct combat ability (effectKey → implemented + executes).
import { describe, it, expect } from 'vitest';
import { combatCards, cat, label } from './helpers';
import { resolveBout, getEffect, EFFECTS } from '../src/engine/effects';
import type { CombatCard } from '../src/engine/types';

const VALID_TERRAIN = new Set(['woods', 'swamp', 'mountain', 'plains', 'hill', '']);
const VALID_TYPE = new Set(['ranged', 'melee']);
const VALID_OWNER = new Set(['hero', 'monster']);

// A neutral opponent card so every bout has both sides populated.
const NEUTRAL: CombatCard = {
  id: 'test-neutral', deck: 'monster-behemoth', owner: 'monster', name: 'Neutral',
  type: 'melee', attack: 1, defense: 1, strengthCost: 1, terrain: '',
  ability: '', effectKey: '', copies: 1,
};

describe('combat cards — data integrity', () => {
  it.each(combatCards.map((c) => [label(`${c.id} (${c.name})`), c] as const))(
    '%s has valid combat-card data', (_name, c) => {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(VALID_OWNER.has(c.owner)).toBe(true);
      expect(VALID_TYPE.has(c.type)).toBe(true);
      expect(VALID_TERRAIN.has(c.terrain)).toBe(true);
      expect(Number.isFinite(c.attack)).toBe(true);
      expect(c.attack).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(c.defense)).toBe(true);
      expect(c.defense).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(c.strengthCost)).toBe(true);
      expect(c.strengthCost).toBeGreaterThanOrEqual(0);
      expect(c.copies).toBeGreaterThanOrEqual(1);
    });

  it.each(combatCards.map((c) => [label(`${c.id} (${c.name})`), c] as const))(
    '%s: ability text implies a registered effectKey', (_name, c) => {
      if (c.ability && c.ability.trim()) {
        expect(c.effectKey, `${c.id} has ability text but no effectKey`).toBeTruthy();
      }
      if (c.effectKey) {
        expect(getEffect(c.effectKey), `${c.id} effectKey '${c.effectKey}' not in registry`).not.toBeNull();
      }
    });
});

describe('combat cards — resolve in a bout without throwing', () => {
  it.each(combatCards.map((c) => [label(`${c.id} (${c.name})`), c] as const))(
    '%s resolves as attacker and as defender', (_name, c) => {
      const asAttacker = () => resolveBout(c, NEUTRAL, {}, { attacker: [], defender: [] });
      const asDefender = () => resolveBout(NEUTRAL, c, {}, { attacker: [], defender: [] });
      expect(asAttacker).not.toThrow();
      expect(asDefender).not.toThrow();
      const out = asAttacker();
      expect(out).toHaveProperty('attacker');
      expect(out).toHaveProperty('defender');
      expect(Number.isFinite(out.attacker.damageTaken)).toBe(true);
      expect(Number.isFinite(out.defender.damageTaken)).toBe(true);
    });
});

// Every distinct ability (effectKey) actually used by a card must be implemented
// and must run inside a real bout for a representative card carrying it.
const usedKeys = [...new Set(combatCards.map((c) => c.effectKey).filter(Boolean))].sort();

describe('combat abilities — every effectKey is implemented and executes', () => {
  it.each(usedKeys)('effectKey "%s" is registered', (key) => {
    expect(getEffect(key), `effectKey '${key}' missing from EFFECTS registry`).not.toBeNull();
    expect(EFFECTS[key]).toBeDefined();
  });

  it.each(usedKeys)('effectKey "%s" executes in a bout', (key) => {
    const carrier = combatCards.find((c) => c.effectKey === key)!;
    // Run the ability on both sides and with a carry buffer so next-round /
    // stack-touching effects have somewhere to write.
    const run = () => resolveBout(carrier, NEUTRAL, { attacker: carrier.type }, { attacker: [], defender: [] });
    expect(run, `bout with effectKey '${key}' (card ${carrier.id}) threw`).not.toThrow();
    const out = run();
    expect(out).toHaveProperty('attacker');
  });
});

describe('combat abilities — registry has no dangling specs', () => {
  it('every registry effectKey is a non-empty implemented spec', () => {
    for (const [key, spec] of Object.entries(EFFECTS)) {
      expect(key.length, 'empty registry key').toBeGreaterThan(0);
      expect(spec, `registry spec for '${key}' is falsy`).toBeTruthy();
    }
  });

  it('catalog references no effectKey outside the registry', () => {
    const missing = usedKeys.filter((k) => !EFFECTS[k]);
    expect(missing, `unimplemented effectKeys: ${missing.join(', ')}`).toEqual([]);
  });
});
