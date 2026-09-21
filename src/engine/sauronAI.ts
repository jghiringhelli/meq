// Determinized ISMCTS for the SAURON (Lidless Eye) side. Sauron's decision
// space is very different from the heroes': a Plot Step (which plot to enable,
// or pass) followed by an Action Step of 2 commands (3 with three heroes), each
// a Place-influence / Deploy / Spawn / Move / Heal / Draw / Play-shadow command.
//
// The engine already exposes an interactive Sauron turn (used when a human plays
// Sauron): with `humanSide === 'Sauron'`, `advance()` PAUSES at the Plot Step
// (phase SauronEvents, before the event step resolves) and at each Action-Step
// command (phase SauronMinions while `sauronActionsLeft > 0`) — exactly the way
// it pauses at HeroActions for the heroes. We drive those decisions here.
//
// Each search iteration re-seeds `state.rngCursor` (a fresh determinization of
// every hidden hero card + future draw), descends the tree applying Sauron
// commands through the real forward model, expands one action, and rolls out to
// a horizon with a heuristic policy. Rollouts flip `humanSide` back to 'Hero' so
// `advance()` plays Sauron with the proven greedy automa while the heroes follow
// their rollout policy. The Sauron value = how close Sauron is to a win.
import type { Catalog, GameState, LocationId, Plot } from './types';
import { SHADOW_FALLS, STORY_FINALE } from './types';
import {
  advance, endHeroActions, encounterPlan, chooseEncounter, resolveEncounter, resolveChoice,
  sauronEndActionStep, sauronStoryStep, sauronResolveEvents,
  sauronPlayPlot, sauronPlayShadow, autoResolvePendingTree,
  playablePlots, playableShadow, woundedMinions, boardFigures, moveTargets,
} from './game';
import { newGame } from './setup';
import { clone, gameStage } from './mechanics';
import { minionsInPlay } from './missions';
import { drawShadow, drawPlots } from './sauronmech';
import { deployMinion } from './setup';
import { eyePlaceInfluenceOnce, eyeSpawnMonsterOnce, ratePlot, AI_ECONOMY } from './ai';
import { regionHasInfluence } from './influence';
import {
  type HeroStrategy, type Rng,
  applyHeroAction, mulberry32, STRATEGIES,
} from './heroAI';

const rateP = (p: Plot): number =>
  ratePlot({ id: p.id, advance: p.advance ?? 1, influenceCost: Number(p.influenceCost) || 0,
    aiEffectVal: (p as { aiEffectVal?: number }).aiEffectVal,
    aiReqEase: (p as { aiReqEase?: number }).aiReqEase,
    aiLocDifficulty: (p as { aiLocDifficulty?: number }).aiLocDifficulty });

// ---- action space ------------------------------------------------------
export type SauronAction =
  | { kind: 'plot'; plotId: string }
  | { kind: 'pass-plot' }
  | { kind: 'influence' }
  | { kind: 'deploy' }
  | { kind: 'spawn' }
  | { kind: 'heal'; minionId: string }
  | { kind: 'move'; figKind: 'monster' | 'minion'; id: string; from: LocationId; to: LocationId }
  | { kind: 'draw' }
  | { kind: 'shadow'; cardId: string }
  | { kind: 'end' };

export const sauronActKey = (a: SauronAction): string =>
  a.kind === 'plot' ? `plot:${a.plotId}`
    : a.kind === 'heal' ? `heal:${a.minionId}`
      : a.kind === 'move' ? `move:${a.id}:${a.to}`
        : a.kind === 'shadow' ? `shadow:${a.cardId}`
          : a.kind;

/** True when we're standing at a Sauron decision (plot step or an action-step
 *  command), with no hero-facing resolution pending. */
export function isSauronDecision(s: GameState): boolean {
  if (s.winner || s.pendingChoice || s.pendingCombat || s.pendingEncounter) return false;
  if (s.phase === 'SauronEvents') return true;                       // plot step
  if (s.phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) > 0) return true; // action step
  return false;
}

/** A stage-appropriate reserve minion exists to deploy. */
function canDeploy(s: GameState, cat: Catalog): boolean {
  const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
  const defeated = new Set(s.map.minionDefeated ?? []);
  const stage = gameStage(s);
  return Object.values(cat.minions).some((m) =>
    !onBoard.has(m.id) && !defeated.has(m.id) && (m.stage ?? 1) <= stage && !(m.finale && s.story.finale));
}

