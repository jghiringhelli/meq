// Hero life-as-deck model (MEQ rulebook: "Combat Damage & Being Defeated",
// "Dealing Damage to Heroes", "Defeated Heroes", the Rest step, and the Hero
// Draw step). A hero has NO numeric health. His cards live in four zones:
//   deck       = the LIFE POOL (draw source)
//   hand       = cards in hand (movement + drawn combat cards; no hand limit)
//   discard    = the REST POOL (cards played in combat, face up)
//   damagePool = damage taken (face down)
// Damage discards a card from the top of the life pool (or a chosen hand card)
// into the damage pool. A hero is defeated when his life pool AND hand are both
// empty. `life` is a display mirror of the life-pool size, kept in sync here.
import type { GameState, CardId } from './types';
import { shuffle } from './rng';

/** The four card zones every life-pool operation needs. */
export interface LifeZones {
  deck: CardId[]; hand: CardId[]; discard: CardId[]; damagePool: CardId[];
  life: number;
}

/** Keep the display mirror (`life`) equal to the current life-pool size. */
export function syncLife(h: { deck: CardId[]; life: number }): void {
  h.life = h.deck.length;
}

/** A hero is defeated when both his life pool and his hand are empty. */
export function heroDefeated(h: { deck: CardId[]; hand: CardId[] }): boolean {
  return h.deck.length === 0 && h.hand.length === 0;
}

/** Deal `n` damage: for each point, discard the top card of the life pool (or,
 *  when it is empty, a card from hand) face-down into the damage pool. Returns
 *  the number of cards actually discarded (stops when the hero is out of cards). */
export function dealHeroDamage(h: LifeZones, n: number, fromHand = 0): number {
  let dealt = 0;
  for (let i = 0; i < n; i++) {
    if (i < fromHand && h.hand.length > 0) h.damagePool.push(h.hand.pop()!);
    else if (h.deck.length > 0) h.damagePool.push(h.deck.shift()!);
    else if (h.hand.length > 0) h.damagePool.push(h.hand.pop()!);
    else break;
    dealt++;
  }
  syncLife(h);
  return dealt;
}

/** Draw `n` cards from the top of the life pool into hand. The life pool does
 *  NOT auto-recycle the rest pool — that only happens on the Rest step — so a
 *  short life pool simply yields fewer cards. Returns cards drawn. */
export function drawFromLifePool(h: LifeZones, n: number): number {
  let drawn = 0;
  for (let i = 0; i < n && h.deck.length > 0; i++) { h.hand.push(h.deck.shift()!); drawn++; }
  syncLife(h);
  return drawn;
}

/** Rest step: shuffle the rest pool (discard) back into the life pool. */
export function restHero(s: GameState, h: LifeZones): void {
  if (!h.discard.length) return;
  h.deck.push(...shuffle(s, h.discard));
  h.discard.length = 0;
  syncLife(h);
}

/** Heal (in a Haven): shuffle the damage pool back into the life pool. */
export function healHero(s: GameState, h: LifeZones): void {
  if (!h.damagePool.length) return;
  h.deck.push(...shuffle(s, h.damagePool));
  h.damagePool.length = 0;
  syncLife(h);
}

/** Partial heal: move up to `n` cards from the damage pool back into the life
 *  pool (used by cards that recover a stat-scaled number of cards). */
export function healHeroBy(s: GameState, h: LifeZones, n: number): number {
  const k = Math.min(Math.max(0, n), h.damagePool.length);
  if (k <= 0) return 0;
  const moved = h.damagePool.splice(0, k);
  h.deck.push(...shuffle(s, moved));
  syncLife(h);
  return k;
}

/** Recover (defeated hero, and Finale "Prepare"): shuffle the rest pool AND the
 *  damage pool into the life pool. */
export function recoverHero(s: GameState, h: LifeZones): void {
  h.deck.push(...h.discard, ...h.damagePool);
  h.discard.length = 0;
  h.damagePool.length = 0;
  const reshuffled = shuffle(s, h.deck);
  h.deck.length = 0;
  h.deck.push(...reshuffled);
  syncLife(h);
}

/** Finale "Prepare": shuffle hand, rest pool, and damage pool into the life
 *  pool, then draw `fortitude` cards. */
export function prepareHeroForFinale(s: GameState, h: LifeZones, fortitude: number): void {
  h.deck.push(...h.hand, ...h.discard, ...h.damagePool);
  h.hand.length = 0;
  h.discard.length = 0;
  h.damagePool.length = 0;
  const reshuffled = shuffle(s, h.deck);
  h.deck.length = 0;
  h.deck.push(...reshuffled);
  drawFromLifePool(h, fortitude);
}
