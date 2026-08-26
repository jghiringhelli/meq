// Corruption cards (rulebook p.26). A corrupted hero draws a Corruption card
// from the shared deck; each imposes an ongoing penalty while held and lists a
// favor cost (its `cost`) to discard at Rest. A couple of cards resolve
// immediately and shuffle back into the deck instead of being held. This module
// owns the deck, the draw/discard/cleanse operations, and the query helpers the
// rest of the engine consults to enforce each card's ongoing effect.
import type { Catalog, GameState, HeroId, HeroState, CardId } from './types';

/** Grant a hero `n` favor, respecting the Mistrusted (per-turn gain cap) and
 *  Despairing (absolute cap) Corruption cards. Returns the amount actually
 *  gained. Losses (n <= 0) are applied unclamped. */
export function grantFavor(cat: Catalog, hero: HeroState, n: number): number {
  if (n <= 0) { hero.favor += n; if (hero.favor < 0) hero.favor = 0; return n; }
  let allow = n;
  const gainCap = corruptionFavorGainCap(cat, hero);
  if (gainCap !== undefined) {
    const already = hero.favorGainedThisTurn ?? 0;
    allow = Math.max(0, Math.min(allow, gainCap - already));
    hero.favorGainedThisTurn = already + allow;
  }
  hero.favor += allow;
  const favCap = corruptionFavorCap(cat, hero);
  if (favCap !== undefined && hero.favor > favCap) hero.favor = favCap;
  return allow;
}

/** Keep the numeric mirror in sync with the real held-card list. */
export function syncCorruption(hero: HeroState): void {
  hero.corruption = hero.corruptionCards?.length ?? 0;
}

/** A deterministic, non-gameplay shuffle (never touches the shared rng stream),
 *  matching the pattern used by the Sauron plot/deck helpers. */
function localShuffle(ids: CardId[], seed: number): CardId[] {
  const a = [...ids];
  let r = (seed ^ 0x51ec7) >>> 0;
  const rand = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 0x100000000; };
  for (let j = a.length - 1; j > 0; j--) { const t = Math.floor(rand() * (j + 1)); [a[j], a[t]] = [a[t], a[j]]; }
  return a;
}

/** Build the shuffled Corruption deck (all card ids) for setup. */
export function buildCorruptionDeck(cat: Catalog, seed: number): CardId[] {
  return localShuffle(Object.keys(cat.corruption), seed);
}

function hero(s: GameState, heroId: HeroId): HeroState {
  return s.heroes.find((h) => h.id === heroId)!;
}

function reshuffleDiscardIntoDeck(s: GameState): void {
  const deck = (s.corruptionDeck ??= []);
  const disc = (s.corruptionDiscard ??= []);
  if (!disc.length) return;
  deck.push(...localShuffle(disc.splice(0), s.seed ^ (0x1301 + (s.story?.turn ?? 0))));
}

/** Draw the top Corruption card (reshuffling the discard when the deck runs dry). */
function drawTop(s: GameState): CardId | null {
  const deck = (s.corruptionDeck ??= []);
  if (!deck.length) reshuffleDiscardIntoDeck(s);
  return deck.length ? deck.shift()! : null;
}

/** Apply an "immediate" Corruption card's one-off effect, then (per the card
 *  text) shuffle it and the discard pile back into the deck. Returns a log tag. */
function applyImmediate(s: GameState, cat: Catalog, h: HeroState, id: CardId): string {
  const card = cat.corruption[id];
  const key = card?.effectKey ?? '';
  let tag = card?.name ?? id;
  if (key === 'immediate-loseFavor-2') {
    const lost = Math.min(2, h.favor);
    h.favor -= lost;
    tag = `${card?.name}: discard ${lost} favor`;
  } else if (key === 'immediate-endTurnMoveHaven') {
    // "Your turn immediately ends. Sauron may then choose to move you to the
    //  nearest Haven." The move is Sauron's OPTION; the mandatory part is the
    //  turn ending. (A relocation that lands the hero safely in a Haven aids the
    //  hero, so a rational Sauron declines it — we model the mandatory effect.)
    h.actionsRemaining = 0;
    tag = `${card?.name}: turn ends`;
  }
  // The immediate card + the discard pile shuffle back into the deck.
  (s.corruptionDiscard ??= []).push(id);
  reshuffleDiscardIntoDeck(s);
  return tag;
}

/** A hero gains `n` Corruption cards (rulebook p.26). Immediate cards resolve
 *  and return to the deck; the rest are held. Keeps the numeric mirror synced. */
export function gainCorruption(s: GameState, cat: Catalog, heroId: HeroId, n: number): string {
  const h = hero(s, heroId);
  h.corruptionCards ??= [];
  const held: string[] = [];
  const immediate: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = drawTop(s);
    if (!id) break;
    const key = cat.corruption[id]?.effectKey ?? '';
    if (key.startsWith('immediate-')) immediate.push(applyImmediate(s, cat, h, id));
    else { h.corruptionCards.push(id); held.push(cat.corruption[id]?.name ?? id); }
  }
  // Increment the numeric mirror by the number of cards actually held (immediate
  // cards return to the deck and never count). Adding rather than syncing to the
  // card-list length preserves any pre-seeded numeric-only corruption value.
  h.corruption = (h.corruption ?? 0) + held.length;
  const parts = [
    held.length ? `gains ${held.join(', ')}` : '',
    immediate.length ? immediate.join('; ') : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : `+${n} corruption`;
}

