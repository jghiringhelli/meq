// M15 — interactive Sauron turn: the command-action primitives a human Sauron
// uses during their Plot Step and Action Step. Faithful to the playeraid "Sauron
// Turn": Plot Step (play/pass a plot), then an Action Step of 2 actions (3 with
// three heroes), each a Place-influence / Deploy / Move / Heal / Play-shadow /
// Spawn command. The automatic Story, Event, Hero-Draw and Story-Advance steps
// are handled by the phase machine (see phases.ts sauron* wrappers).
import type { Catalog, GameState, LocationId, MinionId, Plot } from './types';
import { clone, gameStage } from './mechanics';
import { drawMonsterToken } from './ai';
import { log } from './log';
import { autoResolveTree, stepResolveTree, treeActor, treeActorIsHuman } from './encounter';
import { applyPlotCard, drawShadow, takePlots, eyePlaceToken, eyeTrackYield, shadowWindow, type EyeTrack } from './sauronmech';
import { influenceAt, canPlaceInfluence, placeInfluenceAction, removeInfluenceAt, monsterPlaceable, placementTargets } from './influence';
import { plotPlacement, plotPlacementOptions } from './plotReqs';

const num = (v: number | string): number => (typeof v === 'number' ? v : Number(v) || 0);

// ---- Plot Step ---------------------------------------------------------
/** Plots the human may play now: in HAND, not already active, affordable. */
export function playablePlots(s: GameState, cat: Catalog): Plot[] {
  const active = new Set((s.sauron.activePlots ?? []).map((e) => e.eventId));
  if (active.size >= 3) return [];
  if (s.story.turn <= 1 || s.sauronPlotPlayed) return []; // skipped turn 1; one plot per Plot Step
  const hand = new Set(s.sauron.plotHand ?? []);
  return cat.plots.filter((p) =>
    !p.starting && hand.has(p.id) && !active.has(p.id) && s.sauron.influence >= num(p.influenceCost)
    && plotPlacement(s, cat, p).ok); // printed board requirement must be met
}

/** Where a plot's marker may go right now (more than one = the human picks). */
export function plotLocationChoices(s: GameState, cat: Catalog, plotId: string): LocationId[] {
  const p = cat.plots.find((x) => x.id === plotId);
  return p ? plotPlacementOptions(s, cat, p).filter((l): l is LocationId => !!l) : [];
}

/** Plot Step alternative (rulebook p.13): instead of playing a Plot card, Sauron
 *  may discard one of his ACTIVE plots — always legal, e.g. to free a full track. */
export function canDiscardActivePlot(s: GameState): boolean {
  return s.phase === 'SauronEvents' && s.story.turn > 1 && !s.sauronPlotPlayed && (s.sauron.activePlots ?? []).length > 0;
}
export function sauronDiscardPlot(state: GameState, cat: Catalog, plotId: string): GameState {
  if (!canDiscardActivePlot(state)) return state;
  const entry = (state.sauron.activePlots ?? []).find((e) => e.eventId === plotId);
  if (!entry) return state;
  const s = clone(state);
  s.sauronPlotPlayed = true; // play OR discard, not both
  s.sauron.activePlots = (s.sauron.activePlots ?? []).filter((e) => e.eventId !== plotId);
  (s.sauron.plotDiscard ??= []).push(plotId);
  log(s, 'sauron', 'Sauron', `discards active plot ${cat.plots.find((p) => p.id === plotId)?.name ?? plotId}`);
  return s;
}

/** Plot Step: play a plot card. Its influence figure is only a THRESHOLD Sauron
 *  must meet in the Shadow Pool (rulebook p.13: "playing the card does not cause
 *  Sauron to discard any influence from the Shadow Pool") — it is never spent.
 *  Phase stays in SauronEvents; the caller then resolves the Event Step. */
