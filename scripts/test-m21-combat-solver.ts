// M21 acceptance test — the shared combat solver (src/engine/combatSolver.ts).
// Two parts: (1) deterministic micro-decisions on a crafted pendingCombat
// (prefers the harder-hitting affordable card, respects the strength budget,
// gives up only when hopeless); (2) an integration run driving a REAL minion
// combat to completion with the solver, asserting no dangling state.
// Run: npx tsx scripts/test-m21-combat-solver.ts
import { loadCatalog } from '../src/data/loadAssets';
import { newGame, advance, heroEngage, engageableMonsters, resolveChoice } from '../src/engine/game';
import { deployMinion } from '../src/engine/setup';
import { solveCombatOption } from '../src/engine/combatSolver';
import { mulberry32 } from '../src/engine/heroAI';
import type { Catalog, GameState, Combatant, CombatCard } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}
const rng = mulberry32(1);

function card(over: Partial<CombatCard>): CombatCard {
  return {
    id: over.id!, deck: 'test', owner: 'hero', name: over.id!, type: over.type ?? 'melee',
    attack: over.attack ?? 0, defense: over.defense ?? 0, strengthCost: over.strengthCost ?? 0,
    terrain: '', ability: '', effectKey: over.effectKey ?? '', copies: 1,
  };
}
function heroCombatant(refId: string, hand: string[], strength: number, life = 15): Combatant {
  return {
    kind: 'hero', refId, name: refId, life, strength, strengthSpent: 0, exhausted: false,
    hand: [...hand], deck: new Array(life).fill('filler'), discard: [], damagePool: [],
  };
}
function monster(life: number): Combatant {
  return {
    kind: 'monster', refId: 'test-foe', name: 'Foe', life, strength: 3, strengthSpent: 0,
    exhausted: false, hand: [], deck: [], discard: [], damagePool: [],
  };
}
function craft(cat: Catalog, attacker: Combatant, defender: Combatant): GameState {
  const s = newGame(cat, 3);
  attacker.refId = s.heroes[0].id;
  s.pendingCombat = {
    attacker, defender, locationId: s.heroes[0].location, round: 1,
    reveal: {}, pendingEffects: [], report: [], resolved: false,
    lastType: {}, carry: { attacker: [], defender: [] }, stack: { attacker: [], defender: [] },
  };
  s.pendingChoice = {
    id: 'combat-1', seat: 0, kind: 'combat-card', prompt: '',
    options: [...attacker.hand.map((id) => ({ id, label: id })), { id: '__exhaust__', label: 'exhaust' }],
  };
  return s;
}

const cat = loadCatalog();
// inject synthetic cards into the catalog (plain record)
const cards = cat.combatCards as Record<string, CombatCard>;
cards['t-big'] = card({ id: 't-big', attack: 5, defense: 0, strengthCost: 0 });
cards['t-small'] = card({ id: 't-small', attack: 1, defense: 0, strengthCost: 0 });
cards['t-pricey'] = card({ id: 't-pricey', attack: 6, defense: 0, strengthCost: 3 });
cards['t-filler'] = card({ id: 'filler', attack: 0, defense: 0, strengthCost: 0 });

// (1) prefers the harder hitter when both are affordable
{
  const s = craft(cat, heroCombatant('h', ['t-big', 't-small'], 5), monster(3));
  const pick = solveCombatOption(s, cat, s.pendingChoice!.options, rng);
  assert(pick === 't-big', 'solver plays the higher-damage card that secures the kill (t-big)');
}

// (2) respects the strength budget: an unaffordable stronger card is skipped
{
  const s = craft(cat, heroCombatant('h', ['t-pricey', 't-small'], 1), monster(3)); // budget 1 < cost 3
  const pick = solveCombatOption(s, cat, s.pendingChoice!.options, rng);
  assert(pick === 't-small', 'solver skips the unaffordable t-pricey and plays the affordable t-small');
  assert(pick !== '__exhaust__', 'solver keeps fighting rather than exhausting when a playable card exists');
}

// (3) gives up only when hopeless: no affordable card (all too costly), foe huge
{
  const atk = heroCombatant('h', ['t-pricey'], 0, 2); // cannot afford t-pricey; nearly out of life
  const s = craft(cat, atk, monster(20));
  const pick = solveCombatOption(s, cat, s.pendingChoice!.options, rng);
  assert(pick === '__exhaust__', 'with no affordable card, the solver declares exhaustion');
}

// (4) always returns one of the presented options
{
  const s = craft(cat, heroCombatant('h', ['t-big', 't-small'], 5), monster(3));
  const ids = new Set(s.pendingChoice!.options.map((o) => o.id));
  assert(ids.has(solveCombatOption(s, cat, s.pendingChoice!.options, rng)), 'solver returns a legal option id');
}

// (5) integration: drive a real minion combat to completion with the solver
{
  let s0: GameState = newGame(cat, 7);
  let g0 = 0;
  while (s0.phase !== 'HeroActions' && g0++ < 20) s0 = advance(s0, cat);
  const hero = s0.heroes[0];
  s0.story.sauronProgress = 8;
  const id = deployMinion(s0, cat);
  for (const loc of Object.keys(s0.map.minionsAt ?? {})) s0.map.minionsAt![loc] = [];
  (s0.map.minionsAt![hero.location] ||= []).push(id!);
  assert(engageableMonsters(s0, hero.id).includes(id!), 'minion is engageable');
  let g: GameState = heroEngage(s0, cat, hero.id, id!);
  let guard = 0;
  while (g.pendingChoice && guard++ < 200) {
    const pick = solveCombatOption(g, cat, g.pendingChoice.options, rng);
    assert(g.pendingChoice.options.some((o) => o.id === pick) || guard > 1, 'solver picks a legal option each round');
    g = resolveChoice(g, cat, pick);
  }
  assert(g.pendingCombat == null, 'solver-driven combat concludes (no dangling pendingCombat)');
}

console.log(failures ? `\nM21 combat solver: ${failures} FAILURE(S)` : '\nM21 combat solver: PASS');
if (failures) process.exit(1);