/** Remove up to `n` held Corruption cards for free (Event/Encounter/Haven
 *  removal, rulebook p.26). Cards return to the discard pile. */
export function discardCorruption(s: GameState, _cat: Catalog, heroId: HeroId, n: number): number {
  const h = hero(s, heroId);
  if (!h.corruptionCards?.length) {
    // Legacy numeric-only state (no backing cards): just floor the mirror.
    const removed = Math.min(n, h.corruption);
    h.corruption = Math.max(0, h.corruption - n);
    return removed;
  }
  let removed = 0;
  for (; removed < n && h.corruptionCards.length; removed++) {
    (s.corruptionDiscard ??= []).push(h.corruptionCards.pop()!);
  }
  syncCorruption(h);
  return removed;
}

/** Remove ALL held Corruption cards (some Haven Events/Encounters). */
export function discardAllCorruption(s: GameState, cat: Catalog, heroId: HeroId): number {
  const h = hero(s, heroId);
  const n = h.corruptionCards?.length ? h.corruptionCards.length : h.corruption;
  return discardCorruption(s, cat, heroId, n);
}

/** Rest cleanse (rulebook p.26): discard one held Corruption card by paying the
 *  favor cost printed on it. Picks the given card, else the cheapest the hero
 *  can afford. Returns the removed card id, or null if none could be paid for. */
export function cleanseAtRest(s: GameState, cat: Catalog, heroId: HeroId, cardId?: CardId): CardId | null {
  const h = hero(s, heroId);
  const held = h.corruptionCards ?? [];
  if (!held.length) return null;
  const costOf = (id: CardId) => parseInt(cat.corruption[id]?.cost ?? '0', 10) || 0;
  let pick: CardId | undefined;
  if (cardId && held.includes(cardId) && h.favor >= costOf(cardId)) pick = cardId;
  else {
    const affordable = held.filter((id) => h.favor >= costOf(id)).sort((a, b) => costOf(a) - costOf(b));
    pick = affordable[0];
  }
  if (!pick) return null;
  h.favor -= costOf(pick);
  held.splice(held.indexOf(pick), 1);
  (s.corruptionDiscard ??= []).push(pick);
  syncCorruption(h);
  return pick;
}

// ---------------- ongoing-effect query helpers ----------------
// Each reads the hero's held cards and their effectKey. Cheap; call at the
// relevant enforcement point.

function keysOf(cat: Catalog, h: HeroState): string[] {
  return (h.corruptionCards ?? []).map((id) => cat.corruption[id]?.effectKey ?? '');
}
function count(cat: Catalog, h: HeroState, key: string): number {
  return keysOf(cat, h).filter((k) => k === key).length;
}
function has(cat: Catalog, h: HeroState, key: string): boolean {
  return count(cat, h, key) > 0;
}

/** Total attribute penalty from Deranged/Helpless/Weary/Weak (−1 each). */
export function corruptionStatPenalty(
  cat: Catalog, h: HeroState, stat: 'wisdom' | 'agility' | 'fortitude' | 'strength',
): number {
  const n = keysOf(cat, h).filter((k) => k === `stat-${stat}--1`).length;
  return n ? -n : 0;
}

/** Distraught: hand-size cap of 7 while held (else undefined = no cap). */
export function corruptionHandLimit(cat: Catalog, h: HeroState): number | undefined {
  return has(cat, h, 'handLimit-7') ? 7 : undefined;
}

/** Despairing: favor cap of 3 while held (else undefined). */
export function corruptionFavorCap(cat: Catalog, h: HeroState): number | undefined {
  return has(cat, h, 'favorCap-3') ? 3 : undefined;
}

/** Hopeless: Travel-step cap of 3 per turn while held (else undefined). */
export function corruptionTravelCap(cat: Catalog, h: HeroState): number | undefined {
  return has(cat, h, 'travelCap-3') ? 3 : undefined;
}

/** Mistrusted: at most +1 favor gained per turn while held (else undefined). */
export function corruptionFavorGainCap(cat: Catalog, h: HeroState): number | undefined {
  return has(cat, h, 'favorGainCap-1') ? 1 : undefined;
}

/** Indifferent: Encounter draws reduced by 1 each (default 3). */
export function corruptionEncounterDraw(cat: Catalog, h: HeroState, base = 3): number {
  return Math.max(1, base - count(cat, h, 'encounterDraw-1'));
}

/** Reckless: Sauron draws this many extra Peril cards on the hero's turn. */
export function corruptionPerilBonus(cat: Catalog, h: HeroState): number {
  return count(cat, h, 'sauronPerilBonus');
}

/** Isolated: the hero may not consult characters or trade with heroes. */
export function corruptionBlocksSocial(cat: Catalog, h: HeroState): boolean {
  return has(cat, h, 'noConsultTrade');
}

/** Despondent: on Rest/defeat the leftmost Sauron marker advances 2 (not 1). */
export function corruptionRestDefeatSteps(cat: Catalog, h: HeroState, base = 1): number {
  return base + (has(cat, h, 'restDefeatMarker-2') ? 1 : 0);
}

/** Cowardly: discard this many random Hero cards at the start of each combat. */
export function corruptionCombatStartDiscard(cat: Catalog, h: HeroState): number {
  return count(cat, h, 'combatStartDiscard-1');
}

/** Greedy: after Sauron plays a Shadow on the hero's turn he may draw a new one. */
export function corruptionSauronShadowRedraw(cat: Catalog, h: HeroState): boolean {
  return has(cat, h, 'sauronShadowRedraw');
}
