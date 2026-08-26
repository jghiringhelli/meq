// One test per Quest: data integrity (owner, type, task/reward text present).
import { describe, it, expect } from 'vitest';
import { quests, cat, label } from './helpers';

const VALID_TYPE = new Set(['Starting Quest', 'Advanced Quest']);

describe('quests — data integrity', () => {
  it.each(quests.map((q) => [label(`${q.id} (${q.name})`), q] as const))(
    '%s has valid quest data', (_n, q) => {
      expect(q.id).toBeTruthy();
      expect(q.name).toBeTruthy();
      expect(cat.heroes[q.hero], `${q.id}: unknown hero '${q.hero}'`).toBeTruthy();
      expect(VALID_TYPE.has(q.type), `${q.id}: bad type '${q.type}'`).toBe(true);
      expect(typeof q.task).toBe('string');
      expect(typeof q.reward).toBe('string');
      // Every quest is either a task with a reward, or (rarely) narrative setup.
      expect((q.task + q.reward + q.setup).trim().length, `${q.id}: entirely empty`).toBeGreaterThan(0);
    });
});

describe('quests — each hero has a Starting and an Advanced quest', () => {
  it.each(Object.keys(cat.heroes))('hero %s has both quest tiers', (hid) => {
    const mine = quests.filter((q) => q.hero === hid);
    expect(mine.some((q) => q.type === 'Starting Quest'), `${hid}: no Starting Quest`).toBe(true);
    expect(mine.some((q) => q.type === 'Advanced Quest'), `${hid}: no Advanced Quest`).toBe(true);
  });
});
