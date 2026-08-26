// Combat-card effect registry (M2). Each `effectKey` (assigned in
// scripts/build-catalog.py) resolves to a structured EffectSpec; resolveBout()
// applies both revealed cards' specs in a fixed order to produce the round's
// damage plus the next-round carry modifiers. The human-readable rules text
// stays on each card's `ability` field (M3 owns display).
//
// Resolution order per bout:
//   1. apply carried next-round modifiers to each side's working stats
//   2. resolve cancels (this-round + carried), honouring "uncancelable"
//   3. apply printed-stat reductions (respecting defense floors)
//   4. apply conditional attack/defense bonuses
//   5. compute base damage = max(0, atk - def)
//   6. damage amplifiers (deal-more), self-hit penalties, then damage caps
//   7. resolve escape / draw / discard side-effects and queue next-round carry
import type { CombatCard, CombatType, EffectKey, NextMod } from './types';

export type SideKey = 'attacker' | 'defender';
type BattleType = 'ranged' | 'melee' | '';

type Cond =
  | { kind: 'always' }
  | { kind: 'oppType'; type: 'ranged' | 'melee' }
  | { kind: 'oppPrintedDef0' }
  | { kind: 'oppPrintedDefLE'; n: number }
  | { kind: 'oppRepeat' };

export interface EffectSpec {
  key: string;
  atkBonus?: { amount: number; cond: Cond };
  defBonus?: { amount: number; cond: Cond };
  reduceOppDef?: number;
  reduceOppAtk?: number;
  uncancelable?: boolean;
  defenseFloor?: number;
  cancelOpp?: 'any' | 'ranged' | 'melee';
  cancelOppCond?: Cond;             // cancel the opponent's card when this holds
  bonusDamageIfDealt?: number;
  selfExtraDamageIfHit?: number;
  damageCap?: number;
  draw?: number;
  oppDiscardRandom?: number;
  escapeIfUnhurt?: boolean;
  revealOppHand?: boolean;
  next?: NextMod;
  // --- skill effects resolved inside the bout ---
  retaliate?: boolean;                        // deal opp 1 dmg per dmg you take
  defeatOppIfPrintedDef0?: boolean;           // Execute
  atkEqualsOppAtkIfType?: 'ranged' | 'melee'; // Reversal: +opp printed atk if opp plays type
  atkPerOtherStackCard?: number;              // Brutal Finisher (needs stack ctx)
  atkDefPerOtherMeleeStack?: number;          // Focused Assault (needs stack ctx)
}

/** Per-side stack context: how many OTHER cards (and other melee cards) the side
 *  already has in its combat stack, used by count-the-stack skills. */
export interface StackCtx { otherCards: number; otherMelee: number; }

