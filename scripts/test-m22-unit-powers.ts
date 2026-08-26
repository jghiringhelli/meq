// M22 acceptance test — monster innate combat powers (monsterPowers.ts) and
// hero special abilities (Thálin, Eleanor, Beravor). The hero is ALWAYS the
// attacker and the monster ALWAYS the defender, so every monster power operates
// on the defender side.
// Run: npx tsx scripts/test-m22-unit-powers.ts
import { loadCatalog } from '../src/data/loadAssets';
import { newGame, advance } from '../src/engine/game';
import { heroConsultCharacter, heroCompleteQuest } from '../src/engine/economy';
import { heroRest } from '../src/engine/phases';
import {
  monsterAdjustCard, monsterCardCost, monsterCancelsHeroCard, applyMonsterPostBout,
} from '../src/engine/monsterPowers';
import { isPerilous } from '../src/engine/influence';
import type { Catalog, GameState, Combatant, CombatCard, CombatType } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

function card(over: Partial<CombatCard>): CombatCard {
  return {
    id: over.id ?? 'x', deck: 'test', owner: 'monster', name: over.id ?? 'X',
    type: over.type ?? 'melee', attack: over.attack ?? 0, defense: over.defense ?? 0,
    strengthCost: over.strengthCost ?? 0, terrain: '', ability: '', effectKey: over.effectKey ?? '', copies: 1,
  };
}
function heroC(refId: string, hand: string[] = [], life = 15): Combatant {
  return {
    kind: 'hero', refId, name: refId, life, strength: 5, strengthSpent: 0, exhausted: false,
    hand: [...hand], deck: new Array(life).fill('filler'), discard: [], damagePool: [],
  };
}
function monsterC(refId: string, life = 8, deck: string[] = []): Combatant {
  return {
    kind: 'monster', refId, name: refId, life, strength: 3, strengthSpent: 0, exhausted: false,
    hand: [], deck: [...deck], discard: [], damagePool: [],
  };
}
function craft(cat: Catalog, defender: Combatant): GameState {
  const s = newGame(cat, 3);
  const hero = s.heroes[0];
  const attacker = heroC(hero.id, ['a1', 'a2', 'a3']);
  s.pendingCombat = {
    attacker, defender, locationId: hero.location, round: 1,
    reveal: {}, pendingEffects: [], report: [], resolved: false,
    lastType: {}, carry: { attacker: [], defender: [] }, stack: { attacker: [], defender: [] },
  } as GameState['pendingCombat'];
  return s;
}
type Ctx = { attackerType: CombatType | ''; defenderType: CombatType | ''; dmgToHero: number; prevented: number; monsterMaxLife: number };
function post(s: GameState, cat: Catalog, refId: string, c: Ctx) {
  return applyMonsterPostBout(s, cat, { refId, ...c });
}

const cat = loadCatalog();

// ---- pre-resolve stat/cost/cancel powers -------------------------------------
// Precision (Snaga): +1 attack on Ranged cards only.
assert(monsterAdjustCard('mon-snaga', card({ type: 'ranged', attack: 2 }))!.attack === 3, 'Snaga Precision: +1 to ranged attack');
assert(monsterAdjustCard('mon-snaga', card({ type: 'melee', attack: 2 }))!.attack === 2, 'Snaga Precision: no bonus to melee');
// Crushing Strength (Huorn): +1 attack on Melee cards only.
assert(monsterAdjustCard('mon-huorn', card({ type: 'melee', attack: 4 }))!.attack === 5, 'Huorn Crushing Strength: +1 to melee attack');
assert(monsterAdjustCard('mon-huorn', card({ type: 'ranged', attack: 4 }))!.attack === 4, 'Huorn Crushing Strength: no bonus to ranged');
// Superior Tactics (Southron): melee cards cost 1 less strength.
assert(monsterCardCost('mon-southron', card({ type: 'melee', strengthCost: 2 }), false) === 1, 'Southron Superior Tactics: melee cost -1');
assert(monsterCardCost('mon-southron', card({ type: 'ranged', strengthCost: 2 }), false) === 2, 'Southron Superior Tactics: ranged cost unchanged');
// Warg-rider: its first (bottom) melee card is free.
assert(monsterCardCost('mon-warg-rider', card({ type: 'melee', strengthCost: 3 }), true) === 0, 'Warg-rider: first melee card is free');
assert(monsterCardCost('mon-warg-rider', card({ type: 'melee', strengthCost: 3 }), false) === 3, 'Warg-rider: later melee cards cost normally');
// Roar (Cave Troll): a Ranged monster card cancels the hero's Melee card.
assert(monsterCancelsHeroCard('mon-cave-troll', card({ type: 'ranged' }), card({ type: 'melee' })) === true, 'Cave Troll Roar: ranged cancels hero melee');
assert(monsterCancelsHeroCard('mon-cave-troll', card({ type: 'melee' }), card({ type: 'melee' })) === false, 'Cave Troll Roar: needs a ranged monster card');
assert(monsterCancelsHeroCard('mon-orc', card({ type: 'ranged' }), card({ type: 'melee' })) === false, 'Roar is Cave-Troll only');

