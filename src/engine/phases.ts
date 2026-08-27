// Turn machine + hero actions + Sauron turn + win check.
// Numeric/skeleton scope (M1). See docs/core-model.md §4 and docs/rules-digest.md.
import type { Catalog, GameState, HeroId, HeroState, LocationId, MonsterId, Terrain, EventCard, Side, CardId, Plot } from './types';
import { placeCharacterUnique, removeCharacter } from './characters';
import { STORY_FINALE, SHADOW_FALLS } from './types';
import { clone, legalMoves, findMovementCard, discardFromHand, validateMovePayment, ambushPending, advanceLeftmostMarker, gameStage, grantTraining } from './mechanics';
import { HERO_ACTIONS, deployMinion } from './setup';
import { drawFromLifePool, restHero, healHero, prepareHeroForFinale } from './heroLife';
import { log } from './log';
import { shuffle } from './rng';
import { applyOps } from './noncombat';
import { planEncounter, applyAtoms, autoResolveTree, stepResolveTree, treeActorIsHuman, statValue, type PlanResult } from './encounter';
import { eyePlaceInfluenceOnce, eyeSpawnMonsterOnce } from './ai';
import { evalMission, minionsInPlay } from './missions';
import { maybeDrawPeril, advancePlots, drawShadow, drawPlots, playShadow, playShadowReaction, raiseShadowReaction, sauronAuto, lateGameReset, eyePlaceToken, eyeTrackYield } from './sauronmech';
import { beginCombat } from './combat';
import { influenceAt, clearInfluenceAt, enforceInfluenceRules, isPerilous } from './influence';
import { tryCompleteQuestsOnExplore, questSubstituteMonster } from './quests';
import { cleanseAtRest, corruptionRestDefeatSteps, corruptionEncounterDraw, corruptionHandLimit, corruptionTravelCap } from './corruption';

// ---------------- Hero actions (during HeroActions phase) ----------------

function activeHero(state: GameState): HeroState {
  return state.heroes[state.activeHeroIndex];
}

function requireHeroTurn(state: GameState, heroId: HeroId): HeroState {
  if (state.phase !== 'HeroActions') throw new Error(`Not HeroActions phase (${state.phase})`);
  const hero = activeHero(state);
  if (hero.id !== heroId) throw new Error(`Not ${heroId}'s turn`);
  if (hero.actionsRemaining <= 0) throw new Error(`${heroId} has no actions left`);
  return hero;
}

/** Move the active hero across a terrain-matching edge, spending a card. */
export function heroMove(state: GameState, cat: Catalog, heroId: HeroId, to: LocationId, cards?: CardId[]): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  if (ambushPending(s, hero, cat)) throw new Error('Ambush: a foe here must be fought before travelling');
  // Travel steps repeat as many times as the hero is able (rulebook p.22),
  // limited only by the Hero cards in hand — plus any temporary caps: the
  // "Hopeless" Corruption card and a restrictMovement encounter effect.
  const corrCap = corruptionTravelCap(cat, hero);
  const caps = [corrCap, hero.turnTravelCap].filter((n): n is number => n != null);
  const travelCap = caps.length ? Math.min(...caps) : undefined;
  if (travelCap !== undefined && (hero.travelStepsThisTurn ?? 0) >= travelCap) {
    const why = corrCap !== undefined && corrCap === travelCap ? 'Hopeless: no more than' : 'Travel restricted to';
    throw new Error(`${why} ${travelCap} travel step(s) this turn`);
  }
  const mv = legalMoves(cat, hero).find((m) => m.to === to);
  if (!mv) throw new Error(`No legal move from ${hero.location} to ${to}`);
  let spent: string;
  if (cards && cards.length) {
    // Interactive Travel: the player picked exactly which card(s) to spend.
    if (!validateMovePayment(cat, hero, to, cards)) throw new Error(`Invalid card selection to travel to ${to}`);
    const names: string[] = [];
    for (const cid of cards) {
      names.push(cat.combatCards[cid]?.name ?? cid);
      discardFromHand(hero, cid);
    }
    spent = cards.length === 1 && cat.combatCards[cards[0]]?.terrain === mv.terrain
      ? `via ${mv.terrain} (spent ${names[0]})`
      : `via cards (discarded ${names.length}: ${names.join(', ')})`;
  } else if (!mv.viaAnyCards) {
    const card = findMovementCard(cat, hero, mv.terrain as Terrain)!;
    discardFromHand(hero, card);
    spent = `via ${mv.terrain} (spent ${cat.combatCards[card].name})`;
  } else {
    // Manual fallback: no matching-terrain card — discard `cost` cards of any type.
    const names: string[] = [];
    for (let i = 0; i < mv.cost && hero.hand.length; i++) {
      const cid = hero.hand[0];
      names.push(cat.combatCards[cid]?.name ?? cid);
      discardFromHand(hero, cid);
    }
    spent = `via any-card (discarded ${names.length}: ${names.join(', ')})`;
  }
  relocateHero(s, heroId, to);
  hero.hasMovedThisTurn = true;
  hero.travelStepsThisTurn = (hero.travelStepsThisTurn ?? 0) + 1;
  log(s, 'hero-move', heroId, `${hero.location} ${spent}`);
  // Travel step "Combat or Peril" (rulebook p.22): Sauron resolves ONE of the
  // two. With no foe present only Peril can apply. With a foe present he MUST
  // choose — force the fight (the usual, strongest lever) OR, if the location is
  // also perilous, draw Peril instead and let the hero move on.
  const realFoes = (s.map.monstersAt[to]?.length ?? 0) + (s.map.minionsAt?.[to]?.length ?? 0);
  const rumors = s.map.rumorsAt?.[to] ?? 0;
  if (realFoes > 0) {
    if (sauronAuto(s)) {
      const wisdom = statValue(s, cat, heroId, 'wisdom');
      if (isPerilous(s, cat, to, wisdom) && sauronPicksPeril(s, cat, heroId, to)) {
        (hero.perilResolvedAt ||= []).push(to);
        log(s, 'sauron', 'Sauron', `Combat or Peril: chooses Peril at ${cat.locations[to]?.name ?? to}`);
        maybeDrawPeril(s, cat, heroId, to);
      }
      // otherwise combat is forced: the foe blocks travel (Ambush) until fought.
    } else {
      // Human Sauron decides interactively (Combat or Peril) before the hero may
      // continue — but only when the location is genuinely perilous.
      const wisdom = statValue(s, cat, heroId, 'wisdom');
      if (isPerilous(s, cat, to, wisdom)) s.pendingCombatOrPeril = { heroId, loc: to };
    }
  } else if (rumors > 0) {
    // Blank-only location: Sauron KNOWS the token here is a false rumor. Flipping
    // it for combat would reveal nothing and discard it for free, so if the spot
    // is perilous he takes Peril instead (damage AND the bluff survives). If it is
    // not perilous, his only legal resolution is to flip the blank — it is
    // revealed as false and discarded (the hero then proceeds unharmed).
    const wisdom = statValue(s, cat, heroId, 'wisdom');
    if (isPerilous(s, cat, to, wisdom)) {
      log(s, 'sauron', 'Sauron', `Combat or Peril: no monster to reveal, chooses Peril at ${cat.locations[to]?.name ?? to}`);
      maybeDrawPeril(s, cat, heroId, to);
    } else {
      s.map.rumorsAt![to] = rumors - 1;
      if (s.map.rumorsAt![to] <= 0) delete s.map.rumorsAt![to];
      log(s, 'sauron', 'Sauron', `Combat or Peril: a false rumor is revealed at ${cat.locations[to]?.name ?? to} — the token is discarded`);
    }
  } else {
    maybeDrawPeril(s, cat, heroId, to);
  }
  // "After a hero enters a non-Haven location" Shadow window. The automa
  // auto-plays; a human Sauron chooses interactively — unless he already owes a
  // Combat-or-Peril decision here (that resolves first, and the only enter
  // window card merely makes the spot perilous, which is moot in that case).
  if (cat.locations[to]?.kind !== 'haven') {
    if (s.pendingTree) {
      // A Peril just paused for the human hero's decision — defer this window
      // until that decision completes (resolveTreeDecision runs it).
      s.pendingTree.resumeEnterWindow = { heroId, loc: to };
      return s;
    }
    if (sauronAuto(s)) {
      playShadowReaction(s, cat, 'enter-nonhaven', { heroId }, (m) => log(s, 'sauron', 'Sauron', m));
    } else if (!s.pendingCombatOrPeril) {
      raiseShadowReaction(s, cat, 'enter-nonhaven', { heroId });
    }
  }
  return s;
}

/** M3 automa Combat-or-Peril policy (rulebook p.22). Forcing a fight is normally
 *  Sauron's strongest lever (a lost fight ends the hero's turn), so he fights by
 *  default. He opts for Peril only when the fight is low-value: the location has
 *  no minion (minions are always worth engaging) and the hero is at or above a
 *  strong-hand threshold, making a defeat unlikely. */
