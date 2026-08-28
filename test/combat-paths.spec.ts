// Per-COMBAT-CARD, per-PATH resolution coverage. combat-cards.spec.ts proves
// each card resolves and each effectKey executes; THIS suite drives every
// CONDITIONAL branch of a card's combat effect and asserts the exact numeric
// outcome field that branch controls.
//
// resolveBout() is a pure function of (attackerCard, defenderCard, lastTypes,
// carries, stacks). For each card we play it as the attacker against a purpose-
// built opponent that makes each of the card's gated effects fire — and one that
// makes it NOT fire — asserting the controlled outcome (finalAtk / finalDef /
// canceled / defeatsOpp / escape / damageTaken / draw / next …) on both paths.
import { describe, it, expect } from 'vitest';
import { combatCards, label } from './helpers';
import { resolveBout, getEffect } from '../src/engine/effects';
import type { CombatCard, CombatType, NextMod } from '../src/engine/types';

let id = 0;
function mkOpp(over: Partial<CombatCard> = {}): CombatCard {
  return {
    id: `opp-${id++}`, deck: 'monster-behemoth', owner: 'monster', name: 'Opp',
    type: 'melee', attack: 1, defense: 1, strengthCost: 1, terrain: '',
    ability: '', effectKey: '', copies: 1, ...over,
  };
}
const NO = { otherCards: 0, otherMelee: 0 };
function atk(
  a: CombatCard, d: CombatCard,
  o: { lastD?: CombatType; carryA?: NextMod[]; carryD?: NextMod[]; stackA?: { otherCards: number; otherMelee: number } } = {},
) {
  return resolveBout(a, d, { defender: o.lastD }, { attacker: o.carryA ?? [], defender: o.carryD ?? [] },
    { attacker: o.stackA ?? NO, defender: NO });
}

/** Build an opponent (+ its last-played type) that satisfies / fails `cond`. */
type Cond = NonNullable<ReturnType<typeof getEffect>>['atkBonus'] extends { cond: infer C } ? C : never;
function oppForCond(cond: any, satisfy: boolean): { d: CombatCard; lastD?: CombatType } {
  switch (cond.kind) {
    case 'oppType': {
      const other: CombatType = cond.type === 'melee' ? 'ranged' : 'melee';
      return { d: mkOpp({ type: satisfy ? cond.type : other }) };
    }
    case 'oppPrintedDef0':
      return { d: mkOpp({ defense: satisfy ? 0 : 1 }) };
    case 'oppPrintedDefLE':
      return { d: mkOpp({ defense: satisfy ? cond.n : cond.n + 1 }) };
    case 'oppRepeat':
      return { d: mkOpp({ type: 'melee' }), lastD: satisfy ? 'melee' : 'ranged' };
    default: // always
      return { d: mkOpp() };
  }
}