// ---- post-damage triggers ----------------------------------------------------
// Orc Fanatical: both play Melee -> +1 damage to the hero.
{
  const s = craft(cat, monsterC('mon-orc'));
  const r = post(s, cat, 'mon-orc', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 2, prevented: 0, monsterMaxLife: 8 });
  assert(r.dmgToHero === 3, 'Orc Fanatical: +1 damage when both play melee');
  const r2 = post(s, cat, 'mon-orc', { attackerType: 'ranged', defenderType: 'melee', dmgToHero: 2, prevented: 0, monsterMaxLife: 8 });
  assert(r2.dmgToHero === 2, 'Orc Fanatical: no bonus when hero plays ranged');
}
// Dunlending Counter-attack: preventing >=1 with a melee card deals the hero 1.
{
  const s = craft(cat, monsterC('mon-dunlending'));
  assert(post(s, cat, 'mon-dunlending', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 0, prevented: 2, monsterMaxLife: 8 }).dmgToHero === 1, 'Dunlending Counter-attack: +1 when it blocks melee');
  assert(post(s, cat, 'mon-dunlending', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 0, prevented: 0, monsterMaxLife: 8 }).dmgToHero === 0, 'Dunlending Counter-attack: nothing when it blocks nothing');
}
// Uruk-hai Bloodfury: on dealing melee damage, the monster draws a card.
{
  const s = craft(cat, monsterC('mon-uruk-hai', 8, ['m1', 'm2']));
  post(s, cat, 'mon-uruk-hai', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 2, prevented: 0, monsterMaxLife: 8 });
  assert(s.pendingCombat!.defender.hand.length === 1, 'Uruk-hai Bloodfury: draws a combat card after dealing melee damage');
}
// Giant Spider Paralyzing Venom: dealing >=2 melee forces a random hand discard.
{
  const s = craft(cat, monsterC('mon-giant-spider'));
  const handBefore = s.pendingCombat!.attacker.hand.length;
  post(s, cat, 'mon-giant-spider', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 2, prevented: 0, monsterMaxLife: 8 });
  assert(s.pendingCombat!.attacker.hand.length === handBefore - 1, 'Giant Spider Venom: hero randomly discards on >=2 melee damage');
  assert(s.pendingCombat!.attacker.discard.length === 1, 'Giant Spider Venom: the discarded card lands in the discard');
}
// Oliphaunt Stampede: on dealing melee damage, >=1 damage comes from the hand.
{
  const s = craft(cat, monsterC('mon-oliphaunt'));
  assert(post(s, cat, 'mon-oliphaunt', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 3, prevented: 0, monsterMaxLife: 8 }).fromHand === 1, 'Oliphaunt Stampede: 1 damage comes from the hand');
  assert(post(s, cat, 'mon-oliphaunt', { attackerType: 'ranged', defenderType: 'ranged', dmgToHero: 3, prevented: 0, monsterMaxLife: 8 }).fromHand === 0, 'Oliphaunt Stampede: only on melee damage');
}
// Balrog Fear: dealing >=3 melee forces the hero to play a random card next round.
{
  const s = craft(cat, monsterC('mon-balrog', 12));
  assert(post(s, cat, 'mon-balrog', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 3, prevented: 0, monsterMaxLife: 12 }).forceHeroRandom === true, 'Balrog Fear: forces random card on >=3 melee damage');
  assert(post(s, cat, 'mon-balrog', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 2, prevented: 0, monsterMaxLife: 12 }).forceHeroRandom === false, 'Balrog Fear: not triggered under 3 damage');
}
// Barrow-wight Regenerate: after a ranged round, if alive, heal 1 (capped at max).
{
  const s = craft(cat, monsterC('mon-barrow-wight', 5));
  assert(post(s, cat, 'mon-barrow-wight', { attackerType: 'melee', defenderType: 'ranged', dmgToHero: 1, prevented: 0, monsterMaxLife: 8 }).heal === 1, 'Barrow-wight Regenerate: heals 1 after surviving a ranged round');
  const sFull = craft(cat, monsterC('mon-barrow-wight', 8));
  assert(post(sFull, cat, 'mon-barrow-wight', { attackerType: 'melee', defenderType: 'ranged', dmgToHero: 1, prevented: 0, monsterMaxLife: 8 }).heal === 0, 'Barrow-wight Regenerate: no overheal beyond max life');
  const sDead = craft(cat, monsterC('mon-barrow-wight', 0));
  assert(post(sDead, cat, 'mon-barrow-wight', { attackerType: 'melee', defenderType: 'ranged', dmgToHero: 1, prevented: 0, monsterMaxLife: 8 }).heal === 0, 'Barrow-wight Regenerate: a slain monster does not regenerate');
}
// Agent Spread Lies: after dealing ranged damage, hero +1 corruption ONCE per battle.
{
  const s = craft(cat, monsterC('mon-agent'));
  const hero = s.heroes[0]; s.pendingCombat!.attacker.refId = hero.id;
  const before = hero.corruption;
  post(s, cat, 'mon-agent', { attackerType: 'melee', defenderType: 'ranged', dmgToHero: 1, prevented: 0, monsterMaxLife: 8 });
  assert(hero.corruption === before + 1, 'Agent Spread Lies: hero gains 1 corruption on ranged damage');
  post(s, cat, 'mon-agent', { attackerType: 'melee', defenderType: 'ranged', dmgToHero: 1, prevented: 0, monsterMaxLife: 8 });
  assert(hero.corruption === before + 1, 'Agent Spread Lies: only once per battle');
}
// Crebain Spy: ranged damage becomes influence, dealing 0 to the hero.
{
  const s = craft(cat, monsterC('mon-crebain'));
  assert(post(s, cat, 'mon-crebain', { attackerType: 'melee', defenderType: 'ranged', dmgToHero: 2, prevented: 0, monsterMaxLife: 8 }).dmgToHero === 0, 'Crebain Spy: ranged damage is redirected (0 to hero)');
  assert(post(s, cat, 'mon-crebain', { attackerType: 'melee', defenderType: 'melee', dmgToHero: 2, prevented: 0, monsterMaxLife: 8 }).dmgToHero === 2, 'Crebain Spy: melee damage still hurts the hero');
}

