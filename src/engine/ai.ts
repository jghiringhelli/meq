// The Lidless Eye — automated Sauron opponent (M5).
//
// This module holds Sauron's decision policies. The first and most involved is
// the *combat policy*: which combat card the monster (defender) reveals against
// an engaging hero. Combat is a simultaneous reveal, so the Eye chooses under
// uncertainty — it never peeks at the hero's concealed hand. Instead it models
// the hero by their PUBLIC combat deck (cat.decks, weighted by copies) and, for
// each candidate monster card, simulates the real bout resolver (resolveBout,
// so the full M2 effect layer is honoured) against that distribution, scoring
// from Sauron's perspective. A cautious blend of the mean and worst case is
// used so the Eye respects a hero who might play their best answer.

import type { Catalog, GameState, CardId, CombatCard, HeroState } from './types';
import { resolveBout } from './effects';
import { shuffle } from './rng';
import { isTrainedCard } from './mechanics';
import { bestPlacementToward, placeInfluenceAction, influenceAt, graphDistance, placementTargets, isHaven } from './influence';

// Trained cards are Skill-deck cards — never part of a starting deck, so their
// appearance in a hero's public discard reveals a trained card.

/** A neutral stand-in for a trained card whose identity Sauron has not yet seen
 *  (it exists in the hero's deck but has never been played). Modest stats so the
 *  Eye respects that an unknown answer might exist without over/under-fearing it. */
const UNKNOWN_TRAINED_CARD: CombatCard = {
  id: 'unknown-trained', deck: 'advanced', owner: 'hero', name: 'Unknown Trained Card',
  type: 'melee', attack: 1, defense: 1, strengthCost: 1, terrain: 'woods',
  ability: '', effectKey: '', copies: 1,
};

// ---- tunable weights ----------------------------------------------------
export const AI_WEIGHTS = {
  lethalToHero: 100,      // bonus for a card that can drop the hero to 0 this round
  selfDeath: -80,         // penalty for a card that gets the monster killed
  escapeWhenLosing: 12,   // credit for an escape when the monster is behind
  escapeWhenWinning: -6,  // discourage escaping a fight the monster is winning
  carryValue: 0.6,        // credit per point of next-round atk/def buff queued
  caution: 0.5,           // blend: 0 = pure mean vs hero deck, 1 = pure worst case
};

interface HeroModelCard { card: CombatCard; weight: number; }

/** Build the hero opponent model from PUBLIC info only. The base is the hero's
 *  known starting deck (`cat.decks`, weighted by copies), PLUS any trained cards
 *  Sauron has already seen the hero play (`revealedTrained` — now known members
 *  of the deck), MINUS the cards currently in the public discard pile (`seen`).
 *  Finally, `unknownTrainedCount` trained cards whose identity is still hidden
 *  are added as a neutral prior: the Eye knows extra cards exist but not what.
 *
 *  Because combat and movement share ONE persistent hero deck, `seen` is the
 *  game-long discard: the belief narrows as the hero plays cards (for movement
 *  or combat) and widens again on a reshuffle. The Eye never inspects the
 *  concealed hand/deck order — only the public deck, discard, and train count. */
export function heroModel(
  cat: Catalog, heroRefId: string, seen: CardId[] = [],
  revealedTrained: CardId[] = [], trainedCount = 0,
): HeroModelCard[] {
  const hero = cat.heroes[heroRefId];
  const deckId = hero?.deck;
  const ids = deckId ? cat.decks[deckId] ?? [] : [];
  const byCard = new Map<CardId, number>();
  for (const id of ids) byCard.set(id, (byCard.get(id) ?? 0) + 1);
  // revealed trained cards are now known extra members of the hero's deck
  for (const id of revealedTrained) {
    if (cat.combatCards[id]) byCard.set(id, (byCard.get(id) ?? 0) + 1);
  }
  // remove cards sitting in the public discard: they cannot be drawn right now
  for (const id of seen) {
    const w = byCard.get(id);
    if (w === undefined) continue;
    if (w <= 1) byCard.delete(id); else byCard.set(id, w - 1);
  }
  const model: HeroModelCard[] = [];
  for (const [id, weight] of byCard) {
    const card = cat.combatCards[id];
    if (card) model.push({ card, weight });
  }
  // trained cards not yet revealed: known to exist (count is public) but hidden
  const unknown = Math.max(0, trainedCount - revealedTrained.length);
  if (unknown > 0) model.push({ card: UNKNOWN_TRAINED_CARD, weight: unknown });
  return model;
}

