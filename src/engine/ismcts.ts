// Determinized Information-Set Monte Carlo Tree Search (ISMCTS) for the HERO
// side. The heroes face imperfect information (Sauron's hidden Shadow hand + the
// order of every face-down deck) and pure chance (draws, combat). This searcher
// leverages two facts about the engine:
//   1. ALL randomness lives in a single integer, `state.rngCursor`, so a "world"
//      (a determinization of every hidden card + future draw) is sampled simply
//      by re-seeding the cursor before each iteration.
//   2. `advance()` runs the Lidless Eye automa itself, so a rollout already plays
//      a competent opponent — the search optimises the hero line against it.
//
// Each iteration: clone the root, re-seed the cursor (a fresh determinization),
// descend the tree (UCB1) applying hero actions through the real forward model,
// expand one new action, roll out to the end with a heuristic policy, and back-
// propagate the hero result (win = 1, loss = 0, else a heuristic value in [0,1]).
// Nodes hold statistics only; states are re-derived by replay so the same node
// experiences many determinizations — the ISMCTS idea.
import type { Catalog, GameState, HeroId } from './types';
import { SHADOW_FALLS, STORY_FINALE } from './types';
import {
  advance, endHeroActions, engageableMonsters, canExplore, legalMoves,
  encounterPlan, chooseEncounter, resolveEncounter, resolveChoice,
  targetablePlot, favorHere, autoResolvePendingTree,
} from './game';
import {
  type HeroStrategy, type HeroAction, type Rng,
  applyHeroAction, mulberry32, STRATEGIES,
} from './heroAI';

// ---- config ------------------------------------------------------------
export interface IsmctsConfig {
  iterations: number;      // determinized simulations per decision
  c: number;               // UCB1 exploration constant
  rollout: HeroStrategy;   // default policy for rollouts + intermediate choices
  maxRolloutSteps: number; // safety cap on a single rollout (engine micro-steps)
  maxRolloutDepth: number; // truncate a rollout after this many hero actions,
                           // then score the leaf with heroValue (cheap horizon)
}
export const DEFAULT_ISMCTS: IsmctsConfig = {
  iterations: 120, c: 1.4, rollout: STRATEGIES['mission-aware'],
  maxRolloutSteps: 6000, maxRolloutDepth: 24,
};

// ---- action enumeration ------------------------------------------------
/** Every legal action for the active hero at a decision point — the hero move
 *  space (very different from Sauron's command space). */
export function legalHeroActions(s: GameState, cat: Catalog, heroId: HeroId): HeroAction[] {
  const hero = s.heroes.find((h) => h.id === heroId)!;
  const acts: HeroAction[] = [];
  for (const m of engageableMonsters(s, heroId)) acts.push({ kind: 'engage', monsterId: m });
  if (canExplore(s, cat, heroId)) acts.push({ kind: 'explore' });
  for (const mv of legalMoves(cat, hero)) acts.push({ kind: 'move', to: mv.to });
  const t = targetablePlot(s, cat, heroId);
  if (t) {
    const p = cat.plots.find((x) => x.id === t.eventId);
    if (hero.favor >= (p?.favorToCounter ?? 2)) acts.push({ kind: 'counter-plot' });
  }
  if (favorHere(s, heroId) > 0) acts.push({ kind: 'retrieve-favor' });
  if (cat.locations[hero.location]?.kind === 'haven' && !hero.restedThisTurn && !hero.hasMovedThisTurn) acts.push({ kind: 'rest' });
  acts.push({ kind: 'end' });
  return acts;
}

const actKey = (a: HeroAction): string =>
  a.kind === 'move' ? `move:${a.to}` : a.kind === 'engage' ? `engage:${a.monsterId}` : a.kind;

// ---- forward model driver ---------------------------------------------
/** True at a real hero decision point (the active hero can still act). */
function isHeroDecision(s: GameState): boolean {
  if (s.winner || s.phase !== 'HeroActions' || s.pendingChoice || s.pendingCombat || s.pendingEncounter || s.pendingTree) return false;
  const hero = s.heroes[s.activeHeroIndex];
  return hero.status === 'active' && hero.actionsRemaining > 0;
}

/** Drive the engine forward — resolving choices/encounters/combat with `strat`
 *  and running the automa via advance() — until the next hero decision or the
 *  end of the game. Mirrors the proven playoutGame loop. */
function runToDecision(s: GameState, cat: Catalog, strat: HeroStrategy, rng: Rng, maxSteps = 6000): GameState {
  let steps = 0;
  while (!s.winner && steps < maxSteps) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); continue; }
    if (s.pendingCombat && !s.pendingTree) { s = advance(s, cat); continue; }
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.pendingTree) { s = autoResolvePendingTree(s, cat); continue; }
    if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      return s; // decision point
    }
    s = advance(s, cat);
  }
  return s;
}

/** Roll a state out to the end with the default policy; return the hero value. */
function rollout(s: GameState, cat: Catalog, cfg: IsmctsConfig, rng: Rng): number {
  let steps = 0;
  let heroActs = 0;
  while (!s.winner && steps < cfg.maxRolloutSteps) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, cfg.rollout.combatOption(s, cat, s.pendingChoice.options, rng)); continue; }
    if (s.pendingCombat && !s.pendingTree) { s = advance(s, cat); continue; }
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, cfg.rollout.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.pendingTree) { s = autoResolvePendingTree(s, cat); continue; }
    if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      if (heroActs >= cfg.maxRolloutDepth) break; // truncate: score the leaf heuristically
      heroActs++;
      s = applyHeroAction(s, cat, hero.id, cfg.rollout.heroAction(s, cat, hero.id, rng));
      continue;
    }
    s = advance(s, cat);
  }
  return heroValue(s);
}

