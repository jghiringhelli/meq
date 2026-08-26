// One test per Mission (hero + Sauron): valid structured condition and a win
// check that evaluates without throwing against a fresh game.
import { describe, it, expect } from 'vitest';
import { heroMissions, sauronMissions, freshGame, cat, label } from './helpers';
import { evalMission } from '../src/engine/missions';

const KNOWN_CONDS = new Set([
  'heroCorruptionAtMost', 'heroFavorAtLeast', 'monstersAtMost', 'minionsAtMost',
  'activePlotsAtLeast', 'allQuestsComplete', 'sauronMarkerAtStageIII',
  'sauronInfluenceAtLeast', 'ringwraithsOrShireInfluence',
]);

const all = [
  ...heroMissions.map((m) => ['hero', m] as const),
  ...sauronMissions.map((m) => ['sauron', m] as const),
];

describe('missions — data integrity', () => {
  it.each(all.map(([side, m]) => [label(`${side}:${m.id} (${m.name})`), m] as const))(
    '%s has a valid structured condition', (_n, m) => {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.text).toBeTruthy();
      expect(m.condition, `${m.id}: no structured condition`).toBeTruthy();
      expect(KNOWN_CONDS.has(m.condition!.kind), `${m.id}: unknown condition '${m.condition!.kind}'`).toBe(true);
    });
});

describe('missions — evaluate without throwing', () => {
  it.each(all.map(([side, m]) => [label(`${side}:${m.id}`), m] as const))(
    '%s evalMission returns a boolean', (_n, m) => {
      const s = freshGame();
      let res!: boolean;
      expect(() => { res = evalMission(m.condition, s, cat); }).not.toThrow();
      expect(typeof res).toBe('boolean');
    });
});
