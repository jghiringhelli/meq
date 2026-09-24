// Hero AI + self-play driver for endless simulation. The heroes are normally
// human-driven in the UI (the Lidless Eye is the Sauron AI); this module gives
// the heroes a pluggable brain so we can run automated playouts, compare
// strategies, and mine what works. Strategies range from a pure random walk to
// heuristic play. Everything is deterministic per seed (a strategy's own PRNG is
// seeded separately so it never perturbs the game rng).
import type { Catalog, GameState, HeroId, HeroState, LocationId, SauronDoctrine } from './types';
import { STAGE_SIZE, SHADOW_FALLS, STORY_FINALE } from './types';
import { newGame } from './setup';
import {
  advance, heroMove, heroRest, heroExplore, endHeroActions, heroEngage,
  engageableMonsters, canExplore, encounterPlan, resolveChoice, resolveEncounter,
  chooseEncounter, legalMoves, heroDiscardPlot, heroRetrieveFavor, favorHere, targetablePlot,
  heroSurvey, canSurvey, autoResolvePendingTree, heroTradeFavor, otherHeroesHere,
  heroConsultCharacter, charactersHere, consultWouldCorrupt,
} from './game';
import { ambushPending } from './mechanics';
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
  | { kind: 'move'; to: LocationId }
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
function nearestHavens(cat: Catalog): Set<LocationId> {
  return new Set(Object.values(cat.locations).filter((l) => l.kind === 'haven').map((l) => l.id));
}

/** A hero's effective wisdom (base + persistent stat bonuses) — the attribute a
 *  location's influence is compared against to decide perilousness. */
function heroWisdom(cat: Catalog, h: HeroState): number {
  return (cat.heroes[h.id]?.wisdom ?? 0) + (h.statBonus?.wisdom ?? 0);
}

/** Whether a hero should pick a fight VOLUNTARILY. Heroes gain nothing from
 *  combat (rulebook: monsters/minions are obstacles, not objectives), so they
 *  only engage when they can win cheaply — high agility (evades blows) or a full
 *  enough hand to bring a real attack. Otherwise they route around. A forced
 *  ambush still coerces engagement in applyHeroAction regardless of this. */
function combatReady(cat: Catalog, h: HeroState): boolean {
  const agility = (cat.heroes[h.id]?.agility ?? 0) + (h.statBonus?.agility ?? 0);
  return agility >= 3 || h.hand.length >= 4;
}

/** Opportunistic card-gain fight (an experienced-player tactic): a hero gains
 *  nothing from combat itself, but a HIGH-AGILITY hero facing a genuinely WEAK
 *  monster can spend the Preparation step drawing cards (each agility point draws
 *  one) and still win the short bout — walking away with MORE hero cards than he
 *  started with. Worth doing only when the hero actually needs those cards to
 *  press the plot race: he is card-poor, there is a plot to work toward, and he
 *  is healthy enough to risk a bout. Deliberately narrow (only the weakest,
 *  non-corrupting foes) so a smart hero still routes around real danger. */
export function worthFightingForCards(s: GameState, cat: Catalog, hero: HeroState, monsterId: string): boolean {
  const mon = cat.monsters[monsterId];
  if (!mon) return false;
  if (/corrupt/i.test(mon.ability ?? '')) return false; // corruption-dealers are never "cheap"
  const agility = (cat.heroes[hero.id]?.agility ?? 0) + (hero.statBonus?.agility ?? 0);
  const strength = (cat.heroes[hero.id]?.strength ?? 0) + (hero.statBonus?.strength ?? 0);
  if (agility < 4) return false;                 // need real draw headroom in Preparation
  if (mon.strength > 3 || mon.fortitude > 6) return false; // only the weakest foes
  if (strength + agility < mon.fortitude + 2) return false; // must overwhelm it fast
  if ((s.sauron.activePlots ?? []).length === 0) return false; // no plot race → no need
  if (hero.hand.length > 4) return false;        // already card-rich
  if (hero.corruption > 2 || hero.damagePool.length > 2) return false; // too fragile to risk
  return true;
}