/** Count occurrences of each id. */
function countBy(ids: CardId[]): Map<CardId, number> {
  const m = new Map<CardId, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/** Update the Lidless Eye's persistent intel from public info: any advanced
 *  (trained) card now visible in a hero's discard is recorded as revealed. Uses
 *  a per-id high-water mark, so a later reshuffle (which empties the discard)
 *  never erases what the Eye has already learned. Mutates `s.sauron.heroIntel`. */
export function updateHeroIntel(s: GameState, cat: Catalog): void {
  for (const hero of s.heroes) {
    const intel = (s.sauron.heroIntel[hero.id] ||= { revealedTrained: [] });
    const recorded = countBy(intel.revealedTrained);
    const inDiscard = countBy(hero.discard.filter((id) => isTrainedCard(cat, id)));
    for (const [id, dc] of inDiscard) {
      const have = recorded.get(id) ?? 0;
      for (let i = have; i < dc; i++) intel.revealedTrained.push(id);
    }
  }
}

/** Value (to Sauron) of one resolved bout: hero=attacker, monster=defender. */
function scoreBout(
  out: ReturnType<typeof resolveBout>, heroLife: number, monLife: number,
): number {
  const dmgToHero = out.attacker.damageTaken;
  const dmgToMonster = out.defender.damageTaken;
  let s = dmgToHero - dmgToMonster;
  if (dmgToHero >= heroLife) s += AI_WEIGHTS.lethalToHero;
  if (dmgToMonster >= monLife) s += AI_WEIGHTS.selfDeath;
  // next-round buffs the monster queued for itself
  for (const mod of out.defender.next) s += ((mod.atk ?? 0) + (mod.def ?? 0)) * AI_WEIGHTS.carryValue;
  if (out.escape === 'defender') {
    s += monLife < heroLife ? AI_WEIGHTS.escapeWhenLosing : AI_WEIGHTS.escapeWhenWinning;
  }
  return s;
}

/** Expected value of playing monster card `m` vs the hero model (mean/worst blend). */
export function scoreMonsterCard(
  _cat: Catalog, m: CombatCard, model: HeroModelCard[],
  lastType: { attacker?: string; defender?: string },
  carry: { attacker: import('./types').NextMod[]; defender: import('./types').NextMod[] },
  heroLife: number, monLife: number,
): number {
  if (!model.length) return m.attack - m.defense; // no model → mild aggression
  let sum = 0, totW = 0, worst = Infinity;
  for (const hm of model) {
    const out = resolveBout(hm.card, m, lastType, carry);
    const v = scoreBout(out, heroLife, monLife);
    sum += v * hm.weight; totW += hm.weight;
    if (v < worst) worst = v;
  }
  const mean = sum / (totW || 1);
  return (1 - AI_WEIGHTS.caution) * mean + AI_WEIGHTS.caution * worst;
}

/** The Lidless Eye's combat choice: the monster card maximizing Sauron value.
 *  `pc` is the pending combat; `defender` is the monster. Deterministic. */
export function chooseMonsterCard(state: GameState, cat: Catalog): CardId | null {
  const pc = state.pendingCombat;
  if (!pc || !pc.defender.hand.length) return null;
  // Learn from public info first, then model the hero from it.
  updateHeroIntel(state, cat);
  const heroRef = String(pc.attacker.refId);
  const heroState = state.heroes.find((h) => h.id === heroRef);
  const intel = state.sauron.heroIntel[heroRef]?.revealedTrained ?? [];
  // Game-long card counting: pc.attacker.discard is the hero's persistent
  // discard (all movement + prior-combat plays), a public whole-game signal.
  // Trained cards seen in it are known; the rest of the train count is a prior.
  const model = heroModel(cat, heroRef, pc.attacker.discard, intel, heroState?.trainedCount ?? 0);
  const lastType = pc.lastType ?? {};
  const carry = pc.carry ?? { attacker: [], defender: [] };
  // The hero's "life" is the cards he has left (life pool + hand); the monster
  // takes numeric damage against its health.
  const heroLife = pc.attacker.deck.length + pc.attacker.hand.length, monLife = pc.defender.life;

  let best: CardId | null = null, bestScore = -Infinity;
  for (const cid of pc.defender.hand) {
    const m = cat.combatCards[cid];
    if (!m) continue;
    const sc = scoreMonsterCard(cat, m, model, lastType, carry, heroLife, monLife);
    // deterministic tie-break: higher attack, then lexicographic id
    if (sc > bestScore || (sc === bestScore && best !== null &&
        (m.attack > cat.combatCards[best].attack || (m.attack === cat.combatCards[best].attack && cid < best)))) {
      bestScore = sc; best = cid;
    }
  }
  return best;
}

// ---- Sauron economy policy (strategic influence) -------------------------
// Doctrine (owner strategy): for roughly the first two-thirds of the story
// track the Eye MAXIMIZES — it hoards influence (a war chest), fields monsters,
// and keeps board tempo, rather than dribbling influence into low-value tokens.
// In the final third it spends the chest down (heavier pressure / "reset").
export const AI_ECONOMY = {
  influencePerHeroRegion: 1,  // late-game pressure pushed into each hero's current region
  maxSpawnsPerTurn: 1,        // early/mid cap; the late phase lifts this to spend down
  lateMaxSpawnsPerTurn: 2,
  pathBlockCost: 1,           // influence placed on a hero's projected path node
  maxPathBlocksPerTurn: 2,    // how many path segments the Eye seeds per turn
  maxBoardMonsters: 4,        // limited monster supply — don't flood the board
  earlyGameFraction: 2 / 3,   // hoard before this point on the story track, spend after
};

/** A wild location in `region` with no hero standing on it (a spawn seat). */
function spawnSeat(s: GameState, cat: Catalog, region: string, fromLoc?: string): string | null {
  const free = (l: { id: string; kind?: string }) =>
    l.kind !== 'haven' && !(s.map.heroesAt[l.id]?.length);
  // Prefer an influenced, hero-free seat (the only legal one to field a monster
  // token on); fall back to any free seat only for path/adjacency reasoning.
  const rank = (id: string) => (influenceAt(s, id) > 0 ? 0 : 1);
  const seats = Object.values(cat.locations)
    .filter((l) => l.regionId === region && free(l))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  if (seats[0]) return seats[0].id;
  // Fallback: the hero sits in a region with no free non-Haven seat (e.g. on a
  // Haven). Field the monster on an adjacent non-Haven location instead.
  if (fromLoc) {
    const adj = cat.edges
      .filter((e) => e.a === fromLoc || e.b === fromLoc)
      .map((e) => (e.a === fromLoc ? e.b : e.a))
      .map((id) => cat.locations[id])
      .filter((l): l is NonNullable<typeof l> => !!l && free(l))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    if (adj[0]) return adj[0].id;
  }
  return null;
}

/** Project a hero's most likely next step. Heroes gather favor/allies and cycle
 *  back to a HAVEN to rest, spend favor, and destroy plots, so the shortest path
 *  to the nearest haven is the Eye's best public predictor of the route. Returns
 *  the first location on that path (or null if the hero already sits on a haven
 *  or no haven is reachable). */
export function projectedNextStep(cat: Catalog, from: string): string | null {
  if (cat.locations[from]?.kind === 'haven') return null;
  const seen = new Set<string>([from]);
  let frontier: { id: string; first: string | null }[] = [{ id: from, first: null }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (cat.locations[node.id]?.kind === 'haven' && node.first) return node.first;
      for (const e of cat.edges) {
        const nb = e.a === node.id ? e.b : e.b === node.id ? e.a : null;
        if (nb && !seen.has(nb)) { seen.add(nb); next.push({ id: nb, first: node.first ?? nb }); }
      }
    }
    frontier = next;
  }
  return null;
}