export const EFFECTS: Record<string, EffectSpec> = {
  atk_bonus_if_opp_def0_3: { key: 'atk_bonus_if_opp_def0_3', atkBonus: { amount: 3, cond: { kind: 'oppPrintedDef0' } } },
  atk_bonus_if_opp_def0_5: { key: 'atk_bonus_if_opp_def0_5', atkBonus: { amount: 5, cond: { kind: 'oppPrintedDef0' } } },
  atk_bonus_if_opp_repeat_3: { key: 'atk_bonus_if_opp_repeat_3', atkBonus: { amount: 3, cond: { kind: 'oppRepeat' } } },
  atk_bonus_vs_melee_1: { key: 'atk_bonus_vs_melee_1', atkBonus: { amount: 1, cond: { kind: 'oppType', type: 'melee' } } },
  atk_bonus_vs_melee_3: { key: 'atk_bonus_vs_melee_3', atkBonus: { amount: 3, cond: { kind: 'oppType', type: 'melee' } } },
  atk_bonus_vs_ranged_2: { key: 'atk_bonus_vs_ranged_2', atkBonus: { amount: 2, cond: { kind: 'oppType', type: 'ranged' } } },
  def_bonus_vs_melee_2: { key: 'def_bonus_vs_melee_2', defBonus: { amount: 2, cond: { kind: 'oppType', type: 'melee' } } },
  reduce_opp_def_0: { key: 'reduce_opp_def_0', reduceOppDef: 0 },
  reduce_opp_atk_def_1: { key: 'reduce_opp_atk_def_1', reduceOppDef: 1, reduceOppAtk: 1 },
  cancel_opp_any: { key: 'cancel_opp_any', cancelOpp: 'any' },
  cancel_opp_ranged: { key: 'cancel_opp_ranged', cancelOpp: 'ranged' },
  cancel_opp_melee: { key: 'cancel_opp_melee', cancelOpp: 'melee' },
  uncancelable: { key: 'uncancelable', uncancelable: true },
  uncancelable_def_floor_2: { key: 'uncancelable_def_floor_2', uncancelable: true, defenseFloor: 2 },
  bonus_dmg_if_dealt_2: { key: 'bonus_dmg_if_dealt_2', bonusDamageIfDealt: 2 },
  self_extra_dmg_if_hit_2: { key: 'self_extra_dmg_if_hit_2', selfExtraDamageIfHit: 2 },
  dmg_cap_1: { key: 'dmg_cap_1', damageCap: 1 },
  draw_2: { key: 'draw_2', draw: 2 },
  opp_discard_random_1: { key: 'opp_discard_random_1', oppDiscardRandom: 1 },
  opp_discard_random_2: { key: 'opp_discard_random_2', oppDiscardRandom: 2 },
  reveal_opp_hand: { key: 'reveal_opp_hand', revealOppHand: true },
  escape_if_unhurt: { key: 'escape_if_unhurt', escapeIfUnhurt: true },
  next_def_2: { key: 'next_def_2', next: { def: 2 } },
  next_atk_2: { key: 'next_atk_2', next: { atk: 2 } },
  next_atk_def_2: { key: 'next_atk_def_2', next: { atk: 2, def: 2 } },
  next_atk_if_melee_2: { key: 'next_atk_if_melee_2', next: { atk: 2, ifOwnType: 'melee' } },
  next_atk_if_ranged_2: { key: 'next_atk_if_ranged_2', next: { atk: 2, ifOwnType: 'ranged' } },
  next_def_if_ranged_2: { key: 'next_def_if_ranged_2', next: { def: 2, ifOwnType: 'ranged' } },
  next_cancel_opp_melee: { key: 'next_cancel_opp_melee', next: { cancelOppType: 'melee' } },
  next_cancel_opp_ranged: { key: 'next_cancel_opp_ranged', next: { cancelOppType: 'ranged' } },
  next_opp_reveal_first: { key: 'next_opp_reveal_first', next: { oppRevealFirst: true } },
  // --- training skills ---
  set_trap: { key: 'set_trap', next: { dmgToOpp: 2, dmgToOppIfOppType: 'melee' } },
  flaming_arrow: { key: 'flaming_arrow', next: { reduceOppDef: 0 } },
  concussive_shot: { key: 'concussive_shot', next: { cancelOppIfPrintedDefGE: 2 } },
  shield_smash: { key: 'shield_smash', next: { cancelOppIfCostGE: 2 } },
  ready_free_ranged: { key: 'ready_free_ranged', next: { freeIfType: 'ranged' } },
  retaliate: { key: 'retaliate', retaliate: true },
  execute: { key: 'execute', defeatOppIfPrintedDef0: true },
  reversal: { key: 'reversal', atkEqualsOppAtkIfType: 'melee', cancelOppCond: { kind: 'oppType', type: 'melee' } },
  crushing_blow: { key: 'crushing_blow', atkBonus: { amount: 2, cond: { kind: 'oppPrintedDefLE', n: 1 } }, cancelOppCond: { kind: 'oppPrintedDefLE', n: 1 } },
  focused_assault: { key: 'focused_assault', atkDefPerOtherMeleeStack: 1 },
  brutal_finisher: { key: 'brutal_finisher', atkPerOtherStackCard: 1 },
  // Stubs for skills resolved in combat.ts with combat-zone context (deck/hand/
  // stack manipulation). Registered so every effectKey resolves; base stats apply
  // and combat.ts drives the ability by effectKey.
  shrewd_planning: { key: 'shrewd_planning' },
  endure: { key: 'endure' },
  wear_down: { key: 'wear_down' },
  hamstring: { key: 'hamstring' },
  heightened_senses: { key: 'heightened_senses' },
  outmaneuver: { key: 'outmaneuver' },
};