export function sauronPlayPlot(state: GameState, cat: Catalog, plotId: string, loc?: LocationId): GameState {
  if (state.phase !== 'SauronEvents' || state.story.turn <= 1 || state.sauronPlotPlayed) return state;
  const p = cat.plots.find((x) => x.id === plotId);
  if (!p) return state;
  const cost = num(p.influenceCost);
  if (state.sauron.influence < cost) return state; // threshold gate only — not a spend
  const placement = plotPlacement(state, cat, p);
  if (!placement.ok) return state; // board requirement not met
  // "Sauron's choice" plots: one legal spot is taken automatically; several need his pick.
  const choices = plotLocationChoices(state, cat, plotId);
  let placeAt: LocationId | undefined = placement.location;
  if (choices.length > 1) {
    if (!loc || !choices.includes(loc)) return state;
    placeAt = loc;
  } else if (choices.length === 1) placeAt = choices[0];
  const s = clone(state);
  s.sauronPlotPlayed = true;
  s.sauron.plotHand = (s.sauron.plotHand ?? []).filter((id) => id !== plotId);
  applyPlotCard(s, cat, p, cost, (msg) => log(s, 'sauron', 'Sauron', msg), placeAt);
  return s;
}

// ---- Action Step -------------------------------------------------------
// Faithful Eye Action Track model (rulebook pp.16-19): each of the turn's 2 (or
// 3) actions places an Eye token on one of three tracks — Place Influence (yields
// 6/5/4), Draw (2/2/1) or Command (3/2/1) — exactly the tracks the automa uses.
// A human "begins" a track action (sauronBeginAction); Draw resolves at once,
// while Place Influence and Command owe several sub-effects the human resolves
// one at a time (tracked in state.sauronPending).

/** May the human START a new track action right now (an action to spend, no other
 *  action still owing sub-effects)? */
function canBegin(s: GameState): boolean {
  return s.phase === 'SauronMinions' && (s.sauronActionsLeft ?? 0) > 0 && !s.sauronPending;
}
function spend(s: GameState): void {
  s.sauronActionsLeft = Math.max(0, (s.sauronActionsLeft ?? 0) - 1);
}
/** A Command action is mid-flight with commands still owed. */
function canCommand(s: GameState): boolean {
  return s.phase === 'SauronMinions' && s.sauronPending?.track === 'command' && s.sauronPending.remaining > 0;
}
/** Like canCommand, but not while a drawn monster token still awaits placement. */
function canCommandFree(s: GameState): boolean {
  return canCommand(s) && !s.sauronPending?.heldToken;
}
function spendCommand(s: GameState): void {
  if (s.sauronPending?.track === 'command') {
    s.sauronPending.remaining -= 1;
    if (s.sauronPending.remaining <= 0) s.sauronPending = undefined;
  }
}

/** The yield each Action Track would grant if chosen now (null = track full). For
 *  the UI to label the Place Influence / Draw / Command buttons. */
export function sauronActionYields(s: GameState): Record<EyeTrack, number | null> {
  return {
    influence: eyeTrackYield(s, 'influence'),
    draw: eyeTrackYield(s, 'draw'),
    command: eyeTrackYield(s, 'command'),
  };
}

/** Begin one Action-Step action on the chosen Eye track. Draw resolves fully;
 *  Place Influence banks up to 2 to the Shadow Pool (capped at 4× stage) and owes
 *  the rest as board placements; Command owes its yield in commands. */
