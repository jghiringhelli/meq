// E2E coverage + invariant simulation harness.
//
// Runs full headless self-play games across ALL hero combinations (party sizes
// 1..3), with the hero AI driving heroes and the Lidless Eye driving Sauron.
// After EVERY engine transition it runs `checkInvariants` — any inconsistent
// state fails the run. It also accumulates content coverage (which combat
// cards, encounters, plots, shadow cards, events, corruption, skills actually
// fired) and reports per-side AI performance.
//
// Run: npx tsx scripts/test-e2e-coverage.ts
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/setup';
import {
  advance, endHeroActions, resolveEncounter, chooseEncounter, encounterPlan,
} from '../src/engine/phases';
import { resolveChoice } from '../src/engine/game';
import { STRATEGIES, applyHeroAction, mulberry32 } from '../src/engine/heroAI';
import { checkInvariants } from '../src/engine/invariants';
import type { GameState, HeroId } from '../src/engine/types';

declare const process: { exit(code: number): never; argv: string[] };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

const cat = loadCatalog();
const strat = STRATEGIES['mission-aware'];

// ---- coverage accumulators ----
const cov = {
  combat: new Set<string>(),
  encounters: new Set<string>(),
  plots: new Set<string>(),
  shadow: new Set<string>(),
  events: new Set<string>(),
  corruptionEvents: 0,
  skillPlays: new Set<string>(),      // advanced/trained cards revealed in combat
  trainedHeroes: new Set<string>(),   // heroes that gained training/levels
  minionsDeployed: new Set<string>(),
  monstersPlaced: new Set<string>(),
  regionsInfluenced: new Set<string>(),
};
const ADVANCED = new Set(['adv-strength', 'adv-agility', 'advanced-strength', 'advanced-agility']);

let invariantViolations: string[] = [];
let statesChecked = 0;

/** Fold coverage from the newest log entries + current state into `cov`. */
function harvest(prevSeq: number, s: GameState): number {
  for (let i = prevSeq; i < s.log.length; i++) {
    const e = s.log[i];
    const d = e.data as Record<string, unknown> | undefined;
    if (e.type === 'combat-bout' && d) {
      for (const k of ['attackerCard', 'defenderCard'] as const) {
        const c = d[k] as string | undefined;
        if (c) { cov.combat.add(c); if (ADVANCED.has(c) || cat.combatCards[c]?.deck?.includes('advanced')) cov.skillPlays.add(c); }
      }
    }
    if (e.type === 'encounter-draw' && d?.cardId) cov.encounters.add(d.cardId as string);
  }
  // state-derived coverage (ids that live in the state)
  for (const p of s.sauron.activePlots ?? []) cov.plots.add(p.eventId);
  for (const p of s.sauron.activeEvents ?? []) cov.events.add(p.eventId);
  for (const c of s.sauron.shadowDiscard ?? []) cov.shadow.add(c);
  for (const c of s.sauron.eventDiscard ?? []) cov.events.add(c);
  for (const [loc, n] of Object.entries(s.sauron.locationInfluence ?? {})) if ((n as number) > 0) cov.regionsInfluenced.add(cat.locations[loc]?.regionId ?? loc);
  for (const ids of Object.values(s.map.minionsAt ?? {})) for (const m of ids) cov.minionsDeployed.add(m);
  for (const ids of Object.values(s.map.monstersAt ?? {})) for (const m of ids) cov.monstersPlaced.add(m);
  for (const h of s.heroes) { if ((h.training ?? 0) > 0 || h.trainedCount > 0) cov.trainedHeroes.add(h.id); }
  return s.log.length;
}

interface RunResult { winner: string; turns: number; bouts: number; corruption: number; }

/** Drive one full game with invariant checks after every transition. */
function runGame(heroIds: HeroId[], seed: number): RunResult {
  let s = newGame(cat, seed, heroIds);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let steps = 0, prevSeq = 0;
  let prevCorruption = s.heroes.reduce((n, h) => n + h.corruption, 0);

  const check = () => {
    statesChecked++;
    if (invariantViolations.length < 12) {
      const vs = checkInvariants(s, cat);
      for (const msg of vs) invariantViolations.push(`[${heroIds.join('+')}#${seed} @step${steps} ${s.phase}] ${msg}`);
    }
    prevSeq = harvest(prevSeq, s);
    const cur = s.heroes.reduce((n, h) => n + h.corruption, 0);
    if (cur > prevCorruption) cov.corruptionEvents += cur - prevCorruption;
    prevCorruption = cur;
  };

  check();
  while (!s.winner && steps < 20000) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); check(); continue; }
    if (s.pendingCombat) { check(); break; } // combat left dangling => engine bug; caught by invariant loop guard
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng)); check(); continue; }
      s = resolveEncounter(s, cat); check(); continue;
    }
    if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); check(); continue; }
      s = applyHeroAction(s, cat, hero.id, strat.heroAction(s, cat, hero.id, rng));
      check();
      continue;
    }
    s = advance(s, cat);
    check();
  }
  return {
    winner: s.winner ?? 'unfinished',
    turns: s.story.turn,
    bouts: s.log.filter((e) => e.type === 'combat-bout').length,
    corruption: s.heroes.reduce((n, h) => n + h.corruption, 0),
  };
}

