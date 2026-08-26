// M10 — the hero economy (the Explore actions of the Travel step + the Rest
// step's corruption cleanse). Each interaction costs one hero action, matching
// the engine's action-budget model. See docs/rules-digest.md §B and the owner's
// player aid ("Explore: retrieve favor, consult characters, dark path, complete
// quest, discard plot, trade with heroes").
import type { Catalog, GameState, HeroId, HeroState, LocationId } from './types';
import { clone, ambushPending } from './mechanics';
import { log } from './log';
import { adjacentLocations } from './sauronPlay';
import { revealMonsters } from './encounter';
import { completeCurrentQuest, questTaskReadyHere } from './quests';
import {
  gainCorruption, cleanseAtRest, corruptionBlocksSocial, grantFavor,
} from './corruption';

function requireHeroTurn(state: GameState, heroId: HeroId): HeroState {
  if (state.phase !== 'HeroActions') throw new Error(`Not HeroActions phase (${state.phase})`);
  const hero = state.heroes[state.activeHeroIndex];
  if (hero.id !== heroId) throw new Error(`Not ${heroId}'s turn`);
  if (hero.actionsRemaining <= 0) throw new Error(`${heroId} has no actions left`);
  if (ambushPending(state, hero)) throw new Error('Ambush: fight the foe here before exploring');
  return hero;
}

function heroAt(state: GameState, heroId: HeroId): HeroState {
  return state.heroes.find((h) => h.id === heroId)!;
}

// ---------------- availability predicates (for the UI) ----------------

export function favorHere(state: GameState, heroId: HeroId): number {
  const h = heroAt(state, heroId);
  return state.map.favorAt?.[h.location] ?? 0;
}

export function charactersHere(state: GameState, heroId: HeroId): string[] {
  const h = heroAt(state, heroId);
  return state.map.charactersAt?.[h.location] ?? [];
}

/** The plot a hero can counter at their location: an active plot whose marker
 *  sits here (or any active plot, for off-board plots, when on a plot slot). */
export function plotHere(state: GameState, cat: Catalog, heroId: HeroId): boolean {
  return targetablePlot(state, cat, heroId) !== undefined;
}

/** Whether the active hero may complete a Quest here: he stands on the Explore
 *  location of one of his pending quests. */
export function canCompleteQuest(state: GameState, cat: Catalog, heroId: HeroId): boolean {
  return questTaskReadyHere(state, cat, heroId);
}

/** Pick the active plot this hero may counter: one placed at their location if
 *  any, else — when standing on a plot slot — an off-board plot. */
export function targetablePlot(state: GameState, cat: Catalog, heroId: HeroId) {
  const h = heroAt(state, heroId);
  const active = state.sauron.activePlots ?? [];
  const here = active.filter((e) => e.location === h.location);
  if (here.length) return here[0];
  const loc = cat.locations[h.location];
  if (loc?.plotSlot) return active.find((e) => !e.location);
  return undefined;
}

export const PLOT_DISCARD_COST = 2;
export const CLEANSE_COST = 2;

/** Favor cost to counter the plot the hero would target here (undefined if none). */
export function plotCounterCost(state: GameState, cat: Catalog, heroId: HeroId): number | undefined {
  const target = targetablePlot(state, cat, heroId);
  if (!target) return undefined;
  const plot = cat.plots.find((p) => p.id === target.eventId);
  return plot?.favorToCounter ?? PLOT_DISCARD_COST;
}

/** Whether the hero can actually counter a plot here right now (a plot is
 *  targetable AND the hero holds enough favor). Used to gate the UI so the
 *  action is only offered when it is legal. */
export function canDiscardPlot(state: GameState, cat: Catalog, heroId: HeroId): boolean {
  const cost = plotCounterCost(state, cat, heroId);
  if (cost === undefined) return false;
  return heroAt(state, heroId).favor >= cost;
}

export function canDarkPath(state: GameState, heroId: HeroId): boolean {
  const h = heroAt(state, heroId);
  return h.corruption <= 3 && !h.darkPathUsedThisTurn;
}

