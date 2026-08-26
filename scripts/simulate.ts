// Batch self-play simulator. Runs each hero strategy across many seeds against
// the Lidless Eye AI and reports win rates + game shape, so we can mine what
// works. Usage:
//   npx tsx scripts/simulate.ts [seeds] [strategy ...]
//   npx tsx scripts/simulate.ts 200           # all strategies, 200 seeds
//   npx tsx scripts/simulate.ts 500 heuristic # one strategy, 500 seeds
import { loadCatalog } from '../src/data/loadAssets';
import { STRATEGIES, playoutGame, type PlayoutResult } from '../src/engine/heroAI';

declare const process: { argv: string[]; exit(code: number): never };

const args = process.argv.slice(2);
const nSeeds = Number(args[0]) || 100;
const names = args.slice(1).filter((a) => STRATEGIES[a]);
const chosen = names.length ? names : Object.keys(STRATEGIES);

const cat = loadCatalog();
const seeds = Array.from({ length: nSeeds }, (_, i) => i * 2654435761 % 2147483647 || i + 1);

function mean(xs: number[]): number { return xs.reduce((a: number, b: number) => a + b, 0) / (xs.length || 1); }

console.log(`\nMiddle-earth Quest — self-play over ${nSeeds} seeds (heroes = strategy, Sauron = Lidless Eye AI)\n`);
const header = ['strategy', 'HeroWin%', 'SauronWin%', 'unfin', 'avgTurns', 'avgBouts', 'peril', 'shadow', 'plot', 'endCorr', 'endFavor'];
console.log(header.map((h, i) => (i ? h.padStart(9) : h.padEnd(13))).join(' '));

for (const name of chosen) {
  const strat = STRATEGIES[name];
  const rs: PlayoutResult[] = seeds.map((sd) => playoutGame(cat, sd, strat));
  const hero = rs.filter((r) => r.winner === 'Hero').length;
  const sauron = rs.filter((r) => r.winner === 'Sauron').length;
  const unfin = rs.filter((r) => r.winner === null).length;
  const row = [
    name.padEnd(13),
    ((100 * hero) / rs.length).toFixed(1).padStart(9),
    ((100 * sauron) / rs.length).toFixed(1).padStart(9),
    String(unfin).padStart(9),
    mean(rs.map((r) => r.turns)).toFixed(1).padStart(9),
    mean(rs.map((r) => r.combatBouts)).toFixed(1).padStart(9),
    mean(rs.map((r) => r.perils)).toFixed(1).padStart(9),
    mean(rs.map((r) => r.shadowPlays)).toFixed(1).padStart(9),
    mean(rs.map((r) => r.plotMoves)).toFixed(1).padStart(9),
    mean(rs.map((r) => r.finalCorruption)).toFixed(1).padStart(9),
    mean(rs.map((r) => r.finalFavor)).toFixed(1).padStart(9),
  ];
  console.log(row.join(' '));
}

// determinism spot-check
const s0 = Object.keys(STRATEGIES)[0];
const a = playoutGame(cat, 12345, STRATEGIES[s0]);
const b = playoutGame(cat, 12345, STRATEGIES[s0]);
console.log(`\ndeterminism: ${a.winner === b.winner && a.steps === b.steps ? 'OK' : 'BROKEN'} (seed 12345, ${s0})`);
