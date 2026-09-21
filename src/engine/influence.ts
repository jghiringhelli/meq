// MEQ per-location influence model (rulebook pp. 16–18, 22–23).
//
// Influence is tracked PER LOCATION (`s.sauron.locationInfluence`), not per
// region. Two distinct pools exist:
//   · the Shadow Pool (`s.sauron.influence`, a scalar war chest) — gates the
//     play of Plot/Shadow cards and funds spawns; capped at 4× the game stage.
//   · influence tokens ON locations — make locations perilous, gate monster
//     placement/movement, and satisfy plot/encounter requirements.
//
// Location influence obeys the "extension of a Shadow Stronghold" rule: influence
// placed with a Place-Influence action must chain, through influenced locations,
// back to a Shadow Stronghold, and no location may exceed the influence strength
// (red max number) of its connected stronghold. Havens can never hold influence.
import type { Catalog, GameState, LocationId, RegionId } from './types';

export function isStronghold(cat: Catalog, loc: LocationId): boolean {
  return cat.locations[loc]?.kind === 'stronghold';
}
export function isHaven(cat: Catalog, loc: LocationId): boolean {
  return cat.locations[loc]?.kind === 'haven';
}
/** The red max-influence number printed on a Shadow Stronghold's tower icon. */
export function strongholdMax(cat: Catalog, loc: LocationId): number {
  return cat.locations[loc]?.strongholdMax ?? 0;
}
export function influenceAt(s: GameState, loc: LocationId): number {
  return s.sauron.locationInfluence?.[loc] ?? 0;
}

/** Locations adjacent to `from` (undirected map edges). Inlined here to keep
 *  this module free of import cycles. */
function neighbors(cat: Catalog, from: LocationId): LocationId[] {
  const out: LocationId[] = [];
  for (const e of cat.edges) {
    if (e.a === from) out.push(e.b);
    else if (e.b === from) out.push(e.a);
  }
  return out;
}

/** All Shadow Stronghold location ids. */
export function strongholds(cat: Catalog): LocationId[] {
  return Object.values(cat.locations).filter((l) => l.kind === 'stronghold').map((l) => l.id);
}

/** The set of influenced locations that are "in extension" — i.e. reachable,
 *  through a contiguous chain of influenced locations, from a Shadow Stronghold
 *  that itself holds influence. Each returned location also carries the highest
 *  connected stronghold max (its per-location influence cap). */
export function extension(s: GameState, cat: Catalog): Map<LocationId, number> {
  const inf = (loc: LocationId) => influenceAt(s, loc) > 0;
  const result = new Map<LocationId, number>();
  // Seed a BFS from every stronghold that currently holds influence.
  for (const sh of strongholds(cat)) {
    if (!inf(sh)) continue;
    const cap = strongholdMax(cat, sh);
    const queue: LocationId[] = [sh];
    const seen = new Set<LocationId>([sh]);
    while (queue.length) {
      const cur = queue.shift()!;
      // A location's cap is the highest connected stronghold max.
      result.set(cur, Math.max(result.get(cur) ?? 0, cap));
      for (const nb of neighbors(cat, cur)) {
        if (!seen.has(nb) && inf(nb)) { seen.add(nb); queue.push(nb); }
      }
    }
  }
  return result;
}

/** The per-location cap when placing influence with a Place-Influence action:
 *  a stronghold is capped by its own red number; any other location is capped by
 *  the highest stronghold max of an anchored extension it touches (it is legal to
 *  extend onto a location adjacent to the current extension). Returns 0 if no
 *  legal placement (not connected to any stronghold). Havens are never legal. */
export function placementCap(s: GameState, cat: Catalog, loc: LocationId): number {
  if (isHaven(cat, loc)) return 0;
  if (isStronghold(cat, loc)) return strongholdMax(cat, loc);
  const ext = extension(s, cat);
  let cap = ext.get(loc) ?? 0; // already in extension
  for (const nb of neighbors(cat, loc)) cap = Math.max(cap, ext.get(nb) ?? 0);
  return cap;
}

/** Whether a Place-Influence action may add one influence to `loc` right now. */
export function canPlaceInfluence(s: GameState, cat: Catalog, loc: LocationId): boolean {
  return influenceAt(s, loc) < placementCap(s, cat, loc);
}

/** Legal targets for a Place-Influence action, best-first is left to the caller. */
export function placementTargets(s: GameState, cat: Catalog): LocationId[] {
  return Object.keys(cat.locations).filter((loc) => canPlaceInfluence(s, cat, loc));
}

/** Add `n` influence to a location (Place-Influence action): clamped to the
 *  placement cap. Returns how much was actually placed. */
export function placeInfluenceAction(s: GameState, cat: Catalog, loc: LocationId, n: number): number {
  const store = (s.sauron.locationInfluence ||= {});
  const cap = placementCap(s, cat, loc);
  const before = store[loc] ?? 0;
  const after = Math.min(cap, before + Math.max(0, n));
  if (after <= before) return 0;
  store[loc] = after;
  return after - before;
}

/** Add `n` influence to a location from a card effect (Event/Shadow/Encounter).
 *  Card-driven placement is not bound by the extension rule, but still never
 *  lands on a Haven. Returns the amount placed. */
