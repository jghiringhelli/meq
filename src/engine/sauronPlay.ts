// M15 — interactive Sauron turn: the command-action primitives a human Sauron
// uses during their Plot Step and Action Step. Faithful to the playeraid "Sauron
// Turn": Plot Step (play/pass a plot), then an Action Step of 2 actions (3 with
// three heroes), each a Place-influence / Deploy / Move / Heal / Play-shadow /
// Spawn command. The automatic Story, Event, Hero-Draw and Story-Advance steps
// are handled by the phase machine (see phases.ts sauron* wrappers).
import type { Catalog, GameState, LocationId, MinionId, MonsterId, Plot } from './types';
import { clone, gameStage } from './mechanics';
import { log } from './log';
import { autoResolveTree } from './encounter';
import { applyPlotCard, drawShadow, drawPlots, eyePlaceToken, eyeTrackYield, shadowWindow, type EyeTrack } from './sauronmech';
import { influenceAt, canPlaceInfluence, placeInfluenceAction, monsterPlaceable } from './influence';

const num = (v: number | string): number => (typeof v === 'number' ? v : Number(v) || 0);

// ---- Plot Step ---------------------------------------------------------
/** Plots the human may play now: in HAND, not already active, affordable. */
export function playablePlots(s: GameState, cat: Catalog): Plot[] {
  const active = new Set((s.sauron.activePlots ?? []).map((e) => e.eventId));
  if (active.size >= 3) return [];
  const hand = new Set(s.sauron.plotHand ?? []);
  return cat.plots.filter((p) =>
    !p.starting && hand.has(p.id) && !active.has(p.id) && s.sauron.influence >= num(p.influenceCost));
}

/** Plot Step: play a plot card. Its influence figure is only a THRESHOLD Sauron
 *  must meet in the Shadow Pool (rulebook p.13: "playing the card does not cause
 *  Sauron to discard any influence from the Shadow Pool") — it is never spent.
 *  Phase stays in SauronEvents; the caller then resolves the Event Step. */
export function sauronPlayPlot(state: GameState, cat: Catalog, plotId: string): GameState {
  if (state.phase !== 'SauronEvents') return state;
  const p = cat.plots.find((x) => x.id === plotId);
  if (!p) return state;
  const cost = num(p.influenceCost);
  if (state.sauron.influence < cost) return state; // threshold gate only — not a spend
  const s = clone(state);
  s.sauron.plotHand = (s.sauron.plotHand ?? []).filter((id) => id !== plotId);
  applyPlotCard(s, cat, p, cost, (msg) => log(s, 'sauron', 'Sauron', msg));
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
    drawShadow(s, cat, yld);
    drawPlots(s, cat, yld);
    log(s, 'sauron', 'Sauron', `Draw action (space ${yld}): drew ${yld} Shadow & ${yld} Plot card(s)`);
    return s;
  }
  if (track === 'influence') {
    // Bank UP TO TWO in the Shadow Pool (capped at 4× stage); the rest extend the
    // board. Pool income is never free — it costs this action (rulebook pp.15-16).
    const stage = gameStage(s);
    const bank = Math.max(0, Math.min(2, yld, 4 * stage - s.sauron.influence));
    s.sauron.influence += bank;
    const remaining = yld - bank;
    if (remaining > 0) s.sauronPending = { track: 'influence', remaining };
    log(s, 'sauron', 'Sauron', `Place Influence action (space ${yld}): banked ${bank} to pool, ${remaining} to place on the board`);
    return s;
  }
  s.sauronPending = { track: 'command', remaining: yld };
  log(s, 'sauron', 'Sauron', `Command action (space ${yld}): issue up to ${yld} command(s)`);
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
export function moveTargets(s: GameState, cat: Catalog, kind: 'monster' | 'minion', from: LocationId): LocationId[] {
  const nbrs = adjacentLocations(cat, from);
  if (kind === 'minion') return nbrs;
  // Monster tokens may only move onto locations that hold influence.
  return nbrs.filter((loc) => influenceAt(s, loc) > 0);
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
  s.sauronPending!.remaining -= 1;
  if (s.sauronPending!.remaining <= 0) s.sauronPending = undefined;
  log(s, 'sauron', 'Sauron', `places influence on ${cat.locations[loc]?.name ?? loc} (now ${influenceAt(s, loc)})`);
  return s;
}

/** Spawn command: field a monster from the reserve at a legal location. Costs one
 *  command of the current Command action (rulebook p.18 — NOT Shadow-Pool influence). */
export function sauronSpawnMonster(state: GameState, cat: Catalog, monsterId: MonsterId, loc: LocationId): GameState {
  if (!canCommand(state)) return state;
  if (!cat.monsters[monsterId]) return state;
  // Monster tokens may only be placed on an influenced location without a hero.
  if (!monsterPlaceable(state, loc)) return state;
  const s = clone(state);
  (s.map.monstersAt[loc] ||= []).push(monsterId);
  spendCommand(s);
  log(s, 'sauron', 'Sauron', `fields ${cat.monsters[monsterId].name} at ${loc}`);
  return s;
}

/** Deploy command: bring a reserve minion into play at a location. */
export function sauronDeployMinion(state: GameState, cat: Catalog, minionId: MinionId, loc: LocationId): GameState {
  if (!canCommand(state)) return state;
  if (!cat.minions[minionId]) return state;
  if (!reserveMinions(state, cat).includes(minionId)) return state;
  const s = clone(state);
  (s.map.minionsAt ||= {});
  (s.map.minionsAt[loc] ||= []).push(minionId);
  spendCommand(s);
  log(s, 'sauron', 'Sauron', `deploys ${cat.minions[minionId].name} at ${loc}`);
  return s;
}

/** Move command: shift one figure one space to a legal target. */
export function sauronMoveFigure(
  state: GameState, cat: Catalog, kind: 'monster' | 'minion', id: string, from: LocationId, to: LocationId,
): GameState {
  if (!canCommand(state)) return state;
  if (!moveTargets(state, cat, kind, from).includes(to)) return state;
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
  if (!canCommand(state)) return state;
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
export function sauronPlayShadow(state: GameState, cat: Catalog, cardId: string): GameState {
  if (state.phase !== 'SauronMinions' || state.sauronPending) return state;
  if (state.shadowPlayedThisSauronTurn) return state;      // one own-turn Shadow per Sauron turn
  if (state.story.finale) return state;                     // Errata: no Shadow cards in the Finale
  const card = cat.shadow[cardId];
  if (!card || !state.sauron.shadowHand.includes(cardId)) return state;
  if (shadowWindow(card.timing) !== 'action') return state; // reaction cards wait for their window
  if (num(card.poolRequirement) > state.sauron.influence) return state;
  const s = clone(state);
  const target = s.heroes.filter((h) => h.status === 'active')
    .sort((a, b) => b.corruption - a.corruption)[0];
  if (!target) return state;
  s.sauron.shadowHand = s.sauron.shadowHand.filter((x) => x !== cardId);
  s.sauron.shadowDiscard.push(cardId);
  autoResolveTree(s, cat, target.id, card.tree, `shadow ${card.name}`, 'sauron');
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