export const COMBAT_OR_PERIL_STRONG_HAND = 5;
function sauronPicksPeril(s: GameState, cat: Catalog, heroId: HeroId, loc: LocationId): boolean {
  // Guard the objective: if the hero just stepped onto an ACTIVE-PLOT location he
  // is poised to break, forcing combat is the only lever that can stop it — a lost
  // fight ends his turn before he explores, and even a win costs him the foe. If
  // Sauron chose Peril here the foe would stop blocking and the hero could break
  // the plot for the mere price of a Peril card. So never pick Peril on a plot loc.
  const onActivePlot = (s.sauron.activePlots ?? []).some((p) => p.location === loc);
  if (onActivePlot) return false;
  if ((s.map.minionsAt?.[loc]?.length ?? 0) > 0) return false;
  if (!Object.keys(cat.perils).length) return false;
  const hero = s.heroes.find((h) => h.id === heroId)!;
  return hero.hand.length >= COMBAT_OR_PERIL_STRONG_HAND;
}

/** M3: resolve a human Sauron's "Combat or Peril" decision (rulebook p.22).
 *  'peril' draws the Peril and lets the hero move on; 'combat' leaves the foe to
 *  force a fight (Ambush) before the hero may continue travelling. */
export function resolveCombatOrPeril(state: GameState, cat: Catalog, choice: 'combat' | 'peril'): GameState {
  const s = clone(state);
  const pending = s.pendingCombatOrPeril;
  if (!pending) throw new Error('No pending Combat-or-Peril decision');
  s.pendingCombatOrPeril = null;
  const { heroId, loc } = pending;
  if (choice === 'peril') {
    const hero = s.heroes.find((h) => h.id === heroId)!;
    (hero.perilResolvedAt ||= []).push(loc);
    log(s, 'sauron', 'Sauron', `Combat or Peril: chooses Peril at ${cat.locations[loc]?.name ?? loc}`);
    maybeDrawPeril(s, cat, heroId, loc);
  } else {
    log(s, 'sauron', 'Sauron', `Combat or Peril: forces combat at ${cat.locations[loc]?.name ?? loc}`);
  }
  return s;
}

/** True if `loc` is at or adjacent to the Witch-king minion (his no-rest aura). */
function nearWitchKing(s: GameState, cat: Catalog, loc: LocationId): boolean {
  const at = s.map.minionsAt ?? {};
  const wkLocs = Object.entries(at)
    .filter(([, ids]) => ids.some((id) => cat.minions[id]?.effectKey === 'minion-no-rest-aura'))
    .map(([l]) => l);
  if (!wkLocs.length) return false;
  if (wkLocs.includes(loc)) return true;
  return cat.edges.some((e) =>
    (e.a === loc && wkLocs.includes(e.b)) || (e.b === loc && wkLocs.includes(e.a)));
}

/** Rest step (MEQ): if not in a stronghold and no monster/minion is present,
 *  shuffle the rest pool back into the life pool. In a Haven the hero may also
 *  heal (shuffle the damage pool into the life pool) and cleanse 1 Corruption
 *  card by paying 1 favor. */
export function heroRest(state: GameState, cat: Catalog, heroId: HeroId, opts?: { beravorTrain?: boolean }): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  const loc = cat.locations[hero.location];
  const foesHere = (s.map.monstersAt[hero.location]?.length ?? 0) + (s.map.minionsAt?.[hero.location]?.length ?? 0);
  const inHaven = loc?.kind === 'haven';
  // The Rest step happens once per turn (rulebook p.20). It is free (not metered
  // by an action budget); a second Rest this turn is illegal.
  if (hero.restedThisTurn) throw new Error('Rest step already taken this turn');
  // Witch-king (Lord of the Nazgûl): heroes within 1 space may not rest or heal
  // unless they are in a Haven. A blocked Rest does nothing (and the Sauron
  // marker does not advance, since the hero did not rest).
  if (!inHaven && nearWitchKing(s, cat, hero.location)) {
    hero.restedThisTurn = true;
    log(s, 'hero-rest', heroId, `cannot rest or heal within 1 space of the Witch-king`);
    return s;
  }
  // Errata: in a Haven a hero may rest (and heal) even if a minion is present.
  if (loc?.kind !== 'stronghold' && (foesHere === 0 || inHaven)) restHero(s, hero);
  if (inHaven) {
    healHero(s, hero);
    // Rest cleanse (rulebook p.26): discard one held Corruption card by paying
    // its printed favor cost. Falls back to the flat legacy cost if the hero
    // carries a numeric-only corruption value with no backing cards.
    if (hero.corruptionCards?.length) {
      const removed = cleanseAtRest(s, cat, heroId);
      if (removed) log(s, 'hero-cleanse', heroId, `rest: cleansed ${cat.corruption[removed]?.name ?? removed} (favor ${hero.favor})`);
    } else if (hero.corruption > 0 && hero.favor > 0) {
      hero.corruption -= 1; hero.favor -= 1;
    }
  } else if (hero.id === 'beravor' && loc?.kind !== 'stronghold' && foesHere === 0) {
    // Survivalist (hero sheet): when Beravor rests in a non-Haven location she
    // may heal OR receive training — it is always her choice, even when wounded
    // (she can pick training instead of healing). Default without an explicit
    // choice: heal when wounded, otherwise train.
    const train = opts?.beravorTrain === true || hero.damagePool.length === 0;
    if (!train) {
      healHero(s, hero);
      log(s, 'hero-ability', heroId, 'Beravor (Survivalist): heals while resting outside a Haven');
    } else {
      grantTraining(s, cat, hero, 1);
      log(s, 'hero-ability', heroId, 'Beravor (Survivalist): receives training while resting outside a Haven');
    }
  }
  hero.restedThisTurn = true;
  // MEQ Rest: advance the leftmost (least-advanced) Sauron story marker one space
  // (two if the hero carries the Despondent Corruption card).
  const steps = corruptionRestDefeatSteps(cat, hero);
  let moved: string | undefined;
  for (let i = 0; i < steps; i++) moved = advanceLeftmostMarker(s) ?? moved;
  log(s, 'hero-rest', heroId, `life pool ${hero.deck.length}, rest ${hero.discard.length}, damage ${hero.damagePool.length}, corruption ${hero.corruption} — Sauron's ${moved ?? 'leftmost'} marker advances`);
  return s;
}

/** Monsters and minions at the hero's location that can be engaged this action. */
export function engageableMonsters(state: GameState, heroId: HeroId): MonsterId[] {
  const hero = state.heroes.find((h) => h.id === heroId)!;
  const monsters = (state.map.monstersAt[hero.location] ?? []).filter((m): m is MonsterId => m != null);
  const minions = (state.map.minionsAt?.[hero.location] ?? []).filter((m): m is MonsterId => m != null);
  return [...minions, ...monsters];
}

/** #10: the Encounter deck a location draws from — its region-PAIR deck, or the
 *  shared 'Haven' deck for Haven locations. Returns the regionGroup key. */
function encounterGroupFor(cat: Catalog, locId: LocationId): string {
  const loc = cat.locations[locId];
  if (!loc) return '';
  if (loc.kind === 'haven') return 'Haven';
  for (const enc of Object.values(cat.encounters)) {
    if (enc.regionGroup === 'Haven') continue;
    if (enc.regionGroup.toLowerCase().replace(/ /g, '-') === loc.regionId) return enc.regionGroup;
  }
  return '';
}

/** Whether an Encounter card affects a location: an exact printed-location match
 *  or a region-wide ("Any Location…") card (the region-pair is the finest
 *  granularity this engine models). */
function encounterAffects(cat: Catalog, cardId: CardId, locId: LocationId): boolean {
  const enc = cat.encounters[cardId];
  const loc = cat.locations[locId];
  if (!enc || !loc) return false;
  const printed = enc.location.trim().toLowerCase();
  if (printed.startsWith('any location')) return true;
  return printed === loc.name.toLowerCase();
}

function encPriority(cat: Catalog, cardId: CardId): number {
  const p = cat.encounters[cardId]?.priority;
  const n = typeof p === 'number' ? p : parseInt(String(p), 10);
  return Number.isFinite(n) ? n : 99;
}

/** Draw up to n cards from a region's Encounter deck, reshuffling its discard
 *  back in when the deck is depleted (manual: reshuffle a depleted deck). */
function drawEncounters(s: GameState, cat: Catalog, group: string, n: number): CardId[] {
  const decks = (s.encounterDecks ||= {});
  const discards = (s.encounterDiscards ||= {});
  if (!decks[group]) {
    const all = Object.values(cat.encounters).filter((e) => e.regionGroup === group).map((e) => e.id);
    decks[group] = shuffle(s, all);
    discards[group] ||= [];
  }
  const out: CardId[] = [];
  for (let i = 0; i < n; i++) {
    if (!decks[group].length) {
      if (!discards[group]?.length) break;
      decks[group] = shuffle(s, discards[group]);
      discards[group] = [];
    }
    const c = decks[group].pop();
    if (c) out.push(c);
  }
  return out;
}

/** Whether the active hero can explore here: a foe-free (non-ambush) location
 *  whose Encounter step has not yet run this turn and whose region Encounter
 *  deck holds a card that could affect it. The Encounter step happens once per
 *  turn (guarded by `encounterStepDone`) but may repeat on later turns — the
 *  manual places no once-per-game restriction on exploring a location. */
