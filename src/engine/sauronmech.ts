// M8 — Sauron board mechanics: peril draws, plot advancement (the war chest's
// payoff), a shadow-card hand, and the late-game counter reset. These complete
// the Lidless Eye loop so hoarded influence and board pressure actually convert
// into progress on the dark story track.
import type { Catalog, GameState, HeroId, HeroState, LocationId, CardId, Plot, ShadowCard, StoryMarkerColor, SauronDoctrine } from './types';
import { autoResolveTree, stepResolveTree, treeActor, treeActorIsHuman, statValue } from './encounter';
import { influenceAt, plotMakesPerilous } from './influence';
import { shuffle } from './rng';
import { corruptionPerilBonus, corruptionSauronShadowRedraw } from './corruption';
import { log } from './log';

type Logger = ((msg: string) => void) | undefined;
const num = (v: number | string): number => (typeof v === 'number' ? v : Number(v) || 0);

// ---- Peril -------------------------------------------------------------
/** A hero entering an influenced, non-haven location draws a peril card. Peril
 *  cards are reusable (returned to the deck), so we pick one deterministically. */
export function maybeDrawPeril(s: GameState, cat: Catalog, heroId: HeroId, loc: string): void {
  if (cat.locations[loc]?.kind === 'haven') return;
  const influence = influenceAt(s, loc);
  // Manual: a location is perilous only when its influence EXCEEDS the hero's
  // wisdom (or it is within Gothmog's perilous aura, or a Plot marks it so).
  const wisdom = statValue(s, cat, heroId, 'wisdom');
  if (influence <= wisdom && !nearGothmog(s, cat, loc) && !plotMakesPerilous(s, loc) && !cat.locations[loc]?.perilous) return;
  if (!Object.keys(cat.perils).length) return;
  // Rulebook pp.22–23: Sauron draws THREE cards from the Peril deck, resolves the
  // one applicable card he chooses (the automa picks the harshest), and discards
  // all three. If none of the three apply, they are discarded without effect.
  const drawn = drawPerils(s, cat, 3 + corruptionPerilBonus(cat, s.heroes.find((h) => h.id === heroId)!));
  if (!drawn.length) return;
  const applicable = drawn.filter((id) => perilAffects(cat, id, loc));
  const chosen = pickWorstPeril(cat, applicable);
  (s.sauron.perilDiscard ||= []).push(...drawn);
  if (!chosen) {
    log(s, 'peril-draw', heroId, `Peril at ${cat.locations[loc]?.name ?? loc}: drew ${drawn.length}, none apply`);
    if (s.humanSide !== 'Sauron') {
      s.pendingReveal = {
        kind: 'peril', deck: 'perils',
        title: `Peril — ${cat.locations[loc]?.name ?? loc}`,
        drawn,
        note: 'None of the three drawn Perils apply here — they are discarded without effect.',
      };
    }
    return;
  }
  const peril = cat.perils[chosen];
  log(s, 'peril-draw', heroId, `${peril.name} at ${cat.locations[loc]?.name ?? loc} (drew ${drawn.length}, ${applicable.length} apply)`, { cardId: chosen });
  if (s.humanSide !== 'Sauron') {
    s.pendingReveal = {
      kind: 'peril', deck: 'perils',
      title: `Peril — ${cat.locations[loc]?.name ?? loc}`,
      drawn, chosen,
      note: 'Sauron draws three Perils and resolves the applicable one he chooses (the harshest).',
    };
  }
  const actor = treeActor('peril', chosen);
  if (treeActorIsHuman(s, actor)) {
    // The affected hero is human: pause for his printed choice (e.g. Ill-met
    // Company). The surrounding move flow yields on s.pendingTree and resumes.
    stepResolveTree(s, cat, peril.tree, {
      sourceKind: 'peril', cardId: chosen, source: `peril ${peril.name}`, heroId, actor,
    });
  } else {
    autoResolveTree(s, cat, heroId, peril.tree, `peril ${peril.name}`, actor);
  }
}