export function getEffect(key: EffectKey | undefined): EffectSpec | null {
  return key ? EFFECTS[key] ?? null : null;
}

/** Every effectKey the registry knows about — used by coverage checks. */
export function knownEffectKeys(): string[] {
  return Object.keys(EFFECTS);
}

function battleType(t: CombatType | undefined): BattleType {
  return t === 'ranged' || t === 'melee' ? t : '';
}

interface Work {
  side: SideKey;
  card: CombatCard | null;
  spec: EffectSpec | null;
  type: BattleType;
  printedType: BattleType;
  printedDef: number;
  printedAtk: number;
  cost: number;
  atk: number;
  def: number;
  atkLocked: boolean;
  defLocked: boolean;
  uncancelable: boolean;
  defenseFloor: number;
  canceled: boolean;
  carry: NextMod[];
  lastType: BattleType;
  stack: StackCtx;
}

export interface SideOutcome {
  damageTaken: number;
  canceled: boolean;
  finalAtk: number;
  finalDef: number;
  draw: number;
  oppDiscardRandom: number;
  revealOppHand: boolean;
  next: NextMod[];
  defeatsOpp: boolean;
}

export interface BoutOutcome {
  attacker: SideOutcome;
  defender: SideOutcome;
  escape?: SideKey;
}

function makeWork(
  side: SideKey, card: CombatCard | null, carry: NextMod[], lastType: BattleType, stack: StackCtx,
): Work {
  const spec = card ? getEffect(card.effectKey) : null;
  return {
    side, card, spec,
    type: card ? battleType(card.type) : '',
    printedType: card ? battleType(card.type) : '',
    printedDef: card ? card.defense : 0,
    printedAtk: card ? card.attack : 0,
    cost: card ? card.strengthCost : 0,
    atk: card ? card.attack : 0,
    def: card ? card.defense : 0,
    atkLocked: false,
    defLocked: false,
    uncancelable: !!spec?.uncancelable,
    defenseFloor: spec?.defenseFloor ?? 0,
    canceled: false,
    carry,
    lastType,
    stack,
  };
}

function evalCond(cond: Cond, opp: Work): boolean {
  switch (cond.kind) {
    case 'always': return true;
    case 'oppType': return opp.type === cond.type;
    case 'oppPrintedDef0': return opp.printedDef === 0;
    case 'oppPrintedDefLE': return opp.card !== null && opp.printedDef <= cond.n;
    case 'oppRepeat': return opp.type !== '' && opp.type === opp.lastType;
  }
}

function cancelHits(target: Work, kind: 'any' | 'ranged' | 'melee'): boolean {
  if (target.uncancelable) return false;
  if (kind === 'any') return target.card !== null;
  return target.type === kind;
}

const NO_STACK: StackCtx = { otherCards: 0, otherMelee: 0 };

/** Pure numeric resolution of one combat bout given both revealed cards, the
 *  types each side played last round, and each side's carried next-round mods.
 *  `stack` carries per-side combat-stack counts for count-the-stack skills. */