export function canExplore(state: GameState, cat: Catalog, heroId: HeroId): boolean {
  const hero = state.heroes.find((h) => h.id === heroId)!;
  // An event-deck plot at the hero's location is always explorable (to discard
  // it), even where there is no ordinary encounter to draw.
  if ((state.sauron.activeEventPlots ?? []).some((m) => m.location === hero.location)) return true;
  if (hero.encounterStepDone) return false; // the Encounter step runs once per turn
  const group = encounterGroupFor(cat, hero.location);
  if (!group) return false;
  return Object.values(cat.encounters)
    .some((e) => e.regionGroup === group && encounterAffects(cat, e.id, hero.location));
}

/** Shared Encounter-step resolution: draw 3 cards from this location's (or the
 *  Haven's) Encounter deck, discard all three, and set up the lowest-priority
 *  card that affects the location as the pending encounter. Returns true when a
 *  card is pending resolution; false when none apply (the whole draw whiffs).
 *  Faithful to the manual (pp. 24–25): resolve only the lowest-numbered matching
 *  card; the term "Quest" routing is handled downstream in the encounter tree. */
function runEncounterStep(s: GameState, cat: Catalog, heroId: HeroId): boolean {
  const hero = s.heroes.find((h) => h.id === heroId)!;
  // Exploring this location may fulfil an "Explore <location>" quest task.
  tryCompleteQuestsOnExplore(s, cat, heroId, hero.location);
  // Defeat-quest substitution: "When you would draw Encounter cards here, combat
  // a <Monster> instead." Place the foe (if not already present) rather than
  // drawing; the hero must defeat it (which completes the quest).
  const sub = questSubstituteMonster(hero, hero.location);
  if (sub) {
    const here = (s.map.monstersAt[hero.location] ||= []);
    if (!here.includes(sub)) {
      here.push(sub);
      log(s, 'encounter-draw', heroId, `quest: ${cat.monsters[sub]?.name ?? sub} appears at ${hero.location} (combat instead of Encounter)`);
    }
    return true; // a foe is present — the turn continues into combat, not a whiff
  }
  const group = encounterGroupFor(cat, hero.location);
  if (!group) return false;
  const drawn = drawEncounters(s, cat, group, corruptionEncounterDraw(cat, hero, 3));
  (s.encounterDiscards![group] ||= []).push(...drawn);
  const affecting = drawn.filter((c) => encounterAffects(cat, c, hero.location));
  if (!affecting.length) {
    log(s, 'encounter-draw', heroId, `Encounter at ${hero.location}: drew ${drawn.length}, none apply`);
    return false;
  }
  const chosen = affecting.reduce((a, b) => (encPriority(cat, b) < encPriority(cat, a) ? b : a));
  s.pendingEncounter = { locationId: hero.location, cardId: chosen, decisions: [], drawn, applicable: affecting, revealed: false };
  const enc = cat.encounters[chosen];
  log(s, 'encounter-draw', heroId, `${enc?.name ?? chosen} at ${hero.location} (drew ${drawn.length}, ${affecting.length} apply)`, { cardId: chosen });
  return true;
}

/** Explore (#10): the optional way to trigger the Encounter step at the location
 *  the hero started his turn on (manual: he may skip the Move/Combat-or-Peril of
 *  his first Travel step and explore in place). Consumes the action, marks the
 *  Encounter step done, and resolves as the mandatory end-of-turn step would.
 *  If none of the three cards affect the location, the hero's turn ends. */
export function heroExplore(state: GameState, cat: Catalog, heroId: HeroId): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  if (ambushPending(s, hero, cat)) throw new Error('Ambush: a foe here must be fought before exploring');
  // "Explore to Discard": if an event-deck plot sits here, exploring removes it
  // (and its character) from the board instead of drawing an encounter.
  const ep = (s.sauron.activeEventPlots ?? []).find((m) => m.location === hero.location);
  if (ep) {
    hero.encounterStepDone = true;
    discardEventPlot(s, cat, ep.eventId);
    hero.actionsRemaining = 0; // the Encounter step is the final step of the turn
    return s;
  }
  const group = encounterGroupFor(cat, hero.location);
  if (!group) throw new Error(`Nothing to explore at ${hero.location}`);
  hero.encounterStepDone = true;
  s.explored[hero.location] = true; // record the visit (map memory; no longer gates re-exploring)
  runEncounterStep(s, cat, heroId); // resolve (or whiff) — either way the turn ends
  hero.actionsRemaining = 0;
  return s;
}

/** Remove an event-deck plot from play: drop its board token, send the event
 *  card to the Event discard, and clear its character marker. */
function discardEventPlot(s: GameState, cat: Catalog, plotId: CardId): void {
  const list = s.sauron.activeEventPlots ?? [];
  const i = list.findIndex((m) => m.eventId === plotId);
  if (i < 0) return;
  const [removed] = list.splice(i, 1);
  const plot = cat.plots.find((p) => p.id === plotId);
  // Return the matching event card to the Event discard pile.
  const ev = plot ? cat.events.find((e) => normName(e.name) === normName(plot.name)) : undefined;
  if (ev) (s.sauron.eventDiscard ||= []).push(ev.id);
  // Remove its character from the board (a single unique marker).
  if (plot?.character) removeCharacter(s, plot.character);
  log(s, 'event-discard', 'Hero', `${plot?.name ?? plotId} explored and discarded from ${cat.locations[removed.location!]?.name ?? removed.location}`, { cardId: plotId });
}

/** Read-only: plan the pending encounter with its decisions so far. Used by the
 *  UI to render the next choice (or confirm auto-resolution). */
export function encounterPlan(state: GameState, cat: Catalog): PlanResult | null {
  const pe = state.pendingEncounter;
  if (!pe) return null;
  const enc = cat.encounters[pe.cardId];
  const heroId = (state.map.heroesAt[pe.locationId] ?? [])[0] ?? state.heroes[state.activeHeroIndex].id;
  return planEncounter(state, cat, heroId, enc?.tree ?? { k: 'none' }, pe.decisions);
}

/** Record a choice for the pending encounter, then try to complete it. */
export function chooseEncounter(state: GameState, cat: Catalog, optionIndex: number): GameState {
  const s = clone(state);
  if (!s.pendingEncounter) throw new Error('No pending encounter');
  s.pendingEncounter.decisions.push(optionIndex);
  return resolveEncounter(s, cat);
}

/** UI reveal gate: the player has read the (up to 3) drawn Encounter cards and
 *  confirms which applicable card resolves. Defaults to the auto-selected
 *  lowest-priority card; when several cards apply the player may pass the chosen
 *  `cardId`. Marks the tray revealed so resolution can proceed. */
export function revealEncounter(state: GameState, _cat: Catalog, cardId?: CardId): GameState {
  const s = clone(state);
  const pe = s.pendingEncounter;
  if (!pe) return s;
  if (cardId && (pe.applicable ?? []).includes(cardId)) pe.cardId = cardId;
  pe.revealed = true;
  return s;
}

/** Dismiss the pending draw-and-reveal tray (Event Step / Peril). The effect has
 *  already been applied when the tray was raised; this only clears the tray so
 *  the game can continue. */
export function dismissReveal(state: GameState): GameState {
  const s = clone(state);
  s.pendingReveal = null;
  return s;
}

/** Resolve the pending encounter: walk its effect tree with the decisions made
 *  so far. If a choice is still needed the state is returned unchanged (the UI
 *  drives further via chooseEncounter); once fully decided the ops are applied,
 *  the location is marked explored, and the encounter is cleared. */
export function resolveEncounter(state: GameState, cat: Catalog): GameState {
  const s = clone(state);
  const pe = s.pendingEncounter;
  if (!pe) throw new Error('No pending encounter');
  const enc = cat.encounters[pe.cardId];
  const heroId = (s.map.heroesAt[pe.locationId] ?? [])[0] ?? s.heroes[s.activeHeroIndex].id;
  const plan = planEncounter(s, cat, heroId, enc?.tree ?? { k: 'none' }, pe.decisions);
  if (!plan.complete) return s; // awaiting a player choice
  if (plan.atoms.length) applyAtoms(s, cat, heroId, plan.atoms, `encounter ${enc?.name ?? pe.cardId}`);
  else log(s, 'encounter-resolve', heroId, `${enc?.name ?? pe.cardId} (no effect)`, { cardId: pe.cardId });
  s.pendingEncounter = null;
  return s;
}

function relocateHero(s: GameState, heroId: HeroId, to: LocationId): void {
  const hero = s.heroes.find((h) => h.id === heroId)!;
  const arr = s.map.heroesAt[hero.location];
  if (arr) { const i = arr.indexOf(heroId); if (i >= 0) arr.splice(i, 1); }
  hero.location = to;
  (s.map.heroesAt[to] ||= []).push(heroId);
}

/** Validate the hero's turn and clone before opening combat. Engaging a foe is
 *  part of the Ambush/Travel step (rulebook pp.22–23) and is NOT a metered
 *  action; it only fails the turn if the hero loses. */
