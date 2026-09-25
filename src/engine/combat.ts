// Combat sub-machine — numeric resolution with card effects (M2).
// A bout: each side reveals one combat card; both sides' effect abilities are
// applied (see src/engine/effects.ts) to reduce/boost attack & defense, cancel
// cards, amplify or cap damage, and schedule next-round modifiers. Damage is
// dealt; repeat until a life hits 0 (or a side escapes). See docs/rules-digest.md §E.
import type {
  Catalog, GameState, Combatant, HeroId, MonsterId, LocationId, CardId, CombatType, NextMod, CombatCard, CombatState,
} from './types';
import { shuffle, nextInt } from './rng';
import { clone, moveHero, defeatHero, grantTraining } from './mechanics';
import { log } from './log';
import { requestChoice } from './choices';
import { resolveBout } from './effects';
import { chooseMonsterCard } from './ai';
import { statValue, stepResolveTree, bestTreeOption } from './encounter';
import { gainCorruption, corruptionCombatStartDiscard, grantFavor } from './corruption';
import { playShadowReaction, playSpecificShadow, raiseShadowReaction, sauronAuto } from './sauronmech';
import { bestPlacementToward, placeInfluenceAction } from './influence';
import { tryCompleteQuestsOnDefeat } from './quests';
import { syncLife, heroDefeated, dealHeroDamage } from './heroLife';
import {
  monsterAdjustCard, monsterCardCost, monsterCancelsHeroCard, applyMonsterPostBout,
} from './monsterPowers';

export const COMBAT_HAND_SIZE = 4;
const EXHAUST_OPT = '__exhaust__';

function makeMonster(
  state: GameState, cat: Catalog, refId: string, life: number, name: string, deckId: string,
  strength: number, cardsToDraw: number,
): Combatant {
  const deck = shuffle(state, cat.decks[deckId] ?? []);
  const c: Combatant = {
    kind: 'monster', refId, name, life, strength, strengthSpent: 0, exhausted: false,
    hand: [], deck, discard: [], damagePool: [],
  };
  // Sauron Setup: draw cards equal to the monster's/minion's fortitude (capped
  // by the deck). This pool is the monster's whole combat — it never redraws.
  drawCombat(state, c, Math.max(1, cardsToDraw));
  return c;
}

/** The hero fights from the SAME persistent deck used for movement (real MEQ:
 *  one dual-use hero deck). We mirror the hero's live deck/hand/discard into the
 *  combatant and sync them back in endCombat, so combat plays deplete — and are
 *  publicly visible in — the one shared deck. No fresh combat deck is drawn. */
function makeHeroCombatant(cat: Catalog, hero: { id: string; deck: CardId[]; hand: CardId[]; discard: CardId[]; damagePool: CardId[] }, strength: number): Combatant {
  const c: Combatant = {
    kind: 'hero', refId: hero.id, name: cat.heroes[hero.id].name, life: hero.deck.length,
    strength, strengthSpent: 0, exhausted: false,
    hand: [...hero.hand], deck: [...hero.deck], discard: [...hero.discard], damagePool: [...hero.damagePool],
  };
  return c;
}

function drawCombat(state: GameState, c: Combatant, n: number): void {
  for (let i = 0; i < n; i++) {
    if (c.deck.length === 0) {
      // A hero draws only from his life pool (the rest pool is NOT recycled
      // mid-combat — that happens on the Rest step). A monster reshuffles its
      // own spent combat deck.
      if (c.kind === 'hero' || c.discard.length === 0) return;
      c.deck.push(...shuffle(state, c.discard));
      c.discard.length = 0;
    }
    c.hand.push(c.deck.shift()!);
  }
  if (c.kind === 'hero') syncLife(c);
}

/** Open combat between a hero (attacker) and a monster (defender). Mutates a
 *  clone; returns new state with pendingCombat + a combat-card choice queued. */