export function addCardInfluence(s: GameState, cat: Catalog, loc: LocationId, n: number): number {
  if (isHaven(cat, loc) || n <= 0) return 0;
  const store = (s.sauron.locationInfluence ||= {});
  store[loc] = (store[loc] ?? 0) + n;
  return n;
}

/** Remove up to `n` influence from a location (min 0). Returns amount removed. */
export function removeInfluenceAt(s: GameState, loc: LocationId, n: number): number {
  const store = (s.sauron.locationInfluence ||= {});
  const before = store[loc] ?? 0;
  const after = Math.max(0, before - Math.max(0, n));
  store[loc] = after;
  if (after === 0) delete store[loc];
  return before - after;
}

/** Clear ALL influence from a location (Hero Rally / discard effects). */
export function clearInfluenceAt(s: GameState, loc: LocationId): number {
  return removeInfluenceAt(s, loc, Number.MAX_SAFE_INTEGER);
}

/** Total influence on all locations within a region (region-aggregate queries
 *  used by some Encounter/Mission conditions). */
export function regionInfluenceTotal(s: GameState, cat: Catalog, region: RegionId): number {
  let sum = 0;
  for (const [loc, n] of Object.entries(s.sauron.locationInfluence ?? {})) {
    if (cat.locations[loc]?.regionId === region) sum += n;
  }
  return sum;
}

/** Whether any location in a region holds influence (monster-placement gate). */
export function regionHasInfluence(s: GameState, cat: Catalog, region: RegionId): boolean {
  return regionInfluenceTotal(s, cat, region) > 0;
}

/** Total influence within one board SUB-region (a single color half of a
 *  region-encounter-deck pair, e.g. "Brown" within Mordor and Brown Lands).
 *  Per the manual, each of the two colors sharing an Encounter deck is its
 *  own distinct region for "your region"-scoped card effects — narrower than
 *  regionInfluenceTotal, which sums the whole merged deck-pair area (used for
 *  monster-placement gating, where the wider merged region is correct). */
export function subRegionInfluenceTotal(s: GameState, cat: Catalog, regionColor: string): number {
  let sum = 0;
  for (const [loc, n] of Object.entries(s.sauron.locationInfluence ?? {})) {
    if (cat.locations[loc]?.regionColor === regionColor) sum += n;
  }
  return sum;
}

/** A location made perilous by an active Plot regardless of influence
 *  (Saruman Falls to Corruption → Isengard). */
export function plotMakesPerilous(s: GameState, loc: LocationId): boolean {
  if (loc !== 'isengard') return false;
  return (s.sauron.activePlots ?? []).some((p) => p.eventId === 'saruman-falls-to-corruption');
}

/** A location is perilous for a hero when its influence strictly exceeds the
 *  hero's wisdom (rulebook pp. 22–23), it is an inherently Perilous location,
 *  or an active Plot marks it perilous. */
export function isPerilous(s: GameState, cat: Catalog, loc: LocationId, wisdom: number): boolean {
  return influenceAt(s, loc) > wisdom || !!cat.locations[loc]?.perilous || plotMakesPerilous(s, loc);
}

/** Enforce the structural rules after the board changes (esp. after the Hero
 *  Rally discard breaks chains): every influenced non-stronghold location that
 *  is no longer in extension of a stronghold is reduced to a single token, and
 *  every extension location is clamped to its connected stronghold max. */
export function enforceInfluenceRules(s: GameState, cat: Catalog): void {
  const store = s.sauron.locationInfluence ?? {};
  const ext = extension(s, cat);
  for (const [loc, n] of Object.entries(store)) {
    if (n <= 0) { delete store[loc]; continue; }
    if (isStronghold(cat, loc)) {
      const cap = strongholdMax(cat, loc);
      if (n > cap) store[loc] = Math.max(1, cap);
      continue;
    }
    const cap = ext.get(loc);
    if (cap === undefined) {
      // No longer connected to a stronghold: keep a single token.
      if (n > 1) store[loc] = 1;
    } else if (n > cap) {
      store[loc] = Math.max(1, cap);
    }
  }
}

/** The location a monster/minion command should target: any location that holds
 *  influence and (for monsters) has no hero. */
export function monsterPlaceable(s: GameState, loc: LocationId): boolean {
  return influenceAt(s, loc) > 0 && (s.map.heroesAt[loc]?.length ?? 0) === 0;
}

/** Shortest hop-count between two locations over the map graph (BFS). */
export function graphDistance(cat: Catalog, from: LocationId, to: LocationId): number {
  if (from === to) return 0;
  const seen = new Set<LocationId>([from]);
  let frontier = [from];
  let dist = 0;
  while (frontier.length) {
    dist++;
    const next: LocationId[] = [];
    for (const cur of frontier) {
      for (const nb of neighbors(cat, cur)) {
        if (nb === to) return dist;
        if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
      }
    }
    frontier = next;
  }
  return Number.POSITIVE_INFINITY;
}

/** The best legal Place-Influence target growing the extension toward `toward`:
 *  the placeable location (in/adjacent to extension, or a stronghold) nearest to
 *  the target. Returns null if nothing is placeable. */
export function bestPlacementToward(s: GameState, cat: Catalog, toward: LocationId): LocationId | null {
  let best: LocationId | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const loc of placementTargets(s, cat)) {
    const d = graphDistance(cat, loc, toward);
    if (d < bestD) { bestD = d; best = loc; }
  }
  return best;
}