export function spendActionForCombat(state: GameState, heroId: HeroId): GameState {
  const s = clone(state);
  requireHeroTurn(s, heroId);
  return s;
}

/** End the active hero's action step; advance to the next hero or Sauron.
 *  Two-player game (a single hero): the lone hero takes 2 turns per Sauron turn,
 *  with a special Hero Rally + Hero Draw between them (manual, Two-Player Game). */
export function endHeroActions(state: GameState, cat: Catalog): GameState {
  const s = clone(state);
  if (s.phase !== 'HeroActions') throw new Error('Not in HeroActions');
  const hero = activeHero(s);
  // Mandatory Encounter Step (manual pp. 24–25): after finishing his Travel step,
  // and if he is NOT in a perilous location, the hero draws three Encounter cards
  // from his location's deck and resolves the lowest-priority matching card. In a
  // perilous location this step is skipped (Peril was drawn during Travel). If it
  // sets a pending encounter, hold the turn here — the loop resolves it and calls
  // endHeroActions again (encounterStepDone guards against repeating the draw).
  if (hero.status === 'active' && !hero.encounterStepDone) {
    hero.encounterStepDone = true;
    const wisdom = cat.heroes[hero.id].wisdom + (hero.statBonus?.wisdom ?? 0);
    if (!isPerilous(s, cat, hero.location, wisdom)) {
      if (runEncounterStep(s, cat, hero.id)) return s;
    }
  }
  log(s, 'hero-end', hero.id, 'ends turn');
  if (s.activeHeroIndex < s.heroes.length - 1) {
    s.activeHeroIndex += 1;
    s.phase = 'HeroRefresh';
    return runHeroRefresh(s, cat);
  }
  // Lone hero (2-player): grant a second turn after a special Hero Rally + Draw.
  if (s.heroes.length === 1 && !s.heroSecondTurnPending && s.heroes[0].status === 'active') {
    s.heroSecondTurnPending = true;
    heroRally(s, cat);
    s.phase = 'HeroRefresh';
    log(s, 'phase', s.heroes[0].id, 'two-player game: second hero turn (Hero Rally + Draw)');
    return runHeroRefresh(s, cat);
  }
  s.heroSecondTurnPending = false;
  s.activeSide = 'Sauron';
  s.phase = 'SauronRefresh';
  return s;
}

/** Special Hero Rally step (manual, Sauron turn step 1 — also run between the
 *  two-player game's paired hero turns): discard all influence from each active
 *  hero's current location/region, unless it is a Shadow Stronghold. */
function heroRally(s: GameState, cat: Catalog): void {
  for (const h of s.heroes.filter((x) => x.status === 'active')) {
    const loc = cat.locations[h.location];
    if (!loc || loc.kind === 'stronghold') continue;
    if (influenceAt(s, h.location) > 0) {
      clearInfluenceAt(s, h.location);
      log(s, 'hero-rally', h.id, `influence cleared at ${loc.name}`);
    }
  }
  // Heroes disrupting a chain can strand influence: reduce anything no longer in
  // extension of a stronghold to a single token (rulebook p. 16).
  enforceInfluenceRules(s, cat);
}

// ---------------- Phase engine (advance when no choice/combat pending) --------

function runHeroRefresh(s: GameState, cat: Catalog): GameState {
  const hero = activeHero(s);
  s.shadowPlayedThisHeroTurn = false; // new hero activation: reset the once-per-turn window
  if (hero.status === 'active') {
    // Hero Draw step (rulebook p.19): draw a number of NEW cards equal to the
    // hero's fortitude every turn. Cards ACCUMULATE — there is no hand limit
    // (only certain Shadow cards force a discard down to five) — so this is an
    // additive draw of `fortitude` cards, NOT a top-up to `fortitude`.
    const fort = cat.heroes[hero.id].fortitude + (hero.statBonus?.fortitude ?? 0);
    // The Setup starting hand already covers the first turn's draw — skip it once.
    if (hero.startingHandReady) hero.startingHandReady = false;
    else drawFromLifePool(hero, fort);
    // Distraught Corruption card: a hero may never hold more than 7 hero cards —
    // discard down to the cap after the draw.
    const handCap = corruptionHandLimit(cat, hero);
    if (handCap !== undefined) {
      while (hero.hand.length > handCap) hero.discard.push(hero.hand.pop()!);
    }
    hero.actionsRemaining = HERO_ACTIONS;
    hero.darkPathUsedThisTurn = false;
    hero.abilityUsedThisTurn = false;
    hero.encounterStepDone = false;
    hero.hasMovedThisTurn = false;
    hero.restedThisTurn = false;
    hero.travelStepsThisTurn = 0;
    hero.favorGainedThisTurn = 0;
    hero.skipAmbush = false;
    hero.perilResolvedAt = [];
    // restrictMovement (Winter Storm etc.): cap THIS turn's Travel steps.
    hero.turnTravelCap = hero.moveRestriction;
    hero.moveRestriction = undefined;
    if (hero.combatMods) hero.combatMods = [];
  }
  s.phase = 'HeroActions';
  log(s, 'phase', hero.id, `HeroActions (hand ${hero.hand.length}, life pool ${hero.deck.length})`);
  // Start-of-hero-turn Shadow window (one Shadow card per hero turn). The automa
  // auto-plays; a human Sauron chooses interactively (pauses the phase engine).
  if (hero.status === 'active') {
    if (sauronAuto(s)) {
      playShadowReaction(s, cat, 'hero-turn', { heroId: hero.id }, (m) => log(s, 'sauron', 'Sauron', m));
    } else {
      raiseShadowReaction(s, cat, 'hero-turn', { heroId: hero.id });
    }
  }
  return s;
}

function runSauronRefresh(s: GameState, cat: Catalog): GameState {
  // === Ringwraith return === defeated Ringwraiths return to Minas Morgul at the
  // start of Sauron's Action step, restored to full health.
  const returning = s.map.minionReturnPending ?? [];
  if (returning.length) {
    for (const mid of returning) {
      const arr = (s.map.minionsAt ||= {})['minas-morgul'] ||= [];
      if (!arr.includes(mid)) arr.push(mid);
      (s.map.minionHealth ||= {})[mid] = cat.minions[mid]?.health ?? 0;
      log(s, 'sauron', 'Sauron', `${cat.minions[mid]?.name ?? mid} returns to Minas Morgul`);
    }
    s.map.minionReturnPending = [];
  }
  // === Hero Rally Step (Sauron turn step 1) === discard all influence from each
  // active hero's current location/region (unless a Shadow Stronghold).
  heroRally(s, cat);
  // === Story Step (MEQ) === skipped on the first game turn. The hero (green)
  // marker climbs 2 spaces toward the Finale; each of Sauron's story markers
  // advances by the value of every active Plot card feeding it.
  if (s.story.turn > 1) {
    s.story.sauronProgress += 2;
    const st = s.story.sauron;
    if (st) {
      for (const ap of s.sauron.activePlots ?? []) {
        const p = cat.plots.find((x) => x.id === ap.eventId);
        if (!p) continue;
        const marker = (p.marker ?? 'red') as keyof typeof st;
        const adv = p.advance ?? 1;
        st[marker] = Math.min(STORY_FINALE, st[marker] + adv);
      }
      // Event-deck plots on the board advance their coloured marker one space
      // each Story Step while they remain unexplored.
      for (const ep of s.sauron.activeEventPlots ?? []) {
        const p = cat.plots.find((x) => x.id === ep.eventId);
        if (!p) continue;
        const marker = (p.marker ?? 'red') as keyof typeof st;
        st[marker] = Math.min(STORY_FINALE, st[marker] + (p.advance ?? 1));
        log(s, 'sauron', 'Sauron', `${p.name} advances the ${p.markerName ?? marker} marker`);
      }
    }
  } else {
    log(s, 'sauron', 'Sauron', 'Story Step skipped on the first game turn (no marker advance)');
  }
  // Stage minions (e.g. Gothmog at stage II, the Witch-king at stage III) deploy
  // automatically once the game reaches their stage — independent of the Eye's
  // action budget. deployMinion is idempotent (never re-places a figure already
  // on the board) and skips the reserved Finale minion.
  for (let g = 0; g < 8; g++) {
    const id = deployMinion(s, cat);
    if (!id) break;
    log(s, 'sauron', 'Sauron', `stage minion deploys: ${cat.minions[id]?.name ?? id}`);
  }
  s.phase = 'SauronEvents';
  log(s, 'phase', 'Sauron', `story step: hero marker ${s.story.sauronProgress}/${s.story.length}, Sauron ${s.story.sauron ? `Y${s.story.sauron.yellow} R${s.story.sauron.red} B${s.story.sauron.black}` : ''}`);
  return s;
}