export function beginCombat(
  state: GameState, cat: Catalog, heroId: HeroId, monsterId: MonsterId, locationId: LocationId,
): GameState {
  const s = clone(state);
  const hero = s.heroes.find((h) => h.id === heroId)!;
  const mon = cat.monsters[monsterId];
  const min = cat.minions[monsterId];
  const heroStrength = statValue(s, cat, heroId, 'strength');
  const attacker = makeHeroCombatant(cat, hero, heroStrength);
  // Cowardly Corruption card: at the start of each combat, discard 1 random
  // Hero card from the hero's combat deck (per held Cowardly card).
  const cowardly = corruptionCombatStartDiscard(cat, hero);
  if (cowardly > 0 && attacker.deck.length) {
    const bag = shuffle(s, attacker.deck);
    for (let i = 0; i < cowardly && bag.length; i++) attacker.discard.push(bag.shift()!);
    attacker.deck = bag;
    log(s, 'corruption-effect', hero.id, `Cowardly: discards ${cowardly} random Hero card(s) at combat start`);
  }
  // Mouth of Sauron — Emissary of the Dark Tower: engaging it corrupts the hero.
  if (min?.effectKey === 'minion-corruption-on-engage') {
    gainCorruption(s, cat, hero.id, 1);
    log(s, 'minion-ability', hero.id, `${min.name}: ${cat.heroes[hero.id].name} gains 1 corruption on engaging`);
  }
  const minFull = min ? (min.finale ? (s.sauron.finaleWraithHealth ?? min.health) : min.health) : 0;
  const minLife = min ? (s.map.minionHealth?.[monsterId] ?? minFull) : 0;
  const minFort = min && min.finale ? (s.sauron.finaleWraithFortitude ?? min.fortitude) : (min?.fortitude ?? 0);
  const defender = min
    ? makeMonster(s, cat, monsterId, minLife, min.name, min.combatDeck, min.strength, minFort)
    : makeMonster(s, cat, monsterId, mon.health, mon.name, mon.deck, mon.strength, mon.fortitude);
  s.pendingCombat = {
    attacker, defender, locationId, round: 1,
    reveal: {}, pendingEffects: [], report: [], resolved: false,
    lastType: {}, carry: { attacker: [], defender: [] }, stack: { attacker: [], defender: [] },
  };
  log(s, 'combat-begin', heroId, `${attacker.name} (${attacker.life}) vs ${defender.name} (${defender.life}) at ${locationId}`);
  // "Start of combat" Shadow window (one Shadow card per hero turn; some cards
  // require the fight to involve a minion). A human Sauron chooses interactively
  // (pause before Preparation); the automa auto-plays the best card.
  if (sauronAuto(s)) {
    playShadowReaction(s, cat, 'combat-start', { heroId, isMinionCombat: !!min }, (m) => log(s, 'sauron', 'Sauron', m), { resumeCombat: true });
    if (s.pendingTree) return s; // hero-owned combat-start Shadow (Dark Promises) paused for the human hero
  } else if (raiseShadowReaction(s, cat, 'combat-start', { heroId, isMinionCombat: !!min }, true)) {
    return s; // paused for the human Sauron; Preparation runs once he resolves it
  }
  // Preparation step: the hero splits agility between drawing cards and strength.
  return queuePreparation(s, cat);
}

/** Preparation step (real MEQ): the hero spends agility — each point either draws
 *  one combat card or, left unspent, grants +1 strength until end of combat. We
 *  present one option per legal split (0..agility cards drawn). */
function queuePreparation(s: GameState, cat: Catalog): GameState {
  const pc = s.pendingCombat!;
  const heroId = pc.attacker.refId as HeroId;
  const agility = Math.max(0, statValue(s, cat, heroId, 'agility'));
  if (agility <= 0) return queueCombatChoice(s, cat); // nothing to allocate
  const seat = s.heroes.find((h) => h.id === heroId)?.seat ?? 0;
  const options = [];
  for (let draw = 0; draw <= agility; draw++) {
    options.push({
      id: `prep-${draw}`,
      label: draw === 0
        ? `Keep all ${agility} as +${agility} strength`
        : draw === agility
          ? `Draw ${draw} card${draw > 1 ? 's' : ''}`
          : `Draw ${draw}, keep +${agility - draw} strength`,
    });
  }
  return requestChoice(s, {
    id: 'combat-prep', seat, kind: 'combat-prep',
    prompt: `Preparation: spend ${agility} agility vs ${pc.defender.name} — draw cards or gain strength`,
    options,
  });
}

/** Apply the Preparation split: draw `drawCount` cards; the rest boosts strength. */
export function resolvePreparation(state: GameState, cat: Catalog, drawCount: number): GameState {
  const s = clone(state);
  const pc = s.pendingCombat!;
  const heroId = pc.attacker.refId as HeroId;
  const agility = Math.max(0, statValue(s, cat, heroId, 'agility'));
  const draw = Math.max(0, Math.min(agility, drawCount));
  const kept = agility - draw;
  if (draw > 0) drawCombat(s, pc.attacker, draw);
  pc.attacker.strength += kept;
  log(s, 'combat-prep', heroId,
    `preparation: drew ${draw} card(s), +${kept} strength (budget ${pc.attacker.strength})`);
  return queueCombatChoice(s, cat);
}