/** Draw up to n cards from the Peril deck, lazily built + reshuffled from the
 *  discard when depleted. */
function drawPerils(s: GameState, cat: Catalog, n: number): CardId[] {
  s.sauron.perilDeck ||= shuffle(s, Object.keys(cat.perils));
  s.sauron.perilDiscard ||= [];
  const out: CardId[] = [];
  for (let i = 0; i < n; i++) {
    if (!s.sauron.perilDeck.length) {
      if (!s.sauron.perilDiscard.length) break;
      s.sauron.perilDeck = shuffle(s, s.sauron.perilDiscard);
      s.sauron.perilDiscard = [];
    }
    const c = s.sauron.perilDeck.pop();
    if (c) out.push(c);
  }
  return out;
}

// Map a distinctive region keyword (as printed on "Any Location in …" Perils) to
// the board's region-pair id.
const PERIL_REGION_KEYS: Record<string, string> = {
  eriador: 'eriador-and-enedwaith', enedwaith: 'eriador-and-enedwaith',
  rhudaur: 'rhudaur-and-grey-mountains', 'grey mountains': 'rhudaur-and-grey-mountains',
  'misty mountains': 'mist-mountains-and-mirkwood', mirkwood: 'mist-mountains-and-mirkwood',
  rohan: 'rohan-and-gondor', gondor: 'rohan-and-gondor',
  mordor: 'mordor-and-brown-lands', 'brown lands': 'mordor-and-brown-lands', 'bown lands': 'mordor-and-brown-lands',
};

/** Whether a Peril card applies at a location: "Any Location" always applies, a
 *  region-scoped "Any Location in <Region> or <Region>" applies within that
 *  region pair, otherwise the printed location must match exactly. */
export function perilAffects(cat: Catalog, perilId: CardId, locId: LocationId): boolean {
  const p = cat.perils[perilId];
  const loc = cat.locations[locId];
  if (!p || !loc) return false;
  const printed = (p.location || '').trim().toLowerCase();
  if (!printed || printed === 'any location') return true;
  if (printed.startsWith('any location in')) {
    for (const [kw, rid] of Object.entries(PERIL_REGION_KEYS)) {
      if (printed.includes(kw) && loc.regionId === rid) return true;
    }
    return false;
  }
  const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(printed) === norm(loc.name);
}

/** Sauron's choice among the applicable Perils: the harshest (most immediate
 *  damage / forced combat), tie-broken by draw order. */
