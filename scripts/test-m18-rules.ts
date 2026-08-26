// M18 acceptance — rulebook reconciliation: Dark Path limits, level tokens
// (attribute cap), and the Ambush step. Run: npx tsx scripts/test-m18-rules.ts
import { loadCatalog } from '../src/data/loadAssets';
import { newGame, heroDarkPath, heroMove } from '../src/engine/game';
import { raiseAttribute, ambushPending } from '../src/engine/mechanics';
import { applyHeroAction } from '../src/engine/heroAI';
import { legalMoves } from '../src/engine/mechanics';
import type { GameState } from '../src/engine/types';

declare const process: { exit(code: number): never };
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); }
}

const cat = loadCatalog();
function ready(): GameState {
  const s = newGame(cat, 7);
  s.phase = 'HeroActions';
  s.heroes.forEach((h) => (h.actionsRemaining = 9));
  return s;
}

// --- Dark Path: once per turn, and only at <=3 corruption ---
{
  const s = ready();
  const id = s.heroes[0].id;
  const s1 = heroDarkPath(s, cat, id);
  assert(s1.heroes[0].darkPathUsedThisTurn === true, 'dark path sets the once-per-turn flag');
  let threw = false;
  try { heroDarkPath(s1, cat, id); } catch { threw = true; }
  assert(threw, 'dark path a second time in the same turn is rejected');

  const s2 = ready();
  s2.heroes[0].corruption = 4;
  let threw2 = false;
  try { heroDarkPath(s2, cat, s2.heroes[0].id); } catch { threw2 = true; }
  assert(threw2, 'dark path is rejected above 3 corruption');
}

// --- Level tokens: each attribute may be raised at most twice per game ---
{
  const s = ready();
  const h = s.heroes[0];
  assert(raiseAttribute(h, 'strength', 1) === 1, 'first strength raise applies');
  assert(raiseAttribute(h, 'strength', 1) === 1, 'second strength raise applies');
  assert(raiseAttribute(h, 'strength', 1) === 0, 'third strength raise is capped at 0');
  assert((h.levels?.strength ?? 0) === 2, 'strength level token count is 2');
  assert((h.statBonus.strength ?? 0) === 2, 'strength bonus reflects exactly two raises');
  assert(raiseAttribute(h, 'wisdom', 5) === 2, 'a big raise is clamped to the 2-per-attribute room');
}

// --- Ambush: a foe on the hero's location forces combat before Travel ---
{
  const s = ready();
  const h = s.heroes[0];
  const mv = legalMoves(cat, h)[0];
  assert(!!mv, 'the hero has at least one legal move to test against');
  // place a minion on the hero's location
  (s.map.minionsAt ||= {});
  (s.map.minionsAt[h.location] ||= []).push('minion-gothmog' as any);
  assert(ambushPending(s, h), 'ambushPending is true with a foe present');
  let threw = false;
  try { heroMove(s, cat, h.id, mv.to); } catch { threw = true; }
  assert(threw, 'heroMove is rejected while a foe ambushes');
  // AI coercion: a move action becomes an engage
  const after = applyHeroAction(s, cat, h.id, { kind: 'move', to: mv.to });
  const moved = after.heroes[0].location !== h.location;
  assert(!moved || !!after.pendingCombat, 'AI move under ambush does not simply travel away');
}

console.log(failures === 0 ? '\nM18 rules-reconciliation: PASS' : `\nM18 rules-reconciliation: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