export function sauronBeginAction(state: GameState, cat: Catalog, track: EyeTrack): GameState {
  if (!canBegin(state)) return state;
  if (eyeTrackYield(state, track) === null) return state; // this track's 3 spaces are covered
  const s = clone(state);
  const yld = eyePlaceToken(s, track, (m) => log(s, 'sauron', 'Sauron', m))!;
  spend(s);
  if (track === 'draw') {
    // Rulebook p.17: draw N Shadow (all kept) and N Plot cards (keep ONE — the
    // human's choice, so it is left pending for the player).
    drawShadow(s, cat, s.sauron.shadowHand.length + yld);
    const drawn = takePlots(s, yld);
    if (drawn.length > 1) {
      s.sauronPending = { track: 'draw', remaining: 1, drawnPlots: drawn };
      log(s, 'sauron', 'Sauron', `Draw action (space ${yld}): drew ${yld} Shadow & ${drawn.length} Plot cards — choose one Plot to keep`);
    } else {
      s.sauron.plotHand!.push(...drawn);
      log(s, 'sauron', 'Sauron', `Draw action (space ${yld}): drew ${yld} Shadow & ${drawn.length} Plot card(s)`);
    }
    return s;
  }
  if (track === 'influence') {
    // Rulebook pp.15-16: of the yield Sauron MAY put up to two in the Shadow Pool
    // (capped at 4× stage); the player chooses with sauronBankInfluence. The rest
    // extend the board. Pool income is never free — it costs this action.
    s.sauronPending = { track: 'influence', remaining: yld, banked: 0 };
    log(s, 'sauron', 'Sauron', `Place Influence action (space ${yld}): place ${yld} token(s) — up to 2 may go to the Shadow Pool`);
    return s;
  }
  s.sauronPending = { track: 'command', remaining: yld };
  log(s, 'sauron', 'Sauron', `Command action (space ${yld}): issue up to ${yld} command(s)`);
  return s;
}

/** Human Draw action: keep one of the drawn Plot cards; the rest go to the
 *  bottom of the Plot deck (with at most 2 drawn there is no order to choose). */
export function sauronKeepDrawnPlot(state: GameState, cat: Catalog, plotId: string): GameState {
  const p = state.sauronPending;
  if (state.phase !== 'SauronMinions' || p?.track !== 'draw' || !p.drawnPlots?.includes(plotId)) return state;
  const s = clone(state);
  s.sauron.plotHand!.push(plotId);
  s.sauron.plotDeck!.push(...p.drawnPlots.filter((id) => id !== plotId));
  s.sauronPending = undefined;
  log(s, 'sauron', 'Sauron', `keeps ${cat.plots.find((x) => x.id === plotId)?.name ?? plotId} and returns the other drawn Plot card(s) to the bottom of the deck`);
  return s;
}

/** Locations adjacent to `from`. */
export function adjacentLocations(cat: Catalog, from: LocationId): LocationId[] {
  const out: LocationId[] = [];
  for (const e of cat.edges) {
    if (e.a === from) out.push(e.b);
    else if (e.b === from) out.push(e.a);
  }
  return out;
}

/** Reserve minions not currently on the board (deployable). */
export function reserveMinions(s: GameState, cat: Catalog): MinionId[] {
  const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
  return Object.values(cat.minions).filter((m) => !onBoard.has(m.id) && !(m.finale && s.story.finale)).map((m) => m.id);
}

/** Locations worth spawning a monster or deploying a minion at during the
 *  Command sub-action: where heroes stand, one step around them, Sauron's own
 *  seat, and any active plot's location — a curated shortlist (not the full
 *  map) since the rulebook leaves the choice to Sauron but any spot far from
 *  the action is never actually useful. Shared by SauronPanel's sidebar list
 *  and Board's on-map click targets so both always agree. */
export function sauronCommandTargets(s: GameState, cat: Catalog, kind?: 'spawn'): LocationId[] {
  // Monster tokens may only go where the engine will accept them: an influenced location with no hero.
  if (kind === 'spawn') {
    const held = s.sauronPending?.heldToken;
    return held ? monsterTargetsIn(s, cat, held.regionId) : [];
  }
  const heroLocs = s.heroes.filter((h) => h.status === 'active').map((h) => h.location);
  const near = new Set<LocationId>([s.sauron.location, ...heroLocs]);
  for (const l of heroLocs) for (const n of adjacentLocations(cat, l)) near.add(n);
  for (const p of s.sauron.activePlots ?? []) if (p.location) near.add(p.location as LocationId);
  return [...near];
}

