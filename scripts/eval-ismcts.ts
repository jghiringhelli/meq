// Compare hero ISMCTS against the mission-aware heuristic on identical seeds.
import { loadCatalog } from '../src/data/loadAssets';
import { playoutGame, STRATEGIES } from '../src/engine/heroAI';
import { makeIsmctsStrategy, DEFAULT_ISMCTS } from '../src/engine/ismcts';

const cat = loadCatalog();
const iters = Number(process.argv[2] ?? 100);
const nGames = Number(process.argv[3] ?? 24);
const seeds = Array.from({ length: nGames }, (_, i) => (i + 1) * 101 + 7);

const ismcts = makeIsmctsStrategy({ ...DEFAULT_ISMCTS, iterations: iters });
const base = STRATEGIES['mission-aware'];

function tally(name: string, strat: typeof base) {
  let hero = 0, turns = 0; const t0 = Date.now();
  for (const seed of seeds) {
    const r = playoutGame(cat, seed, strat);
    if (r.winner === 'Hero') hero++;
    turns += r.turns;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${name.padEnd(16)} hero ${hero}/${nGames} (${Math.round(100 * hero / nGames)}%)  avg turns ${(turns / nGames).toFixed(1)}  [${secs}s]`);
  return hero;
}

console.log(`ISMCTS eval — ${nGames} games, ${iters} iterations/decision\n`);
const b = tally('mission-aware', base);
const m = tally(ismcts.name, ismcts);
console.log(`\nISMCTS ${m > b ? 'BEATS' : m === b ? 'ties' : 'trails'} mission-aware: ${b} -> ${m} hero wins`);