/** Highest-attack card (ties: highest defense) — the auto/AI picker. */
export function autoPick(cat: Catalog, c: Combatant): CardId | null {
  if (!c.hand.length) return null;
  return [...c.hand].sort((a, b) => {
    const ca = cat.combatCards[a], cb = cat.combatCards[b];
    return (cb.attack - ca.attack) || (cb.defense - ca.defense);
  })[0];
}

/** A combatant with no card to play is exhausted. */
function markSpentIfEmpty(c: Combatant): void {
  if (!c.hand.length) c.exhausted = true;
}

function queueCombatChoice(s: GameState, cat: Catalog): GameState {
  const pc = s.pendingCombat!;
  markSpentIfEmpty(pc.attacker);
  markSpentIfEmpty(pc.defender);
  // Combat runs until one side is defeated or BOTH are exhausted.
  if (pc.attacker.exhausted && pc.defender.exhausted) {
    return endCombat(s, cat, 'standoff', 'both combatants exhausted');
  }
  // If the hero is exhausted (but the monster is not), the hero can make no
  // decision — auto-run bouts (hero passes 0/0) until the battle resolves.
  if (pc.attacker.exhausted) {
    pc.reveal = { attacker: undefined, defender: pickDefenderCard(s, cat) ?? undefined };
    return runBout(s, cat);
  }
  // Balrog "Fear": the hero must play a RANDOM card this round (no choice).
  if (pc.forceHeroRandom && pc.attacker.hand.length) {
    pc.forceHeroRandom = false;
    const cid = pc.attacker.hand[nextInt(s, pc.attacker.hand.length)];
    log(s, 'combat', pc.attacker.refId, `${pc.attacker.name} must play a random card (Fear): ${cat.combatCards[cid]?.name ?? cid}`);
    pc.reveal = { attacker: cid, defender: pickDefenderCard(s, cat) ?? undefined };
    return runBout(s, cat);
  }
  const seat = s.heroes.find((h) => h.id === pc.attacker.refId)?.seat ?? 0;
  const budgetNote = `str ${pc.attacker.strengthSpent}/${pc.attacker.strength}`;
  const options = pc.attacker.hand.map((cid) => {
    const c = cat.combatCards[cid];
    return { id: cid, label: `${c.name} [${c.type}] atk ${c.attack} / def ${c.defense} · cost ${c.strengthCost}` };
  });
  // Declaring exhaustion is a player decision (real MEQ), distinct from a Withdraw
  // card. It ends the hero's participation for the rest of the battle.
  options.push({ id: EXHAUST_OPT, label: 'Declare exhaustion (stop fighting)' });
  return requestChoice(s, {
    id: `combat-${pc.round}`, seat, kind: 'combat-card',
    prompt: `Combat round ${pc.round} vs ${pc.defender.name} (${budgetNote}): choose a card or declare exhaustion`,
    options,
  });
}

/** The Lidless Eye's card for the monster this round (null if it can't/won't play). */
function pickDefenderCard(s: GameState, cat: Catalog): CardId | null {
  const pc = s.pendingCombat!;
  if (pc.defender.exhausted || !pc.defender.hand.length) return null;
  return chooseMonsterCard(s, cat) ?? autoPick(cat, pc.defender);
}

/** Resolve the attacker's choice (a card id, or the Declare-exhaustion option):
 *  the defender picks, then run one bout. Enforces the cumulative-strength budget. */
export function resolveCombatChoice(state: GameState, cat: Catalog, attackerChoice: CardId): GameState {
  const s = clone(state);
  const pc = s.pendingCombat!;
  let aCard: CardId | undefined;
  if (attackerChoice === EXHAUST_OPT) {
    pc.attacker.exhausted = true;
    log(s, 'combat', pc.attacker.refId, `${pc.attacker.name} declares exhaustion`);
  } else {
    aCard = attackerChoice;
  }
  const dCard = pickDefenderCard(s, cat) ?? undefined;
  pc.reveal = { attacker: aCard, defender: dCard };
  return runBout(s, cat);
}

/** Reveal a side's card into its stack and enforce the strength budget: if the
 *  cumulative cost exceeds the combatant's Strength it becomes Exhausted, the
 *  card is canceled (0/0, no ability) and its carried next-round abilities are
 *  cleared. Returns the effective card to resolve (null when canceled/absent). */
