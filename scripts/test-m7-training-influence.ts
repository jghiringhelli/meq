// M7 acceptance test — trained-card injection + Eye intel + strategic influence.
//
// Covers the owner's guidance:
//  * Training injects a hidden advanced card (agility=draw, strength=attack) into
//    the hero's ONE shared deck; identity hidden from Sauron until first played.
//  * The Eye models unknown trained cards as a prior, then LEARNS each one once it
//    surfaces in the public discard (persistent high-water-mark intel).
//  * Influence doctrine: hoard/maximise through the first ~2/3 of the story track,
//    spend the war chest down in the final third.
//  * Plot valuation: advance-2+ plots are worth keeping; advance-1 plots are bluffs.
// Run: npx tsx scripts/test-m7-training-influence.ts
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/game';
import { grantTraining, isTrainedCard, resolveTrainingChoice } from '../src/engine/mechanics';
import {
  heroModel, updateHeroIntel, ratePlot, rankPlots,
} from '../src/engine/ai';
import type { GameState } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}
function total(m: ReturnType<typeof heroModel>): number { return m.reduce((n, c) => n + c.weight, 0); }
function weightOf(m: ReturnType<typeof heroModel>, id: string): number {
  return m.filter((c) => c.card.id === id).reduce((n, c) => n + c.weight, 0);
}

const cat = loadCatalog();

// --- training draws real Skill cards into the hero's hand -------------------
// NOTE: training is now interactive — grantTraining raises a `pendingChoice`
// per level (draw two, keep one) rather than synchronously injecting cards,
// and the kept card goes to the hero's HAND (not straight into the deck; it
// becomes a deck member only once it later cycles hand → rest pool → life
// pool, same as any other Hero card). See test/training.spec.ts for the
// authoritative interactive-choice coverage; this just re-derives the
// M7-specific "both kept cards are real Skill cards" + deck-drain assertions
// against the current API.
{
  const s: GameState = newGame(cat, 5);
  const hero = s.heroes[0];
  const hand0 = hero.hand.length;
  const skillDeck0 = s.skillDeck?.length ?? 0;
  grantTraining(s, cat, hero, 2);
  let guard = 0;
  while (s.pendingChoice?.kind === 'training' && guard++ < 10) {
    const optionId = s.pendingChoice.options[0].id;
    s.pendingChoice = null; // mirrors game.ts's resolveChoice, which clears before dispatching
    resolveTrainingChoice(s, cat, optionId);
  }
  assert(hero.hand.length === hand0 + 2, 'training adds 2 kept Skill cards into the hero hand');
  assert(hero.trainedCount === 2 && hero.training === 2, 'training bumps the public counters');
  const injected = hero.hand.filter((id) => isTrainedCard(cat, id)).length;
  assert(injected === 2, 'both kept cards are real Skill-deck cards');
  // draw 2, keep 1 → 4 cards leave the Skill deck; 2 discarded faceup
  assert((s.skillDeck?.length ?? 0) === skillDeck0 - 4, 'training draws two Skill cards per level');
  assert((s.skillDiscard?.length ?? 0) === 2, 'the unkept Skill cards are discarded faceup');
}

// --- belief: unknown trained is a prior, learned once revealed --------------
{
  const heroRef = Object.keys(cat.heroes)[0];
  const deckLen = (cat.decks[cat.heroes[heroRef].deck] ?? []).length;
  const someSkill = Object.values(cat.combatCards).find((c) => c.deck === 'skills')!.id;

  // no training yet
  const base = heroModel(cat, heroRef, [], [], 0);
  assert(total(base) === deckLen, 'base belief = starting deck');

  // hero has trained twice, nothing revealed → 2 unknown-prior cards added
  const hidden = heroModel(cat, heroRef, [], [], 2);
  assert(total(hidden) === deckLen + 2, 'unknown trained cards inflate the belief as a prior');
  assert(weightOf(hidden, someSkill) === 0, 'trained identities stay hidden until played');
  assert(weightOf(hidden, 'unknown-trained') === 2, 'the two hidden trained cards model as unknown');

  // one trained card has now been played (sits in the public discard)
  const revealed = [someSkill];
  const known = heroModel(cat, heroRef, [], revealed, 2);
  assert(weightOf(known, someSkill) === 1, 'a revealed trained card becomes a known deck member');
  assert(weightOf(known, 'unknown-trained') === 1, 'only the still-hidden trained card remains a prior');
}

// --- Eye intel: learns from discard, persists across reshuffle --------------
{
  const s: GameState = newGame(cat, 5);
  const hero = s.heroes[0];
  const someSkill = Object.values(cat.combatCards).find((c) => c.deck === 'skills')!.id;
  hero.discard.push(someSkill);                // hero played a trained card
  updateHeroIntel(s, cat);
  assert((s.sauron.heroIntel[hero.id]?.revealedTrained ?? []).includes(someSkill),
    'Eye records a trained card seen in the discard');
  // a reshuffle empties the discard; intel must NOT be forgotten (high-water mark)
  hero.discard = [];
  updateHeroIntel(s, cat);
  assert(s.sauron.heroIntel[hero.id].revealedTrained.filter((x) => x === someSkill).length === 1,
    'intel persists after reshuffle and is not double-counted');
}

// --- influence doctrine: hoard early, spend late ---------------------------
// NOTE: `eyeSpendInfluence` (a single combined "drain the Shadow Pool into
// board pressure" command) was removed and replaced with two separate,
// rules-faithful commands that never touch `s.sauron.influence` (the Shadow
// Pool) at all: `eyePlaceInfluenceOnce` (board influence — an unlimited
// resource) and `eyeSpawnMonsterOnce` (monster placement — gated by board
// state, not Pool spend; rulebook pp.13/18). There is no more "hoard early,
// spend late" Shadow-Pool-draining doctrine to test here — the Eye's actual
// pacing/pressure doctrine (tempo vs balanced vs attrition) is covered by
// `test/sauron-doctrine.spec.ts` (vitest), which documents exactly how this
// redesign changed the observable signal (more Shadow cards + perils under
// attrition, not more Pool spend).

// --- plot valuation: keep advance-2+, bluff advance-1 ----------------------
{
  assert(ratePlot({ id: 'x', advance: 1 }) < ratePlot({ id: 'y', advance: 2 }),
    'advance-1 plots are rated below advance-2 plots');
  assert(ratePlot({ id: 'y', advance: 2 }) < ratePlot({ id: 'z', advance: 3 }),
    'higher advance is worth more');
  const { keep, bluff } = rankPlots([
    { id: 'weak', advance: 1 }, { id: 'big', advance: 3 }, { id: 'mid', advance: 2 },
  ]);
  assert(keep.map((p) => p.id).join(',') === 'big,mid', 'keeps advance-2+ plots, best first');
  assert(bluff.map((p) => p.id).join(',') === 'weak', 'advance-1 plots are held as bluffs');
}

console.log(failures ? `\nM7 training+influence: ${failures} FAILURE(S)` : '\nM7 training+influence: PASS');
process.exit(failures ? 1 : 0);
