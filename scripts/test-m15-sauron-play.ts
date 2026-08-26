import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/setup';
import {
  advance, sauronStoryStep, sauronResolveEvents, sauronEndActionStep,
  sauronPlaceInfluence, sauronPlayShadow, playableShadow,
} from '../src/engine/game';
import { advanceHeroSide, missionAware, mulberry32 } from '../src/engine/heroAI';
import type { GameState, Catalog } from '../src/engine/types';

function driveSauronTurn(s: GameState, cat: Catalog): GameState {
  // Story step
  if (s.phase === 'SauronRefresh') s = sauronStoryStep(s, cat);
  // Plot step: pass (just resolve events)
  if (s.phase === 'SauronEvents') s = sauronResolveEvents(s, cat);
  // Action step: place influence + maybe a shadow, then end
  let guard = 0;
  while (s.phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) > 0 && guard++ < 10) {
    const shad = playableShadow(s, cat);
    const before = s.sauronActionsLeft;
    if (shad.length) s = sauronPlayShadow(s, cat, shad[0]);
    else {
      const region = Object.values(cat.locations)[0].regionId;
      s = sauronPlaceInfluence(s, cat, region);
    }
    if (s.sauronActionsLeft === before) break; // no progress; bail
  }
  if (s.phase === 'SauronMinions') s = sauronEndActionStep(s, cat);
  return s;
}

function run(seed: number): { winner: string | null; reason: string; turns: number; steps: number } {
  const cat = loadCatalog();
  let s = newGame(cat, seed, Object.keys(cat.heroes).slice(0, 2), 'Sauron');
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let steps = 0;
  while (!s.winner && steps < 4000) {
    steps++;
    if (s.activeSide === 'Hero') {
      if (s.pendingCombat || s.pendingChoice || s.pendingEncounter) { s = advance(s, cat); continue; }
      s = advanceHeroSide(s, cat, missionAware, rng);
      continue;
    }
    // Sauron side (human) — drive with the simple policy
    s = driveSauronTurn(s, cat);
  }
  return { winner: s.winner ?? null, reason: s.winReason ?? '(unfinished)', turns: s.story.turn, steps };
}

let hero = 0, sauron = 0, unfinished = 0;
for (let i = 0; i < 20; i++) {
  const r = run(1000 + i);
  if (r.winner === 'Hero') hero++;
  else if (r.winner === 'Sauron') sauron++;
  else unfinished++;
  if (i < 3) console.log(`seed ${1000 + i}: ${r.winner ?? 'unfinished'} — ${r.reason} (turn ${r.turns}, steps ${r.steps})`);
}
console.log(`\nHuman-Sauron mode over 20 games: Hero ${hero}, Sauron ${sauron}, unfinished ${unfinished}`);