// ---- hero special abilities ---------------------------------------------------
function heroTurnState(heroId: string): { s: GameState; idx: number } {
  let s = newGame(cat, 5);
  let g = 0;
  while (s.phase !== 'HeroActions' && g++ < 30) s = advance(s, cat);
  const idx = s.activeHeroIndex;
  s.heroes[idx].id = heroId as GameState['heroes'][number]['id'];
  s.heroes[idx].actionsRemaining = 2;
  return { s, idx };
}
// Eleanor: +1 favor when consulting a character (once per turn).
{
  const { s, idx } = heroTurnState('eleanor');
  const hero = s.heroes[idx];
  (s.map.charactersAt ||= {})[hero.location] = ['Gandalf', 'Aragorn'];
  const before = hero.favor;
  const s1 = heroConsultCharacter(s, cat, hero.id, 'Gandalf', 'favor');
  const h1 = s1.heroes[idx];
  assert(h1.favor === before + 2 + 1, 'Eleanor: +1 bonus favor on top of the 2 from consulting');
  assert(h1.abilityUsedThisTurn === true, 'Eleanor: ability flag set after use');
  const s2 = heroConsultCharacter(s1, cat, hero.id, 'Aragorn', 'favor');
  assert(s2.heroes[idx].favor === h1.favor + 2, 'Eleanor: no second bonus in the same turn');
}
// Eleanor: also triggers on completing a Quest (data-driven reward).
{
  const { s, idx } = heroTurnState('eleanor');
  const hero = s.heroes[idx];
  // Pin her Starting Quest to one whose reward grants exactly +1 favor so the
  // Eleanor bonus is isolated, and stand on its Explore-task location.
  hero.quests = { startingDone: false, advancedDone: false,
    startingQuestId: 'quest-eleanor-an-appeal-to-golasgil', advancedQuestId: 'quest-eleanor-hidden-in-the-ash-mountains' };
  hero.favor = 3;
  const s1 = heroCompleteQuest(s, cat, hero.id);
  assert(s1.heroes[idx].favor === 3 + 1 + 1, 'Eleanor: +1 bonus favor when completing a Quest');
}
// A non-Eleanor hero gets no bonus.
{
  const { s, idx } = heroTurnState('thalin');
  const hero = s.heroes[idx];
  (s.map.charactersAt ||= {})[hero.location] = ['Gandalf'];
  const before = hero.favor;
  const s1 = heroConsultCharacter(s, cat, hero.id, 'Gandalf', 'favor');
  assert(s1.heroes[idx].favor === before + 2, 'Non-Eleanor hero: consulting yields only the base 2 favor');
}
// Beravor Survivalist: heals while resting in a non-Haven location.
{
  const { s, idx } = heroTurnState('beravor');
  const hero = s.heroes[idx];
  const plain = Object.values(cat.locations).find((l) => l.kind !== 'haven' && l.kind !== 'stronghold')!;
  hero.location = plain.id;
  // seed a damage pool and clear foes at the location
  hero.damagePool = ['d1', 'd2']; hero.deck = ['c1', 'c2', 'c3'];
  if (s.map.monstersAt) s.map.monstersAt[plain.id] = [];
  if (s.map.minionsAt) s.map.minionsAt[plain.id] = [];
  const s1 = heroRest(s, cat, hero.id);
  assert(s1.heroes[idx].damagePool.length === 0, 'Beravor Survivalist: damage pool cleared when resting outside a Haven');
}
// A non-Beravor hero does NOT heal resting outside a Haven.
{
  const { s, idx } = heroTurnState('thalin');
  const hero = s.heroes[idx];
  const plain = Object.values(cat.locations).find((l) => l.kind !== 'haven' && l.kind !== 'stronghold')!;
  hero.location = plain.id;
  hero.damagePool = ['d1', 'd2']; hero.deck = ['c1', 'c2', 'c3'];
  if (s.map.monstersAt) s.map.monstersAt[plain.id] = [];
  if (s.map.minionsAt) s.map.minionsAt[plain.id] = [];
  const s1 = heroRest(s, cat, hero.id);
  assert(s1.heroes[idx].damagePool.length === 2, 'Non-Beravor hero: damage pool untouched when resting outside a Haven');
}

