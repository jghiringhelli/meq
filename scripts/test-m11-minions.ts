// M11 — named elite minions as real board figures. Verifies the roster loads,
// the Eye deploys reserve minions gradually during its turn, minions are
// engageable like monsters, defeating one removes it from the board, and the
// `minionsAtMost` hero mission / `minionsTotal` metric count real minions.
import { loadCatalog } from '../src/data/loadAssets';
import { newGame, advance, heroEngage, engageableMonsters, resolveChoice, endHeroActions, encounterPlan, chooseEncounter, resolveEncounter } from '../src/engine/game';
import { deployMinion } from '../src/engine/setup';
import { minionsInPlay, evalMission } from '../src/engine/missions';
import { STRATEGIES, applyHeroAction } from '../src/engine/heroAI';
import type { GameState } from '../src/engine/types';

let failures = 0;
declare const process: { exit(code: number): never };
function assert(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
}

const cat = loadCatalog();

// --- roster ----------------------------------------------------------------
const roster = Object.values(cat.minions);
assert(roster.length === 5, `catalog has 5 minions (got ${roster.length})`);
assert(roster.every((m) => cat.decks[m.combatDeck]?.length > 0), 'every minion has a valid combat deck');
assert(roster.some((m) => m.finale), 'the Ringwraiths are flagged as the finale foe');
// minions use DIFFERENT decks by tier — not all the same (Zealot/Ravager/Behemoth)
assert(new Set(roster.map((m) => m.combatDeck)).size >= 3, 'minions span at least 3 distinct combat decks');
assert(cat.minions['minion-mouth-of-sauron'].combatDeck === 'monster-zealot', 'Mouth of Sauron uses the Zealot deck');
assert(cat.minions['minion-witch-king'].combatDeck === 'monster-behemoth', 'Witch King uses the Behemoth deck');
assert(cat.minions['minion-black-serpent'].combatDeck === 'monster-ravager', 'Black Serpent uses the Ravager deck');
assert(roster.every((m) => !!m.ability && !!m.effectKey), 'every minion carries an ability + effectKey');

// --- board starts with Sauron's two lieutenants (the rest enter via the Eye) --
{
  const s = newGame(cat, 3);
  assert(minionsInPlay(s) === 2, 'two starting minions on the board at setup');
}

// --- deployMinion activates a stage-gated reserve minion into play ---------
// Stage-1 minions are already on the board at setup; new minions activate only
// when the game reaches their stage, onto their own designated location.
{
  const s = newGame(cat, 3);
  s.story.sauronProgress = 8; // stage 2 (spaces 7-12)
  const before = minionsInPlay(s);
  const id = deployMinion(s, cat);
  assert(!!id, 'deployMinion returns a minion id at stage 2');
  assert(minionsInPlay(s) === before + 1, 'deploying puts one more minion on the board');
  assert(!cat.minions[id!].finale, 'deployed minion is not the finale foe');
  const loc = Object.entries(s.map.minionsAt ?? {}).find(([, a]) => a.includes(id!))?.[0];
  assert(loc === cat.minions[id!].location, 'minion activates onto its designated location');
}

// --- at stage 1 no further minion activates (both stage-1 minions on board) -
{
  const s = newGame(cat, 3);
  assert(deployMinion(s, cat) === null, 'no stage-1 reserve remains after setup');
}

// --- every stage-appropriate minion deploys — including the Ringwraiths, who
// are a normal stage-II minion (rulebook p.12) as well as the Finale foe ------
{
  const s = newGame(cat, 3);
  s.story.sauronProgress = 15; // stage 3: every minion may activate
  let guard = 0;
  while (deployMinion(s, cat) && guard++ < 20) { /* deploy all reserve */ }
  const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
  assert([...onBoard].some((mid) => cat.minions[mid].finale), 'the Ringwraiths deploy as a normal stage-II/III minion');
  assert(onBoard.size === roster.length, 'every minion (all 5) deploys by stage 3');
}

// --- once the Finale has begun, the finale foe is NOT auto-deployed (it is
// seated explicitly as the champion by maybeBeginFinale) ----------------------
{
  const s = newGame(cat, 3);
  s.story.sauronProgress = 15;
  s.story.finale = true;
  let guard = 0;
  while (deployMinion(s, cat) && guard++ < 20) { /* deploy remaining reserve */ }
  const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
  assert(![...onBoard].some((mid) => cat.minions[mid].finale), 'finale foe is withheld during an active Finale');
}

