// Eval: does the simulation-based combat solver beat the baseline "engine picks
// best-first" combat play? We hold the MACRO strategy fixed (mission-aware) and
// swap ONLY combatOption, so any delta is attributable to combat card choice.
//
// Usage: npx tsx scripts/eval-combat-solver.ts [nGames] [determinizations]
import { loadCatalog } from '../src/data/loadAssets';
import { playoutGame, missionAware, type HeroStrategy } from '../src/engine/heroAI';
import { makeCombatOption, DEFAULT_WEIGHTS } from '../src/engine/combatSolver';

declare const process: { argv: string[] };
const nGames = parseInt(process.argv[2] ?? '40', 10);
const cat = loadCatalog();

const baseline: HeroStrategy = missionAware;
const solver: HeroStrategy = {
  ...missionAware,
  name: 'mission+solver',
  combatOption: makeCombatOption({ weights: DEFAULT_WEIGHTS }),
};

function run(strat: HeroStrategy): { heroWins: number; corr: number; bouts: number } {
  let heroWins = 0, corr = 0, bouts = 0;
  for (let seed = 1; seed <= nGames; seed++) {
    const r = playoutGame(cat, seed, strat);
    if (r.winner === 'Hero') heroWins++;
    corr += r.finalCorruption;
    bouts += r.combatBouts;
  }
  return { heroWins, corr, bouts };
}

const t0 = Date.now();
const b = run(baseline);
const t1 = Date.now();
const sv = run(solver);
const t2 = Date.now();

const pct = (w: number) => `${((100 * w) / nGames).toFixed(0)}%`;
console.log(`games/side: ${nGames}`);
console.log(`baseline (best-first) : hero wins ${b.heroWins}/${nGames} (${pct(b.heroWins)}) · avg corruption ${(b.corr / nGames).toFixed(2)} · bouts ${b.bouts}  [${((t1 - t0) / 1000).toFixed(1)}s]`);
console.log(`combat solver         : hero wins ${sv.heroWins}/${nGames} (${pct(sv.heroWins)}) · avg corruption ${(sv.corr / nGames).toFixed(2)} · bouts ${sv.bouts}  [${((t2 - t1) / 1000).toFixed(1)}s]`);
