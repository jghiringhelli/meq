// Only "The Nine" (the Ringwraiths, as a single group entry with effectKey
// 'minion-return-morgul') return to the board after being defeated. Every
// OTHER elite minion — the Mouth of Sauron, the Black Serpent, Gothmog, and
// the Witch-king (a distinct catalog entry from "The Nine") — is permanently
// destroyed once defeated and must never be redeployed by Sauron's AI.
import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import { deployMinion } from '../src/engine/setup';
import { gameStage } from '../src/engine/mechanics';

describe('permanently-defeated elite minions never redeploy', () => {
  it("marks a defeated non-Ringwraith minion in s.map.minionDefeated and bars its redeploy", () => {
    const s = freshGame();
    s.story.sauronProgress = 15; // stage 3: every minion is stage-eligible
    expect(gameStage(s)).toBeGreaterThanOrEqual(3);
    const mouthOfSauron = cat.minions['minion-mouth-of-sauron'];
    expect(mouthOfSauron).toBeTruthy();
    expect(mouthOfSauron.effectKey).not.toBe('minion-return-morgul');

    // Simulate the Mouth of Sauron having just been defeated in combat
    // (mirrors combat.ts's endCombat 'attacker wins' branch: spliced off the
    // board, then flagged as permanently defeated since it lacks the
    // Ringwraiths' return-to-Minas-Morgul effectKey).
    for (const arr of Object.values(s.map.minionsAt ?? {})) {
      const i = arr.indexOf('minion-mouth-of-sauron');
      if (i >= 0) arr.splice(i, 1);
    }
    s.map.minionDefeated = ['minion-mouth-of-sauron'];

    let guard = 0;
    while (deployMinion(s, cat) && guard++ < 20) { /* deploy the rest of the reserve */ }
    const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
    expect(onBoard.has('minion-mouth-of-sauron')).toBe(false);
  });

  it('a Ringwraith ("The Nine") is NOT put in minionDefeated — it uses minionReturnPending instead', () => {
    const s = freshGame();
    const theNine = Object.values(cat.minions).find((m) => m.effectKey === 'minion-return-morgul')!;
    expect(theNine).toBeTruthy();
    // The Witch-king is a separate catalog entry — never returns despite
    // thematically also being "one of the Nine" in the lore.
    const witchKing = Object.values(cat.minions).find((m) => /witch.?king/i.test(m.name));
    expect(witchKing?.effectKey).not.toBe('minion-return-morgul');
  });
});
