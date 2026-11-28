// Hero AI + self-play driver for endless simulation. The heroes are normally
// human-driven in the UI (the Lidless Eye is the Sauron AI); this module gives
// the heroes a pluggable brain so we can run automated playouts, compare
// strategies, and mine what works. Strategies range from a pure random walk to
// heuristic play. Everything is deterministic per seed (a strategy's own PRNG is
// seeded separately so it never perturbs the game rng).
import type { Catalog, GameState, HeroId, HeroState, LocationId, SauronDoctrine, Terrain } from './types';
import { STAGE_SIZE, SHADOW_FALLS, STORY_FINALE } from './types';
import { newGame } from './setup';
import {
  advance, heroMove, heroRest, heroExplore, endHeroActions, heroEngage,
  engageableMonsters, canExplore, encounterPlan, resolveChoice, resolveEncounter,
  chooseEncounter, legalMoves, heroDiscardPlot, heroRetrieveFavor, favorHere, targetablePlot,
  heroSurvey, canSurvey, autoResolvePendingTree, heroTradeFavor, otherHeroesHere,
  heroConsultCharacter, charactersHere, consultWouldCorrupt,
} from './game';
import { ambushPending, clone, neighbors, otherEnd, terrainsInHand } from './mechanics';
import { isPerilous } from './influence';
import { corruptionBlocksSocial, corruptionFavorGainCap } from './corruption';
import { solveCombatOption } from './combatSolver';

// ---- local PRNG (independent of the game rng) --------------------------
export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];

// ---- strategy interface ------------------------------------------------
/** A hero brain: it answers each decision point the driver reaches. All methods
 *  are pure w.r.t. the strategy (may consult `rng`); they never mutate state. */
export interface HeroStrategy {
  name: string;
  /** choose one of the pending combat-card option ids. */
  combatOption(s: GameState, cat: Catalog, options: { id: string }[], rng: Rng): string;
  /** choose the index of an enabled encounter option. */
  encounterOption(s: GameState, options: { enabled: boolean }[], rng: Rng): number;
  /** choose a hero action for the active hero. */
  heroAction(s: GameState, cat: Catalog, heroId: HeroId, rng: Rng): HeroAction;
}
export type HeroAction =
  | { kind: 'engage'; monsterId: string }
  | { kind: 'explore' }
  | { kind: 'move'; to: LocationId; plan?: { key: string; targets: string[] } }
  | { kind: 'rest' }
  | { kind: 'counter-plot' }
  | { kind: 'retrieve-favor' }
  | { kind: 'consult'; character: string; choice: 'favor' | 'ability' }
  | { kind: 'survey' }
  | { kind: 'trade-favor'; fromId: HeroId; toId: HeroId; n: number }
  | { kind: 'end' };

// ---- shared helpers ----------------------------------------------------
function firstEnabled(options: { enabled: boolean }[]): number {
  const i = options.findIndex((o) => o.enabled);
  return i >= 0 ? i : 0;
}
/** BFS first step from `from` toward the nearest location in `targets`. */
function bfsFirstStep(cat: Catalog, from: LocationId, targets: Set<LocationId>): LocationId | null {
  if (targets.has(from)) return null;
  const seen = new Set<LocationId>([from]);
  let frontier: { id: LocationId; first: LocationId | null }[] = [{ id: from, first: null }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (targets.has(node.id) && node.first) return node.first;
      for (const e of cat.edges) {
        const nb = e.a === node.id ? e.b : e.b === node.id ? e.a : null;
        if (nb && !seen.has(nb)) { seen.add(nb); next.push({ id: nb, first: node.first ?? nb }); }
      }
    }
    frontier = next;
  }
  return null;
}
/** Legal moves minus any location the hero already left with nothing done in between (no pointless loops). */
function aiMoves(cat: Catalog, hero: HeroState) {
  const path = hero.travelPath ?? [];
  return legalMoves(cat, hero).filter((m) => !path.includes(m.to));
}

function nearestHavens(cat: Catalog): Set<LocationId> {
  return new Set(Object.values(cat.locations).filter((l) => l.kind === 'haven').map((l) => l.id));
}

/** A hero's effective wisdom (base + persistent stat bonuses) — the attribute a
 *  location's influence is compared against to decide perilousness. */
function heroWisdom(cat: Catalog, h: HeroState): number {
  return (cat.heroes[h.id]?.wisdom ?? 0) + (h.statBonus?.wisdom ?? 0);
}

/** A hero's effective value of any attribute (base + persistent stat bonuses). */
function heroStat(cat: Catalog, h: HeroState, stat: 'fortitude' | 'strength' | 'agility' | 'wisdom'): number {
  return ((cat.heroes[h.id] as any)?.[stat] ?? 0) + (h.statBonus?.[stat] ?? 0);
}

/** Whether Sauron currently has a plot in play that actually matters — a marker
 *  moving 3/turn (always urgent), or a 2/turn plot that would push its own
 *  marker to trigger the Finale (reach it) or the Shadow Falls (with the other
 *  two markers already there). Small 1/turn plots don't qualify: they aren't
 *  worth burning a Character's one-shot ability over. */
function importantActivePlot(s: GameState, cat: Catalog): boolean {
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  for (const e of s.sauron.activePlots ?? []) {
    const plot = cat.plots.find((p) => p.id === e.eventId);
    if (!plot) continue;
    const advance = plot.advance ?? 1;
    if (advance >= 3) return true;
    if (advance >= 2) {
      const marker = (plot.marker ?? 'red') as 'yellow' | 'red' | 'black';
      const cur = st[marker] ?? 0;
      const others = (['yellow', 'red', 'black'] as const).filter((m) => m !== marker).map((m) => st[m] ?? 0);
      if (cur + advance >= STORY_FINALE) return true;
      if (cur + advance >= SHADOW_FALLS && others.every((m) => m >= SHADOW_FALLS)) return true;
    }
  }
  return false;
}

/** Whether the Finale (the single champion-vs-Ringwraiths last stand) is close
 *  enough that pre-Finale Training (Dain II) or a combat attribute (Boromir's
 *  Strength) is worth banking now rather than favor for the ongoing plot race. */
function finaleLooming(s: GameState): boolean {
  const heroSpaces = Math.max(0, s.story.length - s.story.sauronProgress);
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  const leadMarker = Math.max(st.yellow, st.red, st.black);
  return heroSpaces <= 4 || leadMarker >= STORY_FINALE - 4 || s.story.turn >= 7;
}

/** Consult choice: favor (2, fungible, funds plot-breaking) vs. the Character's
 *  one-shot ability (never repeatable — the Character leaves the board either
 *  way). Rather than a hard yes/no cutoff, each option gets a WEIGHT built from
 *  the same state signals as before (a lightweight Markov-style scoring: the
 *  weights are just this decision's function of the current state, no history),
 *  and the strategy's own rng samples between them proportionally — so a
 *  marginal case sometimes goes the other way, while a clearly lopsided case
 *  (e.g. a hero stuck at 1 wisdom, or an urgent plot needing the favor NOW)
 *  still resolves the sensible way almost all the time. Rules of thumb baked
 *  into the weights, from actual play:
 *   - Wisdom (Gandalf) is scarce and powerful, especially with few heroes or a
 *     hero stuck at 1 — heavily favored.
 *   - Agility (Aragorn) is nearly as good as Strength but more versatile
 *     (evasion + Preparation-step card draws), so it leans toward taking it —
 *     unless an important plot needs this favor right now.
 *   - Strength (Boromir) only pays off in an actual fight, so it only leans
 *     toward the ability heading into the Finale window, and less so with an
 *     urgent plot in play.
 *   - Training (Dain II) pays off right before the last stand, not mid-race.
 *   - Draining the Shadow Pool (Thranduil) only matters if it actually delays
 *     something big, and only while the pool isn't already flush (diminishing
 *     returns once Sauron is sitting on a large war chest).
 *   - Randomly discarding Sauron's Shadow hand (Saruman) rarely lands on
 *     anything that matters: he draws plenty, and his genuinely dangerous cards
 *     already cost him Shadow Pool influence to play — favor keeps most of the
 *     weight, with just a small chance of the flashier play.
 *   - Unmodeled/utility characters (Théoden's Horse, etc.): favor keeps most of
 *     the weight. */
