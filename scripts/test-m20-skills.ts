// M20 acceptance test — training-skill effects. Exercises the skill effectKeys
// added in effects.ts through resolveBout() (numeric + next-round carries + the
// combat-stack count context). Combat-zone skills (wear_down/shrewd_planning/
// endure/hamstring) are driven by combat.ts and covered by integration play.
// Run: npx tsx scripts/test-m20-skills.ts
import { resolveBout } from '../src/engine/effects';
import type { CombatCard, CombatType, NextMod } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

function card(over: Partial<CombatCard>): CombatCard {
  return {
    id: over.id ?? 'x', deck: 'd', owner: 'hero', name: over.name ?? 'X',
    type: (over.type ?? 'melee') as CombatType, attack: over.attack ?? 0, defense: over.defense ?? 0,
    strengthCost: over.strengthCost ?? 0, terrain: '', ability: '', effectKey: over.effectKey ?? '', copies: 1,
  };
}
const NO_CARRY = { attacker: [] as NextMod[], defender: [] as NextMod[] };
const NO_STACK = { attacker: { otherCards: 0, otherMelee: 0 }, defender: { otherCards: 0, otherMelee: 0 } };

// Expose (next_atk_2): +2 attack applies to the OWNER next round unconditionally.
{
  const carry = { attacker: [{ atk: 2 } as NextMod], defender: [] as NextMod[] };
  const o = resolveBout(card({ attack: 1, defense: 0 }), card({ attack: 0, defense: 1 }), {}, carry);
  assert(o.defender.damageTaken === 2, 'Expose: carried +2 atk -> 1+2-1 = 2 damage');
}

// Execute: opponent with printed defense 0 is defeated outright.
{
  const o = resolveBout(card({ attack: 1, defense: 0, effectKey: 'execute' }), card({ attack: 0, defense: 0 }), {}, NO_CARRY);
  assert(o.attacker.defeatsOpp === true, 'Execute: opp printed def 0 -> defeatsOpp');
  const o2 = resolveBout(card({ attack: 1, defense: 0, effectKey: 'execute' }), card({ attack: 0, defense: 2 }), {}, NO_CARRY);
  assert(o2.attacker.defeatsOpp === false, 'Execute: opp printed def 2 -> no instant defeat');
}

// Crushing Blow: opp printed def <=1 -> +2 attack AND opp card canceled.
{
  const o = resolveBout(card({ attack: 2, defense: 0, effectKey: 'crushing_blow' }), card({ attack: 4, defense: 1 }), {}, NO_CARRY);
  assert(o.defender.damageTaken === 4, 'Crushing Blow: 2+2 atk, canceled opp def->0 = 4 to opp');
  assert(o.defender.canceled === true, 'Crushing Blow: opp card canceled');
  assert(o.attacker.damageTaken === 0, 'Crushing Blow: canceled opp deals no damage');
}
// Crushing Blow does nothing extra vs a high-defense opponent.
{
  const o = resolveBout(card({ attack: 2, defense: 0, effectKey: 'crushing_blow' }), card({ attack: 0, defense: 3 }), {}, NO_CARRY);
  assert(o.defender.canceled === false && o.defender.damageTaken === 0, 'Crushing Blow: opp def 3 -> no bonus/cancel');
}

// Reversal: opp plays melee -> gain his attack, then cancel his card.
{
  const o = resolveBout(card({ attack: 0, defense: 0, effectKey: 'reversal' }), card({ attack: 5, defense: 2, type: 'melee' }), {}, NO_CARRY);
  assert(o.defender.damageTaken === 5, 'Reversal: gained atk 5, canceled opp def->0 = 5 to opp');
  assert(o.defender.canceled === true && o.attacker.damageTaken === 0, 'Reversal: opp canceled, deals nothing');
}
// Reversal vs a ranged opponent: no effect.
{
  const o = resolveBout(card({ attack: 0, defense: 0, effectKey: 'reversal' }), card({ attack: 5, defense: 0, type: 'ranged' }), {}, NO_CARRY);
  assert(o.defender.canceled === false && o.attacker.damageTaken === 5, 'Reversal: ranged opp unaffected');
}

// Retaliate: deal the opponent 1 damage per damage you take this round.
{
  const o = resolveBout(card({ attack: 0, defense: 0, effectKey: 'retaliate' }), card({ attack: 3, defense: 0, type: 'melee' }), {}, NO_CARRY);
  assert(o.attacker.damageTaken === 3, 'Retaliate: still takes 3');
  assert(o.defender.damageTaken === 3, 'Retaliate: reflects 3 back to opp');
}

