// Build the initial GameState from the catalog. Deterministic given seed.
import type { Catalog, GameState, HeroState, HeroId, MapState } from './types';
import { placeCharacterUnique } from './characters';
import { shuffle, nextInt } from './rng';
import { drawInto, gameStage } from './mechanics';
import { log } from './log';
import { locByName, registerQuestCombat, questTargetLocation } from './quests';
import { drawShadow, keepBestPlots } from './sauronmech';

export const HERO_HAND_SIZE = 5;
/** The hero turn is NOT metered by a fixed number of actions (rulebook pp.20–24):
 *  the Travel step repeats as many times as the hero wishes or is able (limited
 *  only by the Hero cards in hand or defeat), and Explore sub-activities are
 *  free. `actionsRemaining` is therefore a binary "turn active" gate: 1 while the
 *  hero's turn is ongoing, set to 0 by a turn-ender (failed Travel combat,
 *  defeat, the end-of-turn Encounter, or the player ending the turn). */
export const HERO_ACTIONS = 1;

/** Deterministically pick one id from a list using the seed cursor. */
function pick(state: GameState, ids: string[]): string {
  const n = ids.length;
  const i = (((state.rngCursor % n) + n) % n);
  state.rngCursor = (state.rngCursor * 1103515245 + 12345) | 0;
  return ids[i];
}

/** Pick the seat heroes (default: first `seats` from the catalog roster order). */
export function newGame(cat: Catalog, seed: number, heroIds?: HeroId[], humanSide: 'Hero' | 'Sauron' = 'Hero'): GameState {
  const roster = heroIds && heroIds.length ? heroIds : Object.keys(cat.heroes).slice(0, 2);

  const state: GameState = {
    seed, rngCursor: seed | 0,
    round: 1, phase: 'HeroRefresh',
    activeSide: 'Hero', activeHeroIndex: 0, humanSide,
    heroes: [], sauron: {
      influence: cat.scenario.setup.sauronInfluence,
      location: cat.scenario.setup.sauronStartLocation,
      doctrine: 'tempo',
      activeEvents: [], markers: { corruptionSpread: 0 },
      locationInfluence: {}, heroIntel: {},
      shadowHand: [], shadowDiscard: [], plotTrack: {}, activePlots: [],
      plotDeck: [], plotHand: [], plotDiscard: [],
      eventDeck: [], eventDiscard: [],
    },
    map: { heroesAt: {}, monstersAt: {}, minionsAt: {}, favorAt: {}, charactersAt: {}, questAt: {} } as MapState,
    story: {
      turn: 1, length: cat.scenario.storyTrackLength, sauronProgress: 0,
      sauron: { yellow: 0, red: 0, black: 0 }, finale: false,
    },
    pendingCombat: null, pendingChoice: null,
    pendingEncounter: null, explored: {},
    log: [], winner: null, winReason: '',
    catalogRef: cat.version,
  };

  // The hidden hero + Sauron missions chosen at setup — the difference in the
  // initial objective each side plays toward (public info would spoil it).
  const heroMissionIds = Object.keys(cat.heroMissions);
  const sauronMissionIds = Object.keys(cat.sauronMissions);
  state.secretHeroMission = heroMissionIds.length
    ? pick(state, heroMissionIds) : cat.scenario.heroMission;
  state.secretSauronMission = sauronMissionIds.length
    ? pick(state, sauronMissionIds) : cat.scenario.sauronMission;

  // The Event deck is loaded per game stage on first draw (stage 1 → 3), so no
  // fixed shuffle is needed here.

  // The shared Skill deck (rulebook p.26): all `deck:"skills"` combat cards,
  // shuffled once. Training draws from here (draw 2, keep 1).
  const skillIds = Object.values(cat.combatCards)
    .filter((c) => c.deck === 'skills')
    .map((c) => c.id);
  state.skillDeck = shuffle(state, skillIds);
  state.skillDiscard = [];

  // The shared Corruption deck (rulebook p.26), shuffled once at setup.
  state.corruptionDeck = shuffle(state, Object.keys(cat.corruption));
  state.corruptionDiscard = [];

  roster.forEach((hid, seat) => {
    const h = cat.heroes[hid];
    const deck = shuffle(state, cat.decks[h.deck]);
    const hero: HeroState = {
      id: hid, seat, location: h.startLocation,
      life: deck.length, corruption: 0, corruptionCards: [], favor: 0,
      deck, hand: [], discard: [], damagePool: [], actionsRemaining: HERO_ACTIONS, status: 'active',
      items: [...(h.startItems ?? [])], training: 0, trainedCount: 0, statBonus: {},
      allies: [], quests: { startingDone: false, advancedDone: false },
    };
    // Setup starting hand (rulebook p.10): each hero draws `fortitude` cards. The
    // flag makes the hero's FIRST Hero Refresh skip its Draw step so this hand is
    // not double-dealt on turn 1.
    drawInto(state, hero.deck, hero.hand, hero.discard, h.fortitude);
    hero.startingHandReady = true;
    hero.life = hero.deck.length;
    state.heroes.push(hero);
    (state.map.heroesAt[h.startLocation] ||= []).push(hid);
    assignStartingQuest(state, cat, hero);
    // Public recap of this hero's opening hand (the hero player's own cards).
    const handNames = hero.hand.map((cid) => cat.combatCards[cid]?.name ?? cid);
    log(state, 'setup', hid,
      `${h.name} starts at ${cat.locations[h.startLocation]?.name ?? h.startLocation} with ${hero.hand.length} cards: ${handNames.join(', ')}`);
  });

  // Sauron's two starting lieutenants sit on the board at their designated
  // locations (the rest of the minions enter play via Sauron actions). NB: no
  // monster tokens are placed at setup — per the rulebook, monsters only enter
  // via Sauron's Command actions onto influenced locations.
  placeStartingMinions(state, cat);
  seedStartingPlot(state, cat);
  seedSauronHands(state, cat);

  log(state, 'setup', 'system',
    `New game: heroes=[${roster.join(', ')}] seed=${seed} storyLen=${state.story.length}`);
  return state;
}

