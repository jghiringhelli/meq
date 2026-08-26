// Evaluate the Sauron side. Lower hero win rate = stronger Sauron.
//   baseline : existing greedy automa (playoutGame, humanSide='Hero')
//   driver   : greedySauron through the interactive-Sauron driver (validates
//              the driver reproduces roughly the automa's strength)
//   ismcts   : ISMCTS Sauron through the same driver
// All three face the SAME hero policy (mission-aware) on identical seeds.
import { loadCatalog } from '../src/data/loadAssets';
import { playoutGame, STRATEGIES } from '../src/engine/heroAI';
import { playoutGameSauron, greedySauron, makeIsmctsSauron, DEFAULT_SAURON_ISMCTS } from '../src/engine/sauronAI';

const cat = loadCatalog();
const iters = Number(process.argv[2] ?? 100);
const nGames = Number(process.argv[3] ?? 16);
const seeds = Array.from({ length: nGames }, (_, i) => (i + 1) * 101 + 7);
const hero = STRATEGIES['mission-aware'];

console.log(`Sauron eval — ${nGames} games, ${iters} ISMCTS iters/decision (hero: mission-aware)\n`);

function report(name: string, run: (seed: number) => 'Hero' | 'Sauron' | null) {
  let heroWins = 0; const t0 = Date.now();
  for (const seed of seeds) if (run(seed) === 'Hero') heroWins++;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${name.padEnd(22)} hero ${heroWins}/${nGames} (${Math.round(100 * heroWins / nGames)}%)  [${secs}s]`);
  return heroWins;
}

const b = report('baseline-automa', (seed) => playoutGame(cat, seed, hero).winner ?? null);
const g = report('driver-greedy', (seed) => playoutGameSauron(cat, seed, greedySauron, hero).winner);
const ismcts = makeIsmctsSauron({ ...DEFAULT_SAURON_ISMCTS, iterations: iters });
const m = report(ismcts.name, (seed) => playoutGameSauron(cat, seed, ismcts, hero).winner);

console.log(`\nHero wins — baseline ${b}, driver-greedy ${g}, ISMCTS ${m} (fewer = stronger Sauron)`);
console.log(`ISMCTS Sauron ${m < b ? 'BEATS' : m === b ? 'ties' : 'trails'} the baseline automa.`);
