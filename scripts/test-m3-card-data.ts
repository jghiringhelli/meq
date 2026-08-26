// M3 acceptance test — real card data & missions. Verifies the catalog loads
// all encounter/event/mission data, the mission predicates and non-combat ops
// behave, and a full game plays with heroes exploring real encounters to a
// mission-decided terminal state.
// Run: npx tsx scripts/test-m3-card-data.ts
import { loadCatalog } from '../src/data/loadAssets';
import {
  newGame, advance, heroMove, heroRest, endHeroActions, heroEngage, heroExplore,
  resolveEncounter, canExplore, legalMoves, engageableMonsters, resolveChoice, checkWin,
  chooseEncounter, encounterPlan,
} from '../src/engine/game';
import { evalMission } from '../src/engine/missions';
import { applyOps } from '../src/engine/noncombat';
import type { GameState, LocationId } from '../src/engine/types';
import type { PlanResult } from '../src/engine/encounter';

declare const process: { exit(code: number): never };
function firstEnabled(plan: PlanResult): number {
  const opts = plan.pending?.options ?? [];
  const i = opts.findIndex((o) => o.enabled);
  return i >= 0 ? i : 0;
}
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

const cat = loadCatalog();

// ---- data presence ----
assert(Object.keys(cat.encounters).length === 90, '90 encounter cards loaded');
assert(cat.events.length === 42, '42 event cards loaded');
assert(Object.keys(cat.heroMissions).length === 5 && Object.keys(cat.sauronMissions).length === 5, '5+5 missions loaded');
const withDeck = Object.values(cat.locations).filter((l) => l.encounterDeck.length).length;
assert(withDeck === Object.keys(cat.locations).length, 'every rendered location has an encounter deck');
assert(cat.heroMissions[cat.scenario.heroMission]?.condition != null, 'scenario hero mission carries a condition');

// ---- mission predicate unit tests ----
function baseState(): GameState { return newGame(cat, 1); }
{
  const s = baseState();
  s.heroes.forEach((h) => { h.corruption = 0; });
  assert(evalMission({ kind: 'heroCorruptionAtMost', n: 1 }, s, cat) === true, 'corruption<=1 true at 0 total');
  s.heroes[0].corruption = 3;
  assert(evalMission({ kind: 'heroCorruptionAtMost', n: 1 }, s, cat) === false, 'corruption<=1 false at 3');
  s.heroes.forEach((h, i) => { h.favor = i === 0 ? 5 : 1; });
  assert(evalMission({ kind: 'heroFavorAtLeast', n: 5 }, s, cat) === true, 'favor>=5 true at total 6');
  assert(evalMission({ kind: 'activePlotsAtLeast', n: 3 }, { ...s, sauron: { ...s.sauron, activePlots: [{ eventId: 'a', step: 0 }, { eventId: 'b', step: 0 }, { eventId: 'c', step: 0 }] } } as GameState, cat) === true, 'plots>=3 true');
}

// ---- non-combat op unit tests ----
{
  const s = baseState();
  const h = s.heroes[0];
  h.favor = 0; h.corruption = 2; s.sauron.influence = 5;
  applyOps(s, cat, h.id, [{ op: 'gainFavor', n: 2 }, { op: 'removeCorruption', n: 1 }], 'unit');
  assert(h.favor === 2 && h.corruption === 1, 'gainFavor + removeCorruption applied');
  applyOps(s, cat, h.id, [{ op: 'loseFavor', n: 5 }], 'unit');
  assert(h.favor === 0, 'loseFavor clamps at 0');
  applyOps(s, cat, null, [{ op: 'addInfluence', n: 3 }, { op: 'removeInfluence', n: 1 }], 'unit');
  assert(s.sauron.influence === 7, 'influence ops applied globally (5+3-1)');
  const maxLife = cat.heroes[h.id].fortitude;
  h.life = maxLife;
  const beforeDamage = h.deck.length;
  applyOps(s, cat, h.id, [{ op: 'damage', n: 2 }], 'unit');
  assert(h.life === beforeDamage - 2, 'damage op reduces life');
}