/** Each hero randomly draws one of his two Starting Quests, follows its Setup
 *  instructions (e.g. placing a Character on the board), and receives — but does
 *  not yet unlock — his Advanced Quest (rulebook p.8, "Set up Starting Quests"). */
function assignStartingQuest(state: GameState, cat: Catalog, hero: HeroState): void {
  const starting = Object.values(cat.quests ?? {}).filter((q) => q.hero === hero.id && q.type === 'Starting Quest');
  const advanced = Object.values(cat.quests ?? {}).find((q) => q.hero === hero.id && q.type === 'Advanced Quest');
  hero.quests ||= { startingDone: false, advancedDone: false };
  hero.quests.advancedQuestId = advanced?.id;
  if (!starting.length) return;
  // Deterministic 1-of-N pick drawn from the shared seeded rng stream, same as
  // every other random choice in setup (skill/corruption shuffles, missions).
  const chosen = starting[nextInt(state, starting.length)];
  hero.quests.startingQuestId = chosen.id;
  // Follow the quest's "Setup" instruction — a "Place <Character> in <Location>."
  // directive that seeds a Character token onto the board.
  let placedLoc: string | null = null;
  const m = /Place\s+([A-Za-z'’.\- ]+?)\s+in\s+([A-Za-z'’.\- ]+?)[.,]/.exec(chosen.setup || '');
  if (m) {
    placedLoc = locByName(cat, m[2]);
    if (placedLoc) {
      placeCharacterUnique(state, m[1], placedLoc);
      log(state, 'setup', hero.id, `${m[1].trim()} placed at ${cat.locations[placedLoc]?.name ?? placedLoc} (quest setup: ${chosen.name})`);
    }
  }
  // Defeat-quests also register an Encounter substitution ("combat a <Monster>
  // instead") to be resolved when the hero explores that location.
  registerQuestCombat(cat, hero, chosen, placedLoc);
  // Place a green Quest marker on the objective location so the player sees where
  // this Starting Quest must be completed.
  const questLoc = questTargetLocation(cat, chosen, placedLoc);
  if (questLoc) {
    ((state.map.questAt ||= {})[questLoc] ||= []).push(hero.id);
    log(state, 'setup', hero.id, `quest marker at ${cat.locations[questLoc]?.name ?? questLoc} (${chosen.name})`);
  }
  log(state, 'setup', hero.id, `starting quest: ${chosen.name} — ${chosen.task}`);
}