/** The location a hero is most likely travelling TO: the nearest active Plot
 *  (heroes must physically stand on a plot's location to break it — the corridors
 *  between Mordor and Gondor/Rohan are the pinch), else its nearest Haven (the
 *  favour/rest round-trip). This is the road the Eye most wants perilous. */
function heroRouteTarget(s: GameState, cat: Catalog, from: string): string | null {
  const plotLocs = (s.sauron.activePlots ?? [])
    .map((e) => e.location).filter((l): l is string => !!l);
  const pool = plotLocs.length
    ? plotLocs
    : Object.values(cat.locations).filter((l) => l.kind === 'haven').map((l) => l.id);
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const loc of pool) {
    const d = graphDistance(cat, from, loc);
    if (d > 0 && d < bestD) { bestD = d; best = loc; }
  }
  return best;
}

/** A hero's effective wisdom for perilousness (base + persistent stat bonuses).
 *  Corruption only LOWERS real wisdom, so this is a safe upper bound: influence
 *  above it is guaranteed to make a location perilous for the hero. */
function wisdomOf(cat: Catalog, h: HeroState): number {
  return (cat.heroes[h.id]?.wisdom ?? 0) + (h.statBonus?.wisdom ?? 0);
}

/** How many of `loc`'s map neighbours currently hold influence — a proxy for
 *  chain robustness (a node webbed to several influenced neighbours can't be
 *  collapsed by a hero clearing one unanchored spur). */
