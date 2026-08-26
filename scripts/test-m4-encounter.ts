// M4 acceptance test — layered encounter interpreter. Drives specific real
// cards through their choice/condition trees and asserts the resulting state
// deltas, then plays a full game exercising choice-driven encounters.
// Run: npx tsx scripts/test-m4-encounter.ts
import { loadCatalog } from '../src/data/loadAssets';
import { newGame, advance, endHeroActions, resolveEncounter, encounterPlan, chooseEncounter } from '../src/engine/game';
import { placeInfluenceAction } from '../src/engine/influence';
import { planEncounter, applyAtoms } from '../src/engine/encounter';
import type { GameState, HeroId } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

const cat = loadCatalog();

/** Resolve an encounter tree with a fixed decision list, mutating a fresh state. */
function resolve(id: string, decisions: number[], setup?: (s: GameState, h: HeroId) => void) {
  const s: GameState = newGame(cat, 1);
  const heroId = s.heroes[0].id;
  if (setup) setup(s, heroId);
  const enc = cat.encounters[id];
  assert(!!enc, `card ${id} exists`);
  const plan = planEncounter(s, cat, heroId, enc.tree, decisions);
  assert(plan.complete, `${enc.name}: plan completes with decisions [${decisions}]`);
  applyAtoms(s, cat, heroId, plan.atoms, enc.name);
  return { s, hero: s.heroes[0] };
}

// --- 1. choice + conditional reward: The Court of Theoden -----------------
// "Gain 1 favor or discard 1 Corruption. Then, if wisdom > monsters in region,
//  gain a Horse Item card."  hero wisdom is high; no monsters near start.
{
  const id = 'enc-haven-the-court-of-th-oden';
  const before = newGame(cat, 1).heroes[0].favor;
  const { hero } = resolve(id, [0], (s, h) => {
    const hero = s.heroes.find((x) => x.id === h)!;
    // clear monsters in the hero's region so the wisdom check passes
    s.map.monstersAt = {};
    hero.location = Object.keys(cat.locations)[0];
  });
  assert(hero.favor === before + 1, 'Court of Theoden: chose "gain 1 favor" → +1 favor');
  assert(hero.items.includes('Horse'), 'Court of Theoden: wisdom>monsters → gained Horse item');
}

// --- 2. damage-shield choice: take the hit vs. block it -------------------
{
  const id = 'enc-haven-deadmen-s-dike'; // "dealt 4 damage... reduce by shields... if 0, gain 2 favor + training"
  // option 1 = take 4 damage
  {
    const start = newGame(cat, 1).heroes[0].life;
    const { hero } = resolve(id, [1]);
    assert(hero.life === start - 4, 'Deadmen\u2019s Dike: "take damage" → -4 life');
  }
  // option 0 = discard 4 cards to negate, then reward (2 favor + training)
  {
    const { hero } = resolve(id, [0]);
    assert(hero.favor === 2 && hero.training === 1, 'Deadmen\u2019s Dike: "block" → +2 favor, +1 training');
    assert(hero.life === newGame(cat, 1).heroes[0].life, 'Deadmen\u2019s Dike: blocked → no life lost');
  }
}

// --- 3. optional with corruption cost: The Palantirs ----------------------
// "You may receive 1 Corruption to remove 1 influence from the Shadow Pool
//  and then look at Sauron's hand."  decision 0 = accept.
{
  const id = 'enc-haven-the-palantirs';
  const infl0 = 3;
  const { s, hero } = resolve(id, [0], (st) => { st.sauron.influence = infl0; });
  assert(hero.corruption === 1, 'Palantirs: accepted → +1 corruption (cost)');
  assert(s.sauron.influence === infl0 - 1, 'Palantirs: accepted → -1 shadow influence');
}
// decline path leaves state unchanged
{
  const id = 'enc-haven-the-palantirs';
  const infl0 = 3;
  const { s, hero } = resolve(id, [1], (st) => { st.sauron.influence = infl0; });
  assert(hero.corruption === 0 && s.sauron.influence === infl0, 'Palantirs: declined → no change');
}

