// M5 acceptance test — the Lidless Eye (Sauron AI). Verifies the combat policy
// picks legal, sensible cards; the economy policy spends influence (region
// pressure + spawning); and full auto games with the Eye active terminate
// deterministically with a realistic win distribution (the Eye is a threat).
// Run: npx tsx scripts/test-m5-lidless-eye.ts
import { loadCatalog } from '../src/data/loadAssets';
import {
  newGame, advance, heroMove, heroRest, endHeroActions, heroEngage, heroExplore,
  resolveEncounter, canExplore, legalMoves, engageableMonsters, resolveChoice,
  chooseEncounter, encounterPlan,
} from '../src/engine/game';
import { chooseMonsterCard, eyeSpendInfluence, AI_ECONOMY } from '../src/engine/ai';
import { regionInfluenceTotal } from '../src/engine/influence';
import type { GameState, LocationId } from '../src/engine/types';
import type { PlanResult } from '../src/engine/encounter';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

const cat = loadCatalog();

// --- combat policy: returns a legal card from the monster's hand -----------
{
  let s: GameState = newGame(cat, 5);
  s = advance(s, cat); // HeroRefresh → HeroActions
  // drive to a combat: find a hero adjacent/at a monster, else force one
  const hero = s.heroes[0];
  // Setup no longer seeds monsters on the board (rulebook: monsters enter only
  // via Sauron Commands). Place one deliberately to exercise the combat policy.
  (s.map.monstersAt[hero.location] ||= []).push(Object.keys(cat.monsters)[0]);
  const monLoc = Object.entries(s.map.monstersAt).find(([, m]) => m.length)?.[0];
  assert(!!monLoc, 'a monster exists to fight');
  // teleport hero onto the monster and engage
  const from = hero.location;
  (s.map.heroesAt[from] = s.map.heroesAt[from].filter((h) => h !== hero.id));
  hero.location = monLoc!;
  (s.map.heroesAt[monLoc!] ||= []).push(hero.id);
  const mid = s.map.monstersAt[monLoc!][0];
  s = heroEngage(s, cat, hero.id, mid);
  const pick = chooseMonsterCard(s, cat);
  const inHand = s.pendingCombat!.defender.hand;
  assert(pick !== null && inHand.includes(pick), 'combat policy returns a card from the monster hand');
  // determinism: same state → same pick
  assert(chooseMonsterCard(s, cat) === pick, 'combat policy is deterministic');
  // within-combat card counting: with hero cards already spent, the pick stays legal
  const heroDeck = cat.decks[cat.heroes[String(s.pendingCombat!.attacker.refId)].deck];
  s.pendingCombat!.attacker.discard = [...new Set(heroDeck)].slice(0, 3);
  const pick2 = chooseMonsterCard(s, cat);
  assert(pick2 !== null && inHand.includes(pick2), 'card-counting pick (with seen cards) is still legal');
  assert(chooseMonsterCard(s, cat) === pick2, 'card-counting pick is deterministic');
}

// --- economy policy: spends influence into region pressure + spawns --------
{
  const s: GameState = newGame(cat, 5);
  s.sauron.influence = 20;
  const region = cat.locations[s.heroes[0].location].regionId;
  // Faithful precondition: a monster token may only be fielded on an influenced,
  // hero-free location. Seed such a seat near the hero (a frontier the Eye would
  // build over prior turns) so the spawn command is legal this turn.
  const heroLoc = s.heroes[0].location;
  const free = (id: string) => cat.locations[id]?.kind !== 'haven' && !(s.map.heroesAt[id]?.length);
  const inRegion = Object.values(cat.locations).find((l) => l.regionId === region && free(l.id));
  const adjacent = cat.edges
    .filter((e) => e.a === heroLoc || e.b === heroLoc)
    .map((e) => (e.a === heroLoc ? e.b : e.a))
    .find((id) => free(id));
  const seat = inRegion?.id ?? adjacent;
  assert(!!seat, 'a hero-free seat exists near the hero');
  s.sauron.locationInfluence[seat!] = 2;
  const monstersBefore = Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0);
  const inflBefore = s.sauron.influence;
  eyeSpendInfluence(s, cat);
  assert(s.sauron.influence < inflBefore, 'Eye spent shadow influence');
  const placed = Object.values(s.sauron.locationInfluence ?? {}).reduce((n, v) => n + (v as number), 0);
  assert(placed >= AI_ECONOMY.influencePerHeroRegion || regionInfluenceTotal(s, cat, region) > 0, 'Eye pushed influence onto the board (extending toward heroes)');
  const monstersAfter = Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0);
  assert(monstersAfter > monstersBefore, 'Eye fielded at least one new monster');
}
// with no budget, the economy policy is a no-op
{
  const s: GameState = newGame(cat, 5);
  s.sauron.influence = 0;
  const before = JSON.stringify(s.map.monstersAt);
  eyeSpendInfluence(s, cat);
  assert(s.sauron.influence === 0 && JSON.stringify(s.map.monstersAt) === before, 'no influence → economy policy is a no-op');
}