function pickConsultChoice(s: GameState, cat: Catalog, hero: HeroState, character: string, rng: Rng): 'favor' | 'ability' {
  const name = character.trim().toLowerCase();
  const activeHeroCount = s.heroes.filter((h) => h.status === 'active').length;
  const urgentPlot = importantActivePlot(s, cat);
  const FAVOR_BASE = 50; // "2 fungible favor" is always a solid, safe pick
  let abilityWeight: number;
  switch (name) {
    case 'gandalf': {
      const wis = heroStat(cat, hero, 'wisdom');
      abilityWeight = 45 + (activeHeroCount <= 2 ? 40 : 0) + Math.max(0, 3 - wis) * 20;
      break;
    }
    case 'aragorn': {
      const agi = heroStat(cat, hero, 'agility');
      abilityWeight = 45 + Math.max(0, 5 - agi) * 8 - (urgentPlot ? 35 : 0);
      break;
    }
    case 'boromir': {
      const str = heroStat(cat, hero, 'strength');
      abilityWeight = 20 + (finaleLooming(s) ? 35 : 0) + Math.max(0, 5 - str) * 6 - (urgentPlot ? 30 : 0);
      break;
    }
    case 'dain ii':
    case 'dain':
      abilityWeight = 15 + (finaleLooming(s) ? 55 : 0);
      break;
    case 'thranduil': {
      const flush = s.sauron.influence > 6;
      abilityWeight = s.sauron.influence <= 0 ? 0 : 12 + (urgentPlot ? 48 : 0) - (flush ? 25 : 0);
      break;
    }
    default:
      abilityWeight = 6; // e.g. Saruman: rarely worth it, but not impossible
  }
  abilityWeight = Math.max(0, abilityWeight);
  const p = abilityWeight / (abilityWeight + FAVOR_BASE);
  return rng() < p ? 'ability' : 'favor';
}

// Routing weights (all in "extra safe-steps" units, so they trade off against
// real distance): a human detours several safe hops rather than eat a peril,
// dodges monster-held nodes, and prefers matching-terrain moves (1 card) over
// burning any cards. Peril dominates because that is the corridor grind that
// grounds a lone hero down.
const PERIL_W = 3;   // entering a perilous node
const MONSTER_W = 2; // entering a node a monster/minion sits on (heroes gain nothing fighting)
const MISMATCH_W = 0.75; // a move with no matching-terrain card (must burn any card[s])
const CARD_COST_W = 1.5; // each extra card beyond the first on one move: cards are the heroes' only resource
// When several plots are affordable, a skilled hero does not blindly chase the
// single most-dangerous one: he weighs how EXPOSED the route to it is (peril and
// monster-held nodes accumulated along the weighted path) and will break a
// slightly-less-urgent plot reachable by a safe road instead of running a peril
// gauntlet. This scales that path-exposure against a plot's danger score.
const EXPOSURE_W = 25;

function nodePenalty(s: GameState, cat: Catalog, loc: LocationId, hero: HeroState): number {
  let p = 0;
  if (isPerilous(s, cat, loc, heroWisdom(cat, hero))) p += PERIL_W;
  // A real monster is a genuine obstacle. An unrevealed blank ("false rumor") is
  // indistinguishable from a monster to a hero, so it deters routing just the same
  // (the bluff) — but a blank the hero has SEEN (Argalad's Survivalist or a reveal
  // card) is known to be empty and no longer deters him.
  const mons = s.map.monstersAt[loc] ?? [];
  const realMon = mons.length > 0;
  const known = (s.map.revealedMonstersAt ?? []).includes(loc);
  const bluff = (s.map.rumorsAt?.[loc] ?? 0) > 0 && !known;
  if (realMon || bluff) p += MONSTER_W;
  // A minion is a far deadlier fight than a monster token: always detour around it
  // (a longer safe road beats a fight), and all the more with a thin life pool.
  if ((s.map.minionsAt?.[loc]?.length ?? 0) > 0) p += hero.life <= 6 ? 6 * MONSTER_W : 3 * MONSTER_W;
  // Any fight on a hurt hero is a likely defeat (which also feeds Sauron's marker).
  if (realMon && hero.life <= 6) p += 2 * MONSTER_W;
  return p;
}

/** Whether Sauron is close enough to a win that the heroes must press their plot
 *  race now, rather than pausing to bank cards: a leader marker near the Finale,
 *  or the laggard about to complete the "all three at the Shadow Falls" loss. */
function sauronThreatUrgent(s: GameState): boolean {
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  const max = Math.max(st.yellow, st.red, st.black);
  const min = Math.min(st.yellow, st.red, st.black);
  return max >= STORY_FINALE - 4 || min >= SHADOW_FALLS - 1;
}

/** Peril/monster-weighted distance from every node to the nearest target, via a
 *  Dijkstra expanding backward from `targets`. Entering a node costs 1 plus its
 *  peril/monster penalty; the target itself is never "entered" (dist 0). This is
 *  what lets the hero prefer a slightly longer SAFE route over the direct
 *  perilous corridor — the core human tactic. */
function weightedDistField(s: GameState, cat: Catalog, targets: Set<LocationId>, hero: HeroState): Map<LocationId, number> {
  const dist = new Map<LocationId, number>();
  const pq: { id: LocationId; d: number }[] = [];
  for (const t of targets) { dist.set(t, 0); pq.push({ id: t, d: 0 }); }
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[bi].d) bi = i;
    const { id, d } = pq.splice(bi, 1)[0];
    if (d > (dist.get(id) ?? Infinity)) continue;
    const stepInto = 1 + nodePenalty(s, cat, id, hero); // cost a neighbour pays to enter `id`
    for (const e of cat.edges) {
      const nb = e.a === id ? e.b : e.b === id ? e.a : null;
      if (!nb) continue;
      const nd = d + stepInto;
      if (nd < (dist.get(nb) ?? Infinity)) { dist.set(nb, nd); pq.push({ id: nb, d: nd }); }
    }
  }
  return dist;
}

/** Among the hero's currently-LEGAL moves, pick the first step of the best route
 *  to `targets` — weighting peril, monster-held nodes and card economy, not just
 *  raw hops. The hero thus weaves around the perilised corridor, dodges monsters
 *  and spends matching-terrain cards, only eating a peril when the detour would
 *  cost more than crossing it (or the target itself is perilous). Returns null if
 *  no legal move makes progress toward the target. */
function legalStepToward(s: GameState, cat: Catalog, hero: HeroState, targets: Set<LocationId>): LocationId | null {
  const field = weightedDistField(s, cat, targets, hero);
  const here = field.get(hero.location);
  if (here === undefined || !isFinite(here) || here === 0) return null;
  let best: LocationId | null = null;
  let bestScore = Infinity;
  for (const mv of aiMoves(cat, hero)) {
    const onward = field.get(mv.to);
    if (onward === undefined || onward >= here) continue; // must make progress
    const score = onward + 1 + nodePenalty(s, cat, mv.to, hero)
      + MISMATCH_W * (mv.viaAnyCards ? 1 : 0) + CARD_COST_W * (mv.cost - 1) + (mv.cost >= 3 ? 3 : 0)
      - (cat.locations[mv.to]?.kind === 'haven' ? 0.5 : 0); // prefer safe haven waypoints on ties
    if (score < bestScore) { bestScore = score; best = mv.to; }
  }
  return best;
}

const STAGE_III = 2 * STAGE_SIZE; // marker height at which a marker is one stage from the Finale
/** A hero at or below this many life cards stops to recover instead of marching on. */
const RECOVER_LIFE = 8;