function pickWorstPeril(cat: Catalog, applicable: CardId[]): CardId | null {
  if (!applicable.length) return null;
  const score = (id: CardId): number => {
    const t = JSON.stringify(cat.perils[id]?.tree ?? {});
    const dmg = [...t.matchAll(/"op":"damage","n":(\d+)/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
    const combat = /"op":"forceCombat"/.test(t) ? 6 : 0;
    const corr = /"op":"gainCorruption"/.test(t) ? 3 : 0;
    return dmg + combat + corr;
  };
  return applicable.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/** True if `loc` is at or adjacent to a Gothmog minion (his perilous aura). */
function nearGothmog(s: GameState, cat: Catalog, loc: string): boolean {
  const at = s.map.minionsAt ?? {};
  const gothmogLocs = Object.entries(at)
    .filter(([, ids]) => ids.some((id) => cat.minions[id]?.effectKey === 'minion-perilous-aura'))
    .map(([l]) => l);
  if (!gothmogLocs.length) return false;
  if (gothmogLocs.includes(loc)) return true;
  return cat.edges.some((e) =>
    (e.a === loc && gothmogLocs.includes(e.b)) || (e.b === loc && gothmogLocs.includes(e.a)));
}

// ---- Plots -------------------------------------------------------------
/** The Eye spends its war chest to advance a plot, pushing the dark story track.
 *  It picks the best-rated affordable plot (advance-2+ preferred; advance-1 are
 *  bluffs it would rather hold) and — per the hoard/spend doctrine — commits
 *  influence when it is flush or the game is late. Returns true if it advanced. */
/** Bot Plot Step priority: the plot's value is which colored story marker it
 *  advances and by how much. Highest marker advanced by 3 > 2 > 1, then 2nd
 *  highest, then lowest; ties broken red > black > yellow, then by the most
 *  favors it forces heroes to discard. Returns a sortable score (higher first). */
const MARKER_TIE: Record<StoryMarkerColor, number> = { red: 2, black: 1, yellow: 0 };
function plotPriority(s: GameState, p: Plot): number {
  const doctrine = s.sauron.doctrine ?? 'balanced';
  const sauron = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  const marker = (p.marker ?? 'red') as StoryMarkerColor;
  const advance = p.advance ?? p.track.length;
  const fav = p.favorToCounter ?? 0;
  // rank of this plot's marker among the three by current height (0=highest).
  const order = (['red', 'black', 'yellow'] as StoryMarkerColor[])
    .sort((a, b) => (sauron[b] - sauron[a]) || (MARKER_TIE[b] - MARKER_TIE[a]));
  const rank = order.indexOf(marker);              // 0 highest .. 2 lowest
  if (doctrine === 'tempo') {
    // Rush ONE marker to the Finale: reward stacking the already-leading marker
    // (bigger rank weight) AND large single-turn advances, so the Eye piles its
    // biggest plots on one colour rather than spreading them thin.
    return (2 - rank) * 130 + advance * 30 + MARKER_TIE[marker] + fav * 0.01;
  }
  if (doctrine === 'attrition') {
    // Grind the heroes: prize plots that force the MOST favour to counter (favour
    // is the heroes' plot-breaking currency, so expensive plots drain them and
    // stall their economy), with marker progress a secondary concern.
    return fav * 40 + advance * 8 + (2 - rank) * 15 + MARKER_TIE[marker];
  }
  // primary: prefer higher marker (lower rank); secondary: bigger advance.
  return (2 - rank) * 100 + advance * 10 + MARKER_TIE[marker] + fav * 0.01;
}

/** The Eye spends its war chest to play a plot, pushing the dark story track.
 *  It follows the bot's Plot Step priority (advance the highest story marker by
 *  the most), advancing that plot's colored marker and — per the hoard/spend
 *  doctrine — commits influence when flush or the game is late. Plays into a plot
 *  slot (max 3 active) that heroes can then counter. Returns true if it played. */
export function advancePlots(s: GameState, cat: Catalog, _late: boolean, log?: Logger): boolean {
  if (!cat.plots.length) return false;
  // Plots are Sauron's primary win engine: every active plot advances its
  // coloured story marker each Story Step, and a higher marker at the Finale is
  // pure gain (it denies the heroes dominance — hence their immediate victory and
  // the -mod that weakens the Ringwraiths — and, when Sauron is dominant, ADDS to
  // the Ringwraiths' health/fortitude). The rulebook never conditions the Plot
  // Step on the heroes' progress, so the Eye advances a plot every turn it can.
  const active = (s.sauron.activePlots ??= []);
  if (active.length >= 3) return false; // plot slots full

  // Faithful: the Eye may only play a Plot card FROM HIS HAND (not the whole
  // pool). Rank the affordable ones in hand by the bot's Plot Step priority.
  const played = new Set(active.map((e) => e.eventId));
  const hand = (s.sauron.plotHand ??= []);
  const ranked = hand
    .map((id) => cat.plots.find((p) => p.id === id))
    .filter((p): p is Plot => !!p && !p.starting && !played.has(p.id))
    .map((p) => ({ p, cost: num(p.influenceCost) }))
    .filter((r) => s.sauron.influence >= r.cost)
    .sort((a, b) => plotPriority(s, b.p) - plotPriority(s, a.p));
  const pick = ranked[0];
  if (!pick) return false;

  const p = pick.p;
  s.sauron.plotHand = hand.filter((id) => id !== p.id); // leaves the hand into a slot
  applyPlotCard(s, cat, p, pick.cost, log);
  return true;
}

/** A plot's context-free value: its marker advance dominates, then the marker
 *  tie-break, then the favors it forces heroes to spend. Used to pick which
 *  drawn plots to keep (no live-state dependency, so setup can call it too). */
export function staticPlotValue(p: Plot): number {
  const marker = (p.marker ?? 'red') as StoryMarkerColor;
  const advance = p.advance ?? p.track.length;
  return advance * 10 + MARKER_TIE[marker] + (p.favorToCounter ?? 0) * 0.01;
}

/** Keep the best `k` plot ids (by staticPlotValue). */
export function keepBestPlots(cat: Catalog, ids: string[], k: number): string[] {
  return [...ids]
    .map((id) => cat.plots.find((p) => p.id === id))
    .filter((p): p is Plot => !!p)
    .sort((a, b) => staticPlotValue(b) - staticPlotValue(a))
    .slice(0, k)
    .map((p) => p.id);
}

/** The "Draw Shadow and Plot Cards" action's plot half: draw `n` plots, KEEP 1
 *  (the best), and return the rest to the bottom of the deck (rulebook). Recycles
 *  the discard into the deck when it runs dry (local rng — never the shared
 *  gameplay stream). */
export function drawPlots(s: GameState, cat: Catalog, n: number, log?: Logger): void {
  const deck = (s.sauron.plotDeck ??= []);
  const hand = (s.sauron.plotHand ??= []);
  const disc = (s.sauron.plotDiscard ??= []);
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!deck.length && disc.length) {
      let r = (s.seed ^ (0x91007 + s.story.turn)) >>> 0;
      const rand = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 0x100000000; };
      const d = disc.splice(0);
      for (let j = d.length - 1; j > 0; j--) { const t = Math.floor(rand() * (j + 1)); [d[j], d[t]] = [d[t], d[j]]; }
      deck.push(...d);
    }
    if (!deck.length) break;
    drawn.push(deck.shift()!);
  }
  if (!drawn.length) return;
  const keep = keepBestPlots(cat, drawn, 1);
  hand.push(...keep);
  deck.push(...drawn.filter((id) => !keep.includes(id)));
  log?.(`draws ${drawn.length} Plot card(s), keeps ${keep.length}`);
}

