// M2 acceptance test — combat effects. Exercises resolveBout() directly with
// synthetic cards for each effect category, then asserts the numeric outcomes.
// Run: npx tsx scripts/test-m2-combat.ts
import { resolveBout, EFFECTS, knownEffectKeys } from '../src/engine/effects';
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
    strengthCost: 0, terrain: '', ability: '', effectKey: over.effectKey ?? '', copies: 1,
  };
}
const NO_CARRY = { attacker: [] as NextMod[], defender: [] as NextMod[] };

// baseline: 5 atk vs 2 def -> 3 damage; no effects
{
  const o = resolveBout(card({ attack: 5, defense: 1 }), card({ attack: 4, defense: 2 }), {}, NO_CARRY);
  assert(o.defender.damageTaken === 3, 'baseline: attacker 5 atk - 2 def = 3 to defender');
  assert(o.attacker.damageTaken === 3, 'baseline: defender 4 atk - 1 def = 3 to attacker');
}

// conditional attack bonus vs opponent ranged type
{
  const a = card({ attack: 3, defense: 0, effectKey: 'atk_bonus_vs_ranged_2' });
  const dRanged = card({ type: 'ranged', attack: 0, defense: 1 });
  const dMelee = card({ type: 'melee', attack: 0, defense: 1 });
  assert(resolveBout(a, dRanged, {}, NO_CARRY).defender.damageTaken === 4, '+2 atk applies vs ranged (3+2-1=4)');
  assert(resolveBout(a, dMelee, {}, NO_CARRY).defender.damageTaken === 2, '+2 atk does NOT apply vs melee (3-1=2)');
}

// defense bonus vs melee
{
  const a = card({ type: 'melee', attack: 5, defense: 0 });
  const d = card({ attack: 0, defense: 1, effectKey: 'def_bonus_vs_melee_2' });
  assert(resolveBout(a, d, {}, NO_CARRY).defender.damageTaken === 2, 'def +2 vs melee: 5-(1+2)=2');
}

// reduce opponent printed defense to 0
{
  const a = card({ attack: 4, defense: 0, effectKey: 'reduce_opp_def_0' });
  const d = card({ attack: 0, defense: 3 });
  assert(resolveBout(a, d, {}, NO_CARRY).defender.damageTaken === 4, 'reduce def to 0: 4-0=4');
}

// defense floor protects against reduction
{
  const a = card({ attack: 5, defense: 0, effectKey: 'reduce_opp_def_0' });
  const d = card({ attack: 0, defense: 4, effectKey: 'uncancelable_def_floor_2' });
  assert(resolveBout(a, d, {}, NO_CARRY).defender.damageTaken === 3, 'def floor 2 blocks reduction: 5-2=3');
}

// atk bonus if opponent printed defense is 0
{
  const a = card({ attack: 2, defense: 0, effectKey: 'atk_bonus_if_opp_def0_5' });
  const d0 = card({ attack: 0, defense: 0 });
  const d1 = card({ attack: 0, defense: 1 });
  assert(resolveBout(a, d0, {}, NO_CARRY).defender.damageTaken === 7, '+5 atk when opp def 0: 2+5-0=7');
  assert(resolveBout(a, d1, {}, NO_CARRY).defender.damageTaken === 1, 'no bonus when opp def 1: 2-1=1');
}

// cancel opponent's card (any) -> opponent contributes 0/0 and its effect is nullified
{
  const a = card({ attack: 3, defense: 0, effectKey: 'cancel_opp_any' });
  const d = card({ attack: 6, defense: 4, effectKey: 'bonus_dmg_if_dealt_2' });
  const o = resolveBout(a, d, {}, NO_CARRY);
  assert(o.defender.canceled === true, 'cancel: defender card canceled');
  assert(o.defender.damageTaken === 3, 'cancel: 3-0=3 to canceled defender');
  assert(o.attacker.damageTaken === 0, 'cancel: canceled defender deals 0');
}

// uncancelable resists cancel
{
  const a = card({ attack: 3, defense: 0, effectKey: 'cancel_opp_any' });
  const d = card({ attack: 6, defense: 4, effectKey: 'uncancelable' });
  const o = resolveBout(a, d, {}, NO_CARRY);
  assert(o.defender.canceled === false, 'uncancelable: defender not canceled');
  assert(o.attacker.damageTaken === 6, 'uncancelable: still deals 6-0=6');
}