export function canCleanse(state: GameState, cat: Catalog, heroId: HeroId): boolean {
  const h = heroAt(state, heroId);
  const held = h.corruptionCards ?? [];
  if (cat.locations[h.location]?.kind !== 'haven') return false;
  if (held.length) {
    // Faithful: cleanse costs the printed favor cost of a held card.
    return held.some((id) => h.favor >= (parseInt(cat.corruption[id]?.cost ?? '0', 10) || 0));
  }
  // Legacy numeric-only state: fall back to the flat cost.
  return h.corruption > 0 && h.favor >= CLEANSE_COST;
}

export function otherHeroesHere(state: GameState, heroId: HeroId): HeroState[] {
  const h = heroAt(state, heroId);
  return state.heroes.filter((o) => o.id !== heroId && o.status === 'active' && o.location === h.location);
}

// ---------------- actions ----------------

/** Dark path: gain 1 favor and 1 corruption. Manual: only when the hero has
 *  3 or fewer corruption, and at most once per hero turn. */
export function heroDarkPath(state: GameState, cat: Catalog, heroId: HeroId): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  if (hero.corruption > 3) throw new Error('Dark path needs 3 or fewer corruption');
  if (hero.darkPathUsedThisTurn) throw new Error('Dark path already taken this turn');
  grantFavor(cat, hero, 1);
  const tag = gainCorruption(s, cat, heroId, 1);
  hero.darkPathUsedThisTurn = true;
  log(s, 'hero-dark-path', heroId, `dark path: favor ${hero.favor}, ${tag}`, { favor: hero.favor, corruption: hero.corruption });
  return s;
}

/** Retrieve favor: take the favor token(s) on the hero's location. */
export function heroRetrieveFavor(state: GameState, cat: Catalog, heroId: HeroId): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  const n = s.map.favorAt?.[hero.location] ?? 0;
  if (n <= 0) throw new Error('No favor to retrieve here');
  grantFavor(cat, hero, n);
  s.map.favorAt![hero.location] = 0;
  log(s, 'hero-favor', heroId, `retrieved ${n} favor (total ${hero.favor})`);
  return s;
}

/** Consult a Character present at the hero's location. The manual: the hero
 *  gains **one favor OR the character's ability, but not both** (page 2). We
 *  model "ability" as recruiting the Character as an ally. The player chooses. */
/** Active-plot targets that corrupt a hero who consults a specific Character
 *  (manual plot text). Keyed by plot id → the Character token name. */
const CONSULT_CORRUPTION_PLOTS: Record<string, string> = {
  'a-dark-messenger': 'Dain II',
  'saruman-falls-to-corruption': 'Saruman',
  'wormtongue-taints-theoden': 'Theoden',
  'denethor-falls-into-madness': 'Denethor',
};

export function heroConsultCharacter(
  state: GameState, cat: Catalog, heroId: HeroId, character: string, choice: 'favor' | 'ability' = 'favor',
): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  if (corruptionBlocksSocial(cat, hero)) throw new Error('Isolated: this hero may not consult characters');
  const here = s.map.charactersAt?.[hero.location] ?? [];
  const idx = here.indexOf(character);
  if (idx < 0) throw new Error(`${character} is not here`);
  here.splice(idx, 1); // the character always leaves the board once consulted
  if (choice === 'ability') {
    (hero.allies ||= []).push(character);
    log(s, 'hero-consult', heroId, `consulted ${character} for their ability (ally)`, { character, choice });
  } else {
    grantFavor(cat, hero, 2);
    log(s, 'hero-consult', heroId, `consulted ${character} for 2 favor (total ${hero.favor})`, { character, choice });
  }
  if (hero.id === 'eleanor' && !hero.abilityUsedThisTurn) {
    hero.abilityUsedThisTurn = true; grantFavor(cat, hero, 1);
    log(s, 'hero-ability', heroId, 'Eleanor: +1 favor for consulting a character');
  }
  // Corruption plots: consulting the tainted Character while its plot is active
  // gives the hero 1 Corruption (A Dark Messenger, Saruman/Wormtongue/Denethor).
  const active = new Set((s.sauron.activePlots ?? []).map((p) => p.eventId));
  for (const [plotId, tainted] of Object.entries(CONSULT_CORRUPTION_PLOTS)) {
    if (active.has(plotId) && character === tainted) {
      gainCorruption(s, cat, heroId, 1);
      log(s, 'plot-effect', heroId, `${tainted} is corrupted (${plotId}): hero gains 1 Corruption`);
      break;
    }
  }
  return s;
}