/** Hero-perspective value in [0,1]: a decisive result is 1/0; an unfinished
 *  state scores by how far Sauron is from EITHER loss condition (a single marker
 *  to the Finale, or all three to the Shadow Falls), nudged by banked favor. */
function heroValue(s: GameState): number {
  if (s.winner === 'Hero') return 1;
  if (s.winner === 'Sauron') return 0;
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  const single = Math.max(st.yellow, st.red, st.black) / STORY_FINALE;         // threat A
  const trio = Math.min(st.yellow, st.red, st.black) / SHADOW_FALLS;           // threat B
  const threat = Math.min(1, Math.max(single, trio));
  const favor = s.heroes.reduce((n, h) => n + h.favor, 0);
  return Math.max(0, Math.min(1, 0.55 - 0.5 * threat + 0.02 * favor));
}

// ---- tree --------------------------------------------------------------
interface Node {
  action: HeroAction | null; // action that led here (null at root)
  visits: number;
  value: number;             // summed hero value
  avail: number;             // # determinizations in which this action was legal (ISMCTS)
  children: Map<string, Node>;
}
const newNode = (action: HeroAction | null): Node =>
  ({ action, visits: 0, value: 0, avail: 0, children: new Map() });

/** UCB1 restricted to the moves legal in the CURRENT determinization; the
 *  exploration term uses each child's availability count (the ISMCTS variant),
 *  not the parent visit count, so rarely-legal actions aren't over-explored. */
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

// ---- search ------------------------------------------------------------
/** Choose the active hero's action by determinized ISMCTS. */
export function ismctsHeroAction(
  rootState: GameState, cat: Catalog, heroId: HeroId, cfg: IsmctsConfig = DEFAULT_ISMCTS,
): HeroAction {
  const legal = legalHeroActions(rootState, cat, heroId);
  if (legal.length <= 1) return legal[0] ?? { kind: 'end' };

  const root = newNode(null);
  // a search-local PRNG (independent of the game rng) seeds each determinization
  const meta = mulberry32((rootState.rngCursor ^ 0x51ed270b) >>> 0);

  for (let i = 0; i < cfg.iterations; i++) {
    // fresh determinization: clone root and re-seed the cursor that drives every
    // hidden draw / combat outcome for this simulation.
    let s: GameState = structuredClone(rootState);
    s.rngCursor = (meta() * 0x7fffffff) | 0;
    const rng = mulberry32(s.rngCursor >>> 0);

    const path: Node[] = [root];
    let node = root;
    let decisionHero = heroId;

    // --- selection + expansion (ISMCTS: only moves legal in THIS
    //     determinization are considered; each gets an availability tick) ---
    while (true) {
      if (!isHeroDecision(s)) break; // game ended or no hero to act
      decisionHero = s.heroes[s.activeHeroIndex].id;
      const legalNow = legalHeroActions(s, cat, decisionHero);
      // availability: every currently-legal action that already has a child
      // was "available" for selection this descent.
      const candidates: Node[] = [];
      const untried: HeroAction[] = [];
      for (const a of legalNow) {
        const child = node.children.get(actKey(a));
        if (child) { child.avail++; candidates.push(child); }
        else untried.push(a);
      }
      if (untried.length > 0) {
        const a = untried[Math.floor(rng() * untried.length)];
        s = runToDecision(applyHeroAction(s, cat, decisionHero, a), cat, cfg.rollout, rng);
        const child = newNode(a);
        child.avail++;
        node.children.set(actKey(a), child);
        path.push(child); node = child;
        break; // expanded — go to rollout
      }
      if (candidates.length === 0) break; // no legal move here (shouldn't happen)
      node = ucbSelect(candidates, cfg.c);
      path.push(node);
      s = runToDecision(applyHeroAction(s, cat, decisionHero, node.action!), cat, cfg.rollout, rng);
    }

    // --- rollout + backprop ---
    const val = rollout(s, cat, cfg, rng);
    for (const n of path) { n.visits++; n.value += val; }
  }

  // pick the most-visited root action (robust choice), restricted to actions
  // that are actually legal in the REAL root state — the tree is grown over
  // determinized clones and legalHeroActions is a superset of what the engine
  // will accept (e.g. it lists moves the resolver later rejects), so never
  // return an action the root can't execute.
  const legalKeys = new Set(legal.map(actKey));
  let best: Node | null = null;
  for (const child of root.children.values()) {
    if (child.action && !legalKeys.has(actKey(child.action))) continue;
    if (!best || child.visits > best.visits) best = child;
  }
  return best?.action ?? legal[0];
}

/** Wrap the ISMCTS searcher as a HeroStrategy so it plugs into the existing
 *  driver, harness, and UI. Combat/encounter micro-choices delegate to the
 *  rollout policy (mission-aware) — the search governs the hero ACTION space. */
export function makeIsmctsStrategy(cfg: IsmctsConfig = DEFAULT_ISMCTS): HeroStrategy {
  return {
    name: `ismcts(${cfg.iterations})`,
    combatOption: (s, cat, opts, rng) => cfg.rollout.combatOption(s, cat, opts, rng),
    encounterOption: (s, opts, rng) => cfg.rollout.encounterOption(s, opts, rng),
    heroAction: (s, cat, heroId) => ismctsHeroAction(s, cat, heroId, cfg),
  };
}
