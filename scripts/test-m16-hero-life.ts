// M16 — hero life-as-deck model (MEQ rulebook: "Combat Damage & Being
// Defeated", the Rest step, the Hero Draw step, and "Defeated Heroes").
// A hero has NO numeric health: his cards live in four zones — life pool
// (deck), hand, rest pool (discard), and damage pool. Damage discards cards
// into the damage pool; defeat happens when life pool AND hand are both empty;
// resting recycles the rest pool; healing recycles the damage pool.
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/game';
import {
  dealHeroDamage, heroDefeated, drawFromLifePool, restHero, healHero, recoverHero, prepareHeroForFinale, syncLife,
} from '../src/engine/heroLife';
import type { HeroState } from '../src/engine/types';

let failures = 0;
declare const process: { exit(code: number): never };
function assert(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
}

const cat = loadCatalog();
const footprint = (h: HeroState) => h.deck.length + h.hand.length + h.discard.length + h.damagePool.length;

// --- damage discards from the life pool into the damage pool ----------------
{
  const s = newGame(cat, 3);
  const h = s.heroes[0];
  const before = footprint(h);
  const poolBefore = h.deck.length;
  const dealt = dealHeroDamage(h, 2);
  assert(dealt === 2, 'two points of damage discard two cards');
  assert(h.damagePool.length === 2, 'discarded cards land in the damage pool');
  assert(h.deck.length === poolBefore - 2, 'damage comes off the top of the life pool');
  assert(h.life === h.deck.length, 'life mirror tracks the life-pool size');
  assert(footprint(h) === before, 'no cards created or destroyed by damage');
}

// --- when the life pool empties, damage comes from the hand -----------------
{
  const s = newGame(cat, 5);
  const h = s.heroes[0];
  // dump the whole life pool into the damage pool
  dealHeroDamage(h, h.deck.length);
  assert(h.deck.length === 0, 'life pool emptied');
  assert(!heroDefeated(h), 'not defeated while cards remain in hand');
  const handBefore = h.hand.length;
  dealHeroDamage(h, 1);
  assert(h.hand.length === handBefore - 1, 'with an empty life pool, damage comes from the hand');
}

// --- defeat exactly when life pool AND hand are both empty ------------------
{
  const s = newGame(cat, 7);
  const h = s.heroes[0];
  dealHeroDamage(h, h.deck.length + h.hand.length);
  assert(h.deck.length === 0 && h.hand.length === 0, 'all cards discarded to damage');
  assert(heroDefeated(h), 'defeated once life pool and hand are empty');
}

// --- Hero Draw draws from the life pool only (no rest-pool recycle) ---------
{
  const s = newGame(cat, 9);
  const h = s.heroes[0];
  h.discard.push(...h.hand.splice(0)); // pretend prior plays sit in the rest pool
  const poolBefore = h.deck.length, restBefore = h.discard.length;
  const drew = drawFromLifePool(h, 3);
  assert(drew === Math.min(3, poolBefore), 'draws up to the requested count from the life pool');
  assert(h.discard.length === restBefore, 'the rest pool is NOT recycled by a draw');
}

// --- Rest recycles the rest pool; Heal recycles the damage pool -------------
{
  const s = newGame(cat, 11);
  const h = s.heroes[0];
  h.discard.push(...h.hand.splice(0));
  dealHeroDamage(h, 3);
  const damaged = h.damagePool.length, rested = h.discard.length;
  assert(damaged === 3 && rested > 0, 'set up a damage pool and a rest pool');
  restHero(s, h);
  assert(h.discard.length === 0, 'rest empties the rest pool');
  assert(h.damagePool.length === damaged, 'rest does NOT touch the damage pool');
  healHero(s, h);
  assert(h.damagePool.length === 0, 'heal empties the damage pool into the life pool');
}

// --- Recover (defeated hero) shuffles rest + damage into the life pool ------
{
  const s = newGame(cat, 13);
  const h = s.heroes[0];
  h.discard.push(...h.hand.splice(0));
  dealHeroDamage(h, 4);
  const total = footprint(h);
  recoverHero(s, h);
  assert(h.discard.length === 0 && h.damagePool.length === 0, 'recover empties rest and damage pools');
  assert(h.deck.length + h.hand.length === total, 'recover conserves every card in the life pool + hand');
}

// --- Finale Prepare: everything into the life pool, draw up to fortitude ----
{
  const s = newGame(cat, 15);
  const h = s.heroes[0];
  dealHeroDamage(h, 2);
  const total = footprint(h);
  const fort = cat.heroes[h.id].fortitude;
  prepareHeroForFinale(s, h, fort);
  assert(h.discard.length === 0 && h.damagePool.length === 0, 'prepare clears rest and damage pools');
  assert(h.hand.length === Math.min(fort, total), 'prepare draws up to fortitude');
  assert(footprint(h) === total, 'prepare conserves all cards');
}

// --- syncLife keeps the display mirror honest --------------------------------
{
  const s = newGame(cat, 17);
  const h = s.heroes[0];
  h.deck.pop();
  syncLife(h);
  assert(h.life === h.deck.length, 'syncLife matches the life-pool size');
}

console.log(failures ? `\nM16 hero-life: ${failures} FAILURE(S)` : '\nM16 hero-life: PASS');
process.exit(failures ? 1 : 0);