function influencedNeighbours(s: GameState, cat: Catalog, loc: string): number {
  return cat.edges.reduce((n, e) => {
    const nb = e.a === loc ? e.b : e.b === loc ? e.a : null;
    return n + (nb && influenceAt(s, nb) > 0 ? 1 : 0);
  }, 0);
}

/** One "Place Influence" action: extend influence one step toward the most-
 *  corrupted hero's projected next step (path pressure), respecting the
 *  extension rule. Board influence tokens are drawn from the (unlimited)
 *  Influence area, NOT from the Shadow Pool — the Pool is a separate reserve
 *  grown by the Place-Influence action (≤2/turn) and spent on spawns/plots
 *  (rulebook pp. 15-16). Returns true if any influence was placed. */
export function eyePlaceInfluenceOnce(s: GameState, cat: Catalog, log?: (msg: string) => void): boolean {
  const heroes = s.heroes.filter((h) => h.status === 'active')
    .sort((a, b) => b.corruption - a.corruption);
  // Perilize the ROAD each low-wisdom hero must take to break a plot (heroes must
  // physically reach a plot's location — the corridors between Mordor and
  // Gondor/Rohan are the pinch). A perilous route bleeds favour (Ill Met Company
  // steals 2) and, above all, piles on CORRUPTION.
  // Owner doctrine (wisdom is the peril attribute AND inversely tracks combat):
  //  · LOW-wisdom heroes are STRONG in combat, so you must not trade blows with
  //    them — you CORRUPT them instead. They are also CHEAP to perilise (a node
  //    beats their low wisdom with little influence), so influence pressure is
  //    exactly the right lever against them ("better to corrupt them than fight");
  //  · HIGH-wisdom heroes are WEAK in combat and expensive to perilise, so they
  //    are left to the monsters (eyeSpawnMonsterOnce) to grind down in a fight;
  //  · DON'T over-invest — only push a node until it EXCEEDS the target hero's
  //    wisdom (influence beyond that is wasted);
  //  · grow ROBUST chains — among equally-near nodes prefer the one anchored to
  //    MORE influenced neighbours (webbed placement resists a hero clearing one
  //    unanchored spur by resting). Anchoring to a stronghold chain is already
  //    guaranteed by the extension rule (placementTargets).
  type Cand = { loc: string; dist: number; anchor: number; inf: number };
  const consider = (maxWisdom: number): Cand | null => {
    let best: Cand | null = null;
    for (const hero of heroes) {
      const w = wisdomOf(cat, hero);
      if (w > maxWisdom) continue; // handled in a later, higher-wisdom pass / by monsters
      const target = heroRouteTarget(s, cat, hero.location);
      if (!target) continue;
      for (const loc of placementTargets(s, cat)) {
        if (isHaven(cat, loc) || influenceAt(s, loc) > w || (s.map.heroesAt[loc]?.length ?? 0) > 0) continue;
        const cand: Cand = {
          loc, dist: graphDistance(cat, loc, target),
          anchor: influencedNeighbours(s, cat, loc), inf: influenceAt(s, loc),
        };
        if (!best || cand.dist < best.dist ||
          (cand.dist === best.dist && (cand.anchor > best.anchor ||
            (cand.anchor === best.anchor && (cand.inf > best.inf ||
              (cand.inf === best.inf && cand.loc < best.loc)))))) best = cand;
      }
    }
    return best;
  };
  // First perilise the CHEAP heroes (wisdom ≤ 2); only if none is placeable do we
  // fall through to any hero (so a token is never wasted when only high-wisdom
  // heroes remain and no monster seat exists).
  const pick = consider(2) ?? consider(99);
  if (pick) {
    const placed = placeInfluenceAction(s, cat, pick.loc, 1);
    if (placed > 0) {
      log?.(`places influence at ${cat.locations[pick.loc]?.name ?? pick.loc} (perilous road, now ${influenceAt(s, pick.loc)})`);
      return true;
    }
  }
  // Fallback: nothing on a hero's route is placeable — keep the old path pressure
  // toward the most-corrupted hero's projected next step.
  for (const hero of heroes) {
    const node = projectedNextStep(cat, hero.location) ?? hero.location;
    const loc = bestPlacementToward(s, cat, node);
    if (!loc) continue;
    const placed = placeInfluenceAction(s, cat, loc, 1);
    if (placed <= 0) continue;
    log?.(`places influence at ${cat.locations[loc]?.name ?? loc} (toward ${hero.id}'s path, now ${influenceAt(s, loc)})`);
    return true;
  }
  return false;
}