/** Complete a quest (manual action): fulfill the hero's current pending Quest —
 *  Starting first, then the revealed Advanced — applying its real reward and
 *  revealing the Advanced Quest (rulebook p.22). Completion also happens
 *  automatically during the Explore/Encounter step and on defeating a Defeat-
 *  quest foe; this action lets the player claim it explicitly. */
export function heroCompleteQuest(state: GameState, cat: Catalog, heroId: HeroId): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  const done = completeCurrentQuest(s, cat, hero);
  if (!done) throw new Error('No pending quest to complete');
  return s;
}

/** Discard a Sauron plot: at a plot's location (or a plot slot for off-board
 *  plots), pay that plot's counter cost in favor to remove it from play — its
 *  scroll value (favorToCounter). Counters marker pressure toward Sauron. */
export function heroDiscardPlot(state: GameState, cat: Catalog, heroId: HeroId): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  const target = targetablePlot(s, cat, heroId);
  if (!target) throw new Error('No plot to discard here');
  const plot = cat.plots.find((p) => p.id === target.eventId);
  const cost = plot?.favorToCounter ?? PLOT_DISCARD_COST;
  if (hero.favor < cost) throw new Error(`Need ${cost} favor to counter ${plot?.name ?? target.eventId}`);
  hero.favor -= cost;
  s.sauron.activePlots = (s.sauron.activePlots ?? []).filter((e) => e !== target);
  log(s, 'hero-discard-plot', heroId, `countered plot ${plot?.name ?? target.eventId} (paid ${cost} favor, ${hero.favor} left)`);
  return s;
}

/** Trade favor between two heroes at the active hero's location. Rulebook p.24:
 *  "All heroes in the current hero's location may freely trade favor, Item cards,
 *  and Quests with each other" — so the giver need NOT be the active hero (the
 *  canonical example is Beravor freely giving her favor to Argalad, who is the one
 *  taking his turn). Both participants must share the active hero's location. */
export function heroTradeFavor(state: GameState, cat: Catalog, fromId: HeroId, toId: HeroId, n: number): GameState {
  const s = clone(state);
  if (s.phase !== 'HeroActions') throw new Error(`Not HeroActions phase (${s.phase})`);
  const active = s.heroes[s.activeHeroIndex];
  const from = heroAt(s, fromId);
  const to = heroAt(s, toId);
  if (from.location !== active.location || to.location !== active.location) {
    throw new Error("Heroes must be at the active hero's location to trade");
  }
  if (corruptionBlocksSocial(cat, from)) throw new Error('Isolated: this hero may not trade with heroes');
  const amt = Math.min(n, from.favor);
  if (amt <= 0) throw new Error('No favor to trade');
  from.favor -= amt;
  grantFavor(cat, to, amt);
  log(s, 'hero-trade', fromId, `traded ${amt} favor to ${toId}`);
  return s;
}

/** Trade an item between two heroes at the active hero's location (see
 *  heroTradeFavor for the rulebook basis — any co-located hero may give). */
export function heroTradeItem(state: GameState, cat: Catalog, fromId: HeroId, toId: HeroId, item: string): GameState {
  const s = clone(state);
  if (s.phase !== 'HeroActions') throw new Error(`Not HeroActions phase (${s.phase})`);
  const active = s.heroes[s.activeHeroIndex];
  const from = heroAt(s, fromId);
  const to = heroAt(s, toId);
  if (from.location !== active.location || to.location !== active.location) {
    throw new Error("Heroes must be at the active hero's location to trade");
  }
  if (corruptionBlocksSocial(cat, from)) throw new Error('Isolated: this hero may not trade with heroes');
  const idx = from.items.indexOf(item);
  if (idx < 0) throw new Error(`${fromId} has no ${item}`);
  // One-of-each-title rule (p.26): don't hand over a duplicate the recipient holds.
  if (to.items.includes(item)) throw new Error(`${toId} already has ${item}`);
  from.items.splice(idx, 1);
  to.items.push(item);
  log(s, 'hero-trade', fromId, `gave ${item} to ${toId}`);
  return s;
}