function revealWithBudget(
  s: GameState, cat: Catalog, c: Combatant, cid: CardId | undefined, carrySide: NextMod[],
  monsterRefId?: string, isBottomOfStack?: boolean,
): CombatCardResolved {
  if (!cid) return { card: null, carry: carrySide };
  const card = cat.combatCards[cid];
  // Ready: a carried freeIfType makes a matching card's strength cost 0 this round.
  const free = carrySide.some((m) => m.freeIfType && m.freeIfType === card.type);
  const baseCost = monsterRefId ? monsterCardCost(monsterRefId, card, !!isBottomOfStack) : card.strengthCost;
  c.strengthSpent += free ? 0 : baseCost;
  if (c.strengthSpent > c.strength) {
    c.exhausted = true;
    log(s, 'combat', c.refId, `${c.name} exhausted (strength ${c.strengthSpent}/${c.strength}); ${card.name} canceled`);
    return { card: null, carry: [] }; // card canceled AND prior-round abilities canceled
  }
  return { card, carry: carrySide };
}
interface CombatCardResolved { card: CombatCard | null; carry: NextMod[]; }

function runBout(s: GameState, cat: Catalog): GameState {
  const pc = s.pendingCombat!;
  const aCid = pc.reveal.attacker, dCid = pc.reveal.defender;
  const carry = pc.carry ?? { attacker: [], defender: [] };
  const stk0 = pc.stack ?? { attacker: [], defender: [] };
  const monRef = pc.defender.kind === 'monster' && String(pc.defender.refId).startsWith('mon-')
    ? String(pc.defender.refId) : undefined;
  const aRes = revealWithBudget(s, cat, pc.attacker, aCid, carry.attacker);
  const dRes = revealWithBudget(s, cat, pc.defender, dCid, carry.defender, monRef, stk0.defender.length === 0);
  const aCard = aRes.card;
  const dCard = dRes.card;

  const stk = pc.stack ?? { attacker: [], defender: [] };
  const ctxFor = (ids: CardId[]) => ({
    otherCards: ids.length,
    otherMelee: ids.filter((id) => cat.combatCards[id]?.type === 'melee').length,
  });
  const dCardAdj = monsterAdjustCard(monRef ?? '', dCard);
  const roarCancelsHero = monsterCancelsHeroCard(monRef ?? '', dCard, aCard);
  const out = resolveBout(aCard, dCardAdj, pc.lastType ?? {}, { attacker: aRes.carry, defender: dRes.carry },
    { attacker: ctxFor(stk.attacker), defender: ctxFor(stk.defender) },
    { attacker: roarCancelsHero });

  let dmgToDefender = out.defender.damageTaken;
  let dmgToAttacker = out.attacker.damageTaken;
  // Execute: an instant-defeat effect zeroes the opponent regardless of damage.
  if (out.attacker.defeatsOpp) pc.defender.life = 0;
  // The defender (monster/minion) takes numeric damage against its health; the
  // attacker (hero) takes damage as cards discarded from his life pool/hand into
  // his damage pool.
  pc.defender.life -= dmgToDefender;

  // Monster innate combat power (defender side): may redirect/boost the hero
  // damage, force hand discards, heal the monster, or force a random card next.
  let fromHand = 0;
  if (monRef) {
    const aType = aCard && !out.attacker.canceled ? (aCard.type as CombatType) : '';
    const dType = dCard && !out.defender.canceled ? (dCard.type as CombatType) : '';
    const prevented = dType === 'melee' ? Math.max(0, Math.min(out.attacker.finalAtk, out.defender.finalDef)) : 0;
    const monMax = cat.monsters[pc.defender.refId]?.fortitude ?? pc.defender.life;
    const post = applyMonsterPostBout(s, cat, {
      refId: monRef, attackerType: aType, defenderType: dType,
      dmgToHero: dmgToAttacker, prevented, monsterMaxLife: monMax,
    });
    dmgToAttacker = post.dmgToHero;
    fromHand = post.fromHand;
    if (post.heal > 0 && pc.defender.life > 0) pc.defender.life += post.heal;
    if (post.forceHeroRandom) pc.forceHeroRandom = true;
  }
  if (dmgToAttacker > 0) dealHeroDamage(pc.attacker, dmgToAttacker, fromHand);
  if (out.defender.defeatsOpp) dealHeroDamage(pc.attacker, pc.attacker.deck.length + pc.attacker.hand.length);

  // extra draws granted by this round's effects (card abilities only)
  if (out.attacker.draw) drawCombat(s, pc.attacker, out.attacker.draw);
  if (out.defender.draw) drawCombat(s, pc.defender, out.defender.draw);
  // forced random discards
  for (let i = 0; i < out.attacker.oppDiscardRandom; i++) discardRandom(s, pc.defender);
  for (let i = 0; i < out.defender.oppDiscardRandom; i++) discardRandom(s, pc.attacker);

  // --- training-skill side effects resolved with combat-zone context ---
  // Wear Down: opponent discards a random card; deal damage equal to its attack.
  if (aCard?.effectKey === 'wear_down' && !out.attacker.canceled) {
    const lost = discardRandomReturn(s, pc.defender);
    const extra = lost ? cat.combatCards[lost]?.attack ?? 0 : 0;
    if (extra > 0) { pc.defender.life -= extra; dmgToDefender += extra; }
  }
  // Hamstring: on dealing damage, bury the top of the opponent's deck under his stack.
  if (aCard?.effectKey === 'hamstring' && !out.attacker.canceled && dmgToDefender >= 1 && pc.defender.deck.length) {
    pc.defender.discard.push(pc.defender.deck.shift()!);
  }
  // Shrewd Planning: return one card already played into your stack to your hand.
  if (aCard?.effectKey === 'shrewd_planning' && !out.attacker.canceled && stk.attacker.length) {
    const back = stk.attacker.pop()!;
    const di = pc.attacker.discard.lastIndexOf(back);
    if (di >= 0) pc.attacker.discard.splice(di, 1);
    pc.attacker.hand.push(back);
  }

  // record effect keys that fired this round (for UI / telemetry)
  if (aCard && !out.attacker.canceled && aCard.effectKey) pc.pendingEffects.push(aCard.effectKey);
  if (dCard && !out.defender.canceled && dCard.effectKey) pc.pendingEffects.push(dCard.effectKey);

  const aName = aCard ? aCard.name : (pc.attacker.exhausted ? 'exhausted' : '—');
  const dName = dCard ? dCard.name : (pc.defender.exhausted ? 'exhausted' : '—');
  const parts: string[] = [];
  if (out.attacker.canceled) parts.push('attacker card canceled');
  if (out.defender.canceled) parts.push('defender card canceled');
  pc.report.push({
    round: pc.round, attackerCard: aCid, defenderCard: dCid,
    damageToAttacker: dmgToAttacker, damageToDefender: dmgToDefender,
    note: `${aName} vs ${dName}${parts.length ? ` (${parts.join(', ')})` : ''}`,
  });
  log(s, 'combat-bout', pc.attacker.refId,
    `r${pc.round}: ${aName} deals ${dmgToDefender} (def ${pc.defender.life}); ${dName} deals ${dmgToAttacker} (atk ${pc.attacker.life})`,
    { attackerCard: aCid, defenderCard: dCid });

  // remember types played this round for next-round match effects.
  // Errata: a canceled card is neither melee nor ranged, so it carries no type.
  pc.lastType = {
    attacker: aCard && !out.attacker.canceled ? (aCard.type as CombatType) : undefined,
    defender: dCard && !out.defender.canceled ? (dCard.type as CombatType) : undefined,
  };
  // queue next-round carry modifiers
  pc.carry = {
    attacker: out.attacker.next as NextMod[],
    defender: out.defender.next as NextMod[],
  };
  // Heightened Senses / Outmaneuver: declare a type — next round cancel the
  // opponent's card unless it matches. Declared as the type the opponent just
  // played (predicting a repeat), defaulting to melee (see combat-declaration todo).
  if (aCard && !out.attacker.canceled && (aCard.effectKey === 'heightened_senses' || aCard.effectKey === 'outmaneuver')) {
    const declared = (pc.lastType.defender as CombatType) ?? 'melee';
    pc.carry.attacker.push({ cancelOppUnlessType: declared });
  }

  // discard the revealed cards into each stack; combatants do NOT redraw — they
  // fight from their prepared pool until it is spent (which exhausts them).
  if (aCid) moveToDiscard(pc.attacker, aCid);
  if (dCid) moveToDiscard(pc.defender, dCid);
  // record the played cards in each combat stack (for count-the-stack skills)
  if (aCard) (pc.stack ??= { attacker: [], defender: [] }).attacker.push(aCard.id);
  if (dCard) (pc.stack ??= { attacker: [], defender: [] }).defender.push(dCard.id);
  pc.reveal = {};

  // Endure: if the opponent is defeated this round, shuffle your rest pool and
  // combat stack back into your life pool (a big recovery, hero only).
  if (aCard?.effectKey === 'endure' && !out.attacker.canceled && pc.defender.life <= 0 && pc.attacker.kind === 'hero') {
    pc.attacker.deck.push(...shuffle(s, pc.attacker.discard));
    pc.attacker.discard.length = 0;
    syncLife(pc.attacker);
  }

  if (out.escape) {
    return endCombat(s, cat, 'escape', `${out.escape === 'attacker' ? pc.attacker.name : pc.defender.name} broke off the battle`);
  }
  if (pc.defender.life <= 0) return endCombat(s, cat, 'attacker', `${pc.defender.name} defeated`);
  if (heroDefeated(pc.attacker)) return endCombat(s, cat, 'defender', `${pc.attacker.name} defeated`);
  pc.round += 1;
  return queueCombatChoice(s, cat);
}