/** Sauron begins with his stage-1 lieutenants deployed onto their own
 *  designated board locations (not his seat). Minions activate onto the
 *  location printed on their reference card when the game reaches their stage;
 *  the stage-1 minions are simply on the board from turn 1. */
function placeStartingMinions(state: GameState, cat: Catalog): void {
  const starters = Object.values(cat.minions)
    .filter((m) => !m.finale && (m.stage ?? 1) <= 1);
  for (const m of starters) {
    const loc = m.location ?? state.sauron.location;
    (state.map.minionsAt ||= {});
    (state.map.minionsAt[loc] ||= []).push(m.id);
    log(state, 'setup', 'Sauron', `${m.name} activates at ${cat.locations[loc]?.name ?? loc}`);
  }
}

/** Place Sauron's starting plot (the setup difference tied to his mission). The
 *  Sauron player picks one of the three; the automa picks deterministically. Its
 *  colored story marker starts at the START space and advances each Story Step. */
function seedStartingPlot(state: GameState, cat: Catalog): void {
  const starting = cat.plots.filter((p) => p.starting);
  if (!starting.length) return;
  const chosen = starting[Math.abs(state.rngCursor) % starting.length];
  state.rngCursor = (state.rngCursor * 1103515245 + 12345) | 0;
  const marker = (chosen.marker ?? 'red');
  const advance = chosen.advance ?? 1;
  (state.sauron.activePlots ||= []).push({
    eventId: chosen.id, step: chosen.track.length,
    location: (chosen.affects || undefined) as never,
  });
  // Follow the plot's "Setup" instruction: seed Sauron's initial influence onto
  // the board (N per Shadow Stronghold, M in extension, K in the Shadow Pool).
  applyStartingPlotInfluence(state, cat, chosen.effect ?? '');
  log(state, 'setup', 'Sauron', `starting plot: ${chosen.name} (feeds ${marker} marker +${advance}/turn)`);
  // Public recap of exactly WHERE the starting influence landed, so the hero
  // player can read the board at a glance (Shadow Pool + every seeded location).
  const inf = state.sauron.locationInfluence ?? {};
  const placed = Object.entries(inf).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${cat.locations[id]?.name ?? id} (${n})`);
  log(state, 'setup', 'Sauron',
    `starting influence — Shadow Pool: ${state.sauron.influence}; on the map: ${placed.length ? placed.join(', ') : 'none'}`);
}

/** Seed Sauron's starting hands from the shuffled decks (rulebook / starting-plot
 *  Setup: "keep 1 of 2 Shadow cards; keep 2 of 5 Plot cards"). The Plot deck is
 *  the 18 non-starting plots shuffled with a LOCAL rng so the shared gameplay rng
 *  stream (used by per-hero shuffles + combat) is left untouched — perturbing it
 *  here previously broke the statistical peril tests. */
function seedSauronHands(state: GameState, cat: Catalog): void {
  // The four "event-deck plots" (Of Serpents and Sand, The Glades of Orthanc
  // Darken, The Blood of Rhun, Dark News from Erebor) are NOT part of Sauron's
  // Plot deck — they enter play from the stage Event deck. Exclude them so they
  // are never drawn/played as regular plots.
  const nonStarting = cat.plots.filter((p) => !p.starting && !p.eventDeckPlot).map((p) => p.id);
  // Local deterministic shuffle keyed off the seed only (no state.rngCursor).
  let r = (state.seed ^ 0x5c0b1a7) >>> 0;
  const rand = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 0x100000000; };
  const deck = [...nonStarting];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  // Draw 5, keep the best 2, return the other 3 to the bottom of the deck.
  const drawn = deck.splice(0, 5);
  const keep = keepBestPlots(cat, drawn, 2);
  const returned = drawn.filter((id) => !keep.includes(id));
  state.sauron.plotHand = keep;
  state.sauron.plotDeck = [...deck, ...returned];
  state.sauron.plotDiscard = [];
  // Shadow hand: keep 1 (drawShadow reads but does not advance the shared rng).
  drawShadow(state, cat, 1);
  log(state, 'setup', 'Sauron', `draws hands — ${keep.length} Plot, ${state.sauron.shadowHand.length} Shadow`);
}

/** Parse and apply a starting plot's Setup influence, e.g. "2 influence in each
 *  Shadow Stronghold, 7 in extension, 1 in the Shadow Pool". */
function applyStartingPlotInfluence(state: GameState, cat: Catalog, effect: string): void {
  const num = (re: RegExp) => { const m = effect.match(re); return m ? parseInt(m[1], 10) : 0; };
  const each = num(/(\d+)\s+influence in each Shadow Stronghold/i);
  const extensionN = num(/(\d+)\s+in extension/i);
  // The starting plot's Setup line is authoritative for the Shadow Pool: it says
  // exactly how many tokens seed the Pool (0 if it names none). The rest of its
  // influence (each-stronghold + extension) goes onto the BOARD. This overrides
  // the scenario's placeholder default so e.g. "Monsters in the East" (9 in
  // extension, none in the Pool) starts the Pool at 0, not 2.
  const poolN = num(/(\d+)\s+in the Shadow Pool/i);
  state.sauron.influence = poolN;
  const inf = (state.sauron.locationInfluence ||= {});
  const strongholds = Object.values(cat.locations).filter((l) => l.kind === 'stronghold');
  for (const sh of strongholds) {
    const cap = sh.strongholdMax ?? each;
    inf[sh.id] = Math.min(each, cap || each);
  }
  // Extension: BFS outward from the strongholds, one influence per new location
  // (skip havens and hero-occupied locations), until the budget is spent.
  if (extensionN > 0) {
    const adj = (loc: string) => cat.edges.filter((e) => e.a === loc || e.b === loc).map((e) => (e.a === loc ? e.b : e.a));
    const seen = new Set<string>(strongholds.map((s) => s.id));
    let frontier = strongholds.map((s) => s.id);
    let placed = 0;
    while (placed < extensionN && frontier.length) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const nb of adj(cur)) {
          if (placed >= extensionN) break;
          if (seen.has(nb)) continue;
          const loc = cat.locations[nb];
          if (!loc || loc.kind === 'haven') continue;
          if ((state.map.heroesAt[nb]?.length ?? 0) > 0) continue;
          seen.add(nb);
          inf[nb] = (inf[nb] ?? 0) + 1;
          next.push(nb);
          placed++;
        }
        if (placed >= extensionN) break;
      }
      frontier = next;
    }
  }
}




/** M11: activate the next reserve minion whose stage the game has reached,
 *  placing it onto its own designated board location (not near a plot/hero).
 *  The Ringwraiths (a `finale` minion) DO deploy as a normal stage-II minion —
 *  they are only withheld once the Finale itself has begun (maybeBeginFinale
 *  seats them as the champion foe). Returns the activated minion id or null. */
export function deployMinion(state: GameState, cat: Catalog): string | null {
  const onBoard = new Set(Object.values(state.map.minionsAt ?? {}).flat());
  const defeated = new Set(state.map.minionDefeated ?? []);
  const stage = gameStage(state);
  const reserve = Object.values(cat.minions)
    .filter((m) => !onBoard.has(m.id) && !defeated.has(m.id) && (m.stage ?? 1) <= stage && !(m.finale && state.story.finale))
    .sort((a, b) => (a.stage ?? 1) - (b.stage ?? 1));
  if (!reserve.length) return null;
  const m = reserve[0];
  const loc = m.location ?? state.sauron.location;
  (state.map.minionsAt ||= {});
  (state.map.minionsAt[loc] ||= []).push(m.id);
  return m.id;
}


