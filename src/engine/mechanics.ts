// Shared engine helpers: immutable clone, deck draw/discard, adjacency, and
// terrain-based legal moves. Pure — no randomness except via rng.ts.
import type {
  Catalog, GameState, HeroState, HeroId, LocationId, PathEdge, Terrain, CardId, StoryMarkerColor,
} from './types';
import { STORY_FINALE, STAGE_SIZE } from './types';
import { shuffle, nextInt } from './rng';
import { log } from './log';
import { recoverHero } from './heroLife';
import { corruptionRestDefeatSteps, corruptionTravelCap } from './corruption';
import { influenceAt } from './influence';

/** True if `id` is a Skill-deck (trained) card. Skill cards are never part of a
 *  starting deck, so their appearance in a hero's deck/discard marks training. */
export function isTrainedCard(cat: Catalog, id: CardId): boolean {
  return cat.combatCards[id]?.deck === 'skills';
}

/** A skill card's raw combat worth, used to pick which of two drawn Skill cards a
 *  training hero keeps (rulebook: draw two, keep one). */
function skillValue(cat: Catalog, id: CardId): number {
  const c = cat.combatCards[id];
  if (!c) return 0;
  return (c.attack ?? 0) + (c.defense ?? 0) + (c.effectKey ? 1 : 0);
}

/** Grant `n` training to a hero (rulebook p.26, "Training"): for each level of
 *  training, draw the top two cards of the shared Skill deck, keep the stronger
 *  one — added to the hero's real (single) deck at a random position — and
 *  discard the other faceup to the Skill discard. Skill cards become permanent
 *  members of the hero's deck (raising max health). Sauron sees the COUNT rise
 *  (public) but not each card's identity until the hero first plays it. */
export function grantTraining(state: GameState, cat: Catalog, hero: HeroState, n: number): void {
  state.skillDeck ||= [];
  state.skillDiscard ||= [];
  for (let i = 0; i < n; i++) {
    if (state.skillDeck.length === 0) break;
    const a = state.skillDeck.shift() as CardId;
    const b = state.skillDeck.length ? (state.skillDeck.shift() as CardId) : undefined;
    let keep = a; let toss = b;
    if (b !== undefined) {
      const va = skillValue(cat, a); const vb = skillValue(cat, b);
      if (vb > va || (vb === va && b < a)) { keep = b; toss = a; }
    }
    const pos = nextInt(state, hero.deck.length + 1);
    hero.deck.splice(pos, 0, keep);
    if (toss !== undefined) state.skillDiscard.push(toss);
    hero.trainedCount += 1;
  }
  hero.training += n;
}

/** Raise an attribute via a level token, capped at 2 increases per attribute per
 *  game (manual: "Each hero may increase each of his attributes a maximum of
 *  twice per game."). Returns the amount actually applied (0 if already maxed). */
export function raiseAttribute(
  hero: HeroState, stat: 'fortitude' | 'strength' | 'agility' | 'wisdom', n: number,
): number {
  hero.levels ||= {};
  const used = hero.levels[stat] ?? 0;
  const room = Math.max(0, 2 - used);
  const applied = Math.min(n, room);
  if (applied > 0) {
    hero.statBonus[stat] = (hero.statBonus[stat] ?? 0) + applied;
    hero.levels[stat] = used + applied;
  }
  return applied;
}

/** Ambush (hero turn, step 2): a monster or minion at the hero's location forces
 *  combat before the hero may Travel (Move/Explore). Returns true while a foe is
 *  present and the hero must engage it first. */
export function ambushPending(state: GameState, hero: HeroState): boolean {
  if (hero.skipAmbush) return false;
  // M3: if Sauron chose Peril (not combat) when the hero entered this location
  // during a Travel step, the foe here does not force a fight this turn.
  if (hero.perilResolvedAt?.includes(hero.location)) return false;
  const monsters = state.map.monstersAt[hero.location]?.length ?? 0;
  const minions = state.map.minionsAt?.[hero.location]?.length ?? 0;
  return monsters + minions > 0;
}

