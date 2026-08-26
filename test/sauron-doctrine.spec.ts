import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { playoutGame, missionAware, heuristic } from '../src/engine/heroAI';
import { newGame } from '../src/engine/setup';
import type { SauronDoctrine } from '../src/engine/types';

// Locks the Sauron automa "doctrine" plumbing and its faithful semantics:
//  - the doctrine field is honoured (games still terminate under each);
//  - the 'attrition' doctrine (which leans on corruption/hand-dump Shadow cards
//    and favour-draining plots) grinds MORE corruption onto the heroes than the
//    'balanced' default — its whole point is wearing them down.
// The corruption edge is measured against the plain `heuristic` hero, NOT the
// mission-aware brain: mission-aware now weaves around the perilised corridor,
// shuns needless combat and banks turns on havens, so it largely RESISTS the
// attrition grind (that resistance is the point of the hero-AI work) — which
// makes the doctrine's mechanism only observable against a non-dodging hero.
describe('sauron doctrine', () => {
  it('newGame seats the Eye on the tempo doctrine by default', () => {
    expect(newGame(cat, 1).sauron.doctrine).toBe('tempo');
  });

  it('every doctrine still produces terminating games', () => {
    for (const doctrine of ['balanced', 'tempo', 'attrition'] as SauronDoctrine[]) {
      const r = playoutGame(cat, 1007, missionAware, 20000, { heroIds: ['thalin'], doctrine });
      expect(r.winner === 'Hero' || r.winner === 'Sauron').toBe(true);
    }
  });

  it('attrition grinds more hero corruption than balanced (vs a non-dodging hero)', () => {
    const totalCorruption = (doctrine: SauronDoctrine): number => {
      let corr = 0;
      for (const h of ['thalin', 'eleanor']) {
        for (const base of [1000, 2000]) {
          for (let i = 0; i < 12; i++) {
            corr += playoutGame(cat, base + 13 * i, heuristic, 20000, { heroIds: [h], doctrine }).finalCorruption;
          }
        }
      }
      return corr;
    };
    expect(totalCorruption('attrition')).toBeGreaterThan(totalCorruption('balanced'));
  }, 60000);
});