/** A hero stands on (or the Eye can reach) an influenced, hero-free location so
 *  eyeSpawnMonsterOnce can seat a token there — the rules prerequisite. */
function canSpawn(s: GameState, cat: Catalog): boolean {
  const onBoard = Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0);
  if (onBoard >= AI_ECONOMY.maxBoardMonsters) return false;
  return s.heroes.some((h) => {
    if (h.status !== 'active') return false;
    const region = cat.locations[h.location]?.regionId ?? '';
    return regionHasInfluence(s, cat, region);
  });
}

/** Every legal Sauron action at the current decision point. */
export function legalSauronActions(s: GameState, cat: Catalog): SauronAction[] {
  const acts: SauronAction[] = [];
  if (s.phase === 'SauronEvents') {
    for (const p of playablePlots(s, cat)) acts.push({ kind: 'plot', plotId: p.id });
    acts.push({ kind: 'pass-plot' });
    return acts;
  }
  // Action step (SauronMinions, budget > 0)
  if (s.sauron.influence >= AI_ECONOMY.pathBlockCost) acts.push({ kind: 'influence' });
  if (canDeploy(s, cat)) acts.push({ kind: 'deploy' });
  if (canSpawn(s, cat)) acts.push({ kind: 'spawn' });
  for (const mid of woundedMinions(s, cat)) acts.push({ kind: 'heal', minionId: mid });
  for (const fig of boardFigures(s)) {
    for (const to of moveTargets(s, cat, fig.kind, fig.loc)) {
      acts.push({ kind: 'move', figKind: fig.kind, id: fig.id, from: fig.loc, to });
    }
  }
  acts.push({ kind: 'draw' });
  for (const cid of playableShadow(s, cat)) acts.push({ kind: 'shadow', cardId: cid });
  acts.push({ kind: 'end' });
  return acts;
}

const noop = (_m: string): void => { /* silent inside search */ };

/** Apply one Sauron action. Every ACTION-STEP command spends exactly one budget
 *  action (so the driver always makes progress); PLOT-STEP actions do not touch
 *  the action budget (a different phase). Reuses the faithful engine ops — the
 *  monster bag (no replacement), pool caps and influence prerequisites all hold. */
export function applySauronAction(s: GameState, cat: Catalog, act: SauronAction): GameState {
  switch (act.kind) {
    case 'plot': return sauronPlayPlot(s, cat, act.plotId);
    case 'pass-plot': return s;
    case 'shadow': return sauronPlayShadow(s, cat, act.cardId);      // self-spends
    case 'end': return s;                                            // driver ends the step
    case 'influence': { const c = clone(s); eyePlaceInfluenceOnce(c, cat, noop); spendBudget(c); return c; }
    case 'deploy': { const c = clone(s); deployMinion(c, cat); spendBudget(c); return c; }
    case 'spawn': { const c = clone(s); eyeSpawnMonsterOnce(c, cat, noop); spendBudget(c); return c; }
    case 'draw': { const c = clone(s); drawShadow(c, cat, 2); drawPlots(c, cat, 2); spendBudget(c); return c; }
    case 'heal': {
      const c = clone(s);
      if (c.map.minionHealth && c.map.minionHealth[act.minionId] !== undefined) delete c.map.minionHealth[act.minionId];
      spendBudget(c);
      return c;
    }
    case 'move': {
      const c = clone(s);
      const map = act.figKind === 'monster' ? (c.map.monstersAt ||= {}) : (c.map.minionsAt ||= {});
      const at = map[act.from];
      if (at) { const i = at.indexOf(act.id); if (i >= 0) { at.splice(i, 1); (map[act.to] ||= []).push(act.id); } }
      spendBudget(c);
      return c;
    }
  }
}
function spendBudget(s: GameState): void {
  s.sauronActionsLeft = Math.max(0, (s.sauronActionsLeft ?? 0) - 1);
}

// ---- Sauron strategy interface + greedy baseline -----------------------
export interface SauronStrategy {
  name: string;
  sauronAction(s: GameState, cat: Catalog, rng: Rng): SauronAction;
}