// ---- full game with exploration ----
function bfsFirstStep(from: LocationId, targets: Set<LocationId>): LocationId | null {
  if (targets.has(from)) return from;
  const seen = new Set<LocationId>([from]);
  let frontier: { id: LocationId; first: LocationId | null }[] = [{ id: from, first: null }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const n of frontier) {
      if (targets.has(n.id) && n.first) return n.first;
      for (const e of cat.edges) {
        const nb = e.a === n.id ? e.b : e.b === n.id ? e.a : null;
        if (nb && !seen.has(nb)) { seen.add(nb); next.push({ id: nb, first: n.first ?? nb }); }
      }
    }
    frontier = next;
  }
  return null;
}
function bestCombat(state: GameState): string {
  return [...state.pendingChoice!.options].sort((a, b) =>
    (cat.combatCards[b.id]?.attack ?? 0) - (cat.combatCards[a.id]?.attack ?? 0))[0].id;
}

function run(seed: number): { state: GameState; encounters: number; steps: number } {
  let state = newGame(cat, seed);
  let steps = 0, encounters = 0;
  const CAP = 20000;
  while (!state.winner && steps < CAP) {
    steps++;
    if (state.pendingChoice) { state = resolveChoice(state, cat, bestCombat(state)); continue; }
    if (state.pendingCombat) continue;
    if (state.pendingEncounter) {
      const plan = encounterPlan(state, cat);
      if (plan && !plan.complete) { state = chooseEncounter(state, cat, firstEnabled(plan)); continue; }
      state = resolveEncounter(state, cat); encounters++; continue;
    }
    if (state.phase === 'HeroActions') {
      const hero = state.heroes[state.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { state = endHeroActions(state, cat); continue; }
      const foes = engageableMonsters(state, hero.id);
      if (foes.length) { state = heroEngage(state, cat, hero.id, foes[0]); continue; }
      if (canExplore(state, cat, hero.id)) { state = heroExplore(state, cat, hero.id); continue; }
      const moves = legalMoves(cat, hero);
      if (moves.length) {
        const monsterLocs = new Set<LocationId>(
          Object.entries(state.map.monstersAt).filter(([, m]) => m.length).map(([l]) => l));
        const step = monsterLocs.size ? bfsFirstStep(hero.location, monsterLocs) : null;
        const target = moves.find((m) => m.to === step) ?? moves[0];
        state = heroMove(state, cat, hero.id, target.to);
        continue;
      }
      if (cat.locations[hero.location].kind === 'haven' && !hero.restedThisTurn) state = heroRest(state, cat, hero.id);
      else state = endHeroActions(state, cat);
      continue;
    }
    state = advance(state, cat);
  }
  return { state, encounters, steps };
}

const { state, encounters, steps } = run(777);
console.log(`\ngame ended in ${steps} steps, round ${state.round}, winner ${state.winner} (${state.winReason}); ${encounters} encounters resolved`);
assert(state.winner !== null, 'game reports a winner');
assert(encounters > 0, 'at least one real encounter resolved during play');
assert(state.log.some((e) => e.type === 'encounter-draw'), 'encounter draw logged');
assert(/mission|monsters|heroes lost|Sauron prevails|Finale|Shadow/i.test(state.winReason), 'win decided by a mission/terminal rule');

// determinism
const again = run(777);
assert(again.state.winner === state.winner && again.steps === steps, 'deterministic for a fixed seed');

// checkWin never fires on a fresh game (missions gated to story end / board state)
assert(checkWin(newGame(cat, 5), cat) === null, 'no premature win on a fresh game');

if (failures) { console.error(`\nM3 card-data: ${failures} FAILURE(S)`); process.exit(1); }
console.log('\nM3 card-data: PASS');