function discardRandom(s: GameState, c: Combatant): void {
  if (!c.hand.length) return;
  const i = nextInt(s, c.hand.length);
  c.discard.push(c.hand.splice(i, 1)[0]);
}

/** Discard a random card from `c`'s hand and return its id (or null if none). */
function discardRandomReturn(s: GameState, c: Combatant): CardId | null {
  if (!c.hand.length) return null;
  const i = nextInt(s, c.hand.length);
  const id = c.hand.splice(i, 1)[0];
  c.discard.push(id);
  return id;
}

function moveToDiscard(c: Combatant, cid: CardId): void {
  const i = c.hand.indexOf(cid);
  if (i >= 0) { c.hand.splice(i, 1); c.discard.push(cid); }
}

function endCombat(s: GameState, cat: Catalog, result: 'attacker' | 'defender' | 'escape' | 'standoff', reason: string): GameState {
  const pc = s.pendingCombat!;
  pc.resolved = true; pc.result = result;
  const logStart = s.log.length;
  log(s, 'combat-end', 'system', `${reason} (winner: ${result})`);

  const hero = s.heroes.find((h) => h.id === pc.attacker.refId)!;
  const damageTakenBefore = hero.damagePool.length;
  // Sync the shared card zones back: the life pool, hand, rest pool (discard),
  // and damage pool all live on the one persistent hero state.
  hero.deck = pc.attacker.deck;
  hero.hand = pc.attacker.hand;
  hero.discard = pc.attacker.discard;
  hero.damagePool = pc.attacker.damagePool;
  syncLife(hero);
  if (result === 'attacker') {
    // monster or minion removed from the map
    const arr = s.map.monstersAt[pc.locationId];
    if (arr) {
      const i = arr.indexOf(pc.defender.refId as MonsterId);
      if (i >= 0) arr.splice(i, 1);
    }
    const marr = s.map.minionsAt?.[pc.locationId];
    if (marr) {
      const i = marr.indexOf(pc.defender.refId);
      if (i >= 0) marr.splice(i, 1);
    }
    // minion destroyed → clear its persistent health
    if (s.map.minionHealth) delete s.map.minionHealth[pc.defender.refId];
    // Ringwraiths (The Nine): if defeated they return to Minas Morgul at the
    // start of Sauron's next Action step — queue the redeploy. EXCEPT at the
    // Finale, where they are the Shadow's champions and stay destroyed (their
    // defeat wins the game).
    if (cat.minions[pc.defender.refId]?.effectKey === 'minion-return-morgul' && !s.story.finale) {
      (s.map.minionReturnPending ||= []).push(pc.defender.refId as MonsterId);
      log(s, 'combat', 'Sauron', `${pc.defender.name} will return to Minas Morgul`);
    } else if (cat.minions[pc.defender.refId]) {
      // Every OTHER elite minion (Mouth of Sauron, Black Serpent, Gothmog,
      // the Witch-king) is permanently destroyed once defeated — only The
      // Nine (Ringwraiths, as a group) come back. Bar it from Sauron's
      // deployable reserve for the rest of the game.
      const defeated = (s.map.minionDefeated ||= []);
      if (!defeated.includes(pc.defender.refId)) defeated.push(pc.defender.refId);
    }
    // A defeated monster's token is removed from the board and set aside faceup
    // (rulebook p.28). It yields the hero NO favor or reward on its own — only a
    // Quest that names this foe may complete here.
    tryCompleteQuestsOnDefeat(s, cat, hero.id, pc.defender.refId);
    // A card (Khazad-dûm, The Dark Tower) may promise a reward ONLY if the hero
    // defeats the foe it forced into combat here. Grant and consume it now.
    const rewards = s.map.pendingCombatRewards;
    if (rewards) {
      const i = rewards.findIndex((r) => r.location === pc.locationId);
      if (i >= 0) {
        const r = rewards[i];
        if (r.favor) grantFavor(cat, hero, r.favor);
        if (r.training) grantTraining(s, cat, hero, r.training);
        rewards.splice(i, 1);
        log(s, 'combat', hero.id, `defeated the foe — gains ${[r.favor ? `${r.favor} favor` : '', r.training ? 'training' : ''].filter(Boolean).join(' + ')}`);
      }
    }
  } else if (result === 'escape' || result === 'standoff') {
    // no defeat: the hero keeps the cards he has left. On an escape (a Withdraw
    // card) the hero slips to an adjacent location; on a standoff (both
    // exhausted) he stays put. The monster remains on the map and the battle ends.
    if (result === 'escape') {
      const adj = firstAdjacent(cat, hero.location);
      if (adj) moveHero(s, hero.id, adj);
    }
    // Undefeated monster/minion: Sauron places influence equal to his
    // combatant's wisdom in extension of a Shadow Stronghold (rulebook p.30).
    placeUndefeatedFoeInfluence(s, cat, pc);
    // A hero who does NOT win a Travel combat loses the rest of his turn. An
    // Ambush (fought before any move this turn) does not end the turn. Retreat
    // (escape) continues the turn per errata, so only a standoff ends it.
    // Thálin's ability: his turn never ends from failing to defeat a foe.
    if (result === 'standoff' && hero.hasMovedThisTurn && hero.id !== 'thalin') {
      hero.actionsRemaining = 0;
      log(s, 'combat', hero.id, `did not defeat ${pc.defender.name} during Travel — turn ends`);
    }
  } else {
    // hero defeated → the faithful "Defeated Heroes" sequence. The foe was NOT
    // defeated, so Sauron still places its wisdom in influence (rulebook p.30)
    // before the defeat sequence moves the hero away.
    placeUndefeatedFoeInfluence(s, cat, pc);
    defeatHero(s, cat, hero);
    // "After a hero is defeated" Shadow window (one Shadow card per hero turn).
    if (sauronAuto(s)) {
      playShadowReaction(s, cat, 'hero-defeated', { heroId: hero.id }, (m) => log(s, 'sauron', 'Sauron', m));
    }
  }
  // A surviving minion keeps the damage it took: persist its remaining health so
  // the next hero continues wearing it down.
  if (result !== 'attacker' && cat.minions[pc.defender.refId]) {
    (s.map.minionHealth ||= {})[pc.defender.refId] = Math.max(1, pc.defender.life);
  }
  s.pendingCombat = null;
  if (hero.combatMods) hero.combatMods = [];
  // Finale step 7 — Determine Winner (manual p.33). This ONE combat decides the
  // whole game: if the champion destroyed the Ringwraiths the heroes win; any
  // other outcome (defeat, standoff, escape = "not defeated") means Sauron wins.
  if (s.story.finaleCombat && cat.minions[pc.defender.refId]?.finale) {
    s.story.finaleCombat = false;
    if (result === 'attacker') {
      s.story.finaleWinner = 'Hero';
      s.story.finaleWinnerReason = 'Finale won: the Ringwraiths are destroyed';
    } else {
      s.story.finaleWinner = 'Sauron';
      s.story.finaleWinnerReason = 'Finale: the Ringwraiths were not defeated — the Shadow prevails';
    }
    s.winner = s.story.finaleWinner;
    s.winReason = s.story.finaleWinnerReason;
    s.phase = 'GameOver';
    log(s, 'game-over', s.winner, s.winReason);
  }
  // Interactive "after a hero is defeated" Shadow window for a human Sauron:
  // raised only now, once combat is fully finalized (pendingCombat cleared), so
  // resolving it cannot corrupt mid-combat state. The automa already played its
  // card inline above.
  if (result === 'defender' && !sauronAuto(s) && !s.winner) {
    raiseShadowReaction(s, cat, 'hero-defeated', { heroId: hero.id });
  }
  // Post-combat "what happened" recap for the human UI (App.tsx renders a
  // dismissible summary modal off this field; bots/tests ignore it — combat
  // continuation is still driven purely by pendingCombat, unaffected here).
  const isMinion = !!cat.minions[pc.defender.refId];
  s.lastCombatSummary = {
    result, heroId: hero.id, heroName: cat.heroes[hero.id]?.name ?? hero.id,
    foeName: pc.defender.name, foeKind: isMinion ? 'minion' : 'monster',
    rounds: pc.round, damageTaken: hero.damagePool.length - damageTakenBefore,
    notes: s.log.slice(logStart + 1).map((e) => e.detail),
    report: pc.report.slice(),
    seq: s.log.length ? s.log[s.log.length - 1].seq : 0,
  };
  (s.combatHistory ??= []).push(s.lastCombatSummary);
  return s;
}