/** Every Sauron figure on the board (monsters + minions) with its location. */
export function boardFigures(s: GameState): { kind: 'monster' | 'minion'; id: string; loc: LocationId }[] {
  const out: { kind: 'monster' | 'minion'; id: string; loc: LocationId }[] = [];
  for (const [loc, ids] of Object.entries(s.map.monstersAt ?? {})) {
    for (const id of ids) out.push({ kind: 'monster', id, loc });
  }
  for (const [loc, ids] of Object.entries(s.map.minionsAt ?? {})) {
    for (const id of ids) out.push({ kind: 'minion', id, loc });
  }
  return out;
}

/** Legal one-step move targets for a figure. Monsters may only move onto
 *  locations whose region carries Sauron influence; minions move freely (they
 *  may enter havens). */
export function moveTargets(s: GameState, cat: Catalog, kind: 'monster' | 'minion', from: LocationId, id?: string): LocationId[] {
  const nbrs = adjacentLocations(cat, from);
  if (kind === 'minion') {
    // The Black Serpent and the Ringwraiths may move up to two locations per command.
    if (id !== 'minion-black-serpent' && id !== 'minion-ringwraiths') return nbrs;
    const out = new Set<LocationId>(nbrs);
    for (const n of nbrs) for (const m of adjacentLocations(cat, n)) out.add(m);
    out.delete(from);
    return [...out];
  }
  // Monster tokens may only move onto locations that hold influence.
  return nbrs.filter((loc) => influenceAt(s, loc) > 0);
}

/** Can one more token of the current Place Influence action go to the Shadow Pool? */
export function canBankInfluence(s: GameState): boolean {
  const p = s.sauronPending;
  return s.phase === 'SauronMinions' && p?.track === 'influence' && p.remaining > 0
    && (p.banked ?? 0) < 2 && s.sauron.influence < 4 * gameStage(s);
}

/** Move one owed token into (delta +1) or back out of (delta −1) the Shadow Pool. */
export function sauronBankInfluence(state: GameState, delta: 1 | -1): GameState {
  const p = state.sauronPending;
  if (state.phase !== 'SauronMinions' || p?.track !== 'influence') return state;
  if (delta === 1 ? !canBankInfluence(state) : (p.banked ?? 0) <= 0) return state;
  const s = clone(state);
  const q = s.sauronPending!;
  q.banked = (q.banked ?? 0) + delta;
  q.remaining -= delta;
  s.sauron.influence += delta;
  log(s, 'sauron', 'Sauron', delta === 1 ? `banks 1 influence in the Shadow Pool (now ${s.sauron.influence})` : `takes 1 influence back out of the Shadow Pool (now ${s.sauron.influence})`);
  return s;
}

/** Place one owed board token from the current Place Influence action onto a legal
 *  extension location (board pressure that drives peril draws and encounter
 *  conditions). Only valid while a Place Influence action still owes placements. */
export function sauronPlaceInfluence(state: GameState, cat: Catalog, loc: LocationId): GameState {
  const p = state.sauronPending;
  if (state.phase !== 'SauronMinions' || p?.track !== 'influence' || p.remaining <= 0) return state;
  if (!canPlaceInfluence(state, cat, loc)) return state;
  const s = clone(state);
  const placed = placeInfluenceAction(s, cat, loc, 1);
  if (placed <= 0) return state;
  // Stays pending at 0 remaining until Sauron confirms, so this action's tokens can still be taken back.
  s.sauronPending!.remaining -= 1;
  (s.sauronPending!.placed ||= []).push(loc);
  log(s, 'sauron', 'Sauron', `places influence on ${cat.locations[loc]?.name ?? loc} (now ${influenceAt(s, loc)})`);
  return s;
}

/** Interactive Setup only: place one of the starting plot's owed "extension"
 *  influence tokens (see setup.ts's applyStartingPlotInfluence /
 *  state.setupInfluencePending). Uses the same extension-rule legality as the
 *  in-game Place Influence action, but isn't gated by phase/sauronPending since
 *  it happens before turn 1 even begins. */