/** A competent hand-crafted Sauron: enable the strongest affordable plot, then
 *  spend the action budget by the Lidless-Eye priorities (heal > deploy/spawn in
 *  mid/late > influence > move > draw), stopping when nothing is worthwhile. */
export const greedySauron: SauronStrategy = {
  name: 'greedy-sauron',
  sauronAction(s, cat) {
    const legal = legalSauronActions(s, cat);
    if (s.phase === 'SauronEvents') {
      const plots = playablePlots(s, cat).sort((a, b) => rateP(b) - rateP(a));
      // enable the best plot with a real payoff (advance ≥ 2 preferred) if room.
      const best = plots.find((p) => (p.advance ?? 1) >= 2) ?? plots[0];
      return best ? { kind: 'plot', plotId: best.id } : { kind: 'pass-plot' };
    }
    return bestCommand(s, legal);
  },
};
function commandScore(s: GameState, a: SauronAction): number {
  const frac = s.story.sauronProgress / Math.max(1, s.story.length);
  const monsters = Object.values(s.map.monstersAt).reduce((n, x) => n + x.length, 0);
  const activeHeroes = s.heroes.filter((h) => h.status === 'active').length;
  const hasPlot = (s.sauron.activePlots ?? []).some((p) => !!p.location);
  const flush = s.sauron.influence >= 6;
  switch (a.kind) {
    case 'heal': return 100;
    case 'shadow': return 78;
    case 'deploy': return (frac > 1 / 3 && (hasPlot || flush) && minionsInPlay(s) < 4) ? 70 : 8;
    case 'move': return 50;
    case 'influence': return frac < 2 / 3 ? 56 : 40;
    case 'spawn': return monsters < Math.max(1, activeHeroes) ? 48 : 22;
    case 'draw': return (frac < 0.5 ? 62 : 34) + (s.sauron.shadowHand.length < 2 ? 20 : 0);
    case 'end': return 5; // stop only when nothing else clears the bar
    default: return 0;
  }
}
function bestCommand(s: GameState, legal: SauronAction[]): SauronAction {
  let best: SauronAction = { kind: 'end' };
  let bestScore = -Infinity;
  for (const a of legal) {
    const sc = commandScore(s, a);
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  return best;
}

// ---- forward-model driver ---------------------------------------------
/** Resolve any hero-facing pending state with `hero`, else drive the heroes with
 *  `hero` and the automatic phases with advance(). Stops at the next Sauron
 *  decision (plot step or an action-step command) or the end of the game. */
function runToSauronDecision(s: GameState, cat: Catalog, hero: HeroStrategy, rng: Rng, maxSteps = 6000): GameState {
  let steps = 0;
  while (!s.winner && steps < maxSteps) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, hero.combatOption(s, cat, s.pendingChoice.options, rng)); continue; }
    if (s.pendingCombat && !s.pendingTree) { s = advance(s, cat); continue; }
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, hero.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.pendingTree) { s = autoResolvePendingTree(s, cat); continue; }
    if (isSauronDecision(s)) return s;
    if (s.phase === 'HeroActions') {
      const h = s.heroes[s.activeHeroIndex];
      if (h.status !== 'active' || h.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      s = applyHeroAction(s, cat, h.id, hero.heroAction(s, cat, h.id, rng));
      continue;
    }
    if (s.phase === 'SauronRefresh') { s = sauronStoryStep(s, cat); continue; } // Story Step
    if (s.phase === 'SauronMinions') { s = sauronEndActionStep(s, cat); continue; } // budget exhausted
    s = advance(s, cat);
  }
  return s;
}

/** Advance one Sauron decision: apply `act`, then (plot step) resolve the event
 *  step, or (end / last budget) close the action step, driving heroes with
 *  `hero` until the next Sauron decision or game end. */
function stepSauron(s: GameState, cat: Catalog, act: SauronAction, hero: HeroStrategy, rng: Rng): GameState {
  if (s.phase === 'SauronEvents') {
    s = applySauronAction(s, cat, act);       // play/pass the plot
    s = sauronResolveEvents(s, cat);          // resolve the Event Step -> SauronMinions
    return runToSauronDecision(s, cat, hero, rng);
  }
  // action step
  if (act.kind === 'end') s = sauronEndActionStep(s, cat);
  else s = applySauronAction(s, cat, act);
  if (s.phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) <= 0) s = sauronEndActionStep(s, cat);
  return runToSauronDecision(s, cat, hero, rng);
}

