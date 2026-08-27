// Per-action invariant validator. Steps full self-play games (heroes = strategy,
// Sauron = Lidless Eye AI) and, AFTER EVERY engine action, asserts the game
// state stays legal and the log only grows. On the first violation it prints the
// seed, step, offending invariant, a compact state snapshot and the tail of the
// log so we can see exactly what produced an illegal state.
//   npx tsx scripts/validate-invariants.ts [seeds] [strategy]
import { loadCatalog } from '../src/data/loadAssets';
import { STRATEGIES, applyHeroAction, mulberry32 } from '../src/engine/heroAI';
import { newGame } from '../src/engine/setup';
import {
  resolveChoice, chooseEncounter, resolveEncounter, encounterPlan,
  advance, endHeroActions, autoResolvePendingTree,
} from '../src/engine/game';
import type { GameState } from '../src/engine/types';

declare const process: { argv: string[]; exit(code: number): never };

const args = process.argv.slice(2);
const nSeeds = Number(args[0]) || 100;
const stratName = args[1] && STRATEGIES[args[1]] ? args[1] : 'mission-aware';
const strat = STRATEGIES[stratName];
const cat = loadCatalog();

const PHASES = new Set(['HeroRefresh', 'HeroActions', 'SauronRefresh', 'SauronEvents', 'SauronMinions', 'StoryAdvance', 'GameOver']);

type Violation = { rule: string; detail: string };

function checkInvariants(s: GameState): Violation | null {
  const bad = (rule: string, detail: string): Violation => ({ rule, detail });
  const num = (v: number) => typeof v === 'number' && Number.isFinite(v);

  if (!PHASES.has(s.phase)) return bad('phase', `illegal phase '${s.phase}'`);
  if (s.winner != null && s.winner !== 'Hero' && s.winner !== 'Sauron') return bad('winner', `illegal winner '${s.winner}'`);
  if (!num(s.sauron.influence) || s.sauron.influence < 0) return bad('influence', `shadow pool = ${s.sauron.influence}`);
  if (!num(s.story.turn) || s.story.turn < 0) return bad('turn', `turn = ${s.story.turn}`);
  if (!num(s.story.sauronProgress) || s.story.sauronProgress < 0) return bad('story', `sauronProgress = ${s.story.sauronProgress}`);

  for (const h of s.heroes) {
    if (!num(h.life) || h.life < 0) return bad('life', `${h.id} life = ${h.life}`);
    if (!num(h.corruption) || h.corruption < 0) return bad('corruption', `${h.id} corruption = ${h.corruption}`);
    if (h.corruption !== h.corruptionCards.length) return bad('corruption-sync', `${h.id} corruption ${h.corruption} != cards ${h.corruptionCards.length}`);
    if (!num(h.favor) || h.favor < 0) return bad('favor', `${h.id} favor = ${h.favor}`);
    if (!num(h.actionsRemaining) || h.actionsRemaining < 0) return bad('actions', `${h.id} actionsRemaining = ${h.actionsRemaining}`);
    if (h.status !== 'active' && h.status !== 'defeated') return bad('status', `${h.id} status '${h.status}'`);
    if (!cat.locations[h.location]) return bad('location', `${h.id} at unknown location '${h.location}'`);
  }
  // A pendingChoice must always offer at least one option (else the player is stuck).
  if (s.pendingChoice && (!s.pendingChoice.options || s.pendingChoice.options.length === 0)) {
    return bad('pending-choice', 'pendingChoice with no options');
  }
  if (s.pendingTree && (!s.pendingTree.options || !s.pendingTree.options.some((o) => o.enabled))) {
    return bad('pending-tree', 'pendingTree with no enabled option');
  }
  return null;
}

function snapshot(s: GameState): string {
  const heroes = s.heroes.map((h) => `${h.id}[${h.status} L${h.life} C${h.corruption} F${h.favor} @${h.location}]`).join(' ');
  return `phase=${s.phase} side=${s.activeSide} turn=${s.story.turn} pool=${s.sauron.influence} pend={${[s.pendingChoice && 'choice', s.pendingCombat && 'combat', s.pendingTree && 'tree', s.pendingEncounter && 'enc'].filter(Boolean).join(',')}} winner=${s.winner ?? '-'}\n  ${heroes}`;
}

function logTail(s: GameState, n = 10): string {
  return s.log.slice(-n).map((e) => `    [${e.type}] ${e.detail ?? ''}`).join('\n');
}

let failures = 0;
let unfinished = 0;
let totalSteps = 0;

for (let i = 0; i < nSeeds; i++) {
  const seed = (i * 2654435761) % 2147483647 || i + 1;
  let s = newGame(cat, seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let prevLogLen = s.log.length;
  let steps = 0;
  const maxSteps = 20000;
  let violated = false;

  try {
    while (!s.winner && steps < maxSteps) {
      steps++;
      // one engine step, mirroring playoutGame's driver
      if (s.pendingChoice) { s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); }
      else if (s.pendingTree) { s = autoResolvePendingTree(s, cat); }
      else if (s.pendingCombat) { /* combat waits on the next choice */ s = advance(s, cat); }
      else if (s.pendingEncounter) {
        const plan = encounterPlan(s, cat);
        if (plan && !plan.complete) s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng));
        else s = resolveEncounter(s, cat);
      } else if (s.phase === 'HeroActions') {
        const hero = s.heroes[s.activeHeroIndex];
        if (hero.status !== 'active' || hero.actionsRemaining <= 0) s = endHeroActions(s, cat);
        else s = applyHeroAction(s, cat, hero.id, strat.heroAction(s, cat, hero.id, rng));
      } else {
        s = advance(s, cat);
      }

      // invariants
      if (s.log.length < prevLogLen) {
        console.error(`\n✗ seed ${seed} step ${steps}: LOG SHRANK ${prevLogLen} -> ${s.log.length}`);
        failures++; violated = true; break;
      }
      prevLogLen = s.log.length;
      const v = checkInvariants(s);
      if (v) {
        console.error(`\n✗ seed ${seed} step ${steps}: [${v.rule}] ${v.detail}`);
        console.error('  ' + snapshot(s));
        console.error(logTail(s));
        failures++; violated = true; break;
      }
    }
  } catch (err) {
    console.error(`\n✗ seed ${seed} step ${steps}: THREW ${(err as Error).message}`);
    console.error('  ' + snapshot(s));
    console.error(logTail(s));
    failures++; violated = true;
  }

  totalSteps += steps;
  if (!violated && !s.winner) { unfinished++; }
}

console.log(`\nvalidate-invariants: ${nSeeds} games, strategy '${stratName}', ${totalSteps} total steps`);
console.log(`  invariant failures: ${failures}`);
console.log(`  unfinished (hit step cap): ${unfinished}`);
if (failures > 0) process.exit(1);
console.log('  ✓ all games stayed legal at every action');