/** Resolve a human Sauron's pending reaction Shadow window (rulebook p.20):
 *  `choice` is the id of the card he plays, or null to pass. Passing plays
 *  nothing and does NOT spend his once-per-hero-turn window. A `combat-start`
 *  pause then runs the Preparation step it deferred. */
export function resolveShadowReaction(state: GameState, cat: Catalog, choice: CardId | null): GameState {
  const s = clone(state);
  const pending = s.pendingShadowReaction;
  if (!pending) throw new Error('No pending Shadow reaction');
  s.pendingShadowReaction = null;
  if (choice) {
    if (!pending.options.some((o) => o.id === choice)) throw new Error(`Illegal Shadow reaction '${choice}'`);
    const target = pending.heroId
      ? s.heroes.find((h) => h.id === pending.heroId)
      : s.heroes.filter((h) => h.status === 'active').sort((a, b) => b.corruption - a.corruption)[0];
    if (target) {
      playSpecificShadow(s, cat, choice, target, pending.window, (m) => log(s, 'sauron', 'Sauron', m),
        { resumeCombat: pending.resumeCombat });
    }
  } else {
    log(s, 'sauron', 'Sauron', `passes the ${pending.window} Shadow window`);
  }
  // If the played card paused for an internal Sauron decision, the combat resume
  // (Preparation) is owed once that decision completes — see resolveTreeDecision.
  if (!s.pendingTree && pending.resumeCombat && s.pendingCombat) return queuePreparation(s, cat);
  return s;
}