/** Place a plot card on the Active Plot Track: mark its position and add it to
 *  the active plot slots. Its colored story marker advances during each Story
 *  Step (see runSauronRefresh), NOT on play. Shared by the Eye bot and a human
 *  Sauron's interactive Plot Step. `paidCost` is only for the log line. */
export function applyPlotCard(s: GameState, cat: Catalog, p: Plot, paidCost: number, log?: Logger): void {
  const active = (s.sauron.activePlots ??= []);
  s.sauron.plotTrack[p.id] = p.track.length;
  const marker = (p.marker ?? 'red') as StoryMarkerColor;
  const advance = p.advance ?? p.track.length;
  active.push({ eventId: p.id, step: p.track.length, location: (p.affects || undefined) as never });
  log?.(`plays plot ${p.name} — feeds the ${marker} marker (+${advance}/turn, req ${paidCost}, counter ${p.favorToCounter ?? 0} favor)`);

  // Gollum plots discard other active Gollum plots when they enter play.
  if (p.gollum) {
    const before = active.length;
    s.sauron.activePlots = active.filter((e) => {
      if (e.eventId === p.id) return true;
      const other = cat.plots.find((x) => x.id === e.eventId);
      return !other?.gollum;
    });
    if (s.sauron.activePlots.length < before) log?.(`  ${p.name} discards the rival Gollum plots`);
  }
}