export function setupPlaceInfluence(state: GameState, cat: Catalog, loc: LocationId): GameState {
  const p = state.setupInfluencePending;
  if (!p || p.remaining <= 0) return state;
  if (!canPlaceInfluence(state, cat, loc)) return state;
  const s = clone(state);
  const placed = placeInfluenceAction(s, cat, loc, 1);
  if (placed <= 0) return state;
  // Stays pending at 0 remaining until Sauron confirms, so tokens can still be extracted.
  s.setupInfluencePending!.remaining -= 1;
  (s.setupInfluencePending!.placed ||= []).push(loc);
  log(s, 'setup', 'Sauron', `extends influence to ${cat.locations[loc]?.name ?? loc} (now ${influenceAt(s, loc)})`);
  return s;
}

/** Interactive Setup: take back one token placed during this setup. Rejected if
 *  a later-placed token would no longer satisfy the extension rule. */
export function setupExtractInfluence(state: GameState, cat: Catalog, loc: LocationId): GameState {
  const p = state.setupInfluencePending;
  if (!p?.placed?.includes(loc)) return state;
  const s = clone(state);
  const remainingPlaced = extractPlaced(s, cat, p.placed, loc);
  if (!remainingPlaced) return state;
  s.setupInfluencePending = { remaining: p.remaining + 1, placed: remainingPlaced };
  log(s, 'setup', 'Sauron', `extracts influence from ${cat.locations[loc]?.name ?? loc}`);
  return s;
}

/** Take one token of `placed` (this action's tokens only) off `loc` in `s`, then
 *  re-lay the rest in any order the extension rule accepts. Returns the new
 *  placed list, or null (s must then be discarded) if the rest can't stay legal. */
function extractPlaced(s: GameState, cat: Catalog, placed: string[], loc: LocationId): string[] | null {
  const rest = [...placed];
  rest.splice(rest.indexOf(loc), 1);
  for (const l of placed) removeInfluenceAt(s, l, 1);
  const laid: string[] = [];
  let todo = rest;
  while (todo.length) {
    const next = todo.filter((l) => !(canPlaceInfluence(s, cat, l) && placeInfluenceAction(s, cat, l, 1) > 0 && (laid.push(l), true)));
    if (next.length === todo.length) return null;
    todo = next;
  }
  return laid;
}

/** Mid-game Place Influence: take back a token placed during THIS action only. */
export function sauronExtractInfluence(state: GameState, cat: Catalog, loc: LocationId): GameState {
  const p = state.sauronPending;
  if (state.phase !== 'SauronMinions' || p?.track !== 'influence' || !p.placed?.includes(loc)) return state;
  const s = clone(state);
  const laid = extractPlaced(s, cat, p.placed, loc);
  if (!laid) return state;
  s.sauronPending = { ...p, remaining: p.remaining + 1, placed: laid };
  log(s, 'sauron', 'Sauron', `takes back influence from ${cat.locations[loc]?.name ?? loc}`);
  return s;
}

/** Mid-game Place Influence: lock in the placements (also ends the action early
 *  when no legal location is left). */
export function sauronConfirmInfluence(state: GameState, cat: Catalog): GameState {
  const p = state.sauronPending;
  if (state.phase !== 'SauronMinions' || p?.track !== 'influence') return state;
  if (p.remaining > 0 && placementTargets(state, cat).length > 0) return state;
  const s = clone(state);
  s.sauronPending = undefined;
  return s;
}

/** Interactive Setup: approve the placement once every token is down. */
export function setupConfirmInfluence(state: GameState): GameState {
  const p = state.setupInfluencePending;
  if (!p || p.remaining > 0) return state;
  const s = clone(state);
  s.setupInfluencePending = undefined;
  log(s, 'setup', 'Sauron', 'confirms starting influence');
  return s;
}

/** Interactive Setup: keep the chosen Shadow/Plot cards from those offered; the
 *  unkept Plot cards return to the bottom of the Plot deck (Shadow cards simply
 *  stay in the Shadow deck). */