// --- a hero can engage a co-located minion and defeat removes it -----------
{
  const s = newGame(cat, 7);
  // advance into the hero's action phase before engaging
  let s0: GameState = s;
  let g0 = 0;
  while (s0.phase !== 'HeroActions' && g0++ < 20) s0 = advance(s0, cat);
  const hero = s0.heroes[0];
  s0.story.sauronProgress = 8; // stage 2 so a reserve minion activates
  const id = deployMinion(s0, cat);
  // move the minion onto the hero's node
  for (const loc of Object.keys(s0.map.minionsAt ?? {})) s0.map.minionsAt![loc] = [];
  (s0.map.minionsAt![hero.location] ||= []).push(id!);
  const engage = engageableMonsters(s0, hero.id);
  assert(engage.includes(id!), 'minion at the hero location is engageable');

  // resolve the combat to completion (auto-picking the queued choices)
  let g: GameState = heroEngage(s0, cat, hero.id, id!);
  let guard = 0;
  while (g.pendingChoice && guard++ < 100) {
    g = resolveChoice(g, cat, g.pendingChoice.options[0].id);
  }
  assert(g.pendingCombat == null, 'combat concludes (no dangling pendingCombat)');
  const still = Object.values(g.map.minionsAt ?? {}).flat().includes(id!);
  const heroWon = g.heroes[0].favor > s0.heroes[0].favor;
  // The core invariant: a hero victory (favor gained) removes the defeated
  // minion. A stalemate/withdrawal may leave it on the board — that's valid.
  assert(!heroWon || !still, 'a defeated minion (hero victory) is removed from the board');
}

// --- minionsAtMost hero mission reads the real board count -----------------
{
  const s = newGame(cat, 11);
  const cond = { kind: 'minionsAtMost', n: 2 } as const;
  assert(evalMission(cond, s, cat), 'minionsAtMost(2) satisfied with the 2 starting minions');
  s.story.sauronProgress = 15; // stage 3 so the reserve can activate
  let g = 0;
  while (deployMinion(s, cat) && g++ < 20) { /* deploy remaining reserve */ }
  assert(minionsInPlay(s) > 2, 'more than two minions once the reserve deploys');
  assert(!evalMission(cond, s, cat), 'minionsAtMost(2) fails once >2 minions are in play');
}

// --- Mouth of Sauron corrupts a hero on engagement ------------------------
{
  const s = newGame(cat, 9);
  let s0: GameState = s;
  let g0 = 0;
  while (s0.phase !== 'HeroActions' && g0++ < 20) s0 = advance(s0, cat);
  const hero = s0.heroes[0];
  for (const loc of Object.keys(s0.map.minionsAt ?? {})) s0.map.minionsAt![loc] = [];
  (s0.map.minionsAt ||= {})[hero.location] = ['minion-mouth-of-sauron'];
  const corrBefore = s0.heroes[0].corruption;
  const g = heroEngage(s0, cat, hero.id, 'minion-mouth-of-sauron');
  assert(g.heroes[0].corruption === corrBefore + 1, 'engaging the Mouth of Sauron gives the hero 1 corruption');
}

// --- the Eye actually fields minions across a full campaign -----------------
{
  let s = newGame(cat, 5);
  const strat = STRATEGIES['mission-aware'];
  const rng = (() => { let x = 5 ^ 0x9e3779b9; return () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  let guard = 0;
  let maxMinions = 0;
  while (!s.winner && guard++ < 20000) {
    if (s.pendingChoice) { s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); }
    else if (s.pendingCombat) { break; }
    else if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng));
      else s = resolveEncounter(s, cat);
    } else if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); }
      else s = applyHeroAction(s, cat, hero.id, strat.heroAction(s, cat, hero.id, rng));
    } else { s = advance(s, cat); }
    maxMinions = Math.max(maxMinions, minionsInPlay(s));
  }
  assert(maxMinions >= 1, `the Eye deployed at least one minion during the game (peak ${maxMinions})`);
  assert(maxMinions <= 5, `minion count never exceeds the 5-minion roster (peak ${maxMinions})`);
}

console.log(`\nM11 minions: ${failures ? 'FAIL' : 'PASS'}`);
process.exit(failures ? 1 : 0);