/** Rate a Plot: its marker advance is the payoff; cost is a mild drag. */

// ---- Shadow hand -------------------------------------------------------
/** Draw the shadow hand up to `size`, drawing distinct cards (recycling the
 *  discard when the pool is exhausted). Deterministic via the game rng. */
export function drawShadow(s: GameState, cat: Catalog, size: number): void {
  const all = Object.keys(cat.shadow);
  if (!all.length) return;
  const held = new Set([...s.sauron.shadowHand, ...s.sauron.shadowDiscard]);
  let pool = all.filter((id) => !held.has(id));
  while (s.sauron.shadowHand.length < size) {
    if (!pool.length) { s.sauron.shadowDiscard = []; pool = all.filter((id) => !s.sauron.shadowHand.includes(id)); }
    if (!pool.length) break;
    const i = (((s.rngCursor + s.sauron.shadowHand.length) % pool.length) + pool.length) % pool.length;
    s.sauron.shadowHand.push(pool[i]);
    pool.splice(i, 1);
  }
}

// ---- Shadow-card timing ------------------------------------------------
/** The window a Shadow card may be played in, read from its printed `timing`.
 *  Action-step cards are the Eye's own-turn plays; the rest are hero-turn/combat
 *  reactions (rule: at most ONE Shadow card per hero turn). */
export type ShadowWindow = 'action' | 'hero-turn' | 'combat-start' | 'enter-nonhaven' | 'hero-defeated';

/** A non-interactive Sauron plays its reaction Shadow windows automatically:
 *  either the AI controls Sauron (humanSide !== 'Sauron') or a self-play driver
 *  opted in. A real human Sauron (in the UI) leaves both unset. */
export function sauronAuto(s: GameState): boolean {
  return s.humanSide !== 'Sauron' || !!s.sauronReactsAuto;
}
export function shadowWindow(timing: string): ShadowWindow {
  const t = (timing || '').toLowerCase();
  if (t.includes('start of combat')) return 'combat-start';
  if (t.includes('enters a non-haven') || t.includes('enters a non haven')) return 'enter-nonhaven';
  if (t.includes('is defeated')) return 'hero-defeated';
  if (t.includes('start of hero')) return 'hero-turn';
  return 'action'; // "Play during your Action step."
}

/** A crude desirability score — corruption cards cripple heroes (owner ruling),
 *  so weight them highest; stronger cards demand more pool, a useful proxy. */
function shadowValue(c: ShadowCard): number {
  const txt = `${c.effect ?? ''} ${c.effectKey ?? ''}`.toLowerCase();
  let v = num(c.poolRequirement);
  if (txt.includes('corrupt')) v += 3;
  if (txt.includes('damage') || txt.includes('wound')) v += 1;
  return v;
}

/** How many cards a hand-dump Shadow card would actually strip from `target`
 *  right now — the whole point of "Storms of Mordor" is TIMING it against a hero
 *  who is hoarding cards for a big turn (discard down to 5, then per Corruption).
 *  A card with no discardHand atom returns 0. */
function handDumpImpact(c: ShadowCard, target: { hand: CardId[]; corruptionCards: CardId[] }): number {
  const t = JSON.stringify(c.tree ?? {});
  const segs = t.match(/"op":"discardHand"[^}]*}/g);
  if (!segs) return 0;
  let total = 0;
  for (const seg of segs) {
    let removed = Number(/"n":(-?\d+)/.exec(seg)?.[1] ?? 0);
    const toHand = /"toHand":(\d+)/.exec(seg);
    if (toHand) removed += Math.max(0, target.hand.length - Number(toHand[1]));
    if (/"perCorruption":true/.test(seg)) removed += target.corruptionCards.length;
    total += Math.max(0, removed);
  }
  return Math.min(total, target.hand.length);
}