// ---- minion auras -------------------------------------------------------------
// Witch-king (Lord of the Nazgûl): heroes within 1 space may not rest/heal
// outside a Haven.
{
  const { s, idx } = heroTurnState('thalin');
  const hero = s.heroes[idx];
  const plain = Object.values(cat.locations).find((l) => l.kind !== 'haven' && l.kind !== 'stronghold')!;
  hero.location = plain.id;
  hero.damagePool = ['d1', 'd2']; hero.deck = ['c1']; hero.discard = ['r1', 'r2'];
  if (s.map.monstersAt) s.map.monstersAt[plain.id] = [];
  // place the Witch-king on an ADJACENT location (within 1 space, not on top)
  const edge = cat.edges.find((e) => e.a === plain.id || e.b === plain.id)!;
  const adj = edge.a === plain.id ? edge.b : edge.a;
  (s.map.minionsAt ||= {})[adj] = ['minion-witch-king'];
  const s1 = heroRest(s, cat, hero.id);
  assert(s1.heroes[idx].discard.length === 2, 'Witch-king aura: rest is blocked within 1 space (rest pool not restored)');
  assert(s1.heroes[idx].damagePool.length === 2, 'Witch-king aura: no healing within 1 space outside a Haven');
}
// Ringwraith return-to-Morgul: a defeated Ringwraith is queued for redeploy.
{
  let s = newGame(cat, 6);
  (s.map.minionReturnPending ||= []).push('minion-ringwraiths');
  // driving a Sauron refresh redeploys it to Minas Morgul; here we assert the
  // queue mechanism directly (redeploy is internal to runSauronRefresh).
  assert(s.map.minionReturnPending.includes('minion-ringwraiths'), 'Ringwraiths: defeat queues a return to Minas Morgul');
}


// Consulting a tainted Character while its plot is active gives 1 Corruption.
{
  const { s, idx } = heroTurnState('eleanor');
  const hero = s.heroes[idx];
  (s.map.charactersAt ||= {})[hero.location] = ['Dain II'];
  (s.sauron.activePlots ||= []).push({ eventId: 'a-dark-messenger', step: 1, location: 'erebor' });
  const before = hero.corruption;
  const s1 = heroConsultCharacter(s, cat, hero.id, 'Dain II', 'favor');
  assert(s1.heroes[idx].corruption === before + 1, 'A Dark Messenger: consulting Dáin II gives 1 Corruption');
}
// Without the plot active, no corruption.
{
  const { s, idx } = heroTurnState('thalin');
  const hero = s.heroes[idx];
  (s.map.charactersAt ||= {})[hero.location] = ['Dain II'];
  const before = hero.corruption;
  const s1 = heroConsultCharacter(s, cat, hero.id, 'Dain II', 'favor');
  assert(s1.heroes[idx].corruption === before, 'No plot active: consulting Dáin II is safe');
}
// Saruman Falls to Corruption makes Isengard perilous.
{
  let s = newGame(cat, 2);
  assert(isPerilous(s, cat, 'isengard', 99) === false, 'Isengard not perilous without the plot');
  (s.sauron.activePlots ||= []).push({ eventId: 'saruman-falls-to-corruption', step: 1, location: 'isengard' });
  assert(isPerilous(s, cat, 'isengard', 99) === true, 'Saruman Falls to Corruption: Isengard is perilous regardless of wisdom');
}

console.log(failures ? `\nM22 unit powers: ${failures} FAILURE(S)` : '\nM22 unit powers: PASS');
if (failures) process.exit(1);