// ---- enumerate all hero combinations of size 1..3 ----
const heroIds = Object.keys(cat.heroes) as HeroId[];
function combos<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const [head, ...tail] = arr;
  return [...combos(tail, k - 1).map((c) => [head, ...c]), ...combos(tail, k)];
}
const allCombos: HeroId[][] = [1, 2, 3].flatMap((k) => combos(heroIds, k));
const SEEDS = (process.argv.includes('--fast') ? [1, 7] : [1, 7, 13, 42]);

console.log(`Simulating ${allCombos.length} hero combos x ${SEEDS.length} seeds = ${allCombos.length * SEEDS.length} games...\n`);

const tally: Record<string, number> = { Hero: 0, Sauron: 0, unfinished: 0 };
let totTurns = 0, totBouts = 0, games = 0;
const perSize: Record<number, { hero: number; sauron: number; n: number }> = {};

for (const ids of allCombos) {
  for (const seed of SEEDS) {
    const r = runGame(ids, seed);
    tally[r.winner] = (tally[r.winner] ?? 0) + 1;
    totTurns += r.turns; totBouts += r.bouts; games++;
    const size = ids.length;
    (perSize[size] ||= { hero: 0, sauron: 0, n: 0 });
    perSize[size].n++;
    if (r.winner === 'Hero') perSize[size].hero++;
    if (r.winner === 'Sauron') perSize[size].sauron++;
  }
}

// ---- report ----
console.log(`\n=== Invariants ===`);
console.log(`states checked: ${statesChecked}`);
if (invariantViolations.length) {
  console.log(`VIOLATIONS (first ${invariantViolations.length}):`);
  for (const m of invariantViolations) console.log('  -', m);
}
assert(invariantViolations.length === 0, 'no invariant violations across all games');

const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
console.log(`\n=== Content coverage ===`);
console.log(`combat cards : ${pct(cov.combat.size, Object.keys(cat.combatCards).length)}`);
console.log(`encounters   : ${pct(cov.encounters.size, Object.keys(cat.encounters).length)}`);
console.log(`plots        : ${pct(cov.plots.size, cat.plots.length)}`);
console.log(`shadow cards : ${pct(cov.shadow.size, Object.keys(cat.shadow).length)}`);
console.log(`events (deck): ${pct(cov.events.size, cat.events.length)}`);
console.log(`minions      : ${pct(cov.minionsDeployed.size, Object.keys(cat.minions).length)}`);
console.log(`monsters     : ${pct(cov.monstersPlaced.size, Object.keys(cat.monsters).length)}`);
console.log(`regions infl.: ${pct(cov.regionsInfluenced.size, Object.keys(cat.monsterBags).length)}`);
console.log(`corruption fired: ${cov.corruptionEvents} cards; heroes trained: ${cov.trainedHeroes.size}; skill plays: ${cov.skillPlays.size}`);

const missCombat = Object.keys(cat.combatCards).filter((c) => !cov.combat.has(c));
if (missCombat.length) console.log(`  untriggered combat cards (${missCombat.length}): ${missCombat.slice(0, 40).join(', ')}`);
const missEnc = Object.keys(cat.encounters).filter((c) => !cov.encounters.has(c));
if (missEnc.length) console.log(`  untriggered encounters (${missEnc.length})`);

console.log(`\n=== AI performance (mission-aware heroes vs Lidless Eye) ===`);
console.log(`games ${games}: Hero ${tally.Hero}, Sauron ${tally.Sauron}, unfinished ${tally.unfinished}`);
console.log(`avg turns ${(totTurns / games).toFixed(1)}, avg combat bouts ${(totBouts / games).toFixed(1)}`);
for (const size of Object.keys(perSize).map(Number).sort()) {
  const p = perSize[size];
  console.log(`  ${size}-hero: Hero ${pct(p.hero, p.n)}  Sauron ${pct(p.sauron, p.n)}`);
}

// ---- hard assertions (correctness / consistency) ----
assert(tally.unfinished === 0, 'every game reaches a decisive winner');
assert(cov.combat.size / Object.keys(cat.combatCards).length >= 0.75, 'combat-card coverage >= 75%');
assert(cov.plots.size > 0, 'plots fire');
assert(cov.shadow.size > 0, 'shadow cards fire');
assert(cov.corruptionEvents > 0, 'corruption is dealt');
assert(cov.minionsDeployed.size > 0, 'minions deploy');
assert(cov.monstersPlaced.size > 0, 'monsters are placed');

// ---- reported metrics (measurement, not pass/fail) ----
console.log(`\n=== Balance / gaps (measured, not gated) ===`);
const heroWinRate = tally.Hero / games;
console.log(`hero win rate: ${(100 * heroWinRate).toFixed(0)}%  ${heroWinRate === 0 ? '⚠ heroes never win — hero AI needs tuning (feat-hero-ai-improve)' : ''}`);
if (cov.encounters.size === 0) console.log(`⚠ encounters never fired in self-play (heroes die before exploring); encounter *resolution* is covered by test-m4.`);

console.log(failures ? `\nE2E coverage: ${failures} FAILURE(S)` : '\nE2E coverage: PASS');
process.exit(failures ? 1 : 0);