/** Recovery for a hero whose life pool is nearly empty: rest (a Haven also heals real
 *  damage), or head for a Haven when the damage can only be healed there. Resting
 *  nudges Sauron's laggard marker, so it is only done when truly needed. */
function planRecover(s: GameState, cat: Catalog, hero: HeroState, reserve = 0): HeroAction | null {
  if (hero.life - reserve > (hero.id === 'thalin' ? RECOVER_LIFE - 2 : RECOVER_LIFE)) return null;
  const inHaven = cat.locations[hero.location].kind === 'haven';
  const damage = hero.damagePool.length, wear = hero.discard.length;
  if (damage + wear === 0) return null;
  const canRest = !hero.hasMovedThisTurn && !hero.restedThisTurn;
  const needsHaven = damage >= 2 && damage * 2 >= wear;
  if (canRest && (hero.id === 'beravor' || (needsHaven ? inHaven : wear >= 1 || inHaven))) return { kind: 'rest' };
  if (needsHaven && !inHaven && !hero.hasMovedThisTurn && hero.hand.length > 0) {
    const back = legalStepToward(s, cat, hero, nearestHavens(cat));
    if (back) return { kind: 'move', to: back };
  }
  return null;
}

/** A hero at or below this many life cards does not walk into a fight he can avoid. */
const LOW_LIFE = 10;

/** How urgently the heroes should break a plot, given the two ways Sauron ends
 *  the game: (A) any ONE marker reaches the Finale (18); (B) ALL THREE reach the
 *  Shadow Falls (10, the midpoint). Threat A is driven by the LEADER marker;
 *  threat B by the LAGGARD (the lowest marker is the bottleneck — once it hits
 *  the Falls, all three are there). A plot's danger is its per-turn advance
 *  scaled by how close whichever threat it feeds is to completing; the nearer
 *  the loss, the more decisive breaking that plot is. */
function plotDanger(st: { yellow: number; red: number; black: number }, marker: 'yellow' | 'red' | 'black', advance: number): number {
  const height = st[marker];
  const vals = [st.yellow, st.red, st.black];
  const maxM = Math.max(...vals), minM = Math.min(...vals);
  // Threat A — single marker to the Finale. Only the leader (or a marker level
  // with it) is racing; distance-to-finale sharpens the closer it gets.
  const threatA = Math.max(1, STORY_FINALE - maxM);
  const relA = height >= maxM - 1 ? 1 : 0.15;
  const dangerA = (advance * relA * 24) / threatA;
  // Threat B — all three to the Falls. The laggard gates it; keeping the lowest
  // marker down defends it. Only markers still below the Falls matter here.
  let dangerB = 0;
  if (height < SHADOW_FALLS) {
    const threatB = Math.max(1, SHADOW_FALLS - minM);
    const relB = height <= minM + 1 ? 1 : 0.3;
    dangerB = (advance * relB * 24) / threatB;
  }
  // A 3/turn plot is critical: it outranks anything else the party could break.
  return (dangerA + dangerB) * (advance >= 3 ? 2 : 1);
}

type ActivePlot = NonNullable<GameState['sauron']['activePlots']>[number];

/** Whether a plot deserves the heroes' favor and detours. Only the counters
 *  matter: 1/turn plots are not worth chasing or paying for (unless one more
 *  tick would reach the Finale); 2/turn plots are; 3/turn plots are critical. */
function plotWorthy(s: GameState, cat: Catalog, e: ActivePlot): boolean {
  const plot = cat.plots.find((p) => p.id === e.eventId);
  if (!plot) return false;
  const advance = plot.advance ?? 1;
  if (advance >= 2) return true;
  const marker = (plot.marker ?? 'red') as 'yellow' | 'red' | 'black';
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  return (st[marker] ?? 0) + advance >= STORY_FINALE;
}

function worthyPlots(s: GameState, cat: Catalog): ActivePlot[] {
  return (s.sauron.activePlots ?? []).filter((e) => plotWorthy(s, cat, e));
}

/** Co-located allies pool favor onto the active hero so he can break a plot he
 *  can't solo-afford. Heroes at the same location freely trade favor (rulebook
 *  p.24); this pulls exactly the shortfall from the richest willing ally (never
 *  draining one who might need it, and skipping Isolated heroes who can't trade).
 *  Returns a single trade — repeated calls chain across turns/steps until the
 *  active hero can afford the counter, then he breaks the plot. */
function planFavorPool(s: GameState, cat: Catalog, hero: HeroState, cost: number): HeroAction | null {
  const shortfall = cost - hero.favor;
  if (shortfall <= 0) return null;
  // A favor-gain cap (Corruption) would silently burn any traded favor above the
  // recipient's remaining allowance — cap the ask so an ally's favor is never wasted.
  let want = shortfall;
  const gainCap = corruptionFavorGainCap(cat, hero);
  if (gainCap !== undefined) {
    const remaining = gainCap - (hero.favorGainedThisTurn ?? 0);
    if (remaining <= 0) return null;
    want = Math.min(want, remaining);
  }
  const donors = otherHeroesHere(s, hero.id)
    .filter((a) => a.favor > 0 && !corruptionBlocksSocial(cat, a))
    .sort((a, b) => b.favor - a.favor);
  if (!donors.length) return null;
  const donor = donors[0];
  const n = Math.min(want, donor.favor);
  if (n <= 0) return null;
  return { kind: 'trade-favor', fromId: donor.id, toId: hero.id, n };
}

/** Multi-hero coordination — the core cooperative tactic experienced players use.
 *  Rather than every hero charging the single most-dangerous plot (double-teaming
 *  one break while other threats climb), assign each AFFORDABLE plot to the hero
 *  best placed to break it (least peril/monster-weighted distance), so the party
 *  COVERS several plots at once. Then, for the most dangerous plot that no single
 *  hero can solo-afford but the party's pooled favor CAN, converge the two nearest
 *  heroes on it (breaker + feeder) to meet and pool favor for a last-moment break
 *  (rulebook p.24 — heroes at one location trade favor freely). The plan is a
 *  deterministic function of shared state, so every hero derives the same
 *  assignment without communicating. Returns THIS hero's target (a plot location,
 *  or the plot-slot set for an off-board plot), or null when the hero has no plot
 *  role this step (it should bank favor instead). */