/** Resume a paused card effect-tree (`s.pendingTree`) with the human actor's
 *  chosen `optionIndex`: auto-picks any remaining AI-owned nodes, applies the
 *  atoms once the walk completes (or pauses again at the next human decision),
 *  and — for a combat-start shadow — runs the owed Preparation step. */
export function resolveTreeDecision(state: GameState, cat: Catalog, optionIndex: number): GameState {
  const s = clone(state);
  const p = s.pendingTree;
  if (!p) throw new Error('No pending tree decision');
  if (optionIndex < 0 || optionIndex >= p.options.length || !p.options[optionIndex].enabled) {
    throw new Error(`Illegal tree decision ${optionIndex}`);
  }
  s.pendingTree = null;
  const paused = stepResolveTree(s, cat, p.tree, {
    sourceKind: p.sourceKind, cardId: p.cardId, source: p.source,
    heroId: p.heroId, actor: p.actor, resumeCombat: p.resumeCombat,
  }, [...p.decisions, optionIndex]);
  if (paused) return s;
  if (p.resumeCombat && s.pendingCombat) return queuePreparation(s, cat);
  if (p.resumeEnterWindow) {
    // The hero's Peril decision is done — run the owed "after entering a
    // non-Haven location" Shadow window, mirroring heroMove's tail: the automa
    // auto-plays; a human Sauron chooses interactively.
    const { heroId, loc } = p.resumeEnterWindow;
    if (cat.locations[loc]?.kind !== 'haven') {
      if (sauronAuto(s)) playShadowReaction(s, cat, 'enter-nonhaven', { heroId }, (m) => log(s, 'sauron', 'Sauron', m));
      else if (!s.pendingCombatOrPeril) raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId });
    }
  }
  return s;
}