// ---- value + rollout ---------------------------------------------------
/** Sauron-perspective value in [0,1]: a Sauron win is 1, a hero win 0; an
 *  unfinished state scores by how close Sauron is to EITHER win condition (one
 *  marker to the Finale, or all three to the Shadow Falls), minus banked hero
 *  favor (their means to break plots). */
export function sauronValue(s: GameState): number {
  if (s.winner === 'Sauron') return 1;
  if (s.winner === 'Hero') return 0;
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  const single = Math.max(st.yellow, st.red, st.black) / STORY_FINALE;
  const trio = Math.min(st.yellow, st.red, st.black) / SHADOW_FALLS;
  const threat = Math.min(1, Math.max(single, trio));
  const favor = s.heroes.reduce((n, h) => n + h.favor, 0);
  return Math.max(0, Math.min(1, 0.45 + 0.5 * threat - 0.02 * favor));
}

/** Roll out with the greedy automa on the Sauron side (advance() plays it once
 *  humanSide is flipped) and `hero` on the heroes' side, to a depth horizon. */
function rollout(s: GameState, cat: Catalog, hero: HeroStrategy, rng: Rng, maxDepth: number, maxSteps = 6000): number {
  s = clone(s);
  s.humanSide = 'Hero'; // let advance() auto-play the greedy Sauron automa
  let steps = 0;
  let heroActs = 0;
  while (!s.winner && steps < maxSteps) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, hero.combatOption(s, cat, s.pendingChoice.options, rng)); continue; }
    if (s.pendingCombat && !s.pendingTree) { s = advance(s, cat); continue; }
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, hero.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.pendingTree) { s = autoResolvePendingTree(s, cat); continue; }
    if (s.phase === 'HeroActions') {
      const h = s.heroes[s.activeHeroIndex];
      if (h.status !== 'active' || h.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      if (heroActs >= maxDepth) break;
      heroActs++;
      s = applyHeroAction(s, cat, h.id, hero.heroAction(s, cat, h.id, rng));
      continue;
    }
    s = advance(s, cat);
  }
  return sauronValue(s);
}

// ---- ISMCTS ------------------------------------------------------------
export interface SauronIsmctsConfig {
  iterations: number;
  c: number;
  heroRollout: HeroStrategy; // hero policy used in rollouts + hero-facing choices
  maxRolloutDepth: number;
}
export const DEFAULT_SAURON_ISMCTS: SauronIsmctsConfig = {
  iterations: 120, c: 1.4, heroRollout: STRATEGIES['mission-aware'], maxRolloutDepth: 24,
};

interface Node {
  action: SauronAction | null;
  visits: number;
  value: number;   // summed Sauron value
  avail: number;   // # determinizations the action was legal in (ISMCTS)
  children: Map<string, Node>;
}
const newNode = (action: SauronAction | null): Node =>
  ({ action, visits: 0, value: 0, avail: 0, children: new Map() });

function ucbSelect(candidates: Node[], c: number): Node {
  let best: Node | null = null; let bestScore = -Infinity;
  for (const child of candidates) {
    const exploit = child.value / (child.visits || 1);
    const explore = c * Math.sqrt(Math.log(child.avail + 1) / (child.visits || 1));
    const score = exploit + explore;
    if (score > bestScore) { bestScore = score; best = child; }
  }
  return best!;
}

