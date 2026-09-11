// Shared engine helpers: immutable clone, deck draw/discard, adjacency, and
// terrain-based legal moves. Pure — no randomness except via rng.ts.
import type {
  Catalog, GameState, HeroState, HeroId, LocationId, PathEdge, Terrain, CardId, StoryMarkerColor,
} from './types';
import { STORY_FINALE, STAGE_SIZE } from './types';
import { shuffle } from './rng';
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

/** Grant `n` levels of training to a hero (rulebook p.26, "Training"): for each
 *  level, draw the top two cards of the shared Skill deck and pause for the
 *  hero to choose which to keep — the kept card goes straight into his HAND
 *  (not shuffled into his deck; it becomes a permanent member of his deck only
 *  once it later cycles through hand → rest pool → life pool like any other
 *  Hero card), and the other is discarded faceup. If the Skill deck is
 *  (nearly) empty there is no real choice to make and the draw is applied
 *  immediately. Sauron sees the trained COUNT rise (public) but not each
 *  card's identity until the hero first plays it. */
export function grantTraining(state: GameState, cat: Catalog, hero: HeroState, n: number): void {
  if (n <= 0) return;
  state.skillDeck ||= [];
  state.skillDiscard ||= [];
  queueTrainingDraw(state, cat, hero.id, n);
}

/** Draw the next pending training level's two Skill cards and raise a
 *  `pendingChoice` (kind 'training') for the hero to pick which to keep. */
function queueTrainingDraw(state: GameState, cat: Catalog, heroId: HeroId, remaining: number): void {
  if (remaining <= 0 || !state.skillDeck || state.skillDeck.length === 0) return;
  const a = state.skillDeck.shift() as CardId;
  const b = state.skillDeck.length ? (state.skillDeck.shift() as CardId) : undefined;
  if (b === undefined) {
    applyTrainingPick(state, cat, heroId, a, undefined, remaining - 1);
    return;
  }
  // Order best-first (by raw combat worth) so a bot hero — which simply takes
  // the first offered option — still makes a sound pick; a human sees both
  // full cards and chooses freely.
  const [first, second] = skillValue(cat, b) > skillValue(cat, a) ? [b, a] : [a, b];
  state.pendingTraining = { heroId, remaining, a: first, b: second };
  const seat = state.heroes.find((h) => h.id === heroId)?.seat ?? 0;
  const label = (id: CardId) => {
    const c = cat.combatCards[id];
    return c ? `${c.name} (${c.type} · ⚔${c.attack}/🛡${c.defense} · ✊${c.strengthCost})` : String(id);
  };
  state.pendingChoice = {
    id: 'training', seat, kind: 'training',
    prompt: 'Training: draw two Skill cards — keep one for your hand, discard the other:',
    options: [
      { id: `train:${first}`, label: label(first), cardId: first },
      { id: `train:${second}`, label: label(second), cardId: second },
    ],
  };
}

function applyTrainingPick(
  state: GameState, cat: Catalog, heroId: HeroId, keep: CardId, toss: CardId | undefined, remaining: number,
): void {
  const hero = state.heroes.find((h) => h.id === heroId)!;
  hero.hand.push(keep);
  if (toss !== undefined) (state.skillDiscard ||= []).push(toss);
  hero.trainedCount += 1;
  hero.training += 1;
  log(state, 'hero-training', heroId,
    `training: keeps ${cat.combatCards[keep]?.name ?? keep}${toss !== undefined ? `, discards ${cat.combatCards[toss]?.name ?? toss}` : ''}`);
  if (remaining > 0) queueTrainingDraw(state, cat, heroId, remaining);
}