export function coordinatedPlotTarget(
  s: GameState, cat: Catalog, hero: HeroState,
  st: { yellow: number; red: number; black: number },
): Set<LocationId> | null {
  const active = worthyPlots(s, cat);
  if (!active.length) return null;
  const activeHeroes = s.heroes.filter((h) => h.status === 'active')
    .slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  if (activeHeroes.length <= 1) return null; // solo hero: nothing to coordinate
  const plotSlots = new Set<LocationId>(
    Object.values(cat.locations).filter((l) => l.plotSlot).map((l) => l.id),
  );
  const targetSetFor = (loc: LocationId | null) => (loc ? new Set<LocationId>([loc]) : plotSlots);
  type P = { loc: LocationId | null; cost: number; danger: number };
  const plots: P[] = [];
  for (const e of active) {
    const plot = cat.plots.find((p) => p.id === e.eventId);
    if (!plot) continue;
    const marker = (plot.marker ?? 'red') as 'yellow' | 'red' | 'black';
    plots.push({
      loc: (e.location ?? null) as LocationId | null,
      cost: plot.favorToCounter ?? 2,
      danger: plotDanger(st, marker, plot.advance ?? 1),
    });
  }
  if (!plots.length) return null;
  plots.sort((a, b) => b.danger - a.danger);

  // Peril fields are per-hero (they key off wisdom), so cache by hero + target.
  const distCache = new Map<string, number>();
  const distTo = (h: HeroState, loc: LocationId | null): number => {
    const ck = `${h.id}|${loc ?? '#slots'}`;
    let d = distCache.get(ck);
    if (d === undefined) {
      d = weightedDistField(s, cat, targetSetFor(loc), h).get(h.location) ?? Infinity;
      distCache.set(ck, d);
    }
    return d;
  };

  // 1. Split coverage: hand each affordable plot to its nearest still-free hero.
  const assign = new Map<HeroId, LocationId | null>();
  const used = new Set<HeroId>();
  for (const p of plots) {
    let best: HeroState | null = null;
    let bestD = Infinity;
    for (const h of activeHeroes) {
      if (used.has(h.id) || h.favor < p.cost) continue;
      const d = distTo(h, p.loc);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (best) { assign.set(best.id, p.loc); used.add(best.id); }
  }
  if (assign.has(hero.id)) return targetSetFor(assign.get(hero.id)!);

  // 2. Converge to pool: for EACH plot no one can solo-afford but the party's
  //    combined favor could cover, send its two nearest heroes to meet. Check
  //    every such plot (not just the single most-dangerous one) before giving
  //    up — a hero irrelevant to the top pooling target may still be one of
  //    the two nearest heroes to a lesser one, and bailing out on the first
  //    miss was silently abandoning those plots to advance uncontested.
  const partyFavor = activeHeroes
    .filter((h) => !corruptionBlocksSocial(cat, h))
    .reduce((n, h) => n + h.favor, 0);
  for (const p of plots) {
    if (activeHeroes.some((h) => h.favor >= p.cost)) continue; // someone can solo it
    if (partyFavor < p.cost) continue; // pooling still can't cover it — bank favor
    const team = activeHeroes.slice()
      .sort((a, b) => distTo(a, p.loc) - distTo(b, p.loc))
      .slice(0, 2);
    if (team.some((h) => h.id === hero.id)) return targetSetFor(p.loc);
  }
  // 3. Spare hero with favor in hand: favor has no use beyond breaking plots (and
  //    is easy to lose), so rather than wandering off to farm more, head for the
  //    nearest affordable plot — preferring one no other hero is already covering.
  const covered = new Set<LocationId | null>(assign.values());
  let spare: { p: P; d: number; free: boolean } | null = null;
  for (const p of plots) {
    if (hero.favor < p.cost) continue;
    const d = distTo(hero, p.loc);
    if (!Number.isFinite(d)) continue;
    const free = !covered.has(p.loc);
    if (!spare || (free && !spare.free) || (free === spare.free && d < spare.d)) spare = { p, d, free };
  }
  if (spare) return targetSetFor(spare.p.loc);
  return null;
}

/** Breaking Sauron's plots is THE hero win path: if his colored markers fill he
 *  wins, and if the heroes never counter plots they almost never win. This plans
 *  the best plot-breaking action for the hero:
 *   - counter a plot now if standing on it (or on a plot slot for off-board
 *     plots) AND it is affordable;
 *   - otherwise take the legal step that moves closest to the most dangerous
 *     affordable plot's location.
 *  Danger is ranked by proximity to the two loss conditions — a single marker at
 *  the Finale, or all three at the Shadow Falls (see plotDanger). Returns null
 *  when no plot is affordable/reachable. */
function planPlotCounter(s: GameState, cat: Catalog, hero: HeroState): HeroAction | null {
  const active = worthyPlots(s, cat);
  if (!active.length) return null;
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  // Standing on a counterable plot is the highest-value action: counter it now if
  // affordable, otherwise pull the favor shortfall from a co-located ally (heroes
  // freely trade favor, rulebook p.24) — the "break a plot with pooled favour at
  // the last moment" tactic. This must precede the affordability filter below so
  // it still fires when no single hero can solo-afford the break.
  {
    const here = targetablePlot(s, cat, hero.id);
    if (here && plotWorthy(s, cat, here)) {
      const hp = cat.plots.find((p) => p.id === here.eventId);
      const cost = hp?.favorToCounter ?? 2;
      if (hero.favor >= cost) return { kind: 'counter-plot' };
      const pool = planFavorPool(s, cat, hero, cost);
      if (pool) return pool;
    }
  }
  // Multi-hero coordination: split plot coverage across the party / converge a
  // feeder on an urgent pooled break (see coordinatedPlotTarget). Replaces the
  // independent per-hero targeting below so heroes don't all chase one plot.
  if (s.heroes.filter((h) => h.status === 'active').length > 1) {
    const target = coordinatedPlotTarget(s, cat, hero, st);
    if (target) {
      const step = legalStepToward(s, cat, hero, target);
      if (step) return { kind: 'move', to: step, plan: planOf(target) };
    }
    return null; // no productive plot step this turn — the caller banks favor
  }
  const plotSlots = new Set<LocationId>(
    Object.values(cat.locations).filter((l) => l.plotSlot).map((l) => l.id),
  );
  type Cand = { loc: LocationId | null; cost: number; urgency: number };
  const cands: Cand[] = [];
  for (const e of active) {
    const plot = cat.plots.find((p) => p.id === e.eventId);
    if (!plot) continue;
    const cost = plot.favorToCounter ?? 2;
    if (hero.favor < cost) continue; // unaffordable — earn favor first (handled by caller)
    const marker = (plot.marker ?? 'red') as 'yellow' | 'red' | 'black';
    const advance = plot.advance ?? 1;
    const loc = (e.location ?? null) as LocationId | null;
    // Path exposure: the weighted cost (peril + monster/bluff nodes) to reach the
    // plot from where the hero stands — 0 if already on it. Deducted so that, all
    // else near-equal, the hero breaks the plot he can reach with the least risk.
    const field = weightedDistField(s, cat, loc ? new Set<LocationId>([loc]) : plotSlots, hero);
    const exposure = field.get(hero.location) ?? 0;
    // danger dominates; path exposure steers among comparable plots; favor cost is
    // a mild tiebreak (prefer cheaper breaks).
    cands.push({ loc, cost, urgency: plotDanger(st, marker, advance) * 100 - EXPOSURE_W * exposure - cost });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.urgency - a.urgency);
  // (on-plot counter / favour-pooling is handled at the top of this function.)
  // step toward the most dangerous candidate's location
  const best = cands[0];
  const targets = best.loc ? new Set<LocationId>([best.loc]) : plotSlots;
  const step = legalStepToward(s, cat, hero, targets);
  return step ? { kind: 'move', to: step, plan: planOf(targets) } : null;
}

const SLOTS_KEY = '#slots';
function planOf(targets: Set<LocationId>): { key: string; targets: string[] } {
  return { key: targets.size === 1 ? [...targets][0] : SLOTS_KEY, targets: [...targets] };
}

/** The destination this hero already set out for, while it is still worth reaching:
 *  the plot is still in play and he has not arrived. */
function heldTargets(s: GameState, cat: Catalog, hero: HeroState): Set<LocationId> | null {
  const p = hero.aiPlan;
  if (!p) return null;
  if (!worthyPlots(s, cat).some((e) => (e.location ?? SLOTS_KEY) === p.key)) return null;
  if (p.key !== SLOTS_KEY && hero.location === p.key) return null;
  return new Set(p.targets);
}

/** Dry-run of the trip toward `targets` with the cards actually in hand: each hop
 *  spends a matching-terrain card if one is left, else the path's any-card cost.
 *  Returns the cards the trip will burn and how many foes stand on the way, so the
 *  go / recover-first decision is made once, up front, on the true arrival state. */
function projectTrip(s: GameState, cat: Catalog, hero: HeroState, targets: Set<LocationId>): { cards: number; foes: number } {
  const field = weightedDistField(s, cat, targets, hero);
  const terrains = terrainsInHand(cat, hero);
  let loc = hero.location, cards = 0, foes = 0;
  const seen = new Set<LocationId>([loc]);
  for (let hop = 0; hop < 14 && !targets.has(loc); hop++) {
    let best: { to: LocationId; terrain: Terrain; cost: number } | null = null, bestScore = Infinity;
    for (const e of neighbors(cat, loc)) {
      const to = otherEnd(e, loc);
      const d = field.get(to);
      if (d === undefined || seen.has(to) || d >= (field.get(loc) ?? Infinity)) continue;
      if (d < bestScore) { bestScore = d; best = { to, terrain: e.terrain, cost: Math.max(1, e.cost || 1) }; }
    }
    if (!best) break;
    const i = terrains.indexOf(best.terrain);
    if (i >= 0) { terrains.splice(i, 1); cards += 1; } else cards += best.cost;
    if ((s.map.monstersAt[best.to]?.length ?? 0) + (s.map.minionsAt?.[best.to]?.length ?? 0) > 0) foes++;
    seen.add(best.to); loc = best.to;
  }
  return { cards, foes };
}

/** Consulting a Character present at the hero's location yields +2 favor (Eleanor
 *  +1 more) — the heroes' richest, most reliable favor source and the classic
 *  "ask the characters for favours" tactic experienced players lean on. Worth an
 *  action whenever there is a plot race to fund AND favor is the actual
 *  bottleneck (the hero cannot yet afford the cheapest active plot's counter).
 *  Skips a Character whose consult would self-corrupt (an active corruption plot
 *  taints them) and Isolated heroes (who may not consult). */
function planConsult(s: GameState, cat: Catalog, hero: HeroState): HeroAction | null {
  const active = worthyPlots(s, cat);
  if (!active.length) return null; // no plot race → no favor need
  if (corruptionBlocksSocial(cat, hero)) return null; // Isolated: cannot consult
  const cheapest = Math.min(
    ...active.map((e) => cat.plots.find((p) => p.id === e.eventId)?.favorToCounter ?? 2),
  );
  if (hero.favor >= cheapest) return null; // already able to break a plot — don't burn the token
  for (const c of charactersHere(s, hero.id)) {
    if (consultWouldCorrupt(s, c)) continue;
    // With a plot worth breaking and not enough favor, favor is the point of the consult.
    return { kind: 'consult', character: c, choice: 'favor' };
  }
  return null;
}

/** True when Sauron has an active plot the heroes ought to break but this hero
 *  can't yet afford — a cue to go earn favor (explore) rather than idle. */
function urgentUnaffordablePlot(s: GameState, cat: Catalog, hero: HeroState): boolean {
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  for (const e of worthyPlots(s, cat)) {
    const plot = cat.plots.find((p) => p.id === e.eventId);
    if (!plot) continue;
    const cost = plot.favorToCounter ?? 2;
    if (hero.favor >= cost) continue;
    const marker = (plot.marker ?? 'red') as 'yellow' | 'red' | 'black';
    if ((st[marker] ?? 0) >= STAGE_III - 4) return true;
  }
  return false;
}

/** Resting (and being defeated) advances Sauron's most-behind marker one space —
 *  which is exactly how the "all three markers reach the Shadow Falls" loss
 *  completes. Once his laggard is climbing into the Falls, every rest hands him
 *  progress on that threat, so the heroes should rest only when truly desperate. */
function restAdvancesThreatB(s: GameState): boolean {
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  return Math.min(st.yellow, st.red, st.black) >= SHADOW_FALLS - 3;
}

/** Favor is the currency that breaks plots, and plots are the win path, so the
 *  heroes must bank favor. Favor tokens sit on the board (every Haven starts with
 *  one; event cards add more). This retrieves the token underfoot, or — when
 *  Sauron has plots to break — steps (on a peril/monster-weighted route) toward
 *  the nearest favor token. Returns null when there is nothing to gain. */
function planEarnFavor(s: GameState, cat: Catalog, hero: HeroState): HeroAction | null {
  if (favorHere(s, hero.id) > 0) return { kind: 'retrieve-favor' };
  const active = worthyPlots(s, cat);
  if (!active.length) return null; // no plots worth breaking => no urgency
  const tokenLocs = Object.entries(s.map.favorAt ?? {})
    .filter(([, n]) => (n ?? 0) > 0).map(([l]) => l as LocationId);
  // A Character to consult is worth +2 favor, as good as a token or two.
  if (!corruptionBlocksSocial(cat, hero)) {
    for (const [l, cs] of Object.entries(s.map.charactersAt ?? {})) {
      if (cs.some((c) => !consultWouldCorrupt(s, c))) tokenLocs.push(l as LocationId);
    }
  }
  const targets = new Set(tokenLocs);
  targets.delete(hero.location);
  if (!targets.size) return null;
  const step = legalStepToward(s, cat, hero, targets);
  return step ? { kind: 'move', to: step } : null;
}

/** Proactive play while no plot demands a response (e.g. the first turns): work
 *  the hero's Starting/Advanced quest, bank favor tokens, consult Characters for
 *  favor, and otherwise stage toward the locations plots are fixed on, instead of
 *  shuttling between havens. Returns null when there is nothing productive. */
function planPrepare(s: GameState, cat: Catalog, hero: HeroState, rng: Rng): HeroAction | null {
  const inHaven = cat.locations[hero.location].kind === 'haven';
  if (inHaven && !hero.hasMovedThisTurn && !hero.restedThisTurn && (hero.corruption > 1 || hero.damagePool.length > 1)) return null;
  const social = !corruptionBlocksSocial(cat, hero);
  if (social && hero.favor < 5) {
    for (const c of charactersHere(s, hero.id)) {
      if (!consultWouldCorrupt(s, c)) return { kind: 'consult', character: c, choice: pickConsultChoice(s, cat, hero, c, rng) };
    }
  }
  // Favor first (tokens, Characters): it is what breaks plots. Quests are only about
  // getting stronger — and often a fight — so they come after the favor trail runs dry.
  const goals = new Set<LocationId>();
  for (const [l, n] of Object.entries(s.map.favorAt ?? {})) if ((n ?? 0) > 0) goals.add(l as LocationId);
  if (social && hero.favor < 5) {
    for (const [l, cs] of Object.entries(s.map.charactersAt ?? {})) {
      if (cs.some((c) => !consultWouldCorrupt(s, c))) goals.add(l as LocationId);
    }
  }
  goals.delete(hero.location);
  const toGoal = goals.size ? legalStepToward(s, cat, hero, goals) : null;
  if (toGoal) return { kind: 'move', to: toGoal };
  const questLocs = Object.entries(s.map.questAt ?? {})
    .filter(([, ids]) => ids.includes(hero.id)).map(([l]) => l as LocationId);
  const healthy = hero.life > LOW_LIFE + 4;
  if (healthy && questLocs.includes(hero.location) && canExplore(s, cat, hero.id)) return { kind: 'explore' };
  const questGoals = new Set(questLocs);
  questGoals.delete(hero.location);
  const toQuest = healthy && questGoals.size ? legalStepToward(s, cat, hero, questGoals) : null;
  if (toQuest) return { kind: 'move', to: toQuest };
  // Nothing to collect: approach the places Sauron's plots are tied to.
  const plotZones = new Set<LocationId>(
    cat.plots.map((p) => p.affects as LocationId).filter((l) => !!l && !!cat.locations[l] && l !== hero.location),
  );
  const toZone = plotZones.size ? legalStepToward(s, cat, hero, plotZones) : null;
  return toZone ? { kind: 'move', to: toZone } : null;
}

// ---- strategies --------------------------------------------------------
/** Pure random walk: legal but unguided — the noise-floor baseline. */
export const randomWalk: HeroStrategy = {
  name: 'random-walk',
  combatOption: (_s, _cat, opts, rng) => pick(rng, opts).id,
  encounterOption: (_s, opts, rng) => {
    const enabled = opts.map((o, i) => ({ o, i })).filter((x) => x.o.enabled);
    return enabled.length ? pick(rng, enabled).i : 0;
  },
  heroAction: (s, cat, heroId, rng) => {
    const hero = s.heroes.find((h) => h.id === heroId)!;
    const acts: HeroAction[] = [];
    const foes = engageableMonsters(s, heroId);
    for (const m of foes) acts.push({ kind: 'engage', monsterId: m });
    if (canExplore(s, cat, heroId)) acts.push({ kind: 'explore' });
    for (const mv of aiMoves(cat, hero)) acts.push({ kind: 'move', to: mv.to });
    if (cat.locations[hero.location].kind === 'haven' && !hero.restedThisTurn && !hero.hasMovedThisTurn) acts.push({ kind: 'rest' });
    acts.push({ kind: 'end' });
    return pick(rng, acts);
  },
};

/** Heuristic play: fight monsters that block the way, explore for rewards, push
 *  toward havens (favor/allies, plot-breaking), and rest when corruption bites. */
export const heuristic: HeroStrategy = {
  name: 'heuristic',
  combatOption: (_s, _cat, opts) => opts[0].id, // engine orders best-first
  encounterOption: (_s, opts) => firstEnabled(opts),
  heroAction: (s, cat, heroId) => {
    const hero = s.heroes.find((h) => h.id === heroId)!;
    const foes = engageableMonsters(s, heroId);
    if (foes.length) return { kind: 'engage', monsterId: foes[0] };
    // breaking plots is the win path: counter one here, or step toward it
    const plot = planPlotCounter(s, cat, hero);
    if (plot) return plot;
    // can't break a plot yet — bank favor (retrieve tokens / step toward one)
    const earn = planEarnFavor(s, cat, hero);
    if (earn) return earn;
    // an urgent plot we can't afford yet → go earn favor by exploring
    if (urgentUnaffordablePlot(s, cat, hero) && canExplore(s, cat, heroId)) return { kind: 'explore' };
    // rest if badly corrupted or hurt while sitting in a haven — but resting
    // advances Sauron's laggard marker, so demand a higher bar once that would
    // feed the "all three at the Falls" loss.
    const corrBar = restAdvancesThreatB(s) ? 3 : 1;
    const hurtBar = restAdvancesThreatB(s) ? 4 : 2;
    if (!hero.restedThisTurn && !hero.hasMovedThisTurn && cat.locations[hero.location].kind === 'haven' && (hero.corruption > corrBar || hero.damagePool.length > hurtBar)) {
      return { kind: 'rest' };
    }
    // Travel as far as the hand allows BEFORE taking the terminal Encounter step
    // (Explore): the Travel step repeats until out of cards (rulebook p.22).
    const moves = aiMoves(cat, hero);
    if (moves.length) {
      // hunt nearby monsters first, else head for the nearest haven
      const monsterLocs = new Set<LocationId>(
        Object.entries(s.map.monstersAt).filter(([, m]) => m.length).map(([l]) => l),
      );
      const goal = monsterLocs.size
        ? bfsFirstStep(cat, hero.location, monsterLocs)
        : bfsFirstStep(cat, hero.location, nearestHavens(cat));
      const target = moves.find((m) => m.to === goal) ?? moves[0];
      return { kind: 'move', to: target.to };
    }
    // Out of moves: take the Encounter step (ends the turn) or end.
    if (canExplore(s, cat, heroId)) return { kind: 'explore' };
    if (!hero.restedThisTurn && !hero.hasMovedThisTurn && cat.locations[hero.location].kind === 'haven') return { kind: 'rest' };
    return { kind: 'end' };
  },
};

/** Cautious play: like heuristic but avoids stepping into influenced (perilous)
 *  nodes when a safer legal move exists, and rests more readily. */
export const cautious: HeroStrategy = {
  name: 'cautious',
  combatOption: (_s, _cat, opts) => opts[0].id,
  encounterOption: (_s, opts) => firstEnabled(opts),
  heroAction: (s, cat, heroId, rng) => {
    const base = heuristic.heroAction(s, cat, heroId, rng);
    if (base.kind !== 'move') return base;
    const hero = s.heroes.find((h) => h.id === heroId)!;
    if (cat.locations[hero.location].kind === 'haven' && !hero.restedThisTurn && !hero.hasMovedThisTurn && !restAdvancesThreatB(s) && (hero.corruption > 0 || hero.damagePool.length > 0)) {
      return { kind: 'rest' };
    }
    const influenced = (loc: LocationId) => (s.sauron.locationInfluence?.[loc] ?? 0) > 0;
    if (influenced(base.to)) {
      const safe = aiMoves(cat, hero).filter((m) => !influenced(m.to));
      if (safe.length) return { kind: 'move', to: safe[0].to };
    }
    return base;
  },
};

export const STRATEGIES: Record<string, HeroStrategy> = {
  'random-walk': randomWalk, heuristic, cautious,
};

/** Whether stepping onto `loc` means a fight: a minion, monster token or
 *  unrevealed rumor (indistinguishable from a monster to the hero) sits there. */
function fightAhead(s: GameState, _hero: HeroState, loc: LocationId): boolean {
  const known = (s.map.revealedMonstersAt ?? []).includes(loc);
  return (s.map.monstersAt[loc]?.length ?? 0) > 0
    || (s.map.minionsAt?.[loc]?.length ?? 0) > 0
    || ((s.map.rumorsAt?.[loc] ?? 0) > 0 && !known);
}

/** Mission-aware play: reads the scenario's hero win condition and biases the
 *  heuristic toward it. For a corruption-cap mission (e.g. Noble Blood) it
 *  avoids needless combat and cleanses aggressively; for monster/minion-cap
 *  missions it hunts; otherwise it seeks favor by exploring. This is the hook
 *  the simulations pointed at — the "best" line depends on the mission. */
export const missionAware: HeroStrategy = {
  name: 'mission-aware',
  combatOption: (s, cat, opts, rng) => solveCombatOption(s, cat, opts, rng),
  encounterOption: (_s, opts) => firstEnabled(opts),
  heroAction: (s, cat, heroId, rng) => {
    const kind = cat.heroMissions[s.secretHeroMission ?? cat.scenario.heroMission]?.condition?.kind ?? '';
    const hero = s.heroes.find((h) => h.id === heroId)!;
    const inHaven = cat.locations[hero.location].kind === 'haven';
    // Argalad's Survivalist (free, once/turn): scout the face-down tokens in an
    // adjacent location to tell a real monster from a false rumor. Knowing a token
    // is blank lets him route THROUGH the bluff instead of around it. Always worth
    // it when adjacent tokens are unrevealed — it costs no action.
    if (canSurvey(s, cat, heroId)) return { kind: 'survey' };
    // breaking plots is the win path — pursue it before mission-specific play
    const plot0 = planPlotCounter(s, cat, hero);
    if (plot0 && (plot0.kind === 'counter-plot' || plot0.kind === 'trade-favor')) return plot0;
    // Commitment: a hero already under way keeps his destination (and the route he
    // sized up when he left) until the plot is gone or he arrives. The go / recover-
    // first call is made ONCE, before departing, on the cards the trip will burn —
    // never re-made mid-trip just because the trip itself spent cards.
    const held = plot0 && plot0.kind === 'move' ? heldTargets(s, cat, hero) : null;
    let plot: HeroAction | null = plot0;
    let reserve = 0;
    if (held) {
      const st0 = legalStepToward(s, cat, hero, held);
      if (st0) plot = { kind: 'move', to: st0, plan: hero.aiPlan };
    } else if (plot0 && plot0.kind === 'move' && plot0.plan) {
      const trip = projectTrip(s, cat, hero, new Set(plot0.plan.targets));
      reserve = trip.foes > 0 ? 3 : 0;
    }
    // Arrived at a Haven this turn: stop there. Cards in hand are the heroes' only
    // resource, and a haven is safe (no Shadow cards, better location cards, rest/heal).
    // Don't keep marching (spending more cards) unless Sauron is near a win.
    if (plot && plot.kind === 'move' && inHaven && hero.hasMovedThisTurn && !hero.restedThisTurn && !sauronThreatUrgent(s)) {
      return { kind: 'end' };
    }
    // A hero running on empty (travel and encounters drain the life pool) cannot march
    // or survive the Encounter step: recover before anything else.
    const recover = held ? null : planRecover(s, cat, hero, reserve);
    if (recover) return recover;
    // Fighting is never a goal: it is only the toll on the road to a plot. A hurt hero
    // does not pay it — he recovers first (rest anywhere for wear, in a Haven for real
    // damage) and, if he cannot, simply stops here rather than walking into the fight.
    // Thalin the dwarf keeps fighting on even without killing his foe, so he tolerates more.
    if (!held && plot && plot.kind === 'move' && fightAhead(s, hero, plot.to)) {
      if (hero.life <= (hero.id === 'thalin' ? LOW_LIFE - 2 : LOW_LIFE)) {
        const canRest = !hero.hasMovedThisTurn && !hero.restedThisTurn;
        const damage = hero.damagePool.length, wear = hero.discard.length;
        // Mostly wear (rest pool) -> a plain rest recycles it anywhere. Real damage
        // -> only a Haven rest heals it, so it is worth the trip.
        const needsHeal = damage >= 2 && damage * 2 >= wear;
        // Beravor heals anywhere when resting (or trains if unhurt), so she always rests.
        if (canRest && (hero.id === 'beravor' ? damage + wear >= 1 : needsHeal ? inHaven : wear >= 1 || damage >= 1)) return { kind: 'rest' };
        if (needsHeal && !inHaven && !hero.hasMovedThisTurn) {
          const back = legalStepToward(s, cat, hero, nearestHavens(cat));
          if (back) return { kind: 'move', to: back };
        }
        if (hero.hasMovedThisTurn && !sauronThreatUrgent(s)) return { kind: 'end' };
      }
    }
    // Fund the plot race: consulting a co-located Character for favor (the classic
    // "ask the characters for favours" tactic) is the heroes' best favor source —
    // do it before marching when favor is the bottleneck.
    const consult = planConsult(s, cat, hero);
    if (consult) return consult;
    if (plot) return plot;
    const earn = planEarnFavor(s, cat, hero);
    if (earn) return earn;
    const prep = planPrepare(s, cat, hero, rng);
    if (prep) return prep;
    // Card-conserving haven-hopping (user tactic): with nothing productive to
    // chase, and already hopped to a haven this turn, bank the remaining cards
    // and END here (hand is additive/no discard; havens are safe from shadow and
    // peril) rather than burning cards to stop exposed in the open — unless
    // Sauron is near a win (then tempo beats card economy).
    if (inHaven && hero.hasMovedThisTurn && hero.corruption === 0 && hero.damagePool.length === 0
        && !sauronThreatUrgent(s) && !hero.restedThisTurn) {
      return { kind: 'end' };
    }

    if (kind === 'heroCorruptionAtMost') {
      // purity race: cleanse in havens, shun avoidable danger, don't pick fights.
      // Resting feeds Sauron's laggard, so near the Falls only rest when it matters.
      const restBar = restAdvancesThreatB(s) ? 1 : 0;
      if (inHaven && !hero.hasMovedThisTurn && (hero.corruption > restBar || hero.damagePool.length > restBar)) return { kind: 'rest' };
      // Head for a haven to cleanse, weaving around peril/monsters (peril-aware
      // routing) rather than marching straight through the influenced corridor.
      const havenStep = legalStepToward(s, cat, hero, nearestHavens(cat));
      if (havenStep) return { kind: 'move', to: havenStep };
      const influenced = (loc: LocationId) => (s.sauron.locationInfluence?.[loc] ?? 0) > 0;
      const moves = aiMoves(cat, hero);
      const safe = moves.filter((m) => !influenced(m.to) && !fightAhead(s, hero, m.to));
      const pool = (hero.corruption > 0 ? safe : moves.filter((m) => !fightAhead(s, hero, m.to)));
      const target = pool[0];
      if (target) return { kind: 'move', to: target.to };
      return inHaven && !hero.hasMovedThisTurn ? { kind: 'rest' } : { kind: 'end' };
    }
    if (kind === 'monstersAtMost' || kind === 'minionsAtMost') {
      // The secret mission is the second priority: hunt only a healthy hero's neighbours,
      // and only while no plot worth breaking is pulling him elsewhere (we are past `plot`).
      const foes = engageableMonsters(s, heroId);
      if (foes.length && hero.life > LOW_LIFE) return { kind: 'engage', monsterId: foes[0] };
    }
    if ((kind === 'heroFavorAtLeast' || kind === 'allQuestsComplete') && hero.life > LOW_LIFE
        && canExplore(s, cat, heroId) && !fightAhead(s, hero, hero.location)) {
      return { kind: 'explore' }; // favor/quests come from encounters
    }
    return idlePlay(s, cat, hero);
  },
};

/** Tertiary play, when no plot or mission step applies: get stronger for the next
 *  plot — heal in a Haven, explore (favor, cards, quests) where it is quiet, or move
 *  toward the nearest Haven — never hunting monsters. */
function idlePlay(s: GameState, cat: Catalog, hero: HeroState): HeroAction {
  const inHaven = cat.locations[hero.location].kind === 'haven';
  if (inHaven && !hero.hasMovedThisTurn && !hero.restedThisTurn
      && (hero.corruption > 0 || hero.damagePool.length > 0 || hero.discard.length > 1)) return { kind: 'rest' };
  if (canExplore(s, cat, hero.id) && hero.life > LOW_LIFE && !fightAhead(s, hero, hero.location)) return { kind: 'explore' };
  const step = legalStepToward(s, cat, hero, nearestHavens(cat));
  if (step && !fightAhead(s, hero, step)) return { kind: 'move', to: step };
  if (!hero.restedThisTurn && !hero.hasMovedThisTurn && (inHaven || hero.discard.length > 1)) return { kind: 'rest' };
  return { kind: 'end' };
}

STRATEGIES['mission-aware'] = missionAware;

// ---- driver ------------------------------------------------------------
export interface PlayoutResult {
  winner: 'Hero' | 'Sauron' | null;
  reason: string;
  turns: number;
  steps: number;
  combatBouts: number;
  perils: number;
  shadowPlays: number;
  plotMoves: number;
  finalCorruption: number;
  finalFavor: number;
}

/** Run one full game to completion with `strat` driving the heroes and the
 *  built-in Lidless Eye driving Sauron. Deterministic for a fixed (seed, strat). */
export function playoutGame(
  cat: Catalog, seed: number, strat: HeroStrategy, maxSteps = 20000,
  opts?: { heroIds?: HeroId[]; doctrine?: SauronDoctrine },
): PlayoutResult {
  let s = newGame(cat, seed, opts?.heroIds);
  if (opts?.doctrine) s.sauron.doctrine = opts.doctrine;
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let steps = 0;
  while (!s.winner && steps < maxSteps) {
    steps++;
    if (s.pendingChoice) { s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); continue; }
    if (s.pendingCombat && !s.pendingTree) { continue; }
    if (s.pendingTree) { s = autoResolvePendingTree(s, cat); continue; }
    if (s.pendingEncounter) {
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      const act = strat.heroAction(s, cat, hero.id, rng);
      s = applyHeroAction(s, cat, hero.id, act);
      continue;
    }
    s = advance(s, cat);
  }
  const detail = (needle: string) => s.log.filter((e) => e.detail?.includes(needle)).length;
  return {
    winner: s.winner ?? null,
    reason: s.winReason ?? '(unfinished)',
    turns: s.story.turn,
    steps,
    combatBouts: s.log.filter((e) => e.type === 'combat-bout').length,
    perils: detail('peril '),
    shadowPlays: detail('shadow '),
    plotMoves: detail('plot '),
    finalCorruption: s.heroes.reduce((n, h) => n + h.corruption, 0),
    finalFavor: s.heroes.reduce((n, h) => n + h.favor, 0),
  };
}