export function resolveBout(
  attackerCard: CombatCard | null,
  defenderCard: CombatCard | null,
  lastType: { attacker?: CombatType; defender?: CombatType },
  carry: { attacker: NextMod[]; defender: NextMod[] },
  stack: { attacker: StackCtx; defender: StackCtx } = { attacker: NO_STACK, defender: NO_STACK },
  forceCancel: { attacker?: boolean; defender?: boolean } = {},
): BoutOutcome {
  const A = makeWork('attacker', attackerCard, carry.attacker, battleType(lastType.attacker), stack.attacker);
  const D = makeWork('defender', defenderCard, carry.defender, battleType(lastType.defender), stack.defender);

  // 1. carried next-round modifiers (owner-side stat buffs conditioned on own type)
  const applyCarryStats = (w: Work) => {
    for (const m of w.carry) {
      if (m.ifOwnType && m.ifOwnType !== w.type) continue;
      if (m.atk) w.atk += m.atk;
      if (m.def) w.def += m.def;
    }
  };
  applyCarryStats(A);
  applyCarryStats(D);

  // 2. cancels — collect intents simultaneously, then mark (mutual cancels allowed).
  const condCancels = (src: Work, tgt: Work): boolean => {
    if (tgt.uncancelable || tgt.card === null) return false;
    if (src.spec?.cancelOppCond && evalCond(src.spec.cancelOppCond, tgt)) return true;
    for (const m of src.carry) {
      if (m.cancelOppIfPrintedDefGE !== undefined && tgt.printedDef >= m.cancelOppIfPrintedDefGE) return true;
      if (m.cancelOppIfCostGE !== undefined && tgt.cost >= m.cancelOppIfCostGE) return true;
      if (m.cancelOppUnlessType && tgt.type !== m.cancelOppUnlessType) return true;
    }
    return false;
  };
  const wantsCancel = (src: Work, tgt: Work): boolean => {
    if (src.spec?.cancelOpp && cancelHits(tgt, src.spec.cancelOpp)) return true;
    for (const m of src.carry) {
      if (m.cancelOppType && cancelHits(tgt, m.cancelOppType as 'ranged' | 'melee')) return true;
    }
    return condCancels(src, tgt);
  };
  const cancelD = wantsCancel(A, D) || !!forceCancel.defender;
  const cancelA = wantsCancel(D, A) || !!forceCancel.attacker;
  // Errata: a canceled combat card has final atk/def 0, no ability, and is
  // considered neither melee nor ranged (so it triggers no type-based effects).
  const cancel = (w: Work) => { w.canceled = true; w.spec = null; w.atk = 0; w.def = 0; w.type = ''; };
  if (cancelA) cancel(A);
  if (cancelD) cancel(D);

  // 3. printed-stat reductions (this-round spec + carried reduceOppDef).
  //    Manual: a stat REDUCED to 0 is locked and cannot be raised again.
  const applyReductions = (src: Work, tgt: Work) => {
    const cutDef = (v: number) => { tgt.def = Math.max(v, tgt.defenseFloor); if (tgt.def === 0) tgt.defLocked = true; };
    const cutAtk = (v: number) => { tgt.atk = Math.max(v, 0); if (tgt.atk === 0) tgt.atkLocked = true; };
    if (src.spec?.reduceOppDef !== undefined) cutDef(src.spec.reduceOppDef);
    if (src.spec?.reduceOppAtk !== undefined) cutAtk(src.spec.reduceOppAtk);
    for (const m of src.carry) {
      if (m.reduceOppDef !== undefined) cutDef(m.reduceOppDef);
    }
  };
  applyReductions(A, D);
  applyReductions(D, A);

  // 4. conditional bonuses (spec conditions, stack counts, Reversal). A stat
  //    locked at 0 by a reduction ignores any further additive modifier.
  const applyBonuses = (self: Work, opp: Work) => {
    if (!self.spec) return;
    const addAtk = (n: number) => { if (!self.atkLocked) self.atk += n; };
    const addDef = (n: number) => { if (!self.defLocked) self.def += n; };
    if (self.spec.atkBonus && evalCond(self.spec.atkBonus.cond, opp)) addAtk(self.spec.atkBonus.amount);
    if (self.spec.defBonus && evalCond(self.spec.defBonus.cond, opp)) addDef(self.spec.defBonus.amount);
    if (self.spec.atkPerOtherStackCard) addAtk(self.spec.atkPerOtherStackCard * self.stack.otherCards);
    if (self.spec.atkDefPerOtherMeleeStack) {
      const b = self.spec.atkDefPerOtherMeleeStack * self.stack.otherMelee;
      addAtk(b); addDef(b);
    }
    if (self.spec.atkEqualsOppAtkIfType && opp.printedType === self.spec.atkEqualsOppAtkIfType) {
      addAtk(opp.printedAtk);
    }
  };
  applyBonuses(A, D);
  applyBonuses(D, A);

  // 5. base damage
  let dmgToDefender = Math.max(0, A.atk - D.def);
  let dmgToAttacker = Math.max(0, D.atk - A.def);

  // 6a. amplifiers (dealer deals more if it landed a hit)
  if (A.spec?.bonusDamageIfDealt && dmgToDefender >= 1) dmgToDefender += A.spec.bonusDamageIfDealt;
  if (D.spec?.bonusDamageIfDealt && dmgToAttacker >= 1) dmgToAttacker += D.spec.bonusDamageIfDealt;
  // 6b. self-hit penalties (owner takes extra if it was dealt a hit)
  if (A.spec?.selfExtraDamageIfHit && dmgToAttacker >= 1) dmgToAttacker += A.spec.selfExtraDamageIfHit;
  if (D.spec?.selfExtraDamageIfHit && dmgToDefender >= 1) dmgToDefender += D.spec.selfExtraDamageIfHit;
  // 6c. caps (final)
  if (A.spec?.damageCap !== undefined) dmgToAttacker = Math.min(dmgToAttacker, A.spec.damageCap);
  if (D.spec?.damageCap !== undefined) dmgToDefender = Math.min(dmgToDefender, D.spec.damageCap);
  // 6d. carried conditional damage (Set Trap) + retaliation (computed from the
  //     post-cap damage each side takes, snapshotted to avoid feedback loops)
  const takenA = dmgToAttacker, takenD = dmgToDefender;
  const carriedDmg = (src: Work, oppType: BattleType): number => {
    let d = 0;
    for (const m of src.carry) {
      if (m.dmgToOpp && (!m.dmgToOppIfOppType || m.dmgToOppIfOppType === oppType)) d += m.dmgToOpp;
    }
    return d;
  };
  dmgToDefender += carriedDmg(A, D.type);
  dmgToAttacker += carriedDmg(D, A.type);
  if (A.spec?.retaliate) dmgToDefender += takenA;
  if (D.spec?.retaliate) dmgToAttacker += takenD;

  // 7. escape (attacker priority if both qualify)
  let escape: SideKey | undefined;
  if (A.spec?.escapeIfUnhurt && dmgToAttacker === 0) escape = 'attacker';
  else if (D.spec?.escapeIfUnhurt && dmgToDefender === 0) escape = 'defender';

  // 8. instant defeat (Execute): the opponent's printed defense is 0
  const aDefeats = !!A.spec?.defeatOppIfPrintedDef0 && D.card !== null && D.printedDef === 0;
  const dDefeats = !!D.spec?.defeatOppIfPrintedDef0 && A.card !== null && A.printedDef === 0;

  const outcomeFor = (w: Work, dmgTaken: number, defeatsOpp: boolean): SideOutcome => ({
    damageTaken: dmgTaken,
    canceled: w.canceled,
    finalAtk: w.atk,
    finalDef: w.def,
    draw: w.spec?.draw ?? 0,
    oppDiscardRandom: w.spec?.oppDiscardRandom ?? 0,
    revealOppHand: !!w.spec?.revealOppHand,
    next: w.spec?.next ? [w.spec.next] : [],
    defeatsOpp,
  });

  return {
    attacker: outcomeFor(A, dmgToAttacker, aDefeats),
    defender: outcomeFor(D, dmgToDefender, dDefeats),
    escape,
  };
}