export function sauronKeepStartingHand(state: GameState, cat: Catalog, shadow: string[], plot: string[]): GameState {
  void cat;
  const p = state.setupHandPending;
  if (!p) return state;
  const uniq = (a: string[]) => [...new Set(a)];
  const sh = uniq(shadow), pl = uniq(plot);
  if (sh.length !== Math.min(p.shadowKeep, p.shadowOffered.length) || sh.some((id) => !p.shadowOffered.includes(id))) return state;
  if (pl.length !== Math.min(p.plotKeep, p.plotOffered.length) || pl.some((id) => !p.plotOffered.includes(id))) return state;
  const s = clone(state);
  s.sauron.shadowHand = sh;
  s.sauron.plotHand = pl;
  s.sauron.plotDeck = [...(s.sauron.plotDeck ?? []), ...p.plotOffered.filter((id) => !pl.includes(id))];
  s.setupHandPending = undefined;
  log(s, 'setup', 'Sauron', `keeps ${sh.length} Shadow and ${pl.length} Plot cards`);
  return s;
}

/** Spawn command: field a monster from the reserve at a legal location. Costs one
 *  command of the current Command action (rulebook p.18 — NOT Shadow-Pool influence). */
export function sauronSpawnMonster(state: GameState, cat: Catalog, loc: LocationId): GameState {
  if (!canCommand(state)) return state;
  const held = state.sauronPending?.heldToken;
  if (!held) return state;
  // Monster tokens may only be placed on an influenced location without a hero,
  // in the region (colour pair) the token was drawn from.
  if (!monsterPlaceable(state, loc) || cat.locations[loc]?.regionId !== held.regionId) return state;
  const s = clone(state);
  if (held.token === 'blank') {
    (s.map.rumorsAt ||= {})[loc] = (s.map.rumorsAt[loc] ?? 0) + 1;
    log(s, 'sauron', 'Sauron', `plants a face-down token at ${loc}`);
  } else {
    (s.map.monstersAt[loc] ||= []).push(held.token);
    log(s, 'sauron', 'Sauron', `plants a face-down token at ${loc}`);
  }
  s.sauronPending!.heldToken = undefined;
  s.sauronPending!.monsterDone = true;
  spendCommand(s);
  return s;
}

/** Locations in `regionId` where a monster token may be placed now. */
export function monsterTargetsIn(s: GameState, cat: Catalog, regionId: string): LocationId[] {
  return (Object.keys(cat.locations) as LocationId[])
    .filter((l) => cat.locations[l].regionId === regionId && monsterPlaceable(s, l));
}

/** Place Monster Token, step 1: Sauron picks one of the five piles and draws a
 *  random token (rulebook p.18); only Sauron may look at it, then it must be
 *  placed. One monster token per Command action. */
export function sauronDrawMonsterToken(state: GameState, cat: Catalog, regionId: string): GameState {
  if (!canCommand(state)) return state;
  const p = state.sauronPending!;
  if (p.heldToken || p.monsterDone || !cat.monsterBags[regionId]) return state;
  if (monsterTargetsIn(state, cat, regionId).length === 0) return state;
  const s = clone(state);
  const token = drawMonsterToken(s, cat, regionId);
  if (token === null) return state;
  s.sauronPending!.heldToken = { regionId, token };
  log(s, 'sauron', 'Sauron', `draws a monster token from the ${cat.monsterBags[regionId].name} pile`);
  return s;
}

/** Command is "up to N": the player may stop issuing commands early. */
export function sauronFinishCommand(state: GameState): GameState {
  if (state.sauronPending?.track !== 'command' || state.sauronPending.heldToken) return state;
  const s = clone(state);
  s.sauronPending = undefined;
  return s;
}

/** Move command: shift one figure one space to a legal target. */
export function sauronMoveFigure(
  state: GameState, cat: Catalog, kind: 'monster' | 'minion', id: string, from: LocationId, to: LocationId,
): GameState {
  if (!canCommandFree(state)) return state;
  if (!moveTargets(state, cat, kind, from, id).includes(to)) return state;
  const s = clone(state);
  const map = kind === 'monster' ? (s.map.monstersAt ||= {}) : (s.map.minionsAt ||= {});
  const at = map[from];
  if (!at) return state;
  const i = at.indexOf(id);
  if (i < 0) return state;
  at.splice(i, 1);
  (map[to] ||= []).push(id);
  spendCommand(s);
  const name = kind === 'monster' ? cat.monsters[id]?.name : cat.minions[id]?.name;
  log(s, 'sauron', 'Sauron', `moves ${name ?? id} to ${to}`);
  return s;
}