// cancel by type only hits matching type
{
  const a = card({ attack: 3, defense: 0, effectKey: 'cancel_opp_ranged' });
  const dm = card({ type: 'melee', attack: 5, defense: 0 });
  assert(resolveBout(a, dm, {}, NO_CARRY).defender.canceled === false, 'cancel_ranged does not hit melee');
}

// bonus damage if dealt >= 1
{
  const a = card({ attack: 3, defense: 0, effectKey: 'bonus_dmg_if_dealt_2' });
  const d = card({ attack: 0, defense: 1 });
  const dHigh = card({ attack: 0, defense: 5 });
  assert(resolveBout(a, d, {}, NO_CARRY).defender.damageTaken === 4, 'bonus dmg: (3-1)=2 +2 = 4');
  assert(resolveBout(a, dHigh, {}, NO_CARRY).defender.damageTaken === 0, 'no bonus dmg when 0 dealt');
}

// self extra damage if hit
{
  const a = card({ attack: 0, defense: 0, effectKey: 'self_extra_dmg_if_hit_2' });
  const d = card({ attack: 3, defense: 0 });
  assert(resolveBout(a, d, {}, NO_CARRY).attacker.damageTaken === 5, 'self extra dmg: 3 +2 = 5');
}

// damage cap
{
  const a = card({ attack: 0, defense: 0, effectKey: 'dmg_cap_1' });
  const d = card({ attack: 9, defense: 0 });
  assert(resolveBout(a, d, {}, NO_CARRY).attacker.damageTaken === 1, 'damage cap 1 limits 9 -> 1');
}

// escape when unhurt
{
  const a = card({ attack: 2, defense: 9, effectKey: 'escape_if_unhurt' });
  const d = card({ attack: 3, defense: 0 });
  assert(resolveBout(a, d, {}, NO_CARRY).escape === 'attacker', 'escape triggers when attacker takes 0 dmg');
  const a2 = card({ attack: 2, defense: 0, effectKey: 'escape_if_unhurt' });
  assert(resolveBout(a2, d, {}, NO_CARRY).escape === undefined, 'no escape when attacker is hit');
}

// next-round carry: gain +2 atk/def next round
{
  const a = card({ attack: 1, defense: 0, effectKey: 'next_atk_def_2' });
  const d = card({ attack: 0, defense: 1 });
  const o1 = resolveBout(a, d, {}, NO_CARRY);
  assert(o1.attacker.next.length === 1 && o1.attacker.next[0].atk === 2, 'next_atk_def_2 queues carry mod');
  // apply carry next round
  const a2 = card({ attack: 1, defense: 0 });
  const d2 = card({ attack: 0, defense: 2 });
  const o2 = resolveBout(a2, d2, {}, { attacker: o1.attacker.next, defender: [] });
  assert(o2.defender.damageTaken === 1, 'carried +2 atk applies next round: (1+2)-2=1');
}

// conditional carry: +2 atk next round only if you play melee
{
  const carry: NextMod[] = [{ atk: 2, ifOwnType: 'melee' }];
  const melee = card({ type: 'melee', attack: 1, defense: 0 });
  const ranged = card({ type: 'ranged', attack: 1, defense: 0 });
  const d = card({ attack: 0, defense: 0 });
  assert(resolveBout(melee, d, {}, { attacker: carry, defender: [] }).defender.damageTaken === 3, 'conditional carry applies for melee: 1+2=3');
  assert(resolveBout(ranged, d, {}, { attacker: carry, defender: [] }).defender.damageTaken === 1, 'conditional carry skipped for ranged');
}

// match-type bonus: opp repeats last-round type
{
  const a = card({ attack: 2, defense: 0, effectKey: 'atk_bonus_if_opp_repeat_3' });
  const dMelee = card({ type: 'melee', attack: 0, defense: 0 });
  const repeat = resolveBout(a, dMelee, { defender: 'melee' }, NO_CARRY);
  const noRepeat = resolveBout(a, dMelee, { defender: 'ranged' }, NO_CARRY);
  assert(repeat.defender.damageTaken === 5, 'match bonus applies when opp repeats melee: 2+3=5');
  assert(noRepeat.defender.damageTaken === 2, 'no match bonus when opp changed type: 2');
}

// registry integrity
assert(knownEffectKeys().length === 48, 'registry has 48 effect specs');
assert(Object.values(EFFECTS).every((e) => typeof e.key === 'string'), 'every spec has a key');

if (failures) { console.error(`\nM2 combat-effects: ${failures} FAILURE(S)`); process.exit(1); }
console.log('\nM2 combat-effects: PASS');