/** Auto-resolve any pending card-tree decision (`s.pendingTree`) by picking the
 *  deciding actor's best option — for the AI drivers and rollouts, which spoof
 *  `humanSide` and so must never stall on a decision meant for a human. */
export function autoResolvePendingTree(state: GameState, cat: Catalog): GameState {
  let s = state;
  for (let guard = 0; s.pendingTree && guard < 64; guard++) {
    s = resolveTreeDecision(s, cat, bestTreeOption(s, cat));
  }
  return s;
}

function firstAdjacent(cat: Catalog, from: LocationId): LocationId | null {
  for (const e of cat.edges) {
    if (e.a === from) return e.b;
    if (e.b === from) return e.a;
  }
  return null;
}

/** Undefeated foe (escape, standoff, or hero-defeat): Sauron may place influence
 *  equal to his combatant's wisdom "in extension of Shadow Strongholds"
 *  (rulebook p.30), grown toward the combat location and clamped to placement
 *  caps. */
function placeUndefeatedFoeInfluence(s: GameState, cat: Catalog, pc: CombatState): void {
  const foeWisdom = cat.monsters[pc.defender.refId]?.wisdom ?? cat.minions[pc.defender.refId]?.wisdom ?? 0;
  if (foeWisdom <= 0 || !pc.locationId) return;
  let placed = 0;
  for (let i = 0; i < foeWisdom; i++) {
    const loc = bestPlacementToward(s, cat, pc.locationId);
    if (!loc || placeInfluenceAction(s, cat, loc, 1) <= 0) break;
    placed++;
  }
  if (placed > 0) {
    log(s, 'combat', 'Sauron', `undefeated ${pc.defender.name}: +${placed} influence in extension toward ${cat.locations[pc.locationId]?.name ?? pc.locationId}`);
  }
}