/** Minions on the board that have taken damage (healable). */
export function woundedMinions(s: GameState, cat: Catalog): MinionId[] {
  const hp = s.map.minionHealth ?? {};
  const onBoard = new Set(Object.values(s.map.minionsAt ?? {}).flat());
  return Object.keys(hp).filter((id) => onBoard.has(id) && hp[id] < (cat.minions[id]?.health ?? 0));
}

/** Heal command: fully restore a wounded minion (clears its carried damage). */
export function sauronHealMinion(state: GameState, cat: Catalog, minionId: MinionId): GameState {
  if (!canCommandFree(state)) return state;
  const s = clone(state);
  if (!s.map.minionHealth || s.map.minionHealth[minionId] === undefined) return state;
  delete s.map.minionHealth[minionId];
  spendCommand(s);
  log(s, 'sauron', 'Sauron', `heals ${cat.minions[minionId]?.name ?? minionId}`);
  return s;
}

/** Play-shadow command: resolve a shadow card from Sauron's hand (gated on the
 *  shadow pool = current influence) against the most-corrupted hero. */
/** Play-shadow: resolve ONE own-turn Shadow card from Sauron's hand against the
 *  most-corrupted hero. Only "Play during your Action step." (action-window) cards
 *  qualify, at most ONE per Sauron turn, and — like the automa — it is a free play
 *  that does NOT cost an Eye action. Gated on the Shadow Pool (= influence). */
export function sauronPlayShadow(state: GameState, cat: Catalog, cardId: string, heroId?: string): GameState {
  if (state.phase !== 'SauronMinions' || state.sauronPending) return state;
  if (state.shadowPlayedThisSauronTurn) return state;      // one own-turn Shadow per Sauron turn
  if (state.story.finale) return state;                     // Errata: no Shadow cards in the Finale
  const card = cat.shadow[cardId];
  if (!card || !state.sauron.shadowHand.includes(cardId)) return state;
  if (shadowWindow(card.timing) !== 'action') return state; // reaction cards wait for their window
  if (num(card.poolRequirement) > state.sauron.influence) return state;
  const s = clone(state);
  const actives = s.heroes.filter((h) => h.status === 'active');
  const chosen = heroId ? actives.find((h) => h.id === heroId) : undefined;
  if (heroId && !chosen) return state;
  const target = chosen ?? [...actives].sort((a, b) => b.corruption - a.corruption)[0];
  if (!target) return state;
  s.sauron.shadowHand = s.sauron.shadowHand.filter((x) => x !== cardId);
  s.sauron.shadowDiscard.push(cardId);
  const actor = treeActor('shadow', cardId);
  if (actor === 'sauron' && treeActorIsHuman(s, 'sauron')) {
    stepResolveTree(s, cat, card.tree, {
      sourceKind: 'shadow', cardId, source: `shadow ${card.name}`, heroId: target.id, actor,
    });
  } else {
    autoResolveTree(s, cat, target.id, card.tree, `shadow ${card.name}`, actor);
  }
  s.shadowPlayedThisSauronTurn = true;
  log(s, 'sauron', 'Sauron', `plays shadow ${card.name} on ${target.id}`);
  return s;
}

/** Shadow cards the human may play on his OWN turn now: in hand, action-window,
 *  pool-affordable, and only while he has not yet played his one own-turn card. */
export function playableShadow(s: GameState, cat: Catalog): string[] {
  if (s.shadowPlayedThisSauronTurn || s.story.finale) return [];
  return s.sauron.shadowHand.filter((id) => {
    const c = cat.shadow[id];
    return c && shadowWindow(c.timing) === 'action' && num(c.poolRequirement) <= s.sauron.influence;
  });
}