// Routing weights (all in "extra safe-steps" units, so they trade off against
// real distance): a human detours several safe hops rather than eat a peril,
// dodges monster-held nodes, and prefers matching-terrain moves (1 card) over
// burning any cards. Peril dominates because that is the corridor grind that
// grounds a lone hero down.
const PERIL_W = 3;   // entering a perilous node
const MONSTER_W = 2; // entering a node a monster/minion sits on (heroes gain nothing fighting)
const MISMATCH_W = 0.75; // a move with no matching-terrain card (must burn any card[s])
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
  for (const mv of legalMoves(cat, hero)) {
    const onward = field.get(mv.to);
    if (onward === undefined || onward >= here) continue; // must make progress
    const score = onward + 1 + nodePenalty(s, cat, mv.to, hero)
      + MISMATCH_W * (mv.viaAnyCards ? 1 : 0) + 0.25 * (mv.cost - 1)
      - (cat.locations[mv.to]?.kind === 'haven' ? 0.5 : 0); // prefer safe haven waypoints on ties
    if (score < bestScore) { bestScore = score; best = mv.to; }
  }
  return best;
}

const STAGE_III = 2 * STAGE_SIZE; // marker height at which a marker is one stage from the Finale

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
  return dangerA + dangerB;
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
  const active = s.sauron.activePlots ?? [];
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

  // 2. Converge to pool: the most dangerous plot no one can solo-afford but the
  //    party's combined favor could cover — send its two nearest heroes to meet.
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
    return null; // not on the pool team → bank favor to become a future feeder
  }
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
  const active = s.sauron.activePlots ?? [];
  if (!active.length) return null;
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  // Standing on a counterable plot is the highest-value action: counter it now if
  // affordable, otherwise pull the favor shortfall from a co-located ally (heroes
  // freely trade favor, rulebook p.24) — the "break a plot with pooled favour at
  // the last moment" tactic. This must precede the affordability filter below so
  // it still fires when no single hero can solo-afford the break.
  {
    const here = targetablePlot(s, cat, hero.id);
    if (here) {
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
      if (step) return { kind: 'move', to: step };
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
  return step ? { kind: 'move', to: step } : null;
}

/** Consulting a Character present at the hero's location yields +2 favor (Eleanor
 *  +1 more) — the heroes' richest, most reliable favor source and the classic
 *  "ask the characters for favours" tactic experienced players lean on. Worth an
 *  action whenever there is a plot race to fund AND favor is the actual
 *  bottleneck (the hero cannot yet afford the cheapest active plot's counter).
 *  Skips a Character whose consult would self-corrupt (an active corruption plot
 *  taints them) and Isolated heroes (who may not consult). */
function planConsult(s: GameState, cat: Catalog, hero: HeroState): HeroAction | null {
  const active = s.sauron.activePlots ?? [];
  if (!active.length) return null; // no plot race → no favor need
  if (corruptionBlocksSocial(cat, hero)) return null; // Isolated: cannot consult
  const cheapest = Math.min(
    ...active.map((e) => cat.plots.find((p) => p.id === e.eventId)?.favorToCounter ?? 2),
  );
  if (hero.favor >= cheapest) return null; // already able to break a plot — don't burn the token
  for (const c of charactersHere(s, hero.id)) {
    if (consultWouldCorrupt(s, c)) continue;
    return { kind: 'consult', character: c, choice: 'favor' };
  }
  return null;
}

/** True when Sauron has an active plot the heroes ought to break but this hero
 *  can't yet afford — a cue to go earn favor (explore) rather than idle. */
function urgentUnaffordablePlot(s: GameState, cat: Catalog, hero: HeroState): boolean {
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  for (const e of s.sauron.activePlots ?? []) {
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
  const active = s.sauron.activePlots ?? [];
  if (!active.length) return null; // no plots to break => no urgency
  const tokenLocs = Object.entries(s.map.favorAt ?? {})
    .filter(([, n]) => (n ?? 0) > 0).map(([l]) => l as LocationId);
  if (!tokenLocs.length) return null;
  const step = legalStepToward(s, cat, hero, new Set(tokenLocs));
  return step ? { kind: 'move', to: step } : null;
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
    for (const mv of legalMoves(cat, hero)) acts.push({ kind: 'move', to: mv.to });
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
    const moves = legalMoves(cat, hero);
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
      const safe = legalMoves(cat, hero).filter((m) => !influenced(m.to));
      if (safe.length) return { kind: 'move', to: safe[0].to };
    }
    return base;
  },
};