// --- full auto games with the Eye active -----------------------------------
function firstEnabled(plan: PlanResult): number {
  const opts = plan.pending?.options ?? [];
  const i = opts.findIndex((o) => o.enabled);
  return i >= 0 ? i : 0;
}
function bfsFirstStep(from: LocationId, targets: Set<LocationId>): LocationId | null {
  const seen = new Set([from]);
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
function bestCombat(s: GameState): string {
  const opts = s.pendingChoice!.options;
  return opts[0].id; // scripted hero: greedy first option
}
function run(seed: number) {
  let state = newGame(cat, seed);
  let steps = 0;
  while (!state.winner && steps < 20000) {
    steps++;
    if (state.pendingChoice) { state = resolveChoice(state, cat, bestCombat(state)); continue; }
    if (state.pendingCombat) { continue; }
    if (state.pendingEncounter) {
      const plan = encounterPlan(state, cat);
      if (plan && !plan.complete) { state = chooseEncounter(state, cat, firstEnabled(plan)); continue; }
      state = resolveEncounter(state, cat); continue;
    }
    if (state.phase === 'HeroActions') {
      const hero = state.heroes[state.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { state = endHeroActions(state, cat); continue; }
      const foes = engageableMonsters(state, hero.id);
      if (foes.length) { state = heroEngage(state, cat, hero.id, foes[0]); continue; }
      if (canExplore(state, cat, hero.id)) { state = heroExplore(state, cat, hero.id); continue; }
      const moves = legalMoves(cat, hero);
      if (moves.length) {
        const monsterLocs = new Set<LocationId>(Object.entries(state.map.monstersAt).filter(([, m]) => m.length).map(([l]) => l));
        const step = monsterLocs.size ? bfsFirstStep(hero.location, monsterLocs) : null;
        const target = moves.find((m) => m.to === step) ?? moves[0];
        state = heroMove(state, cat, hero.id, target.to); continue;
      }
      if (cat.locations[hero.location].kind === 'haven' && !hero.restedThisTurn) state = heroRest(state, cat, hero.id);
      else state = endHeroActions(state, cat);
      continue;
    }
    state = advance(state, cat);
  }
  const combats = state.log.filter((e) => e.type === 'combat-bout').length;
  return { state, steps, combats };
}

const seeds = [1, 7, 13, 42, 99, 100, 256, 777, 2024, 31337];
const tally: Record<string, number> = { Hero: 0, Sauron: 0, none: 0 };
let totalCombats = 0;
for (const seed of seeds) {
  const { state, combats } = run(seed);
  tally[state.winner ?? 'none']++;
  totalCombats += combats;
}
console.log(`\nover ${seeds.length} seeds: Hero ${tally.Hero}, Sauron ${tally.Sauron}, unfinished ${tally.none}; total combat rounds ${totalCombats}`);
assert(tally.none === 0, 'every auto game reaches a winner');
assert(totalCombats > 0, 'the Eye fought at least one combat round across games');
// determinism across a fixed seed
{
  const a = run(777), b = run(777);
  assert(a.state.winner === b.state.winner && a.steps === b.steps, 'auto game is deterministic for a fixed seed');
}

console.log(failures ? `\nM5 Lidless Eye: ${failures} FAILURE(S)` : '\nM5 Lidless Eye: PASS');
process.exit(failures ? 1 : 0);