/** Choose Sauron's action at the current decision by determinized ISMCTS. */
export function ismctsSauronAction(
  rootState: GameState, cat: Catalog, cfg: SauronIsmctsConfig = DEFAULT_SAURON_ISMCTS,
): SauronAction {
  const legal = legalSauronActions(rootState, cat);
  if (legal.length <= 1) return legal[0] ?? { kind: 'end' };

  const root = newNode(null);
  const meta = mulberry32((rootState.rngCursor ^ 0x2f6e2b1) >>> 0);

  for (let i = 0; i < cfg.iterations; i++) {
    let s: GameState = clone(rootState);
    s.rngCursor = (meta() * 0x7fffffff) | 0;
    const rng = mulberry32(s.rngCursor >>> 0);

    const path: Node[] = [root];
    let node = root;

    // --- selection + expansion (only moves legal in THIS determinization) ---
    while (true) {
      if (!isSauronDecision(s)) break;
      const legalNow = legalSauronActions(s, cat);
      const candidates: Node[] = [];
      const untried: SauronAction[] = [];
      for (const a of legalNow) {
        const child = node.children.get(sauronActKey(a));
        if (child) { child.avail++; candidates.push(child); }
        else untried.push(a);
      }
      if (untried.length > 0) {
        const a = untried[Math.floor(rng() * untried.length)];
        s = stepSauron(s, cat, a, cfg.heroRollout, rng);
        const child = newNode(a);
        child.avail++;
        node.children.set(sauronActKey(a), child);
        path.push(child); node = child;
        break;
      }
      if (candidates.length === 0) break;
      node = ucbSelect(candidates, cfg.c);
      path.push(node);
      s = stepSauron(s, cat, node.action!, cfg.heroRollout, rng);
    }

    // --- rollout + backprop ---
    const val = rollout(s, cat, cfg.heroRollout, rng, cfg.maxRolloutDepth);
    for (const n of path) { n.visits++; n.value += val; }
  }

  // most-visited root action, restricted to what's legal in the real root.
  const legalKeys = new Set(legal.map(sauronActKey));
  let best: Node | null = null;
  for (const child of root.children.values()) {
    if (child.action && !legalKeys.has(sauronActKey(child.action))) continue;
    if (!best || child.visits > best.visits) best = child;
  }
  return best?.action ?? legal[0];
}

/** Wrap the ISMCTS searcher as a SauronStrategy. */
export function makeIsmctsSauron(cfg: SauronIsmctsConfig = DEFAULT_SAURON_ISMCTS): SauronStrategy {
  return {
    name: `ismcts-sauron(${cfg.iterations})`,
    sauronAction: (s, cat) => ismctsSauronAction(s, cat, cfg),
  };
}

// ---- self-play driver --------------------------------------------------
export interface SauronPlayoutResult {
  winner: 'Hero' | 'Sauron' | null;
  reason: string;
  turns: number;
  steps: number;
}

/** Play a full game with `sauron` driving the Lidless Eye (interactive Sauron
 *  turn) and `hero` driving the heroes. Mirrors playoutGame but with Sauron as a
 *  first-class strategy — used to evaluate Sauron AIs (lower hero win = stronger
 *  Sauron). */
export function playoutGameSauron(
  cat: Catalog, seed: number, sauron: SauronStrategy, hero: HeroStrategy, maxSteps = 20000,
): SauronPlayoutResult {
  let s = newGame(cat, seed);
  s.humanSide = 'Sauron'; // pause at Sauron decisions so `sauron` drives them
  s.sauronReactsAuto = true; // fire hero-turn Shadow reactions during self-play
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let steps = 0;
  while (!s.winner && steps < maxSteps) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, hero.combatOption(s, cat, s.pendingChoice.options, rng)); continue; }
    if (s.pendingCombat && !s.pendingTree) { s = advance(s, cat); continue; }
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, hero.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.pendingTree) { s = autoResolvePendingTree(s, cat); continue; }
    if (isSauronDecision(s)) {
      const a = sauron.sauronAction(s, cat, rng);
      if (s.phase === 'SauronEvents') {
        s = applySauronAction(s, cat, a);
        s = sauronResolveEvents(s, cat); // resolve the Event Step
      } else {
        if (a.kind === 'end') s = sauronEndActionStep(s, cat);
        else s = applySauronAction(s, cat, a);
        if (s.phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) <= 0) s = sauronEndActionStep(s, cat);
      }
      continue;
    }
    if (s.phase === 'HeroActions') {
      const h = s.heroes[s.activeHeroIndex];
      if (h.status !== 'active' || h.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      s = applyHeroAction(s, cat, h.id, hero.heroAction(s, cat, h.id, rng));
      continue;
    }
    if (s.phase === 'SauronRefresh') { s = sauronStoryStep(s, cat); continue; }
    if (s.phase === 'SauronMinions') { s = sauronEndActionStep(s, cat); continue; }
    s = advance(s, cat);
  }
  return {
    winner: s.winner ?? null,
    reason: s.winReason ?? '(unfinished)',
    turns: s.story.turn,
    steps,
  };
}