/** Resolve a pending 'training' choice (optionId = `train:<cardId>`). */
export function resolveTrainingChoice(state: GameState, cat: Catalog, optionId: string): void {
  const pending = state.pendingTraining;
  if (!pending) throw new Error('No pending training choice');
  const cid = optionId.slice('train:'.length) as CardId;
  const toss = cid === pending.a ? pending.b : pending.a;
  state.pendingTraining = null;
  applyTrainingPick(state, cat, pending.heroId, cid, toss, pending.remaining - 1);
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
export function ambushPending(state: GameState, hero: HeroState, cat?: Catalog): boolean {
  if (hero.skipAmbush) return false;
  // M3: if Sauron chose Peril (not combat) when the hero entered this location
  // during a Travel step, the foe here does not force a fight this turn.
  if (hero.perilResolvedAt?.includes(hero.location)) return false;
  // Haven (rulebook p.22): "If the current hero is in a Haven location, combat
  // only takes place if the hero allows it" — a foe here never forces a fight.
  // Monsters can't occupy Havens (no influence there), but minions/Ringwraiths
  // can. Needs the catalog to resolve the location's kind.
  if (cat && cat.locations[hero.location]?.kind === 'haven') return false;
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

/** The two ways a hero may pay to cross the path to `to` (rulebook p.22): show
 *  ONE card matching the path terrain, OR discard `anyCardCost` cards of any
 *  type (the number printed on the path; Horse lowers it by 1 on land, Boat
 *  makes a water path cost one any-card). Used by the interactive Travel UI so
 *  the player can pick exactly which card(s) to spend. */
export interface MoveOption {
  to: LocationId; terrain: Terrain; water: boolean;
  /** true when the hero holds a matching-terrain card (1-card route available). */
  terrainPayable: boolean;
  /** number of any-type cards that also cross this path. */
  anyCardCost: number;
}

/** Per-destination payment options from the hero's current location, honouring
 *  the same travel caps as `legalMoves`. Returns every neighbouring path (the
 *  UI decides which are affordable via `terrainPayable`/`anyCardCost`). */
export function moveOptions(cat: Catalog, hero: HeroState): MoveOption[] {
  const corrCap = corruptionTravelCap(cat, hero);
  const caps = [corrCap, hero.turnTravelCap].filter((n): n is number => n != null);
  const travelCap = caps.length ? Math.min(...caps) : undefined;
  if (travelCap !== undefined && (hero.travelStepsThisTurn ?? 0) >= travelCap) return [];
  const held = new Set(terrainsInHand(cat, hero));
  const horse = hasItem(hero, 'item-horse', 'Horse');
  const boat = hasItem(hero, 'item-boat', 'Boat');
  const out: MoveOption[] = [];
  for (const e of neighbors(cat, hero.location)) {
    const to = otherEnd(e, hero.location);
    if (e.water && boat) {
      out.push({ to, terrain: e.terrain, water: true, terrainPayable: false, anyCardCost: 1 });
      continue;
    }
    const base = Math.max(1, e.cost || 1);
    const anyCardCost = horse && !e.water ? Math.max(1, base - 1) : base;
    out.push({ to, terrain: e.terrain, water: !!e.water, terrainPayable: held.has(e.terrain), anyCardCost });
  }
  return out;
}

/** True if discarding exactly `cards` (from hand) is a legal payment to Travel
 *  to `to`: either a single matching-terrain card, or `anyCardCost` any-type
 *  cards. `cards` is a multiset of hand card ids (duplicates allowed when the
 *  hand holds copies). Mirrors the spend logic in `heroMove`. */
export function validateMovePayment(cat: Catalog, hero: HeroState, to: LocationId, cards: CardId[]): boolean {
  const opt = moveOptions(cat, hero).find((o) => o.to === to);
  if (!opt) return false;
  if (!cards.length) return false;
  // The chosen cards must be a sub-multiset of the hand.
  const have = new Map<CardId, number>();
  for (const c of hero.hand) have.set(c, (have.get(c) ?? 0) + 1);
  const want = new Map<CardId, number>();
  for (const c of cards) want.set(c, (want.get(c) ?? 0) + 1);
  for (const [id, n] of want) if ((have.get(id) ?? 0) < n) return false;
  // Terrain route: exactly one matching-terrain card (never available on a
  // water path crossed by Boat, where any single card is required instead).
  if (opt.terrainPayable && cards.length === 1 && cat.combatCards[cards[0]]?.terrain === opt.terrain) return true;
  // Any-card route: exactly the printed number of cards, of any type.
  return cards.length === opt.anyCardCost;
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
