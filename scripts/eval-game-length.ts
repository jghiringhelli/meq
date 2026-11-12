// Game-length probe (not part of `npm test`): human Sauron plays the highest-
// advance affordable plot every turn, banks influence / draws plots, against the
// hero AI. Prints how many turns each game lasts and who wins.
//   node --import tsx scripts/eval-game-length.ts
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/setup';
import {
  sauronStoryStep, sauronResolveEvents, sauronEndActionStep, sauronBeginAction,
  sauronPlaceInfluence, sauronPlayPlot, playablePlots, autoResolvePendingTree,
} from '../src/engine/game';
import { resolveShadowReaction, sauronCombatPlaceInfluence } from '../src/engine/combat';
import { resolveChoice } from '../src/engine/game';
import { resolveCombatOrPeril } from '../src/engine/phases';
import { advanceHeroSide, missionAware, mulberry32 } from '../src/engine/heroAI';
import type { GameState, Catalog } from '../src/engine/types';

function sauronTurn(s: GameState, cat: Catalog): GameState {
  if (s.phase === 'SauronRefresh') s = sauronStoryStep(s, cat);
  if (s.phase === 'SauronEvents') {
    const plots = playablePlots(s, cat).sort((a, b) => (b.advance ?? 1) - (a.advance ?? 1));
    if (plots.length) s = sauronPlayPlot(s, cat, plots[0].id);
    s = sauronResolveEvents(s, cat);
    s = autoResolvePendingTree(s, cat);
  }
  for (let g = 0; s.phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) > 0 && g < 12; g++) {
    const before = s.sauronActionsLeft;
    const needPlots = (s.sauron.plotHand ?? []).length < 2;
    s = sauronBeginAction(s, cat, needPlots ? 'draw' : 'influence');
    if (s.sauronActionsLeft === before) s = sauronBeginAction(s, cat, 'influence');
    for (const loc of Object.keys(cat.locations)) {
      if (!s.sauronPending) break;
      s = sauronPlaceInfluence(s, cat, loc);
    }
    if (s.sauronPending) s.sauronPending = undefined; // nothing legal left to place
    if (s.sauronActionsLeft === before) break;
  }
  if (s.phase === 'SauronMinions') s = sauronEndActionStep(s, cat);
  return s;
}

// Sauron's reactive decisions during the hero phase: take the simplest legal option.
function sauronReact(s: GameState, cat: Catalog): GameState {
  if (s.sauronCombatInfluence) {
    for (const loc of Object.keys(cat.locations)) {
      const n = sauronCombatPlaceInfluence(s, cat, loc);
      if (n !== s) return n;
    }
    s.sauronCombatInfluence = undefined; return s;
  }
  if (s.pendingChoice?.seat === 'sauron') return resolveChoice(s, cat, s.pendingChoice.options[0].id);
  if (s.pendingShadowReaction) return resolveShadowReaction(s, cat, null);
  if (s.pendingCombatOrPeril) return resolveCombatOrPeril(s, cat, 'combat');
  if (s.pendingTree?.actor === 'sauron') return autoResolvePendingTree(s, cat);
  return advanceHeroSide(s, cat, missionAware, mulberry32(s.log.length));
}

function run(seed: number, heroes: number) {
  const cat = loadCatalog();
  let s = newGame(cat, seed, Object.keys(cat.heroes).slice(0, heroes), 'Sauron');
  for (let steps = 0; !s.winner && steps < 6000; steps++) {
    if (s.activeSide === 'Hero') {
      s = sauronReact(s, cat);
    } else if (s.pendingChoice) s = resolveChoice(s, cat, s.pendingChoice.options[0].id);
    else s = sauronTurn(s, cat);
  }
  if (!s.winner && process.env.DBG) console.log('STUCK', seed, s.phase, s.activeSide, s.story.turn, Object.entries(s).filter(([k,v]) => k.startsWith('pending') && v).map(([k]) => k).join(','), s.sauronActionsLeft, JSON.stringify(s.sauronPending));
  return { winner: s.winner ?? 'none', reason: s.winReason ?? '', turn: s.story.turn };
}

for (const heroes of [2, 3]) {
  const turns: number[] = [];
  const wins: Record<string, number> = {};
  for (let i = 0; i < 20; i++) {
    const r = run(2000 + i, heroes);
    turns.push(r.turn);
    wins[r.winner] = (wins[r.winner] ?? 0) + 1;
    if (i < 3) console.log(`${heroes}h seed ${2000 + i}: ${r.winner} turn ${r.turn} — ${r.reason}`);
  }
  turns.sort((a, b) => a - b);
  console.log(`${heroes} heroes: wins ${JSON.stringify(wins)} turns min ${turns[0]} median ${turns[10]} max ${turns[19]}\n`);
}