/** Draw one face-down token from a region's monster pile. Entries are a
 *  monsterId or 'blank' (false rumor). The pile is built ONCE from the catalog
 *  bag and drawn WITHOUT replacement — used/placed tokens never return and the
 *  pile is never reshuffled (owner ruling: if a region's 10 tokens run out,
 *  they run out). Returns null when the region has no bag or the pile is empty. */
export function drawMonsterToken(s: GameState, cat: Catalog, regionId: string): string | null {
  const bag = cat.monsterBags[regionId];
  if (!bag) return null;
  const piles = (s.sauron.monsterBagPiles ||= {});
  if (piles[regionId] === undefined) {
    const full: string[] = [];
    for (let i = 0; i < bag.blanks; i++) full.push('blank');
    for (const t of bag.tokens) for (let i = 0; i < t.count; i++) full.push(t.monsterId);
    piles[regionId] = shuffle(s, full);
  }
  return piles[regionId].length ? (piles[regionId].pop() ?? null) : null;
}

/** One "Place Monster Token" command: draw a random face-down token from a
 *  region that HOLDS INFLUENCE (rules prerequisite) and field it near a hero.
 *  A blank draw is a "false rumor" — the command is still spent (returns true)
 *  but no monster reaches the board. Returns true if the command executed. */