/** Context-aware desirability of playing `c` on `target` now. Extends the base
 *  score with hand-dump TIMING: prize a strip against a hoarding hero, and HOLD
 *  a hand-dump card (negative bump) while the hero's hand is small — exactly the
 *  expert doctrine of saving Storms of Mordor for a hero building a super turn. */
function shadowScoreFor(
  c: ShadowCard,
  target: { hand: CardId[]; corruptionCards: CardId[] },
  doctrine: SauronDoctrine = 'balanced',
): number {
  let v = shadowValue(c);
  const txt = `${c.effect ?? ''} ${c.effectKey ?? ''}`.toLowerCase();
  if (doctrine === 'attrition' && txt.includes('corrupt')) v += 4; // grind: corruption is king
  const isDump = /"op":"discardHand"/.test(JSON.stringify(c.tree ?? {}));
  if (isDump) {
    const impact = handDumpImpact(c, target);
    v += impact * 2;
    // Hold a hand-dump while the hero isn't hoarding — but an attrition Eye is
    // less patient and will still strip a small hand to keep the pressure on.
    if (impact <= 1) v -= doctrine === 'attrition' ? 2 : 6;
  }
  return v;
}

/** The hero a reaction `window` targets: the named hero (moves/combat/defeat) or,
 *  for untargeted windows, the most-corrupted active hero. */
function reactionTarget(s: GameState, ctx: { heroId?: HeroId }): HeroState | undefined {
  return ctx.heroId
    ? s.heroes.find((h) => h.id === ctx.heroId && h.status === 'active')
    : s.heroes.filter((h) => h.status === 'active').sort((a, b) => b.corruption - a.corruption)[0];
}

/** The affordable Shadow cards in hand that legally match `window` (and its
 *  printed sub-condition), ranked best-first against `target`. Shared by the
 *  automa (auto-plays [0]) and the interactive human (picks from the list). */
export function reactionCandidates(
  s: GameState, cat: Catalog, window: ShadowWindow,
  ctx: { heroId?: HeroId; isMinionCombat?: boolean }, target: HeroState,
): CardId[] {
  const cands = s.sauron.shadowHand.filter((cid) => {
    const c = cat.shadow[cid];
    if (!c || shadowWindow(c.timing) !== window) return false;
    if (num(c.poolRequirement) > s.sauron.influence) return false;
    const t = c.timing.toLowerCase();
    if (window === 'combat-start' && t.includes('involving a minion') && !ctx.isMinionCombat) return false;
    // Save the strongest pre-combat Shadow cards (Morgul-Blade, The Black Breath)
    // for the fights that matter — don't blow a pool-6+ combat card on a trivial
    // monster skirmish; hold it for a minion battle.
    if (window === 'combat-start' && !ctx.isMinionCombat && num(c.poolRequirement) >= 6) return false;
    if (window === 'hero-turn' && t.includes('not in a haven') && cat.locations[target.location]?.kind === 'haven') return false;
    return true;
  });
  cands.sort((a, b) => shadowScoreFor(cat.shadow[b], target, s.sauron.doctrine) - shadowScoreFor(cat.shadow[a], target, s.sauron.doctrine));
  return cands;
}

/** Play one specific Shadow card `cid` on `target` for a reaction `window`:
 *  move it to the discard, resolve its effect tree, mark the once-per-hero-turn
 *  window spent, and apply the Elven Cloak pool drain. Used by both the automa
 *  (best card) and the interactive human (his chosen card). */
