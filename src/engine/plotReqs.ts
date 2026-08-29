// Plot play requirements (rulebook: most Plot cards may only be played once a
// board state — printed on the card — is prepared, typically over several turns:
// concentrated influence near a location, a monster/minion in a region, or a
// specific location's contents). Sauron plays ONE plot per turn and only when
// its requirement is currently satisfied, so the strong marker-plots cannot be
// stacked instantly — they must be set up first.
//
// The card text lives in each plot's `condition` field; this module compiles the
// eleven distinct requirements into evaluable predicates. A predicate returns the
// LOCATION the plot marker is placed at when the requirement is met, or null when
// it is not yet playable. Plots with no printed condition are always playable
// (subject only to the Shadow-Pool `influenceCost` gate applied by advancePlots).
import type { Catalog, GameState, LocationId, Plot } from './types';
import { influenceAt } from './influence';

function neighbors(cat: Catalog, from: LocationId): LocationId[] {
  const out: LocationId[] = [];
  for (const e of cat.edges) {
    if (e.a === from) out.push(e.b);
    else if (e.b === from) out.push(e.a);
  }
  return out;
}

/** Total Sauron influence on a location AND its immediate neighbours ("within
 *  1 space of X"). */
function influenceWithin1(s: GameState, cat: Catalog, center: LocationId): number {
  let n = influenceAt(s, center);
  for (const nb of neighbors(cat, center)) n += influenceAt(s, nb);
  return n;
}

function hasMonster(s: GameState, loc: LocationId): boolean {
  return (s.map.monstersAt?.[loc]?.length ?? 0) > 0;
}
function hasMinion(s: GameState, loc: LocationId): boolean {
  return (s.map.minionsAt?.[loc]?.length ?? 0) > 0;
}
function hasCharacter(s: GameState, loc: LocationId): boolean {
  return (s.map.charactersAt?.[loc]?.length ?? 0) > 0;
}
/** A monster token or minion on `center` or a neighbour ("within 1 space"). */
function mobWithin1(s: GameState, cat: Catalog, center: LocationId): boolean {
  if (hasMonster(s, center) || hasMinion(s, center)) return true;
  return neighbors(cat, center).some((nb) => hasMonster(s, nb) || hasMinion(s, nb));
}
function plotMarkerAt(s: GameState, loc: LocationId): boolean {
  return (s.sauron.activePlots ?? []).some((p) => p.location === loc);
}
function plotActive(s: GameState, id: string): boolean {
  return (s.sauron.activePlots ?? []).some((p) => p.eventId === id);
}
/** First location satisfying `pred`, in catalog order (Sauron's choice). */
function findLoc(cat: Catalog, pred: (loc: LocationId) => boolean): LocationId | null {
  for (const id of Object.keys(cat.locations)) if (pred(id as LocationId)) return id as LocationId;
  return null;
}

/** "A Haven (Sauron's choice) with no plot marker and 6+ influence adjacent." */
function brokenLineOfKings(s: GameState, cat: Catalog): LocationId | null {
  let best: LocationId | null = null, bestAdj = -1;
  for (const l of Object.values(cat.locations)) {
    if (l.kind !== 'haven' || plotMarkerAt(s, l.id)) continue;
    const adj = neighbors(cat, l.id).reduce((n, nb) => n + influenceAt(s, nb), 0);
    if (adj >= 6 && adj > bestAdj) { bestAdj = adj; best = l.id; }
  }
  return best;
}

/** Per-plot requirement predicates → placement location when met, else null. */
const REQS: Record<string, (s: GameState, cat: Catalog) => LocationId | null> = {
  'a-dark-messenger': (s) => (hasMinion(s, 'erebor') ? 'erebor' : null),
  'osgiliath-invaded': (s) => (hasMonster(s, 'osgiliath') ? 'osgiliath' : null),
  'wormtongue-taints-theoden': (s, cat) =>
    (influenceWithin1(s, cat, 'edoras') >= 6 || plotActive(s, 'saruman-falls-to-corruption')) ? 'edoras' : null,
  'orcs-in-the-mountains': (s, cat) =>
    (influenceWithin1(s, cat, 'mount-gundabad') >= 8 ? 'mount-gundabad' : null),
  'a-broken-line-of-kings': brokenLineOfKings,
  'a-broken-line-of-kings-2': brokenLineOfKings,
  'smeagol-escapes': (s, cat) =>
    (mobWithin1(s, cat, 'the-woodland-realm') ? 'the-woodland-realm' : null),
  'loss-of-an-heir': (s, cat) =>
    (['edoras', 'minas-tirith'] as LocationId[]).find((l) => mobWithin1(s, cat, l)) ?? null,
  'a-promise-of-rings': (s, cat) =>
    findLoc(cat, (l) => hasCharacter(s, l) && (hasMonster(s, l) || hasMinion(s, l))),
  'rise-of-the-uruk-hai': (s) =>
    (influenceAt(s, 'isengard') >= 3 || plotActive(s, 'saruman-falls-to-corruption')) ? 'isengard' : null,
  'urgent-summons': (s, cat) =>
    findLoc(cat, (l) => hasCharacter(s, l) && !plotMarkerAt(s, l)),
};

export type PlotPlacement = { ok: false } | { ok: true; location?: LocationId };

/** Whether `plot` may be played right now, and where its marker is placed. A
 *  plot with no printed board condition is always playable (its marker goes on
 *  its `affects` location, or off-board when it has none). A plot with a modelled
 *  condition is playable only when the predicate finds a valid location. An
 *  unmodelled condition fails open (never blocks — preserves prior behaviour). */
export function plotPlacement(s: GameState, cat: Catalog, plot: Plot): PlotPlacement {
  const cond = (plot.condition ?? '').trim();
  const affects = (plot.affects || undefined) as LocationId | undefined;
  if (!cond) return { ok: true, location: affects };
  const req = REQS[plot.id];
  if (!req) return { ok: true, location: affects }; // unmodelled condition → fail open
  const loc = req(s, cat);
  return loc ? { ok: true, location: loc } : { ok: false };
}

/** A location the Eye should grow influence TOWARD to make `plot`'s (influence-
 *  based) requirement come true — so the automa deliberately PREPARES a strong
 *  marker-plot over several turns. Returns null for monster/character-based
 *  requirements (those are enabled opportunistically by normal board pressure)
 *  and for plots with no influence requirement. */
export function plotPrepTarget(s: GameState, cat: Catalog, plot: Plot): LocationId | null {
  switch (plot.id) {
    case 'orcs-in-the-mountains': return 'mount-gundabad';
    case 'wormtongue-taints-theoden': return 'edoras';
    case 'rise-of-the-uruk-hai': return 'isengard';
    case 'a-broken-line-of-kings':
    case 'a-broken-line-of-kings-2': {
      // Build toward the plot-marker-free Haven whose neighbourhood already holds
      // the most influence (closest to the 6-adjacent threshold).
      let best: LocationId | null = null, bestAdj = -1;
      for (const l of Object.values(cat.locations)) {
        if (l.kind !== 'haven' || plotMarkerAt(s, l.id)) continue;
        const adj = neighbors(cat, l.id).reduce((n, nb) => n + influenceAt(s, nb), 0);
        if (adj > bestAdj) { bestAdj = adj; best = l.id; }
      }
      return best;
    }
    default: return null;
  }
}