// Flaming Arrow (carry reduceOppDef 0): next round opp printed def treated as 0.
{
  const carry = { attacker: [{ reduceOppDef: 0 } as NextMod], defender: [] as NextMod[] };
  const o = resolveBout(card({ attack: 3, defense: 0 }), card({ attack: 0, defense: 5 }), {}, carry);
  assert(o.defender.damageTaken === 3, 'Flaming Arrow: opp def reduced to 0 -> 3 damage');
}

// Set Trap (carry dmgToOpp 2 if opp melee): only fires vs a melee card.
{
  const carry = { attacker: [{ dmgToOpp: 2, dmgToOppIfOppType: 'melee' } as NextMod], defender: [] as NextMod[] };
  const melee = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 0, defense: 0, type: 'melee' }), {}, carry);
  assert(melee.defender.damageTaken === 2, 'Set Trap: opp melee -> 2 damage');
  const ranged = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 0, defense: 0, type: 'ranged' }), {}, carry);
  assert(ranged.defender.damageTaken === 0, 'Set Trap: opp ranged -> no trap damage');
}

// Concussive Shot (carry cancelOppIfPrintedDefGE 2): cancels a sturdy card.
{
  const carry = { attacker: [{ cancelOppIfPrintedDefGE: 2 } as NextMod], defender: [] as NextMod[] };
  const o = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 4, defense: 2, type: 'melee' }), {}, carry);
  assert(o.defender.canceled === true && o.attacker.damageTaken === 0, 'Concussive Shot: opp def>=2 canceled');
  const o2 = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 4, defense: 1, type: 'melee' }), {}, carry);
  assert(o2.defender.canceled === false, 'Concussive Shot: opp def 1 not canceled');
}

// Shield Smash (carry cancelOppIfCostGE 2): cancels an expensive card.
{
  const carry = { attacker: [{ cancelOppIfCostGE: 2 } as NextMod], defender: [] as NextMod[] };
  const o = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 4, defense: 0, strengthCost: 3, type: 'melee' }), {}, carry);
  assert(o.defender.canceled === true, 'Shield Smash: opp cost>=2 canceled');
  const o2 = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 4, defense: 0, strengthCost: 1, type: 'melee' }), {}, carry);
  assert(o2.defender.canceled === false, 'Shield Smash: cheap opp not canceled');
}

// Heightened Senses / Outmaneuver (carry cancelOppUnlessType): cancel a mismatch.
{
  const carry = { attacker: [{ cancelOppUnlessType: 'ranged' } as NextMod], defender: [] as NextMod[] };
  const mismatch = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 4, defense: 0, type: 'melee' }), {}, carry);
  assert(mismatch.defender.canceled === true, 'Outmaneuver: mismatched type canceled');
  const match = resolveBout(card({ attack: 0, defense: 0 }), card({ attack: 4, defense: 0, type: 'ranged' }), {}, carry);
  assert(match.defender.canceled === false, 'Outmaneuver: matched type survives');
}

// Focused Assault (atk/def +1 per other MELEE card in own stack).
{
  const stack = { attacker: { otherCards: 3, otherMelee: 2 }, defender: { otherCards: 0, otherMelee: 0 } };
  const o = resolveBout(card({ attack: 0, defense: 0, effectKey: 'focused_assault' }), card({ attack: 0, defense: 0 }), {}, NO_CARRY, stack);
  assert(o.defender.damageTaken === 2, 'Focused Assault: +2 atk from 2 melee in stack');
  assert(o.attacker.finalDef === 2, 'Focused Assault: +2 def from 2 melee in stack');
}

// Brutal Finisher (atk +1 per other card in own stack).
{
  const stack = { attacker: { otherCards: 4, otherMelee: 1 }, defender: { otherCards: 0, otherMelee: 0 } };
  const o = resolveBout(card({ attack: 3, defense: 0, effectKey: 'brutal_finisher' }), card({ attack: 0, defense: 0 }), {}, NO_CARRY, stack);
  assert(o.defender.damageTaken === 7, 'Brutal Finisher: 3 + 4 stack = 7 damage');
}

// Sanity: an empty stack yields no count bonus.
{
  const o = resolveBout(card({ attack: 3, defense: 0, effectKey: 'brutal_finisher' }), card({ attack: 0, defense: 0 }), {}, NO_CARRY, NO_STACK);
  assert(o.defender.damageTaken === 3, 'Brutal Finisher: empty stack -> base 3');
}

console.log(failures ? `\nM20 skills: ${failures} FAILURE(S)` : '\nM20 skills: PASS');
process.exit(failures ? 1 : 0);
