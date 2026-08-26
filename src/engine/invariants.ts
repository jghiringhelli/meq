// Central game-state consistency checker. `checkInvariants` returns a list of
// human-readable violations (empty = a healthy state). Used by the E2E
// simulation harness to prove that no engine transition leaves the game in an
// inconsistent state, and available to the UI/debug tooling.
import type { Catalog, GameState } from './types';
import { STORY_FINALE } from './types';

export function checkInvariants(s: GameState, cat: Catalog): string[] {
  const v: string[] = [];
  const combat = cat.combatCards;
  const validCard = (id: string) => !!combat[id];

  // ---- heroes ----
  const seatsSeen = new Set<number>();
  for (const h of s.heroes) {
    const tag = `hero ${h.id}`;
    if (h.corruption < 0) v.push(`${tag}: negative corruption ${h.corruption}`);
    if (h.favor < 0) v.push(`${tag}: negative favor ${h.favor}`);
    if (h.actionsRemaining < 0) v.push(`${tag}: negative actionsRemaining ${h.actionsRemaining}`);
    if (h.status !== 'active' && h.status !== 'defeated') v.push(`${tag}: bad status '${h.status}'`);
    if (!cat.locations[h.location]) v.push(`${tag}: unknown location '${h.location}'`);
    // NOTE: `life` is a display-only mirror of the life pool (may lag a tick
    // after combat before the next syncLife); the authoritative life is
    // deck.length, so we do not treat a stale mirror as a hard inconsistency.
    if (seatsSeen.has(h.seat)) v.push(`${tag}: duplicate seat ${h.seat}`);
    seatsSeen.add(h.seat);
    for (const zone of ['deck', 'hand', 'discard', 'damagePool'] as const) {
      for (const c of h[zone]) if (!validCard(c)) v.push(`${tag}: invalid card '${c}' in ${zone}`);
    }
    // board placement consistency: the hero must be listed at its own location.
    if (h.status === 'active' && !(s.map.heroesAt[h.location] ?? []).includes(h.id)) {
      v.push(`${tag}: not present in map.heroesAt['${h.location}']`);
    }
  }

  // ---- active hero index ----
  if (s.activeHeroIndex < 0 || s.activeHeroIndex >= s.heroes.length) {
    v.push(`activeHeroIndex ${s.activeHeroIndex} out of range (${s.heroes.length} heroes)`);
  }

  // ---- Sauron / influence ----
  if (s.sauron.influence < 0) v.push(`sauron.influence negative ${s.sauron.influence}`);
  for (const [loc, n] of Object.entries(s.sauron.locationInfluence ?? {})) {
    if (n < 0) v.push(`location influence '${loc}' negative ${n}`);
    if (cat.locations[loc]?.kind === 'haven' && n > 0) v.push(`influence on haven '${loc}' (${n})`);
  }
  if ((s.sauron.activePlots?.length ?? 0) > 3) {
    v.push(`too many active plots: ${s.sauron.activePlots!.length} (>3)`);
  }

  // ---- story markers ----
  // sauronProgress is an ABSTRACT, unbounded aggregate counter: once it reaches
  // the Finale the game enters the Ringwraith endgame window and plots keep
  // pushing it while the heroes play out the finale, so it legitimately exceeds
  // STORY_FINALE. Only a negative value is a genuine inconsistency. The three
  // COLORED markers are the real MEQ markers and stay clamped to [0, Finale].
  if (s.story.sauronProgress < 0) v.push(`story sauronProgress negative ${s.story.sauronProgress}`);
  const clampCheck = (name: string, n: number | undefined) => {
    if (n === undefined) return;
    if (n < 0 || n > STORY_FINALE) v.push(`story marker ${name}=${n} out of [0,${STORY_FINALE}]`);
  };
  if (s.story.sauron) {
    clampCheck('yellow', s.story.sauron.yellow);
    clampCheck('red', s.story.sauron.red);
    clampCheck('black', s.story.sauron.black);
  }

  // ---- board references ----
  for (const [loc, ids] of Object.entries(s.map.monstersAt ?? {})) {
    if (ids.length && !cat.locations[loc]) v.push(`monsters at unknown location '${loc}'`);
    for (const m of ids) if (!cat.monsters[m]) v.push(`unknown monster '${m}' at '${loc}'`);
  }
  for (const [loc, ids] of Object.entries(s.map.minionsAt ?? {})) {
    if (ids.length && !cat.locations[loc]) v.push(`minions at unknown location '${loc}'`);
    for (const m of ids) if (!cat.minions[m]) v.push(`unknown minion '${m}' at '${loc}'`);
  }
  for (const [loc, ids] of Object.entries(s.map.heroesAt ?? {})) {
    if (ids.length && !cat.locations[loc]) v.push(`heroes at unknown location '${loc}'`);
  }

  // ---- monster-token piles: without replacement, only valid entries ----
  for (const [r, pile] of Object.entries(s.sauron.monsterBagPiles ?? {})) {
    const bag = cat.monsterBags[r];
    if (!bag) { v.push(`monster pile for unknown region '${r}'`); continue; }
    const cap = bag.blanks + bag.tokens.reduce((n, t) => n + t.count, 0);
    if (pile.length > cap) v.push(`monster pile '${r}' larger (${pile.length}) than bag capacity ${cap}`);
    for (const e of pile) if (e !== 'blank' && !cat.monsters[e]) v.push(`invalid token '${e}' in pile '${r}'`);
  }

  return v;
}