/** Deep clone used at every public action boundary to keep states immutable. */
export function clone(state: GameState): GameState {
  return structuredCloneCompat(state);
}
function structuredCloneCompat<T>(v: T): T {
  const g = globalThis as { structuredClone?: <U>(x: U) => U };
  if (g.structuredClone) return g.structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Draw `n` from a deck into a hand, reshuffling discard when the deck runs dry. */
export function drawInto(
  state: GameState, deck: CardId[], hand: CardId[], discard: CardId[], n: number,
): void {
  for (let i = 0; i < n; i++) {
    if (deck.length === 0) {
      if (discard.length === 0) return;
      const reshuffled = shuffle(state, discard);
      deck.push(...reshuffled);
      discard.length = 0;
    }
    hand.push(deck.shift()!);
  }
}

export function neighbors(cat: Catalog, loc: LocationId): PathEdge[] {
  return cat.edges.filter((e) => e.a === loc || e.b === loc);
}
export function otherEnd(e: PathEdge, from: LocationId): LocationId {
  return e.a === from ? e.b : e.a;
}

/** Move a hero figure between locations, keeping the map index in sync. */
export function moveHero(s: GameState, heroId: HeroId, to: LocationId): void {
  const hero = s.heroes.find((h) => h.id === heroId)!;
  const from = hero.location;
  const arr = s.map.heroesAt[from];
  if (arr) { const i = arr.indexOf(heroId); if (i >= 0) arr.splice(i, 1); }
  hero.location = to;
  (s.map.heroesAt[to] ||= []).push(heroId);
}

/** BFS over path edges to the closest Haven-kind location (or the hero's own).
 *  When several Havens tie at the minimum distance, "Sauron decides" (rulebook
 *  p.32): with a GameState he sends the hero to the tied Haven most surrounded
 *  by his influence; otherwise the first reached is used. */
export function nearestHaven(cat: Catalog, from: LocationId, s?: GameState): LocationId | null {
  if (cat.locations[from]?.kind === 'haven') return from;
  const seen = new Set<LocationId>([from]);
  let frontier: LocationId[] = [from];
  while (frontier.length) {
    const next: LocationId[] = [];
    const found: LocationId[] = [];
    for (const id of frontier) {
      for (const e of cat.edges) {
        const nb = e.a === id ? e.b : e.b === id ? e.a : null;
        if (nb && !seen.has(nb)) {
          seen.add(nb);
          if (cat.locations[nb]?.kind === 'haven') found.push(nb);
          else next.push(nb);
        }
      }
    }
    if (found.length) return sauronPicksHaven(cat, found, s);
    frontier = next;
  }
  return null;
}

/** Among equidistant Havens, Sauron picks the one ringed by the most influence
 *  (its own value is always 0 — Havens are never influenced). */
function sauronPicksHaven(cat: Catalog, havens: LocationId[], s?: GameState): LocationId {
  if (havens.length === 1 || !s) return havens[0];
  let best = havens[0];
  let bestScore = -1;
  for (const h of havens) {
    let score = influenceAt(s, h);
    for (const e of cat.edges) {
      const nb = e.a === h ? e.b : e.b === h ? e.a : null;
      if (nb) score += influenceAt(s, nb);
    }
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

/** Advance the leftmost (least-advanced) Sauron story marker one space up the
 *  Story Track — the MEQ effect of a hero Rest and step 1 of the Defeated Heroes
 *  sequence. On a tie the hero would choose; the automa breaks ties yellow→black
 *  →red deterministically. Returns which marker moved. */
export function advanceLeftmostMarker(s: GameState): StoryMarkerColor | null {
  const st = s.story.sauron;
  if (!st) return null;
  const order: StoryMarkerColor[] = ['yellow', 'black', 'red'];
  let pick = order[0];
  for (const c of order) if (st[c] < st[pick]) pick = c;
  st[pick] = Math.min(STORY_FINALE, st[pick] + 1);
  return pick;
}

/** Current game stage (1..3) from the story marker CLOSEST TO THE FINALE — the
 *  rightmost stage of the track holding any marker (rulebook p.12), i.e. the
 *  furthest-advanced of the hero (green) marker and Sauron's three colored
 *  markers. Stage 1 = spaces 1-6, stage 2 = 7-12, stage 3 = 13-18. Drives the
 *  influence cap (4×stage), the active Event deck, and minion activation. */
export function gameStage(s: GameState): 1 | 2 | 3 {
  const st = s.story.sauron;
  const pos = Math.max(s.story.sauronProgress, st?.yellow ?? 0, st?.red ?? 0, st?.black ?? 0);
  return (pos <= STAGE_SIZE ? 1 : pos <= 2 * STAGE_SIZE ? 2 : 3);
}

/** The MEQ "Defeated Heroes" sequence: 1) advance the leftmost Sauron story
 *  marker, 2) lose a favor or an item card, 3) move to the closest Haven, 4)
 *  Recover (shuffle rest + damage pools into the life pool), 5) end the hero's
 *  turn. */
export function defeatHero(s: GameState, cat: Catalog, hero: HeroState): void {
  const steps = corruptionRestDefeatSteps(cat, hero);
  let moved: string | undefined;
  for (let i = 0; i < steps; i++) moved = advanceLeftmostMarker(s) ?? moved;
  if (hero.favor > 0) hero.favor -= 1;
  else if (hero.items.length) hero.items.pop();
  const haven = nearestHaven(cat, hero.location, s);
  if (haven) moveHero(s, hero.id, haven);
  recoverHero(s, hero);
  hero.status = 'active';
  hero.actionsRemaining = 0;
  log(s, 'hero-defeated', hero.id, `${cat.heroes[hero.id].name} defeated → Sauron's ${moved ?? 'leftmost'} marker advances, loses favor/item, recovers at ${haven ?? hero.location}`);
}

/** Whether a hero holds a given item, matching either its catalog id
 *  (e.g. 'item-horse') or its display name (e.g. 'Horse') — items enter play
 *  from start-items (ids) and from card/quest rewards (names), so both forms
 *  occur. Case-insensitive. */
export function hasItem(hero: HeroState, id: string, name: string): boolean {
  const want = new Set([id.toLowerCase(), name.toLowerCase()]);
  return (hero.items ?? []).some((it) => want.has(String(it).toLowerCase()));
}

/** Terrains the hero can currently pay for movement (one per card in hand). */
export function terrainsInHand(cat: Catalog, hero: HeroState): Terrain[] {
  const out: Terrain[] = [];
  for (const cid of hero.hand) {
    const t = cat.combatCards[cid]?.terrain;
    if (t) out.push(t);
  }
  return out;
}

export interface LegalMove { to: LocationId; terrain: Terrain; edge: PathEdge; viaAnyCards: boolean; cost: number; }

/** Legal Travel moves from the hero's location. A path is crossable EITHER by
 *  discarding one card matching its terrain icon, OR (manual fallback) by
 *  discarding `cost` cards of any type. Terrain payment is preferred when the
 *  hero holds a matching card. */
export function legalMoves(cat: Catalog, hero: HeroState): LegalMove[] {
  // Travel steps are limited by any temporary cap (the "Hopeless" Corruption
  // card or a restrictMovement effect): once the cap is reached, no Travel move
  // is legal this turn (rulebook p.22 — the step repeats only while the hero is
  // able). This keeps the AI and UI from offering an illegal move.
  const corrCap = corruptionTravelCap(cat, hero);
  const caps = [corrCap, hero.turnTravelCap].filter((n): n is number => n != null);
  const travelCap = caps.length ? Math.min(...caps) : undefined;
  if (travelCap !== undefined && (hero.travelStepsThisTurn ?? 0) >= travelCap) return [];
  const held = new Set(terrainsInHand(cat, hero));
  const horse = hasItem(hero, 'item-horse', 'Horse');
  const boat = hasItem(hero, 'item-boat', 'Boat');
  const out: LegalMove[] = [];
  for (const e of neighbors(cat, hero.location)) {
    const to = otherEnd(e, hero.location);
    // Water (blue) paths (rulebook p.22): crossable like a normal path, but with
    // a "Boat" Item the hero discards ANY one card regardless of the printed
    // icon (always cost 1). The Horse does not help on water paths.
    if (e.water && boat) {
      if (hero.hand.length >= 1) out.push({ to, terrain: e.terrain, edge: e, viaAnyCards: true, cost: 1 });
      continue;
    }
    // Horse: reduce the any-card cost of each LAND path by 1 (to a minimum of 1).
    // A matching-terrain move always costs exactly one card, so Horse never lowers
    // it below 1 — it only eases the any-card fallback on multi-cost paths.
    const base = Math.max(1, e.cost || 1);
    const cost = horse && !e.water ? Math.max(1, base - 1) : base;
    if (held.has(e.terrain)) out.push({ to, terrain: e.terrain, edge: e, viaAnyCards: false, cost });
    else if (hero.hand.length >= cost) out.push({ to, terrain: e.terrain, edge: e, viaAnyCards: true, cost });
  }
  return out;
}

/** A card in hand whose terrain matches, to spend for a move. */
export function findMovementCard(cat: Catalog, hero: HeroState, terrain: Terrain): CardId | null {
  for (const cid of hero.hand) {
    if (cat.combatCards[cid]?.terrain === terrain) return cid;
  }
  return null;
}

export function discardFromHand(hero: HeroState, cid: CardId): void {
  const i = hero.hand.indexOf(cid);
  if (i >= 0) { hero.hand.splice(i, 1); hero.discard.push(cid); }
}