export const STRATEGIES: Record<string, HeroStrategy> = {
  'random-walk': randomWalk, heuristic, cautious,
};

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
    const plot = planPlotCounter(s, cat, hero);
    // Breaking a plot NOW (or pooling favor to) beats everything; but if the plot
    // plan is only a card-hungry march, first take an opportunistic card-gain
    // fight against a weak foe standing here (user tactic) to stock the cards the
    // march needs.
    if (plot && (plot.kind === 'counter-plot' || plot.kind === 'trade-favor')) return plot;
    // Fund the plot race: consulting a co-located Character for favor (the classic
    // "ask the characters for favours" tactic) is the heroes' best favor source —
    // do it before marching or fighting when favor is the bottleneck.
    const consult = planConsult(s, cat, hero);
    if (consult) return consult;
    const easyFoe = engageableMonsters(s, heroId).find((m) => worthFightingForCards(s, cat, hero, m));
    if (easyFoe) return { kind: 'engage', monsterId: easyFoe };
    if (plot) return plot;
    const earn = planEarnFavor(s, cat, hero);
    if (earn) return earn;
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
      const foes = engageableMonsters(s, heroId);
      if (foes.length && hero.damagePool.length <= 1 && combatReady(cat, hero)) return { kind: 'engage', monsterId: foes[0] };
      // Head for a haven to cleanse, weaving around peril/monsters (peril-aware
      // routing) rather than marching straight through the influenced corridor.
      const havenStep = legalStepToward(s, cat, hero, nearestHavens(cat));
      if (havenStep) return { kind: 'move', to: havenStep };
      const influenced = (loc: LocationId) => (s.sauron.locationInfluence?.[loc] ?? 0) > 0;
      const moves = legalMoves(cat, hero);
      const safe = moves.filter((m) => !influenced(m.to));
      const pool = (hero.corruption > 0 ? safe : moves);
      const target = pool[0] ?? moves[0];
      if (target) return { kind: 'move', to: target.to };
      return inHaven && !hero.hasMovedThisTurn ? { kind: 'rest' } : { kind: 'end' };
    }
    if (kind === 'monstersAtMost' || kind === 'minionsAtMost') {
      const foes = engageableMonsters(s, heroId);
      if (foes.length) return { kind: 'engage', monsterId: foes[0] };
      return heuristic.heroAction(s, cat, heroId, rng); // heuristic already hunts
    }
    if (kind === 'heroFavorAtLeast' || kind === 'allQuestsComplete') {
      if (canExplore(s, cat, heroId)) return { kind: 'explore' }; // favor/quests come from encounters
      return heuristic.heroAction(s, cat, heroId, rng);
    }
    return heuristic.heroAction(s, cat, heroId, rng);
  },
};

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
  switch (act.kind) {
    case 'engage': return heroEngage(s, cat, heroId, act.monsterId);
    case 'explore': return heroExplore(s, cat, heroId);
    case 'move': return heroMove(s, cat, heroId, act.to);
    case 'rest': return heroRest(s, cat, heroId);
    case 'counter-plot': return heroDiscardPlot(s, cat, heroId);
    case 'retrieve-favor': return heroRetrieveFavor(s, cat, heroId);
    case 'consult': return heroConsultCharacter(s, cat, heroId, act.character, act.choice);
    case 'survey': return heroSurvey(s, cat, heroId);
    case 'trade-favor': return heroTradeFavor(s, cat, act.fromId, act.toId, act.n);
    case 'end': return endHeroActions(s, cat);
  }
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
): GameState {
  let steps = 0;
  while (!s.winner && s.activeSide === 'Hero' && steps < maxSteps) {
    steps++;
    if (s.pendingChoice) {
      const seat = s.pendingChoice.seat;
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
      if (hero.status !== 'active' || hero.actionsRemaining <= 0) { s = endHeroActions(s, cat); continue; }
      const act = strat.heroAction(s, cat, hero.id, rng);
      s = applyHeroAction(s, cat, hero.id, act);
      continue;
    }
    s = advance(s, cat);
  }
  return s;
}
