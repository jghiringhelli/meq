// Regression coverage for the online-multiplayer AI-hero-driver fix: when a
// game mixes AI-controlled heroes with human-claimed ones (a real online
// player has claimed a hero role while the rest are left to the AI), the
// driver must stop and hand control back the instant it reaches a hero whose
// role is NOT AI-controlled, rather than racing ahead and playing that turn
// for them before their own dispatched action ever arrives over the network.
import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { newGame, advance } from '../src/engine/game';
import { advanceHeroSide, mulberry32, missionAware } from '../src/engine/heroAI';

const THREE = Object.keys(cat.heroes).slice(0, 3);

function atHeroActions() {
  let s = newGame(cat, 5, THREE);
  for (let i = 0; i < 50 && s.phase !== 'HeroActions'; i++) s = advance(s, cat);
  return s;
}

/** Force a hero's turn to end trivially the next time the driver reaches it,
 *  bypassing the mandatory Encounter Step's card draw entirely (irrelevant to
 *  what this suite is testing: the AI/human-hero pause gating). */
function markDoneForTurn(s: ReturnType<typeof atHeroActions>, heroId: string) {
  const h = s.heroes.find((x) => x.id === heroId)!;
  h.actionsRemaining = 0;
  h.encounterStepDone = true;
}

describe('advanceHeroSide — mixed AI/human hero control (online multiplayer)', () => {
  it('with no predicate (solo default), every hero is AI-driven end to end', () => {
    const s = atHeroActions();
    const out = advanceHeroSide(s, cat, missionAware, mulberry32(1));
    // the whole hero side finished autonomously and control returned to Sauron
    expect(out.activeSide).toBe('Sauron');
  });

  it('stops immediately when the FIRST active hero is human-controlled', () => {
    const s = atHeroActions();
    const humanHero = s.heroes[s.activeHeroIndex].id;
    const out = advanceHeroSide(s, cat, missionAware, mulberry32(1), (id) => id !== humanHero);
    // no AI action was ever taken for this hero — state is unchanged, still
    // this hero's own turn, waiting for their dispatched action instead.
    expect(out).toBe(s);
    expect(out.activeSide).toBe('Hero');
    expect(out.heroes[out.activeHeroIndex].id).toBe(humanHero);
  });

  it('AI-drives every OTHER hero and stops only once it reaches the human-controlled one', () => {
    const s = atHeroActions();
    // Pick a hero OTHER than the one initially active as "the human" — since
    // it's the only non-AI hero, the driver must eventually reach it and pause
    // there (turn order need not be array order; only one hero can be a
    // dead-end for the loop, so it's the one guaranteed to be hit). Every
    // other hero is pre-marked "done for the turn" so the driver blows
    // through them in one step each, keeping this test isolated to the
    // AI/human-hero gating logic (not real combat/encounter resolution,
    // covered elsewhere by the fuzzer/self-play suites).
    const humanHero = s.heroes.find((h) => h.id !== s.heroes[s.activeHeroIndex].id)!.id;
    for (const h of s.heroes) if (h.id !== humanHero) markDoneForTurn(s, h.id);
    const out = advanceHeroSide(s, cat, missionAware, mulberry32(1), (id) => id !== humanHero);
    expect(out.activeSide).toBe('Hero');
    expect(out.heroes[out.activeHeroIndex].id).toBe(humanHero);
    // the earlier AI hero(es) actually did something (state advanced, not a no-op)
    expect(out).not.toBe(s);
  });

  it('once every hero is AI again (predicate flips), a fresh call finishes the side', () => {
    const s = atHeroActions();
    const humanHero = s.heroes[s.activeHeroIndex].id;
    for (const h of s.heroes) if (h.id !== humanHero) markDoneForTurn(s, h.id);
    const paused = advanceHeroSide(s, cat, missionAware, mulberry32(1), (id) => id !== humanHero);
    expect(paused.activeSide).toBe('Hero');
    // the human "reconnects"/AI takes over (predicate now says everyone's AI)
    markDoneForTurn(paused, humanHero);
    const resumed = advanceHeroSide(paused, cat, missionAware, mulberry32(2));
    expect(resumed.activeSide).toBe('Sauron');
  });
});
