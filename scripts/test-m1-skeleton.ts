// M1 acceptance test — headless. Plays a scripted 2-player game with a trivial
// AI for both sides to a terminal state and asserts the milestone criteria:
//  - every phase fires, a hero moves by spending a card, a numeric combat
//    resolves, and the game reports a winner.
// Run: npx tsx scripts/test-m1-skeleton.ts
import { loadCatalog } from '../src/data/loadAssets';
import {
  newGame, advance, heroMove, heroRest, endHeroActions, heroEngage,
  legalMoves, engageableMonsters, resolveChoice,
} from '../src/engine/game';
import type { GameState, Catalog, LocationId } from '../src/engine/types';

function bfsFirstStep(cat: Catalog, from: LocationId, targets: Set<LocationId>): LocationId | null {
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

function bestCombatOption(cat: Catalog, state: GameState): string {
  const opts = state.pendingChoice!.options;
  return [...opts].sort((a, b) =>
    (cat.combatCards[b.id]?.attack ?? 0) - (cat.combatCards[a.id]?.attack ?? 0))[0].id;
}

function run(seed: number): { state: GameState; steps: number } {
  const cat = loadCatalog();
  let state = newGame(cat, seed);
  let steps = 0;
  const CAP = 20000;
  while (!state.winner && steps < CAP) {
    steps++;
    if (state.pendingChoice) { state = resolveChoice(state, cat, bestCombatOption(cat, state)); continue; }
    if (state.pendingCombat) { continue; } // resolved via choices
    if (state.phase === 'HeroActions') {
      const hero = state.heroes[state.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { state = endHeroActions(state, cat); continue; }
      const foes = engageableMonsters(state, hero.id);
      if (foes.length) { state = heroEngage(state, cat, hero.id, foes[0]); continue; }
      const moves = legalMoves(cat, hero);
      if (moves.length) {
        const monsterLocs = new Set<LocationId>(
          Object.entries(state.map.monstersAt).filter(([, m]) => m.length).map(([l]) => l));
        const step = monsterLocs.size ? bfsFirstStep(cat, hero.location, monsterLocs) : null;
        const target = moves.find((m) => m.to === step) ?? moves[0];
        state = heroMove(state, cat, hero.id, target.to);
        continue;
      }
      // no move possible: rest if in a haven, else end turn
      if (cat.locations[hero.location].kind === 'haven' && !hero.restedThisTurn) state = heroRest(state, cat, hero.id);
      else state = endHeroActions(state, cat);
      continue;
    }
    state = advance(state, cat);
  }
  return { state, steps };
}

// ---- assertions ----
declare const process: { exit(code: number): never };
function assert(cond: boolean, msg: string) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } }

const seed = 12345;
const { state, steps } = run(seed);
const types = new Set(state.log.map((e) => e.type));

console.log(`game ended in ${steps} steps, round ${state.round}, winner ${state.winner} (${state.winReason})`);
assert(state.winner !== null, 'game reports a winner');
assert(steps < 20000, 'game terminates within cap');
assert(state.log.some((e) => e.type === 'hero-move'), 'a hero moved by spending a card');
assert(state.log.some((e) => e.type === 'combat-begin'), 'a combat started');
assert(state.log.some((e) => e.type === 'combat-end'), 'a numeric combat resolved');
assert(types.has('phase'), 'phase transitions logged');
assert(state.log.some((e) => e.detail.includes('event step for turn')), 'Sauron events/plots phase fired');

// determinism: same seed => same outcome
const again = run(seed);
assert(again.state.winner === state.winner && again.steps === steps, 'deterministic for a fixed seed');

console.log('M1 acceptance: PASS');