// --- 4. pure conditional: Intrigue Within Meduseld ------------------------
// "If wisdom >= influence in your region, gain 2 favor." region influence 0.
{
  const id = 'enc-haven-intrigue-within-meduseld';
  const { hero } = resolve(id, []);
  assert(hero.favor === 2, 'Intrigue: wisdom>=0 region influence → +2 favor');
}

// --- 5. quest chain: Explore + reward -------------------------------------
{
  const quest = Object.values(cat.encounters).find((e) => e.name.startsWith('Quest:'))!;
  assert(!!quest, 'a Quest encounter exists');
  const s = newGame(cat, 1); const h = s.heroes[0].id;
  const plan = planEncounter(s, cat, h, quest.tree, [0, 0, 0, 0]);
  assert(plan.complete, `${quest.name}: quest tree resolves`);
  assert(plan.atoms.some((a) => a.op === 'explore'), `${quest.name}: includes an explore op`);
  assert(plan.atoms.some((a) => a.op === 'gainFavor'), `${quest.name}: includes a favor reward`);
}

// --- 7. mandatory end-of-turn Encounter step (manual pp. 24–25) -----------
// Ending a hero turn in a non-perilous location must trigger the Encounter step
// automatically (draw 3, resolve lowest matching) — not only via the optional
// Explore action. We drive a hero turn to its end and assert the step fired.
{
  let s: GameState = newGame(cat, 4);
  let guard = 0;
  while (s.phase !== 'HeroActions' && guard++ < 40) s = advance(s, cat);
  // ensure the location is non-perilous (no influence) so the step is not skipped
  s.sauron.locationInfluence = {};
  const drawLogsBefore = s.log.filter((e) => e.type === 'encounter-draw').length;
  s = endHeroActions(s, cat);
  // resolve any pending encounter the step produced
  let g2 = 0;
  while (s.pendingEncounter && g2++ < 30) {
    const plan = encounterPlan(s, cat);
    if (plan && !plan.complete) {
      const idx = plan.pending!.options.findIndex((o) => o.enabled);
      s = chooseEncounter(s, cat, idx >= 0 ? idx : 0);
    } else s = resolveEncounter(s, cat);
  }
  const drawLogsAfter = s.log.filter((e) => e.type === 'encounter-draw').length;
  assert(drawLogsAfter > drawLogsBefore, 'mandatory Encounter step: an encounter-draw was logged at turn end');
}

// --- 8. perilous location skips the Encounter step ------------------------
{
  let s: GameState = newGame(cat, 8);
  let guard = 0;
  while (s.phase !== 'HeroActions' && guard++ < 40) s = advance(s, cat);
  const hero = s.heroes[s.activeHeroIndex];
  // flood the hero's location with influence so it exceeds wisdom (perilous)
  const wisdom = cat.heroes[hero.id].wisdom;
  s.sauron.locationInfluence = {};
  s.map.monstersAt = {}; s.map.minionsAt = {};
  try { placeInfluenceAction(s, cat, hero.location, wisdom + 2); } catch { /* fall back below */ }
  s.sauron.locationInfluence[hero.location] = wisdom + 2;
  const drawBefore = s.log.filter((e) => e.type === 'encounter-draw').length;
  s = endHeroActions(s, cat);
  const drawAfter = s.log.filter((e) => e.type === 'encounter-draw').length;
  assert(drawAfter === drawBefore, 'perilous location: Encounter step is skipped (no draw)');
}


{
  let resolved = 0;
  for (const enc of Object.values(cat.encounters)) {
    const s = newGame(cat, 1); const h = s.heroes[0].id;
    const decisions: number[] = [];
    let guard = 0; let ok = true;
    while (guard++ < 30) {
      const plan = planEncounter(s, cat, h, enc.tree, decisions);
      if (plan.complete) { applyAtoms(s, cat, h, plan.atoms, enc.name); break; }
      const opts = plan.pending!.options;
      const idx = opts.findIndex((o) => o.enabled);
      decisions.push(idx >= 0 ? idx : 0);
      if (guard >= 29) ok = false;
    }
    if (ok) resolved++;
  }
  assert(resolved === Object.keys(cat.encounters).length, `all ${resolved}/90 cards resolve without looping`);
}

console.log(failures ? `\nM4 encounter: ${failures} FAILURE(S)` : '\nM4 encounter: PASS');
process.exit(failures ? 1 : 0);