export function applyHeroAction(s: GameState, cat: Catalog, heroId: HeroId, act: HeroAction): GameState {
  act = coerceHeroAction(s, cat, heroId, act);
  if (act.kind !== 'move' && act.kind !== 'end') {
    const h = s.heroes.find((x) => x.id === heroId);
    if (h?.travelPath?.length) { s = clone(s); s.heroes.find((x) => x.id === heroId)!.travelPath = []; }
  }
  switch (act.kind) {
    case 'engage': return heroEngage(s, cat, heroId, act.monsterId);
    case 'explore': return heroExplore(s, cat, heroId);
    case 'move': {
      const r = heroMove(s, cat, heroId, act.to);
      const h = r.heroes.find((x) => x.id === heroId);
      if (h && act.plan && h.location === act.to) h.aiPlan = act.plan;
      return r;
    }
    case 'rest': { const r = heroRest(s, cat, heroId); const h = r.heroes.find((x) => x.id === heroId); if (h) delete h.aiPlan; return r; }
    case 'counter-plot': return heroDiscardPlot(s, cat, heroId);
    case 'retrieve-favor': return heroRetrieveFavor(s, cat, heroId);
    case 'consult': return heroConsultCharacter(s, cat, heroId, act.character, act.choice);
    case 'survey': return heroSurvey(s, cat, heroId);
    case 'trade-favor': return heroTradeFavor(s, cat, act.fromId, act.toId, act.n);
    case 'end': return endHeroActions(s, cat);
  }
}