function runSauronEvents(s: GameState, cat: Catalog): GameState {
  const late = s.story.turn / Math.max(1, s.story.length) > 2 / 3;
  // === Plot Step === the Eye plays/advances a plot into an empty plot location,
  // chosen by the bot priority list. Skipped when a human controls Sauron — the
  // human already resolved their Plot Step interactively.
  if (s.humanSide !== 'Sauron') {
    advancePlots(s, cat, late, (msg) => log(s, 'sauron-ai', 'Sauron', msg));
  }
  // === Event Step === draw from the shuffled Event deck per dominance:
  //  · neither side dominant → draw 1 and resolve it
  //  · Sauron dominant       → draw 3, resolve the HIGHEST priority (worst for heroes)
  //  · Heroes dominant       → draw 3, resolve the LOWEST priority (best for heroes)
  const turn = s.story.turn;
  const dom = dominantSide(s);
  const drawn = drawEventCards(s, cat, dom ? 3 : 1);
  let chosen: EventCard[] = [];
  if (drawn.length) {
    if (!dom) {
      chosen = [drawn[0]];
    } else {
      const byPriority = [...drawn].sort((a, b) => Number(a.cardNo) - Number(b.cardNo));
      chosen = [dom === 'Sauron' ? byPriority[byPriority.length - 1] : byPriority[0]];
    }
    for (const e of drawn) if (!chosen.includes(e)) s.sauron.eventDiscard!.push(e.id);
  }
  s.sauron.activeEvents = chosen.map((e) => ({ eventId: e.id, step: 0 }));
  log(s, 'sauron-event', 'Sauron', `Event Step (${dom ? dom + ' dominant' : 'no dominance'}): drew ${drawn.length}, resolving ${chosen.map((e) => e.name).join(', ') || 'none'}`,
    { dominant: dom, drawn: drawn.map((e) => e.id), resolved: chosen.map((e) => e.id) });
  // Surface the drawn Event card(s) to a human hero player: a reveal tray shows
  // all drawn cards with the resolved one highlighted (read + OK). Skipped when a
  // human plays Sauron — he already sees his own event resolution.
  if (drawn.length && s.humanSide !== 'Sauron') {
    s.pendingReveal = {
      kind: 'event', deck: 'events',
      title: dom ? `Event Step — ${dom} dominant` : 'Event Step',
      drawn: drawn.map((e) => e.id),
      chosen: chosen[0]?.id,
      note: dom
        ? `${dom} dominant: three drawn, resolving the ${dom === 'Sauron' ? 'highest' : 'lowest'}-priority card.`
        : 'No dominance: a single card is drawn and resolved.',
    };
  }
  // Event board placement happens FIRST — it is independent of the card's
  // mechanical effect (favor/Character tokens land per the card text), so doing
  // it up front lets the effect below PAUSE for a human hero's printed choice
  // without stranding the placement or the phase transition.
  for (const e of chosen) if (eventDeckPlotFor(cat, e)) registerEventPlot(s, cat, e);
  for (const e of chosen) placeEventTokens(s, cat, e);
  // Discard the resolved cards — EXCEPT event-deck plots, which are held in play
  // (out of the deck) until a hero Explores them.
  for (const e of chosen) if (!eventDeckPlotFor(cat, e)) s.sauron.eventDiscard!.push(e.id);
  s.phase = 'SauronMinions';
  log(s, 'phase', 'Sauron', `event step for turn ${turn}: ${chosen.length} card(s) resolved`);
  // === Action Step setup === for a human Sauron, set the action budget (2, or 3
  // with three heroes). Unlike the automa, the human gets NO free war-chest income
  // or card draws here: pool influence and cards come ONLY from spending actions
  // on the Eye's Place Influence and Draw tracks — exactly the rules the automa
  // plays by (rulebook pp.16-19).
  if (s.humanSide === 'Sauron') {
    const activeHeroes = s.heroes.filter((h) => h.status === 'active').length;
    s.sauronActionsLeft = activeHeroes >= 3 ? 3 : 2;
    s.sauronPending = undefined;
    s.shadowPlayedThisSauronTurn = false;
    log(s, 'phase', 'Sauron', `action step: ${s.sauronActionsLeft} actions (chest ${s.sauron.influence})`);
  }
  // Apply each event's mechanical effect LAST: global ops (influence) once;
  // hero-scoped ops (favor/corruption/damage) fall on every active hero. A card
  // whose printed "Choose one" belongs to the hero PAUSES here for a human hero
  // (see treeActor); the AI picks the hero's best option.
  for (const e of chosen) {
    if (eventDeckPlotFor(cat, e)) continue; // a lasting plot, no one-shot effect
    if (e.tree && (e.tree as any).k && (e.tree as any).k !== 'none') {
      const target = s.heroes.find((x) => x.status === 'active');
      if (target) {
        if (treeActorIsHuman(s, 'hero')) {
          stepResolveTree(s, cat, e.tree, {
            sourceKind: 'event', cardId: e.id, source: `event ${e.name}`, heroId: target.id, actor: 'hero',
          });
        } else {
          autoResolveTree(s, cat, target.id, e.tree, `event ${e.name}`, 'hero');
        }
      }
      continue;
    }
    if (!e.ops?.length) continue;
    const globalOps = e.ops.filter((o) => o.op === 'addInfluence' || o.op === 'removeInfluence');
    const heroOps = e.ops.filter((o) => o.op !== 'addInfluence' && o.op !== 'removeInfluence');
    if (globalOps.length) applyOps(s, cat, null, globalOps, `event ${e.name}`);
    if (heroOps.length) for (const h of s.heroes.filter((x) => x.status === 'active')) applyOps(s, cat, h.id, heroOps, `event ${e.name}`);
  }
  return s;
}

