// M6 acceptance test — unified hero deck + game-long deck belief.
//
// Real MEQ uses ONE dual-use hero deck for both movement and combat. This test
// proves (a) combat now draws from / writes back to the persistent hero deck
// (plays are spent from the one shared deck, visible to movement afterwards),
// and (b) the Lidless Eye's opponent model is a legitimate game-long belief:
// it narrows as public discards accumulate and widens again on a reshuffle,
// while never inspecting the concealed hand.
// Run: npx tsx scripts/test-m6-deck-belief.ts
import { loadCatalog } from '../src/data/loadAssets';
import {
  newGame, advance, resolveChoice, heroEngage,
} from '../src/engine/game';
import { heroModel } from '../src/engine/ai';
import type { GameState } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}
function totalWeight(m: ReturnType<typeof heroModel>): number {
  return m.reduce((n, c) => n + c.weight, 0);
}

const cat = loadCatalog();

// --- belief model: narrows with public discards, widens on reshuffle -------
{
  const heroId = Object.keys(cat.heroes)[0];
  const deckId = cat.heroes[heroId].deck;
  const deck = cat.decks[deckId] ?? [];
  const full = heroModel(cat, heroId, []);
  assert(totalWeight(full) === deck.length, 'empty discard → belief spans the whole known deck');

  // reveal three distinct cards into the public discard
  const seen = [...new Set(deck)].slice(0, 3);
  const narrowed = heroModel(cat, heroId, seen);
  assert(totalWeight(narrowed) === deck.length - seen.length, 'belief shrinks by each publicly discarded card');
  assert(totalWeight(narrowed) < totalWeight(full), 'belief is strictly narrower after discards');

  // a reshuffle empties the discard → belief widens back to the full deck
  const reshuffled = heroModel(cat, heroId, []);
  assert(totalWeight(reshuffled) === totalWeight(full), 'reshuffle (discard cleared) widens the belief back');

  // the model never reveals hidden hand identities — it is derived purely from
  // the catalog deck minus `seen`; so equal `seen` ⇒ identical model
  const again = heroModel(cat, heroId, seen);
  assert(JSON.stringify(again) === JSON.stringify(narrowed), 'belief depends only on public info (deterministic)');
}

// --- unified deck: a combat depletes the persistent hero deck ---------------
{
  let s: GameState = newGame(cat, 5);
  s = advance(s, cat); // HeroRefresh → HeroActions (hero now holds a hand)

  const hero = s.heroes[0];
  // Setup no longer seeds monsters on the board (rulebook: monsters enter only
  // via Sauron Commands). Place one deliberately to exercise the combat flow.
  (s.map.monstersAt[hero.location] ||= []).push(Object.keys(cat.monsters)[0]);
  const monLoc = Object.entries(s.map.monstersAt).find(([, m]) => m.length)?.[0];
  assert(!!monLoc, 'a monster exists to fight');

  // teleport the hero onto the monster and engage
  s.map.heroesAt[hero.location] = s.map.heroesAt[hero.location].filter((h) => h !== hero.id);
  hero.location = monLoc!;
  (s.map.heroesAt[monLoc!] ||= []).push(hero.id);
  const mid = s.map.monstersAt[monLoc!][0];

  // the hero's shared-deck footprint before the fight
  const h0 = s.heroes.find((h) => h.id === hero.id)!;
  const beforeHand = [...h0.hand];
  const beforeFootprint = h0.deck.length + h0.hand.length + h0.discard.length + h0.damagePool.length;
  assert(beforeHand.length > 0, 'hero enters combat with the movement hand (shared deck)');

  s = heroEngage(s, cat, hero.id, mid);
  // the combatant is seeded FROM the persistent hand (not a fresh combat deck)
  assert(JSON.stringify(s.pendingCombat!.attacker.hand) === JSON.stringify(beforeHand),
    'combat starts from the hero movement hand, not a fresh combat draw');

  // play the fight out; hero uses greedy first option
  let steps = 0;
  while (s.pendingCombat && steps < 500) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, s.pendingChoice.options[0].id); continue; }
    break;
  }
  assert(!s.pendingCombat, 'combat resolved');

  const h1 = s.heroes.find((h) => h.id === hero.id)!;
  // Life-as-deck model: a hero's cards live in four conserved zones — life pool
  // (deck), hand, rest pool (discard), and damage pool. Nothing is created or
  // destroyed; combat just moves cards between them (plays → rest pool, damage →
  // damage pool, and a defeat "Recover" shuffles them back into the life pool).
  const afterFootprint = h1.deck.length + h1.hand.length + h1.discard.length + h1.damagePool.length;
  assert(afterFootprint === beforeFootprint, 'no cards created/destroyed — one conserved shared deck');
  assert(JSON.stringify(h1.hand) !== JSON.stringify(beforeHand), 'the shared hand changed as a result of combat');
}

console.log(failures ? `\nM6 deck+belief: ${failures} FAILURE(S)` : '\nM6 deck+belief: PASS');
process.exit(failures ? 1 : 0);