describe('combat card paths', () => {
  for (const card of combatCards) {
    const spec = getEffect(card.effectKey);
    if (!spec) continue;
    const t = `${label(card.id)} (${label(card.name)})`;

    // --- conditional attack bonus ---
    if (spec.atkBonus) {
      const { amount, cond } = spec.atkBonus;
      it(`${t}: atkBonus(+${amount}) applies iff condition holds`, () => {
        const on = oppForCond(cond, true), off = oppForCond(cond, false);
        expect(atk(card, on.d, { lastD: on.lastD }).attacker.finalAtk).toBe(card.attack + amount);
        expect(atk(card, off.d, { lastD: off.lastD }).attacker.finalAtk).toBe(card.attack);
      });
    }

    // --- conditional defense bonus ---
    if (spec.defBonus) {
      const { amount, cond } = spec.defBonus;
      it(`${t}: defBonus(+${amount}) applies iff condition holds`, () => {
        const on = oppForCond(cond, true), off = oppForCond(cond, false);
        expect(atk(card, on.d, { lastD: on.lastD }).attacker.finalDef).toBe(card.defense + amount);
        expect(atk(card, off.d, { lastD: off.lastD }).attacker.finalDef).toBe(card.defense);
      });
    }

    // --- conditional cancel of the opponent ---
    if (spec.cancelOppCond) {
      const cond = spec.cancelOppCond;
      it(`${t}: cancels opponent iff condition holds`, () => {
        const on = oppForCond(cond, true), off = oppForCond(cond, false);
        expect(atk(card, on.d, { lastD: on.lastD }).defender.canceled).toBe(true);
        expect(atk(card, off.d, { lastD: off.lastD }).defender.canceled).toBe(false);
      });
    }

    // --- unconditional cancel by played type ---
    if (spec.cancelOpp) {
      const kind = spec.cancelOpp;
      it(`${t}: cancelOpp('${kind}') hits a matching, cancelable card only`, () => {
        const hit = kind === 'any' ? mkOpp({ type: 'melee' }) : mkOpp({ type: kind });
        expect(atk(card, hit).defender.canceled).toBe(true);
        // a matching but UNCANCELABLE opponent is not canceled
        const armored = mkOpp({ type: kind === 'any' ? 'melee' : kind, effectKey: 'uncancelable' });
        expect(atk(card, armored).defender.canceled).toBe(false);
        if (kind !== 'any') {
          const wrong = mkOpp({ type: kind === 'melee' ? 'ranged' : 'melee' });
          expect(atk(card, wrong).defender.canceled).toBe(false);
        }
      });
    }

    // --- Reversal: gain the opponent's printed attack vs a matching type ---
    if (spec.atkEqualsOppAtkIfType) {
      const type = spec.atkEqualsOppAtkIfType;
      it(`${t}: gains opponent's printed attack vs ${type}`, () => {
        const other: CombatType = type === 'melee' ? 'ranged' : 'melee';
        expect(atk(card, mkOpp({ type, attack: 4 })).attacker.finalAtk).toBe(card.attack + 4);
        expect(atk(card, mkOpp({ type: other, attack: 4 })).attacker.finalAtk).toBe(card.attack);
      });
    }

    // --- Execute: defeat an opponent whose printed defense is 0 ---
    if (spec.defeatOppIfPrintedDef0) {
      it(`${t}: defeats opponent iff its printed defense is 0`, () => {
        expect(atk(card, mkOpp({ defense: 0 })).attacker.defeatsOpp).toBe(true);
        expect(atk(card, mkOpp({ defense: 1 })).attacker.defeatsOpp).toBe(false);
      });
    }

    // --- amplifier: extra damage only when a hit landed ---
    if (spec.bonusDamageIfDealt && card.attack >= 1) {
      const amt = spec.bonusDamageIfDealt;
      it(`${t}: +${amt} damage only when it deals a hit`, () => {
        expect(atk(card, mkOpp({ defense: 0, attack: 0 })).defender.damageTaken).toBe(card.attack + amt);
        expect(atk(card, mkOpp({ defense: 99, attack: 0 })).defender.damageTaken).toBe(0);
      });
    }

    // --- self-hit penalty: extra self damage only when hit ---
    if (spec.selfExtraDamageIfHit) {
      const amt = spec.selfExtraDamageIfHit;
      it(`${t}: takes +${amt} self damage only when hit`, () => {
        const raw = card.defense + 3; // opponent attack that pierces our defense
        expect(atk(card, mkOpp({ attack: raw, defense: 0 })).attacker.damageTaken).toBe(3 + amt);
        expect(atk(card, mkOpp({ attack: 0, defense: 0 })).attacker.damageTaken).toBe(0);
      });
    }

    // --- damage cap ---
    if (spec.damageCap !== undefined) {
      const cap = spec.damageCap;
      it(`${t}: caps incoming damage at ${cap}`, () => {
        const out = atk(card, mkOpp({ attack: card.defense + 9, defense: 0 }));
        expect(out.attacker.damageTaken).toBe(cap);
      });
    }

    // --- escape when unhurt ---
    if (spec.escapeIfUnhurt) {
      it(`${t}: escapes iff it takes no damage`, () => {
        expect(atk(card, mkOpp({ attack: 0, defense: 0 })).escape).toBe('attacker');
        // pierced defense → hurt → no escape
        expect(atk(card, mkOpp({ attack: card.defense + 5, defense: 0 })).escape).toBeUndefined();
      });
    }

    // --- unconditional printed-stat reductions ---
    if (spec.reduceOppDef !== undefined) {
      const v = spec.reduceOppDef;
      it(`${t}: reduces opponent defense to ${v}`, () => {
        expect(atk(card, mkOpp({ defense: 5 })).defender.finalDef).toBe(Math.max(v, 0));
      });
    }
    if (spec.reduceOppAtk !== undefined) {
      const v = spec.reduceOppAtk;
      it(`${t}: reduces opponent attack to ${v}`, () => {
        expect(atk(card, mkOpp({ attack: 5 })).defender.finalAtk).toBe(Math.max(v, 0));
      });
    }

    // --- side-effect outputs surface on the outcome ---
    if (spec.draw) {
      it(`${t}: draws ${spec.draw}`, () => {
        expect(atk(card, mkOpp()).attacker.draw).toBe(spec.draw);
      });
    }
    if (spec.oppDiscardRandom) {
      it(`${t}: forces opponent to discard ${spec.oppDiscardRandom}`, () => {
        expect(atk(card, mkOpp()).attacker.oppDiscardRandom).toBe(spec.oppDiscardRandom);
      });
    }
    if (spec.revealOppHand) {
      it(`${t}: reveals opponent hand`, () => {
        expect(atk(card, mkOpp()).attacker.revealOppHand).toBe(true);
      });
    }
    if (spec.next) {
      it(`${t}: queues its next-round modifier`, () => {
        expect(atk(card, mkOpp()).attacker.next).toEqual([spec.next]);
      });
    }

    // --- uncancelable / defense floor (played as the DEFENDER of a canceller) ---
    if (spec.uncancelable) {
      it(`${t}: cannot be canceled`, () => {
        const canceller = mkOpp({ type: 'melee', effectKey: 'cancel_opp_any' });
        // card is the defender here; the attacker tries to cancel it
        const out = resolveBout(canceller, card, {}, { attacker: [], defender: [] });
        expect(out.defender.canceled).toBe(false);
      });
    }
    if (spec.defenseFloor) {
      const floor = spec.defenseFloor;
      it(`${t}: defense cannot be reduced below ${floor}`, () => {
        const reducer = mkOpp({ effectKey: 'reduce_opp_def_0' });
        const out = resolveBout(reducer, card, {}, { attacker: [], defender: [] });
        expect(out.defender.finalDef).toBe(floor);
      });
    }

    // --- stack-count skills ---
    if (spec.atkPerOtherStackCard) {
      const per = spec.atkPerOtherStackCard;
      it(`${t}: +${per} attack per other stack card`, () => {
        expect(atk(card, mkOpp(), { stackA: { otherCards: 3, otherMelee: 0 } }).attacker.finalAtk)
          .toBe(card.attack + per * 3);
        expect(atk(card, mkOpp(), { stackA: { otherCards: 0, otherMelee: 0 } }).attacker.finalAtk)
          .toBe(card.attack);
      });
    }
    if (spec.atkDefPerOtherMeleeStack) {
      const per = spec.atkDefPerOtherMeleeStack;
      it(`${t}: +${per} atk/def per other melee stack card`, () => {
        const out = atk(card, mkOpp(), { stackA: { otherCards: 2, otherMelee: 2 } }).attacker;
        expect(out.finalAtk).toBe(card.attack + per * 2);
        expect(out.finalDef).toBe(card.defense + per * 2);
      });
    }

    // --- retaliate: deal back the damage you take ---
    if (spec.retaliate) {
      it(`${t}: retaliates the damage it takes`, () => {
        const raw = card.defense + 2;
        const out = atk(card, mkOpp({ attack: raw, defense: 5 }));
        expect(out.attacker.damageTaken).toBe(2);
        // defender takes card.attack (vs def5) plus retaliated 2
        expect(out.defender.damageTaken).toBe(Math.max(0, card.attack - 5) + 2);
      });
    }
  }
});
