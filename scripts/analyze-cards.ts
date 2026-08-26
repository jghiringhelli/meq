// Card coverage + health analyzer. Answers two questions:
//   (1) STATIC  — is every card's mechanical effect actually modeled, or is it
//                 empty / only partially parsed?
//   (2) DYNAMIC — across many simulated games (full audit logs), which cards
//                 actually fire, and do they produce an effect or a no-op?
// Usage: npx tsx scripts/analyze-cards.ts [games]
import { loadCatalog } from '../src/data/loadAssets';
import { EFFECTS } from '../src/engine/effects';
import { STRATEGIES } from '../src/engine/heroAI';
import { newGame } from '../src/engine/setup';
import {
  advance, heroMove, heroRest, heroExplore, endHeroActions, heroEngage,
  encounterPlan, resolveChoice, resolveEncounter, chooseEncounter,
} from '../src/engine/game';
import { mulberry32 } from '../src/engine/heroAI';
import type { GameState, LogEvent } from '../src/engine/types';

declare const process: { argv: string[]; exit(code: number): never };
const nGames = Number(process.argv[2]) || 300;
const cat = loadCatalog();

// ------------------------------------------------------------------ STATIC
console.log('\n=== STATIC implementation report ===\n');

// combat cards: every effectKey must resolve to a registered spec
{
  const cards = Object.values(cat.combatCards);
  const bad = cards.filter((c) => c.effectKey && !EFFECTS[c.effectKey]);
  const keys = new Set(cards.map((c) => c.effectKey).filter(Boolean));
  console.log(`combat cards : ${cards.length} cards, ${keys.size} distinct effectKeys, `
    + `${bad.length} unregistered → ${bad.length ? 'FAIL' : 'all keys modeled ✅'}`);
  if (bad.length) for (const c of bad) console.log(`   ✗ ${c.id} (${c.name}) key='${c.effectKey}'`);
}

function report<T extends { id: string; name: string }>(
  label: string, items: T[], isModeled: (x: T) => boolean, isPartial: (x: T) => boolean,
): void {
  const empty = items.filter((x) => !isModeled(x));
  const partial = items.filter((x) => isModeled(x) && isPartial(x));
  const full = items.length - empty.length - partial.length;
  console.log(`${label.padEnd(13)}: ${items.length} cards — ${full} full ✅, ${partial.length} partial ◐, ${empty.length} empty ✗`);
  if (empty.length) console.log(`   empty  : ${empty.map((x) => x.name).join(', ')}`);
  if (partial.length) console.log(`   partial: ${partial.map((x) => x.name).slice(0, 40).join(', ')}${partial.length > 40 ? ' …' : ''}`);
}

const treeModeled = (t: { tree?: { k?: string } }) => !!t.tree && t.tree.k !== 'none';
report('encounters', Object.values(cat.encounters), treeModeled, (x) => !!x.partial);
report('perils', Object.values(cat.perils), treeModeled, (x) => !!x.partial);
report('shadow', Object.values(cat.shadow), treeModeled, (x) => !!x.partial);
{
  const ev = cat.events.map((e) => ({ id: e.id, name: e.name, ops: e.ops }));
  report('events', ev, (x) => !!x.ops && x.ops.length > 0, () => false);
}
{
  const plots = cat.plots.map((p) => ({ id: p.id, name: p.name, real: !!p.rulesText }));
  report('plots', plots, (x) => x.real, () => false);
}

// ----------------------------------------------------------------- DYNAMIC
console.log(`\n=== DYNAMIC exercise report (${nGames} games, heuristic heroes) ===\n`);

// A driver that returns the full log so we can mine it.
function playoutLog(seed: number): LogEvent[] {
  const strat = STRATEGIES.heuristic;
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let s: GameState = newGame(cat, seed);
  let steps = 0;
  while (!s.winner && steps < 20000) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); continue; }
    if (s.pendingCombat) continue;
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      const a = strat.heroAction(s, cat, hero.id, rng);
      if (a.kind === 'engage') s = heroEngage(s, cat, hero.id, a.monsterId);
      else if (a.kind === 'explore') s = heroExplore(s, cat, hero.id);
      else if (a.kind === 'move') s = heroMove(s, cat, hero.id, a.to);
      else if (a.kind === 'rest') s = heroRest(s, cat, hero.id);
      else s = endHeroActions(s, cat);
      continue;
    }
    s = advance(s, cat);
  }
  return s.log;
}

// aggregate across games
const combatCardPlays = new Map<string, number>();      // card name → times revealed
const effectFires = new Map<string, { hits: number; noop: number }>(); // "peril X" → counts
let bouts = 0;

function bump(map: Map<string, { hits: number; noop: number }>, key: string, noop: boolean) {
  const e = map.get(key) ?? { hits: 0, noop: 0 };
  e.hits++; if (noop) e.noop++; map.set(key, e);
}

for (let i = 0; i < nGames; i++) {
  const log = playoutLog(i * 7919 + 1);
  for (const e of log) {
    if (e.type === 'combat-bout') {
      bouts++;
      // "r1: <A> deals X (def N); <B> deals Y (atk M)"
      for (const m of e.detail.matchAll(/(?:r\d+:\s|;\s)([^;]+?) deals/g)) {
        const name = m[1].trim();
        if (name && name !== 'no card') combatCardPlays.set(name, (combatCardPlays.get(name) ?? 0) + 1);
      }
    } else if (e.type === 'effect') {
      // "<source>: <tags>"  where tags === '(no effect)' when inert
      const idx = e.detail.indexOf(': ');
      if (idx < 0) continue;
      const source = e.detail.slice(0, idx);
      const noop = e.detail.slice(idx + 2).trim() === '(no effect)';
      const category = source.split(' ')[0]; // peril / shadow / encounter
      bump(effectFires, `${category}|${source}`, noop);
    }
  }
}

// combat-card coverage
{
  const played = new Set([...combatCardPlays.keys()]);
  const allNames = new Set(Object.values(cat.combatCards).map((c) => c.name));
  const unseen = [...allNames].filter((n) => !played.has(n));
  console.log(`combat cards : ${played.size}/${allNames.size} distinct cards played across ${bouts} bouts`);
  if (unseen.length) console.log(`   never played (unreachable in these games): ${unseen.length} — ${unseen.slice(0, 25).join(', ')}${unseen.length > 25 ? ' …' : ''}`);
}

// effect-source coverage by category
for (const cat0 of ['encounter', 'peril', 'shadow', 'plot', 'event']) {
  const rows = [...effectFires.entries()].filter(([k]) => k.startsWith(`${cat0}|`));
  if (!rows.length) { console.log(`${cat0.padEnd(9)}   : (none fired)`); continue; }
  const total = rows.reduce((n, [, v]) => n + v.hits, 0);
  const noops = rows.filter(([, v]) => v.hits === v.noop); // fired but ALWAYS inert
  console.log(`${cat0.padEnd(9)}   : ${rows.length} distinct sources fired (${total} times); ${noops.length} always-inert`);
  if (noops.length) console.log(`   always no-effect: ${noops.map(([k]) => k.split('|')[1]).slice(0, 20).join(', ')}`);
}

console.log('\n(Notes: "partial" = mechanical core applied, complex conditional text not yet fully'
  + '\n parsed. Encounters are drawn highest-priority-first per location, so many are unreachable'
  + '\n in normal play — static modeling, not dynamic firing, is the coverage measure for those.)');