/** Cleanse: at a haven, pay favor to discard one Corruption card. */
export function heroCleanseCorruption(state: GameState, cat: Catalog, heroId: HeroId): GameState {
  const s = clone(state);
  const hero = requireHeroTurn(s, heroId);
  if (!canCleanse(s, cat, heroId)) throw new Error('Cannot cleanse corruption here');
  if (hero.corruptionCards?.length) {
    const removed = cleanseAtRest(s, cat, heroId);
    if (!removed) throw new Error('Cannot afford to cleanse any held Corruption card');
    log(s, 'hero-cleanse', heroId, `cleansed ${cat.corruption[removed]?.name ?? removed} (favor ${hero.favor})`);
  } else {
    // Legacy numeric-only fallback.
    hero.favor -= CLEANSE_COST;
    hero.corruption = Math.max(0, hero.corruption - 1);
    log(s, 'hero-cleanse', heroId, `cleansed 1 corruption (${hero.corruption} left, favor ${hero.favor})`);
  }
  return s;
}

/** Place a favor token on a location (used by events / setup helpers). */
export function placeFavorToken(state: GameState, loc: LocationId, n: number): void {
  (state.map.favorAt ||= {});
  state.map.favorAt[loc] = (state.map.favorAt[loc] ?? 0) + n;
}

/** Adjacent locations with unrevealed monster tokens — the legal targets of
 *  Argalad's Survivalist ability. */
function surveyTargets(state: GameState, cat: Catalog, from: LocationId): LocationId[] {
  const revealed = new Set(state.map.revealedMonstersAt ?? []);
  return adjacentLocations(cat, from).filter(
    (loc) => ((state.map.monstersAt[loc]?.length ?? 0) > 0 || (state.map.rumorsAt?.[loc] ?? 0) > 0)
      && !revealed.has(loc));
}

/** UI predicate: can the active hero use Argalad's Survivalist right now? */
export function canSurvey(state: GameState, cat: Catalog, heroId: HeroId): boolean {
  if (state.phase !== 'HeroActions' || state.pendingChoice || state.pendingCombat) return false;
  const hero = state.heroes[state.activeHeroIndex];
  if (hero.id !== heroId || heroId !== 'argalad' || hero.abilityUsedThisTurn) return false;
  return surveyTargets(state, cat, hero.location).length > 0;
}

/** Argalad's "Survivalist": once per turn, look at the faces of all monster
 *  tokens in an adjacent location. Free (costs no action). If several adjacent
 *  locations hold tokens the player picks one via a pending choice. */
export function heroSurvey(state: GameState, cat: Catalog, heroId: HeroId): GameState {
  const s = clone(state);
  const hero = s.heroes[s.activeHeroIndex];
  if (hero.id !== heroId || heroId !== 'argalad') throw new Error('Not Argalad');
  if (hero.abilityUsedThisTurn) throw new Error('Survivalist already used this turn');
  const targets = surveyTargets(s, cat, hero.location);
  if (!targets.length) throw new Error('No adjacent monster tokens to survey');
  hero.abilityUsedThisTurn = true;
  if (targets.length === 1) {
    revealMonsters(s, targets);
    log(s, 'hero-ability', heroId, `Survivalist: examined the monster tokens in ${cat.locations[targets[0]]?.name ?? targets[0]}`);
    return s;
  }
  s.pendingChoice = {
    id: 'survey', seat: s.activeHeroIndex, kind: 'survey',
    prompt: 'Survivalist — look at the monster tokens in an adjacent location:',
    options: targets.map((loc) => ({
      id: `survey:${loc}`,
      label: `${cat.locations[loc]?.name ?? loc} (${(s.map.monstersAt[loc]?.length ?? 0) + (s.map.rumorsAt?.[loc] ?? 0)})`,
    })),
  };
  return s;
}

/** Apply a resolved Survivalist pending choice (reveal the chosen location). */
export function resolveSurveyChoice(s: GameState, cat: Catalog, optionId: string): void {
  const loc = optionId.slice('survey:'.length);
  revealMonsters(s, [loc]);
  log(s, 'hero-ability', 'argalad', `Survivalist: examined the monster tokens in ${cat.locations[loc]?.name ?? loc}`);
}