/** Plain-language description of what an AI hero is about to do (shown to a
 *  human Sauron, who steps the heroes' turns one action at a time). */
export function describeHeroAction(s: GameState, cat: Catalog, heroId: HeroId, raw: HeroAction): string {
  const act = coerceHeroAction(s, cat, heroId, raw);
  const hero = s.heroes.find((h) => h.id === heroId)!;
  const name = cat.heroes[heroId]?.name ?? heroId;
  const loc = (id: string) => cat.locations[id]?.name ?? id;
  const here = loc(hero.location);
  switch (act.kind) {
    case 'move': return `${name} travels from ${here} to ${loc(act.to)}.`;
    case 'explore': return `${name} explores ${here} (draws Encounter cards).`;
    case 'engage': {
      const foe = cat.monsters[act.monsterId]?.name ?? cat.minions[act.monsterId]?.name ?? 'a foe';
      return `${name} engages ${foe} at ${here}.`;
    }
    case 'rest': return `${name} rests at ${here}.`;
    case 'counter-plot': return `${name} spends favor to counter a plot at ${here}.`;
    case 'retrieve-favor': return `${name} picks up a favor token at ${here}.`;
    case 'consult': return `${name} consults ${act.character} at ${here} (${act.choice === 'ability' ? 'ability' : 'favor'}).`;
    case 'survey': return `${name} surveys (looks at) Sauron's board information.`;
    case 'trade-favor': return `${name} passes favor to ${cat.heroes[act.toId]?.name ?? act.toId}.`;
    case 'end': return `${name} ends the turn${hero.encounterStepDone ? '' : ' (then draws Encounter cards if the location is not perilous)'}.`;
  }
}