// Card/location names are matched punctuation- AND diacritic-insensitively so
// "The Blood of Rhûn" (event) reconciles with "The Blood of Rhun" (plot), etc.
function normName(x: string): string {
  return x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Resolve an event card's uppercase location name (e.g. "HELMS DEEP") to a
// location id by matching on a punctuation-insensitive, uppercased name.
function locByName(cat: Catalog, name: string | undefined): string | null {
  if (!name) return null;
  const key = normName(name);
  if (!key) return null;
  const hit = Object.values(cat.locations).find((l) => normName(l.name) === key || normName(l.id) === key);
  return hit ? hit.id : null;
}

/** The Plot-catalog entry for an event-deck "plot" card (matched by name), or
 *  null for an ordinary event. */
function eventDeckPlotFor(cat: Catalog, e: { name?: string }): Plot | null {
  if (!e.name) return null;
  const key = normName(e.name);
  return cat.plots.find((p) => p.eventDeckPlot && normName(p.name) === key) ?? null;
}

/** Bring an event-deck plot onto the board: a lasting token at its location that
 *  advances its coloured story marker each Story Step until Explored away. */
function registerEventPlot(s: GameState, cat: Catalog, e: { name?: string; questLocation?: string }): void {
  const plot = eventDeckPlotFor(cat, e);
  if (!plot) return;
  const loc = locByName(cat, e.questLocation) ?? locByName(cat, plot.affectsText);
  if (!loc) return;
  const list = (s.sauron.activeEventPlots ||= []);
  if (list.some((m) => m.eventId === plot.id)) return; // already in play
  list.push({ eventId: plot.id, step: 0, location: loc });
  log(s, 'event-place', 'Sauron', `${plot.name} enters play at ${cat.locations[loc]?.name ?? loc} — Explore to discard`, { cardId: plot.id });
}

/** Place an event card's board tokens: favor at favor1/favor2 and the named
 *  Character at its characterLocation. */
function placeEventTokens(s: GameState, cat: Catalog, e: { name: string; favor1?: string; favor2?: string; character?: string; characterLocation?: string }): void {
  for (const f of [e.favor1, e.favor2]) {
    const loc = locByName(cat, f);
    if (loc) {
      (s.map.favorAt ||= {});
      s.map.favorAt[loc] = (s.map.favorAt[loc] ?? 0) + 1;
      log(s, 'event-place', 'Sauron', `favor placed at ${cat.locations[loc]?.name ?? loc} (${e.name})`);
    }
  }
  const cloc = locByName(cat, e.characterLocation);
  if (e.character && cloc) {
    const from = placeCharacterUnique(s, e.character, cloc);
    log(s, 'event-place', 'Sauron', from
      ? `${e.character} moves from ${cat.locations[from]?.name ?? from} to ${cat.locations[cloc]?.name ?? cloc} (${e.name})`
      : `${e.character} arrives at ${cat.locations[cloc]?.name ?? cloc} (${e.name})`);
  }
}

function runSauronMinions(s: GameState, cat: Catalog): GameState {
  // A human Sauron drives the Action Step interactively (see sauronPlay.ts);
  // the phase machine holds here until they finish and advance to StoryAdvance.
  if (s.humanSide === 'Sauron') return s;
  // === Action Step === the manual grants Sauron 2 actions (3 in a 4-player /
  // three-hero game). The Eye does NOT run a fixed script: each action it scores
  // every candidate and takes the best, and it may REPEAT a type — placing more
  // influence, drawing for better plots, or moving/healing a minion again.
  const activeHeroes = s.heroes.filter((h) => h.status === 'active').length;
  const budget = activeHeroes >= 3 ? 3 : 2;
  const frac = s.story.sauronProgress / Math.max(1, s.story.length);
  const late = frac > 2 / 3;

  const logMsg = (msg: string) => log(s, 'sauron-ai', 'Sauron', msg);
  for (let a = 0; a < budget; a++) {
    const label = eyeTakeBestAction(s, cat, frac, logMsg);
    if (!label) break; // nothing worthwhile left to do
  }

  // Play an affordable shadow card, then (late) reset the counters to press anew.
  playShadow(s, cat, 1, logMsg);
  if (late) lateGameReset(s, logMsg);

  s.phase = 'StoryAdvance';
  log(s, 'phase', 'Sauron', `action step complete (${budget} actions)`);
  return s;
}

/** Score and execute the single most valuable Sauron action this step. An action
 *  covers a space on one of the three Lidless Eye Action Tracks (Place Influence,
 *  Draw, Command) — the covered space's DEGRADING yield (6/5/4, 2/2/1, 3/2/1)
 *  determines how much the action accomplishes, and tokens persist across steps
 *  until the 4th resets the Eye (rulebook pp.16–19). Returns a label for the
 *  action taken, or null if nothing worthwhile could be done. */
function eyeTakeBestAction(s: GameState, cat: Catalog, frac: number, logMsg: (m: string) => void): string | null {
  const plotLocs = new Set<LocationId>(
    (s.sauron.activePlots ?? []).map((p) => p.location).filter((l): l is LocationId => !!l),
  );
  const wounded = Object.entries(s.map.minionHealth ?? {}).some(([mid, hp]) => hp < (cat.minions[mid]?.health ?? 0));
  const minions = minionsInPlay(s);
  const monsters = Object.values(s.map.monstersAt).reduce((n, a) => n + a.length, 0);
  const activeHeroes = s.heroes.filter((h) => h.status === 'active').length;
  const hasPlot = plotLocs.size > 0;
  const flush = s.sauron.influence >= 6;
  const commandUrgency = wounded ? 100
    : (frac > 1 / 3 && (hasPlot || flush) && minions < 4) ? 70
    : monsters < Math.max(1, activeHeroes) ? 48
    : 50;

  // Score each Action Track; skip a full track (yield null). Higher = better.
  const tracks: { track: 'influence' | 'draw' | 'command'; score: number }[] = [
    { track: 'draw' as const, score: (frac < 0.5 ? 62 : 34) + (s.sauron.shadowHand.length < 2 ? 20 : 0) },
    { track: 'influence' as const, score: (frac < 2 / 3 ? 56 : 40) },
    { track: 'command' as const, score: commandUrgency },
  ].filter((t) => eyeTrackYield(s, t.track) !== null);
  tracks.sort((a, b) => b.score - a.score);

  for (const { track } of tracks) {
    const yld = eyePlaceToken(s, track, logMsg);
    if (yld == null) continue;
    switch (track) {
      case 'influence': {
        // Rulebook p.15-16: a Place Influence action yields `yld` tokens; Sauron
        // may bank UP TO TWO in the Shadow Pool (capped at 4× stage) and lays the
        // REST in extension of his Strongholds (on the board). Pool income is NOT
        // free — it costs this action, competing with Draw and Command.
        const stage = gameStage(s);
        const toPool = Math.max(0, Math.min(2, yld, 4 * stage - s.sauron.influence));
        s.sauron.influence += toPool;
        let placed = 0;
        for (let i = 0; i < yld - toPool; i++) if (eyePlaceInfluenceOnce(s, cat, placed === 0 ? logMsg : undefined)) placed++;
        logMsg(`Place Influence action (space ${yld}): banked ${toPool} to pool, laid ${placed} on board`);
        return `influence×${yld}`;
      }
      case 'draw': {
        drawShadow(s, cat, yld);
        drawPlots(s, cat, yld, logMsg);
        logMsg(`Draw action (space ${yld}): drew ${yld} Shadow & ${yld} Plot cards`);
        return `draw×${yld}`;
      }
      case 'command': {
        let done = 0;
        let spawnedThisAction = false;
        for (let i = 0; i < yld; i++) {
          if (wounded && healStrongestMinion(s, cat)) { done++; continue; }
          if (frac > 1 / 3 && minionsInPlay(s) < 4 && deployMinion(s, cat)) { done++; continue; }
          if (!spawnedThisAction && eyeSpawnMonsterOnce(s, cat, logMsg)) { spawnedThisAction = true; done++; continue; }
          if (moveOneMinion(s, cat, plotLocs) || moveOneMonster(s, cat)) { done++; continue; }
          break;
        }
        if (done === 0) continue; // nothing to command — try the next track
        logMsg(`Command Monsters & Minions action (space ${yld}): issued ${done} command(s)`);
        return `command×${yld}`;
      }
    }
  }
  return null;
}

/** Distance (edge count) from `from` to the nearest location in `targets`. */
function bfsDistance(cat: Catalog, from: LocationId, targets: Set<LocationId>): number {
  if (targets.has(from)) return 0;
  const seen = new Set<LocationId>([from]);
  let frontier: LocationId[] = [from];
  let dist = 0;
  while (frontier.length) {
    dist++;
    const next: LocationId[] = [];
    for (const node of frontier) {
      for (const e of cat.edges) {
        const nb = e.a === node ? e.b : e.b === node ? e.a : null;
        if (nb && !seen.has(nb)) {
          if (targets.has(nb)) return dist;
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return Infinity;
}

/** One command action: move the single minion closest to a plot marker one step
 *  closer (Black Serpent moves twice). Never moves a minion away from a plot.
 *  Falls back to pursuing the nearest hero when no plots are on the board. */
function moveOneMinion(s: GameState, cat: Catalog, plotLocs: Set<LocationId>): boolean {
  const at = s.map.minionsAt;
  if (!at) return false;
  for (const targets of eyeBlockTiers(s, cat, plotLocs)) {
    if (stepNearestFigureToward(s, cat, at, targets)) return true;
  }
  return false;
}

const neighborsOf = (cat: Catalog, loc: LocationId): LocationId[] => {
  const out: LocationId[] = [];
  for (const e of cat.edges) {
    if (e.a === loc) out.push(e.b);
    else if (e.b === loc) out.push(e.a);
  }
  return out;
};

/** The nodes the Eye most wants a figure to stand on, in priority order (each a
 *  target Set; only hero-free, non-Haven seats are offered). Heroes gain nothing
 *  from fighting foes and dodge them, so a figure only bites when it sits on a
 *  node the hero MUST reach or cross:
 *   1. active-plot locations a hero is ON or ADJACENT to — a figure there forces
 *      an ambush before the hero can destroy the plot (imminent defence);
 *   2. the remaining active-plot locations (hold the objective — "on the plot",
 *      the hero must come to the plot to break it, so this both defends AND baits);
 *   3. hero locations (pursue).
 *  NOTE: route-blocking (sitting on the hero's projected next step toward its
 *  nearest Haven) was tried and REMOVED: the MEQ board is biconnected (no
 *  topological cut vertices), and against a hero that fights through rather than
 *  detours it merely feeds figures to the hero (measured −5% Sauron win rate).
 *  It only bites a HUMAN who reroutes to dodge, so it is not modelled here. */
function eyeBlockTiers(s: GameState, cat: Catalog, plotLocs: Set<LocationId>): Set<LocationId>[] {
  const heroes = s.heroes.filter((h) => h.status === 'active');
  const heroFree = (loc: LocationId) => cat.locations[loc]?.kind !== 'haven' && !(s.map.heroesAt[loc]?.length);
  const urgentPlots = new Set<LocationId>();
  for (const p of plotLocs) {
    if (!heroFree(p)) continue;
    if (heroes.some((h) => h.location === p || neighborsOf(cat, h.location).includes(p))) urgentPlots.add(p);
  }
  const otherPlots = new Set<LocationId>([...plotLocs].filter((p) => heroFree(p) && !urgentPlots.has(p)));
  const heroLocs = new Set<LocationId>(heroes.map((h) => h.location));
  return [urgentPlots, otherPlots, heroLocs].filter((t) => t.size);
}

/** Move the single figure closest to any `target` one step nearer (a
 *  `minion-double-move` figure steps twice), never moving a figure already on a
 *  target. Works for minions (`s.map.minionsAt`) or monsters (`monstersAt`).
 *  Returns true if a figure moved. */
function stepNearestFigureToward(
  s: GameState, cat: Catalog, at: Record<LocationId, string[]>, targets: Set<LocationId>,
): boolean {
  if (!targets.size) return false;
  let best: { loc: LocationId; dist: number; str: number } | null = null;
  for (const [loc, figs] of Object.entries(at)) {
    if (!figs.length || targets.has(loc)) continue; // already on a target — hold
    const d = bfsDistance(cat, loc, targets);
    if (!Number.isFinite(d)) continue;
    const str = figs.reduce((m, id) => Math.max(m, cat.minions[id]?.strength ?? cat.monsters[id]?.strength ?? 0), 0);
    if (!best || d < best.dist || (d === best.dist && str > best.str)) best = { loc, dist: d, str };
  }
  if (!best) return false;
  const doubles = at[best.loc].some((id) => cat.minions[id]?.effectKey === 'minion-double-move');
  const hops = doubles ? 2 : 1;
  let cur = best.loc;
  let moved = false;
  for (let h = 0; h < hops; h++) {
    if (targets.has(cur)) break;
    const step = bfsFirstStep(cat, cur, targets);
    if (!step || step === cur) break;
    const moving = at[cur].slice();
    at[cur] = [];
    (at[step] ||= []).push(...moving);
    cur = step;
    moved = true;
  }
  if (moved) log(s, 'sauron-ai', 'Sauron', `command: moves figure to ${cur}`);
  return moved;
}

/** One command action: move a monster to block a chokepoint on a hero's route
 *  (or defend a plot / pursue a hero) — heroes avoid foes, so seating one on a
 *  node they cannot route around is what actually costs them a turn. */
function moveOneMonster(s: GameState, cat: Catalog): boolean {
  const plotLocs = new Set<LocationId>(
    (s.sauron.activePlots ?? []).map((p) => p.location).filter((l): l is LocationId => !!l),
  );
  for (const targets of eyeBlockTiers(s, cat, plotLocs)) {
    if (stepNearestFigureToward(s, cat, s.map.monstersAt, targets)) return true;
  }
  return false;
}

/** One command action: fully heal the strongest wounded minion (the Eye favors
 *  the strong). Returns false if no minion is wounded. */
function healStrongestMinion(s: GameState, cat: Catalog): boolean {
  const hp = s.map.minionHealth;
  if (!hp) return false;
  let target: { id: string; str: number } | null = null;
  for (const [loc, mins] of Object.entries(s.map.minionsAt ?? {})) {
    void loc;
    for (const mid of mins) {
      const cur = hp[mid];
      const full = cat.minions[mid]?.health ?? 0;
      if (cur === undefined || cur >= full) continue; // not wounded
      const str = cat.minions[mid]?.strength ?? 0;
      if (!target || str > target.str) target = { id: mid, str };
    }
  }
  if (!target) return false;
  const full = cat.minions[target.id]?.health ?? 0;
  const healed = Math.min(full, (hp[target.id] ?? full) + 4); // a monster command heals up to 4
  if (healed >= full) delete hp[target.id]; else hp[target.id] = healed;
  log(s, 'sauron-ai', 'Sauron', `command: heals ${cat.minions[target.id].name} (up to 4)`);
  return true;
}
/** First step along the shortest path from `from` to any location in `targets`. */
function bfsFirstStep(cat: Catalog, from: LocationId, targets: Set<LocationId>): LocationId | null {
  if (!targets.size) return null;
  const seen = new Set<LocationId>([from]);
  let frontier: { id: LocationId; first: LocationId | null }[] = [{ id: from, first: null }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (targets.has(node.id) && node.first) return node.first;
      for (const e of cat.edges) {
        const nb = e.a === node.id ? e.b : e.b === node.id ? e.a : null;
        if (nb && !seen.has(nb)) {
          seen.add(nb);
          next.push({ id: nb, first: node.first ?? nb });
        }
      }
    }
    frontier = next;
  }
  return null;
}

function runStoryAdvance(s: GameState, cat: Catalog): GameState {
  s = maybeBeginFinale(s, cat);
  // A contested Finale opens the single, decisive champion-vs-Ringwraiths combat
  // (manual step 6). Pause the turn machine and let that one combat play out; its
  // result — set in endCombat — adjudicates the whole game.
  if (s.pendingCombat) return s;
  const win = checkWin(s, cat);
  if (win) {
    s.winner = win.side; s.winReason = win.reason; s.phase = 'GameOver';
    log(s, 'game-over', win.side, win.reason);
    return s;
  }
  s.round += 1;
  s.story.turn += 1;
  s.activeSide = 'Hero';
  s.activeHeroIndex = 0;
  s.phase = 'HeroRefresh';
  log(s, 'phase', 'system', `round ${s.round} (story turn ${s.story.turn})`);
  return runHeroRefresh(s, cat);
}

export interface WinResult { side: 'Hero' | 'Sauron'; reason: string; }

/** The named minion flagged as the Finale foe (the Ringwraiths). */
function finaleMinionId(cat: Catalog): string | null {
  return Object.values(cat.minions).find((m) => m.finale)?.id ?? null;
}


/** The dominant side = the one nearer its win condition (fewer steps to goal).
 *  Heroes advance the hero clock toward the Finale (`sauronProgress`→`length`);
 *  Sauron advances his lead colored marker toward stage III. On a tie there is
 *  no dominant side (manual). */
function dominantSide(s: GameState): Side | null {
  // Manual (p.14): compare "spaces to goal". Heroes = spaces from their (green)
  // marker to the Finale. Sauron uses the LOWER of: his closest colored marker's
  // distance to the Finale, or the cumulative distance of all three markers to
  // The Shadow Falls. The side with fewer spaces is dominant; a tie = neither.
  const heroSpaces = Math.max(0, s.story.length - s.story.sauronProgress);
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  const closestToFinale = STORY_FINALE - Math.max(st.yellow, st.red, st.black);
  const cumulativeToFalls = [st.yellow, st.red, st.black]
    .reduce((n, m) => n + Math.max(0, SHADOW_FALLS - m), 0);
  const sauronSpaces = Math.min(closestToFinale, cumulativeToFalls);
  if (heroSpaces < sauronSpaces) return 'Hero';
  if (sauronSpaces < heroSpaces) return 'Sauron';
  return null;
}

/** Draw up to `n` cards from the CURRENT stage's Event deck (events carry a
 *  `turn` field = stage 1/2/3), reshuffling the discard back in when the deck
 *  runs dry. When the game stage advances, the stage's fresh 14-card deck is
 *  loaded. Returns the EventCard objects. */
function drawEventCards(s: GameState, cat: Catalog, n: number): EventCard[] {
  const out: EventCard[] = [];
  const stage = gameStage(s);
  if (s.sauron.eventStage !== stage) {
    s.sauron.eventStage = stage;
    s.sauron.eventDeck = shuffle(s, cat.events.filter((e) => Number(e.turn) === stage).map((e) => e.id));
    s.sauron.eventDiscard = [];
  }
  s.sauron.eventDeck ||= [];
  s.sauron.eventDiscard ||= [];
  for (let i = 0; i < n; i++) {
    if (!s.sauron.eventDeck.length) {
      if (!s.sauron.eventDiscard.length) break;
      s.sauron.eventDeck = shuffle(s, s.sauron.eventDiscard);
      s.sauron.eventDiscard = [];
    }
    const id = s.sauron.eventDeck.shift()!;
    const card = cat.events.find((e) => e.id === id);
    if (card) out.push(card);
  }
  return out;
}

/** The Finale begins when any story marker reaches the Finale space, or all
 *  three Sauron markers reach The Shadow Falls (the midpoint). Returns which
 *  side reached the end first (drives adjudication), or null. */
function finaleTriggered(s: GameState): 'Hero' | 'Sauron' | null {
  const st = s.story.sauron;
  if (s.story.sauronProgress >= s.story.length) return 'Hero';
  if (st) {
    if (st.yellow >= STORY_FINALE || st.red >= STORY_FINALE || st.black >= STORY_FINALE) return 'Sauron';
    if (st.yellow >= SHADOW_FALLS && st.red >= SHADOW_FALLS && st.black >= SHADOW_FALLS) return 'Sauron';
  }
  return null;
}

/** Begin the Finale (manual pp.33–34). Step 1 (Check for Immediate Victory)
 *  runs first: the dominant side wins outright — with NO Ringwraith combat — if
 *  it holds its secret mission; when neither side is dominant (both markers
 *  reached together), the sole side fulfilling its mission wins outright. Only a
 *  contested result (dominant side's mission unmet, or both/neither fulfilling
 *  when tied) falls through to steps 2–7: the Ringwraith last-stand combat, whose
 *  difficulty is shifted by mission-driven marker advances (step 2) and dominance
 *  (step 4). */
function maybeBeginFinale(s: GameState, cat: Catalog): GameState {
  if (s.story.finale) return s;
  const trigger = finaleTriggered(s);
  if (!trigger) return s;
  s.story.finaleTrigger = trigger;
  s.story.finale = true;

  const heroMissionId = s.secretHeroMission ?? cat.scenario.heroMission;
  const sauronMissionId = s.secretSauronMission ?? cat.scenario.sauronMission;
  const heroMission = cat.heroMissions[heroMissionId];
  const sauronMission = cat.sauronMissions[sauronMissionId];
  const heroMet = evalMission(heroMission?.condition, s, cat);
  const sauronMet = evalMission(sauronMission?.condition, s, cat);
  const dom = dominantSide(s);

  // --- Finale Step 1: Check for Immediate Victory (no combat) ---
  if (dom === 'Hero') {
    if (heroMet) {
      s.story.finaleWinner = 'Hero';
      s.story.finaleWinnerReason = `Finale: heroes are dominant and fulfilled ${heroMission?.name ?? 'their mission'} — immediate victory`;
      log(s, 'finale', 'Hero', s.story.finaleWinnerReason);
      return s;
    }
  } else if (dom === 'Sauron') {
    if (sauronMet) {
      s.story.finaleWinner = 'Sauron';
      s.story.finaleWinnerReason = `Finale: Sauron is dominant and fulfilled ${sauronMission?.name ?? 'his mission'} — immediate victory`;
      log(s, 'finale', 'Sauron', s.story.finaleWinnerReason);
      return s;
    }
  } else {
    // Neither dominant (both reached the Finale together): the SOLE side that
    // fulfills its mission wins outright; both/neither → proceed to combat.
    if (heroMet && !sauronMet) {
      s.story.finaleWinner = 'Hero';
      s.story.finaleWinnerReason = `Finale: markers tied but only the heroes fulfilled ${heroMission?.name ?? 'their mission'} — immediate victory`;
      log(s, 'finale', 'Hero', s.story.finaleWinnerReason);
      return s;
    }
    if (sauronMet && !heroMet) {
      s.story.finaleWinner = 'Sauron';
      s.story.finaleWinnerReason = `Finale: markers tied but only Sauron fulfilled ${sauronMission?.name ?? 'his mission'} — immediate victory`;
      log(s, 'finale', 'Sauron', s.story.finaleWinnerReason);
      return s;
    }
  }

  // --- Contested: set up the Ringwraith last stand (steps 2–7) ---
  const wraithId = finaleMinionId(cat);
  if (!wraithId) {
    // No Ringwraith defined: fall back to a mission adjudication so the game
    // still resolves (dominant side, else the Shadow).
    s.story.finaleWinner = dom === 'Hero' ? 'Hero' : dom === 'Sauron' ? 'Sauron' : (heroMet && !sauronMet ? 'Hero' : 'Sauron');
    s.story.finaleWinnerReason = 'Finale resolved by mission (no Ringwraith champion defined)';
    return s;
  }

  // Finale Step 2 — Advance Story Markers by fulfilled missions (affects the
  // difficulty distances computed below). A marker on the Finale space stays.
  if (sauronMet && s.story.sauron) {
    s.story.sauron.yellow = Math.min(STORY_FINALE, s.story.sauron.yellow + 1);
    s.story.sauron.red = Math.min(STORY_FINALE, s.story.sauron.red + 1);
    s.story.sauron.black = Math.min(STORY_FINALE, s.story.sauron.black + 1);
  }
  if (heroMet) s.story.sauronProgress = Math.min(s.story.length, s.story.sauronProgress + 1);

  const wraith = cat.minions[wraithId];
  // Finale step 4 — Adjust Difficulty (manual p.34). If one side is dominant,
  // the Ringwraiths' health AND fortitude shift by the same amount:
  //  · Sauron dominant  → +(spaces the hero marker is from the Finale).
  //  · Heroes dominant  → −min(a,b): a = spaces Sauron's lead marker is from the
  //    Finale; b = cumulative spaces his REMAINING markers need to reach Shadow Falls.
  const st = s.story.sauron ?? { yellow: 0, red: 0, black: 0 };
  let mod = 0;
  if (dom === 'Sauron') {
    mod = Math.max(0, s.story.length - s.story.sauronProgress);
  } else if (dom === 'Hero') {
    const markers = [st.yellow, st.red, st.black];
    const lead = Math.max(...markers);
    const a = STORY_FINALE - lead;
    const li = markers.indexOf(lead);
    const b = markers.filter((_, i) => i !== li).reduce((n, m) => n + Math.max(0, SHADOW_FALLS - m), 0);
    mod = -Math.min(a, b);
  }
  s.sauron.finaleWraithHealth = Math.max(1, wraith.health + mod);
  s.sauron.finaleWraithFortitude = Math.max(1, wraith.fortitude + mod);
  // Finale step 3 — Prepare: each hero reshuffles and draws to fortitude BEFORE
  // the champion is chosen (so the choice can weigh the drawn hand).
  for (const h of s.heroes) {
    if (h.status === 'active') prepareHeroForFinale(s, h, cat.heroes[h.id].fortitude + (h.statBonus?.fortitude ?? 0));
  }
  // Finale step 5 — Choose Champion: the heroes pick who fights the Ringwraiths.
  // Per the manual's advice, choose the hero with the strongest drawn hand
  // (total printed attack + defense of the combat cards now in hand).
  const handPower = (h: HeroState): number =>
    h.hand.reduce((n, id) => n + (cat.combatCards[id]?.attack ?? 0) + (cat.combatCards[id]?.defense ?? 0), 0);
  const champion = s.heroes.filter((h) => h.status === 'active')
    .sort((a, b) => handPower(b) - handPower(a))[0] ?? s.heroes[0];
  (s.map.minionsAt ||= {});
  // Finale step 3 (Prepare): the Ringwraiths may already be on the board as a
  // normal stage-II/III minion. Strip any existing figures and all prior damage
  // before seating one fresh champion at the chosen hero's location.
  for (const arr of Object.values(s.map.minionsAt)) {
    let i: number;
    while ((i = arr.indexOf(wraithId)) >= 0) arr.splice(i, 1);
  }
  if (s.map.minionHealth) delete s.map.minionHealth[wraithId];
  if (s.map.minionReturnPending) s.map.minionReturnPending = s.map.minionReturnPending.filter((m) => m !== wraithId);
  (s.map.minionsAt[champion.location] ||= []).push(wraithId);
  const sauronMissions = Object.keys(cat.sauronMissions);
  const drawn = [sauronMissions[s.story.turn % sauronMissions.length], sauronMissions[(s.story.turn + 1) % sauronMissions.length]];
  log(s, 'finale', 'Sauron', `Finale contested (${trigger} reached the end, ${dom ?? 'neither'} dominant): ${wraith.name} (health ${s.sauron.finaleWraithHealth}, fortitude ${s.sauron.finaleWraithFortitude}, mod ${mod >= 0 ? '+' : ''}${mod}) vs champion ${cat.heroes[champion.id].name} at ${champion.location}; Sauron reveals ${drawn.join(', ')}. The final battle begins.`);
  // Finale step 6 — Combat: open the SINGLE, decisive battle immediately (manual
  // p.33: "players no longer take normal turns"). endCombat adjudicates the game
  // from its outcome — Ringwraiths destroyed → heroes win, else Sauron wins.
  s.story.finaleCombat = true;
  return beginCombat(s, cat, champion.id, wraithId, champion.location);
}

export function checkWin(s: GameState, _cat: Catalog): WinResult | null {
  const heroesAlive = s.heroes.some((h) => h.status === 'active');
  if (!heroesAlive) return { side: 'Sauron', reason: 'all heroes lost' };

  if (!s.story.finale) return null; // nothing is decided until the Finale begins

  // The Finale is decided either by an immediate victory (step 1) or by the
  // single champion-vs-Ringwraiths combat (steps 6–7), whose result endCombat
  // records in finaleWinner. While that combat is still pending, nothing yet.
  if (s.story.finaleWinner) {
    return { side: s.story.finaleWinner, reason: s.story.finaleWinnerReason ?? 'Finale resolved by immediate victory' };
  }
  return null;
}

/** Advance the phase machine one step. Never advances through an interactive
 *  HeroActions step or while a choice/combat is pending. */
export function advance(state: GameState, cat: Catalog): GameState {
  if (state.pendingChoice || state.pendingCombat || state.pendingTree) return state;
  // A human Sauron drives their own turn via the sauronPlay functions; the phase
  // machine must not auto-run the Lidless Eye on their behalf.
  if (state.humanSide === 'Sauron' && state.activeSide === 'Sauron' && state.phase !== 'GameOver') {
    return state;
  }
  const s = clone(state);
  switch (s.phase) {
    case 'HeroRefresh': return runHeroRefresh(s, cat);
    case 'HeroActions': return s;                     // interactive; caller drives
    case 'SauronRefresh': return runSauronRefresh(s, cat);
    case 'SauronEvents': return runSauronEvents(s, cat);
    case 'SauronMinions': return runSauronMinions(s, cat);
    case 'StoryAdvance': return runStoryAdvance(s, cat);
    case 'GameOver': return s;
    default: return s;
  }
}

// ---------------- Interactive Sauron turn (human plays Sauron) ----------------
// A human Sauron steps their own turn: Story Step → Plot Step → Event Step →
// Action Step → end (Hero Draw + Story Advance run inside runStoryAdvance).

/** Story Step: advance the dark story clock and move to the Plot/Event phase. */
export function sauronStoryStep(state: GameState, cat: Catalog): GameState {
  if (state.phase !== 'SauronRefresh') return state;
  return runSauronRefresh(clone(state), cat);
}

/** Resolve the Event Step (after the human has taken their Plot Step) and set up
 *  the interactive Action Step. */
export function sauronResolveEvents(state: GameState, cat: Catalog): GameState {
  if (state.phase !== 'SauronEvents') return state;
  return runSauronEvents(clone(state), cat);
}

/** End the Action Step: run the Hero Draw Step + Story Advance, returning control
 *  to the (AI-driven) heroes. */
export function sauronEndActionStep(state: GameState, cat: Catalog): GameState {
  if (state.phase !== 'SauronMinions') return state;
  const s = clone(state);
  s.sauronActionsLeft = undefined;
  s.sauronPending = undefined;
  s.phase = 'StoryAdvance';
  return runStoryAdvance(s, cat);
}