export function playSpecificShadow(
  s: GameState, cat: Catalog, cid: CardId, target: HeroState, window: ShadowWindow,
  log?: Logger, opts?: { resumeCombat?: boolean },
): void {
  const card = cat.shadow[cid];
  s.sauron.shadowHand = s.sauron.shadowHand.filter((x) => x !== cid);
  s.sauron.shadowDiscard.push(cid);
  const actor = treeActor('shadow', cid);
  // Sauron's own printed choices become interactive when a human plays the Eye;
  // everything else (AI Sauron, or a hero-owned choice like Dark Promises whose
  // hero is AI here) auto-resolves optimally for the deciding side.
  if (actor === 'sauron' && treeActorIsHuman(s, 'sauron')) {
    stepResolveTree(s, cat, card.tree, {
      sourceKind: 'shadow', cardId: cid, source: `shadow ${card.name}`,
      heroId: target.id, actor, resumeCombat: opts?.resumeCombat,
    });
  } else {
    autoResolveTree(s, cat, target.id, card.tree, `shadow ${card.name}`, actor);
  }
  s.shadowPlayedThisHeroTurn = true;
  // Elven Cloak: "After Sauron plays a Shadow card on your turn, discard 1
  // influence from the Shadow Pool."
  if (target.items.includes('Elven Cloak') && s.sauron.influence > 0) {
    s.sauron.influence -= 1;
    log?.(`${card.name} — ${target.id}'s Elven Cloak drains 1 from the Shadow Pool`);
  }
  log?.(`plays shadow ${card.name} on ${target.id} (${window})`);
}

/** Fire a hero-turn/reaction Shadow window: if the Eye hasn't already played a
 *  Shadow card this hero activation, play the best affordable card matching
 *  `window` (and its printed sub-condition) on the relevant hero, honouring the
 *  Finale ban and the Elven Cloak (a hero-turn play costs the Eye 1 pool if the
 *  target holds one). Returns true if a card was played. */
export function playShadowReaction(
  s: GameState, cat: Catalog, window: ShadowWindow,
  ctx: { heroId?: HeroId; isMinionCombat?: boolean }, log?: Logger,
): boolean {
  if (s.story.finale) return false;              // Errata: no Shadow cards in the Finale
  if (s.shadowPlayedThisHeroTurn) return false;  // one Shadow card per hero turn
  const target = reactionTarget(s, ctx);
  if (!target) return false;
  const cands = reactionCandidates(s, cat, window, ctx, target);
  if (!cands.length) return false;
  playSpecificShadow(s, cat, cands[0], target, window, log);
  return true;
}

/** Interactive counterpart of playShadowReaction for a HUMAN Sauron: instead of
 *  auto-playing the best card, raise a `pendingShadowReaction` decision offering
 *  the affordable matching cards (plus an implicit Pass) so he chooses whether
 *  and what to play. Returns true if a decision was raised (the caller must then
 *  pause). No-op (false) when nothing is playable or the window is already spent.
 *  `resumeCombat` marks a combat-start pause that owes the Preparation step. */
export function raiseShadowReaction(
  s: GameState, cat: Catalog, window: ShadowWindow,
  ctx: { heroId?: HeroId; isMinionCombat?: boolean }, resumeCombat = false,
): boolean {
  if (s.story.finale) return false;
  if (s.shadowPlayedThisHeroTurn) return false;
  const target = reactionTarget(s, ctx);
  if (!target) return false;
  const cands = reactionCandidates(s, cat, window, ctx, target);
  if (!cands.length) return false;
  s.pendingShadowReaction = {
    window, heroId: ctx.heroId, isMinionCombat: ctx.isMinionCombat, resumeCombat,
    options: cands.map((cid) => ({ id: cid, label: cat.shadow[cid]?.name ?? cid })),
  };
  return true;
}

/** Play up to `maxPlays` affordable Shadow cards during the Eye's OWN Action Step
 *  (only "Play during your Action step." cards). Gate on the pool (= influence)
 *  but don't spend it. */