function coerceHeroAction(s: GameState, cat: Catalog, heroId: HeroId, act: HeroAction): HeroAction {
  const hero = s.heroes.find((h) => h.id === heroId)!;
  // Rest is a once-per-turn step (rulebook p.20): if the hero has already rested,
  // there is nothing more to rest for — end the turn instead of repeating it.
  if (act.kind === 'rest' && hero.restedThisTurn) act = { kind: 'end' };
  // The Encounter step needs something to draw; otherwise fall through to ending.
  if (act.kind === 'explore' && !canExplore(s, cat, heroId)) act = { kind: 'end' };
  // Ambush: while a foe stands on the hero, Travel is illegal — coerce any
  // move/explore/counter-plot/retrieve-favor/consult into engaging the foe
  // first (rules-faithful; requireHeroTurn in economy.ts rejects ALL of these
  // with an "Ambush" error otherwise — 'consult' was missing here and could
  // throw an uncaught exception whenever an AI-controlled hero shared its
  // ambushed location with a Character token, crashing the game/validator).
  if (ambushPending(s, hero, cat)
    && (act.kind === 'move' || act.kind === 'explore' || act.kind === 'counter-plot'
      || act.kind === 'retrieve-favor' || act.kind === 'consult')) {
    const foes = engageableMonsters(s, heroId);
    if (foes.length) act = { kind: 'engage', monsterId: foes[0] };
  }
  // A card-forced fight (Flocks of Crebain, Seem Fairer Feel Fouler) must happen
  // before anything else, including resting, surveying or simply ending the turn.
  if (hero.forcedFoe && act.kind !== 'engage' && s.map.monstersAt[hero.location]?.includes(hero.forcedFoe)) {
    const foes = engageableMonsters(s, heroId);
    const foe = foes.includes(hero.forcedFoe) ? hero.forcedFoe : foes[0];
    if (foe) act = { kind: 'engage', monsterId: foe };
  }
  return act;
}