export function eyeSpawnMonsterOnce(s: GameState, cat: Catalog, log?: (msg: string) => void): boolean {
  if (!Object.keys(cat.monsters).length) return false;
  const onBoard = Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0)
    + Object.values(s.map.rumorsAt ?? {}).reduce((n, c) => n + c, 0);
  if (onBoard >= AI_ECONOMY.maxBoardMonsters) return false;
  // Field monsters against the HIGH-wisdom heroes first — the ones too costly to
  // perilise with influence are instead deterred by a foe on their route (owner
  // doctrine: "the other one you handle with monsters"). A facedown/blank token
  // still deters, since heroes can't tell a false rumor from a real monster.
  // Lidless Eye — GUARD THE PLOT first. Heroes now route AROUND monster-occupied
  // nodes, so a foe seated ON an active-plot location a hero is approaching forces
  // them into a turn-ending fight to reach and break the plot — striking their win
  // path directly. Pick the influenced, hero-free plot with the nearest hero.
  const plots = (s.sauron.activePlots ?? [])
    .map((p) => p.location)
    .filter((l): l is string => !!l && influenceAt(s, l) > 0 && !(s.map.heroesAt[l]?.length ?? 0));
  let guard: { seat: string; dist: number } | null = null;
  for (const p of plots) {
    let nearest = Infinity;
    for (const h of s.heroes) {
      if (h.status !== 'active') continue;
      const d = graphDistance(cat, h.location, p);
      if (Number.isFinite(d)) nearest = Math.min(nearest, d);
    }
    if (nearest <= 2 && (!guard || nearest < guard.dist)) guard = { seat: p, dist: nearest };
  }
  if (guard) {
    const seatRegion = cat.locations[guard.seat]?.regionId ?? '';
    const token = drawMonsterToken(s, cat, seatRegion);
    if (token !== null) {
      if (token === 'blank') {
        (s.map.rumorsAt ||= {})[guard.seat] = (s.map.rumorsAt[guard.seat] ?? 0) + 1;
        log?.(`plants a face-down token at ${guard.seat} to guard a plot — a false rumor (blank)`);
        return true;
      }
      (s.map.monstersAt[guard.seat] ||= []).push(token);
      log?.(`fields ${cat.monsters[token].name} at ${guard.seat} (guards a plot)`);
      return true;
    }
  }
  const heroes = s.heroes.filter((h) => h.status === 'active')
    .sort((a, b) => wisdomOf(cat, b) - wisdomOf(cat, a) || b.corruption - a.corruption);
  for (const h of heroes) {
    const region = cat.locations[h.location]?.regionId ?? '';
    const seat = spawnSeat(s, cat, region, h.location);
    // Rules prerequisite: a monster token may only be placed on a location that
    // holds influence and has no hero.
    if (!seat || influenceAt(s, seat) <= 0 || (s.map.heroesAt[seat]?.length ?? 0) > 0) continue;
    // Draw from the seat's region bag.
    const seatRegion = cat.locations[seat]?.regionId ?? region;
    const token = drawMonsterToken(s, cat, seatRegion);
    if (token === null) continue;
    if (token === 'blank') {
      (s.map.rumorsAt ||= {})[seat] = (s.map.rumorsAt[seat] ?? 0) + 1;
      log?.(`plants a face-down token near ${h.id} at ${seat} — a false rumor (blank)`);
      return true;
    }
    (s.map.monstersAt[seat] ||= []).push(token);
    log?.(`fields ${cat.monsters[token].name} at ${seat} (near ${h.id})`);
    return true;
  }
  return false;
}

/** Count monsters standing adjacent-or-on any active hero (threat coverage). */
export function monstersThreateningHeroes(s: GameState): number {
  return Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0);
}

// Owner strategy: the best plots advance the dark marker by 2+ and are worth
// enabling/keeping; plots that only advance the marker by 1 are weak and are
// better held as BLUFFS — their mere presence baits the heroes into spending
// favor and cards to pre-empt them. (Plot selection isn't wired to a choice
// phase yet — plots are still scripted per turn — so these are pure helpers the
// Eye will consult once a plot-choice / plot-influence-cost mechanic exists;
// see docs/milestones.md M7.)
export interface PlotLike {
  id: string; advance: number; influenceCost?: number;
  aiEffectVal?: number; aiReqEase?: number; aiLocDifficulty?: number;
}

/** Value of a plot to Sauron. Marker advance is the dominant payoff; advance-1
 *  plots are discounted hard (bluff-only). The Lidless Eye's 0-4 ratings tune
 *  ties: a valuable effect on an easy-to-meet requirement at a location that is
 *  hard for the heroes is preferred. Influence cost is a mild penalty. */
export function ratePlot(p: PlotLike): number {
  const payoff = p.advance <= 1 ? 0.25 * p.advance : p.advance;
  const rating = 0.05 * ((p.aiEffectVal ?? 0) + (p.aiReqEase ?? 0) + (p.aiLocDifficulty ?? 0));
  return payoff + rating - 0.1 * (p.influenceCost ?? 0);
}

/** Partition available plots into ones worth enabling ("keep", advance ≥ 2,
 *  best first) and weak advance-1 plots better used as bluffs. */
export function rankPlots(plots: PlotLike[]): { keep: PlotLike[]; bluff: PlotLike[] } {
  const keep: PlotLike[] = [], bluff: PlotLike[] = [];
  for (const p of plots) (p.advance >= 2 ? keep : bluff).push(p);
  keep.sort((a, b) => ratePlot(b) - ratePlot(a));
  bluff.sort((a, b) => ratePlot(b) - ratePlot(a));
  return { keep, bluff };
}