export function playShadow(s: GameState, cat: Catalog, maxPlays: number, log?: Logger): void {
  if (s.story.finale) return; // Errata: Sauron may not play Shadow cards during the Finale.
  const target = s.heroes.filter((h) => h.status === 'active')
    .sort((a, b) => b.corruption - a.corruption)[0];
  if (!target) return;
  let plays = 0;
  while (plays < maxPlays) {
    // Rank affordable own-turn cards by their value AGAINST this hero right now
    // (so a hand-dump like Storms of Mordor is played only when it strips a real
    // hoard, and held otherwise). A negative best score means nothing is worth
    // playing yet — hold the hand.
    const affordable = s.sauron.shadowHand
      .filter((cid) => {
        const c = cat.shadow[cid];
        return c && shadowWindow(c.timing) === 'action' && num(c.poolRequirement) <= s.sauron.influence;
      })
      .sort((a, b) => shadowScoreFor(cat.shadow[b], target, s.sauron.doctrine) - shadowScoreFor(cat.shadow[a], target, s.sauron.doctrine));
    const cid = affordable[0];
    if (!cid || shadowScoreFor(cat.shadow[cid], target, s.sauron.doctrine) < 0) break;
    const card = cat.shadow[cid];
    s.sauron.shadowHand = s.sauron.shadowHand.filter((x) => x !== cid);
    s.sauron.shadowDiscard.push(cid);
    autoResolveTree(s, cat, target.id, card.tree, `shadow ${card.name}`, 'sauron');
    log?.(`plays shadow ${card.name} on ${target.id}`);
    plays++;
    // Greedy Corruption card: after Sauron plays a Shadow on this hero's turn he
    // may draw a new Shadow card.
    if (corruptionSauronShadowRedraw(cat, target)) {
      drawShadow(s, cat, s.sauron.shadowHand.length + 1);
      log?.(`draws a Shadow card (${target.id} is Greedy)`);
    }
  }
}

// ---- Late-game counter reset ------------------------------------------
/** In the final third the Eye "resets its counters": it clears its corruption-
 *  spread marker and recycles its shadow discard so it can press again fresh. */
export function lateGameReset(s: GameState, log?: Logger): void {
  if (s.sauron.markers.corruptionSpread) {
    s.sauron.markers.corruptionSpread = 0;
    log?.('resets its corruption-spread counter');
  }
  if (s.sauron.shadowDiscard.length) {
    s.sauron.shadowDiscard = [];
    log?.('recycles its shadow deck');
  }
}

// ---- The Lidless Eye Action Tracks (rulebook pp.16–19) -----------------
/** Degrading yields for each Action Track: the value of the 1st/2nd/3rd space
 *  covered. Place Influence 6/5/4, Draw Shadow & Plot 2/2/1, Command 3/2/1. */
export const EYE_TRACKS = {
  influence: [6, 5, 4],
  draw: [2, 2, 1],
  command: [3, 2, 1],
} as const;
export type EyeTrack = keyof typeof EYE_TRACKS;

export function eyeState(s: GameState): { influence: number; draw: number; command: number } {
  return (s.sauron.eye ||= { influence: 0, draw: 0, command: 0 });
}

/** The yield Sauron would gain by taking an action on `track` right now (the
 *  next free space's number), or null if the track's three spaces are all
 *  covered — he must choose a different track. */
export function eyeTrackYield(s: GameState, track: EyeTrack): number | null {
  const covered = eyeState(s)[track];
  return covered >= 3 ? null : EYE_TRACKS[track][covered];
}

/** Take an action on `track`: cover its leftmost free space and return that
 *  space's yield. Tokens persist across Action steps; when the placement is the
 *  4th token on the board, all but this just-placed token are retrieved
 *  (rulebook p.19). Returns null if the track was already full. */
export function eyePlaceToken(s: GameState, track: EyeTrack, log?: Logger): number | null {
  const e = eyeState(s);
  if (e[track] >= 3) return null;
  const value = EYE_TRACKS[track][e[track]];
  e[track] += 1;
  const total = e.influence + e.draw + e.command;
  if (total >= 4) {
    e.influence = 0; e.draw = 0; e.command = 0;
    e[track] = 1; // retrieve all tokens except the one just placed
    log?.('retrieves its action tokens (fourth placed) — the Eye resets');
  }
  return value;
}