/** M15: drive the AI-controlled hero side one full "half turn" — from the start
 *  of the heroes' turn until control passes back to Sauron (or the game ends).
 *  Used when a human plays Sauron: the heroes act autonomously via `strat`.
 *
 *  `isAiHero` lets a caller mix AI- and human-controlled heroes in the same
 *  game (online multiplayer, where individual hero roles may be claimed by
 *  real players while others are left to the AI): whenever the hero whose
 *  decision is next due is NOT AI-controlled, the loop stops and returns
 *  control to the caller instead of acting on that hero's behalf — the
 *  human's own dispatched actions (via the normal UI/network path) take it
 *  from there. Defaults to "every hero is AI" (solo-vs-human-Sauron mode). */
export function advanceHeroSide(
  s: GameState, cat: Catalog, strat: HeroStrategy, rng: Rng,
  isAiHero: (heroId: HeroId) => boolean = () => true, maxSteps = 5000,
  /** When given, the loop stops BEFORE applying the next AI hero action and
   *  reports it here (for a human Sauron who steps the heroes one action at a time). */
  peek?: { heroId?: HeroId; act?: HeroAction },
): GameState {
  let steps = 0;
  while (!s.winner && s.activeSide === 'Hero' && steps < maxSteps) {
    steps++;
    if (s.sauronCombatInfluence) break; // a human Sauron places combat influence first
    if (peek && s.pendingReveal) break; // a human Sauron confirms the Peril draw before the heroes go on
    if (s.pendingChoice) {
      const seat = s.pendingChoice.seat;
      if (seat === 'sauron') break; // a human Sauron picks the foe's card
      const heroId = typeof seat === 'number' ? s.heroes[seat]?.id : undefined;
      if (heroId && !isAiHero(heroId)) break; // that hero's own controller decides
      s = resolveChoice(s, cat, strat.combatOption(s, cat, s.pendingChoice.options, rng)); continue;
    }
    if (s.pendingShadowReaction) { break; }
    if (s.pendingTree) {
      if (s.pendingTree.actor === 'sauron') break; // human Sauron decides via the UI
      if (!isAiHero(s.pendingTree.heroId)) break; // the affected hero's own controller decides
      s = autoResolvePendingTree(s, cat); continue;
    }
    if (s.pendingCombat) { break; }
    if (s.pendingCombatOrPeril) { break; }
    if (s.pendingEncounter) {
      const heroId = s.heroes[s.activeHeroIndex]?.id;
      if (heroId && !isAiHero(heroId)) break;
      const plan = encounterPlan(s, cat);
      if (plan && !plan.complete) { s = chooseEncounter(s, cat, strat.encounterOption(s, plan.pending!.options, rng)); continue; }
      s = resolveEncounter(s, cat); continue;
    }
    if (s.phase === 'HeroActions') {
      const hero = s.heroes[s.activeHeroIndex];
      if (!isAiHero(hero.id)) break; // control returns to this hero's human owner
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) {
        if (peek && hero.status === 'active') { peek.heroId = hero.id; peek.act = { kind: 'end' }; break; }
        s = endHeroActions(s, cat); continue;
      }
      const act = strat.heroAction(s, cat, hero.id, rng);
      if (peek) { peek.heroId = hero.id; peek.act = act; break; }
      s = applyHeroAction(s, cat, hero.id, act);
      continue;
    }
    s = advance(s, cat);
  }
  return s;
}
