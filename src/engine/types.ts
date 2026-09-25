// Entity + state types for the Middle-earth Quest engine.
// Source of truth: docs/core-model.md (amended in M1 to the real MEQ model:
// single dual-use hero deck, terrain movement, attack/defense combat).
// No logic lives here.

export type Side = 'Sauron' | 'Hero';
export type HeroId = string;
export type LocationId = string;
export type RegionId = string;
export type CardId = string;
export type MonsterId = string;
export type EffectKey = string;
export type Terrain = 'woods' | 'swamp' | 'mountain' | 'plains' | 'hill' | '';
export type CombatType = 'ranged' | 'melee' | string;

export type Provenance = 'placeholder' | 'owner-verified' | 'paraphrase';
export interface Meta { schema: string; provenance: Provenance; source: string; notes: string[]; }

// ---- Catalog (immutable data from assets/*.json) ----

export interface Hero {
  id: HeroId; name: string;
  fortitude: number; strength: number; agility: number; wisdom: number;
  ratioRanged: number; ratioMelee: number;
  startLocation: LocationId; startLocationName: string;
  abilityName: string; abilityText: string;
  deck: string;            // deck id, e.g. "hero-argalad"
  startItems?: string[];   // item ids the hero begins the game with
  image: string; copies: number;
}

// A card in a hero or monster combat deck. Hero cards double as movement cards
// via `terrain`. Monster cards have no terrain.
export interface CombatCard {
  id: CardId; deck: string; owner: 'hero' | 'monster';
  name: string; type: CombatType;
  attack: number; defense: number; strengthCost: number;
  terrain: Terrain;
  ability: string; effectKey: EffectKey; copies: number;
}

export interface Monster {
  id: MonsterId; name: string;
  /** Combat life pool (damage tokens needed to defeat it). Distinct from
   *  fortitude — see `fortitude` below. */
  health: number;
  /** Cards drawn into its combat hand at the start of a fight — NOT its life
   *  total (per the physical MEQ Monster Reference sheet, Fortitude only
   *  governs hand size). */
  fortitude: number; strength: number; wisdom: number;
  deck: string; ratioRanged: number; ratioMelee: number;
  ability: string; effectKey: EffectKey; image: string;
}

export type MinionId = string;
/** M11: a named elite minion of Sauron. Persistent board figure (distinct from
 *  a generic monster). `fortitude` = max health cap from the VASSAL module. */
export interface Minion {
  id: MinionId; name: string;
  /** Health = damage tokens needed to defeat the minion (persists between combats). */
  health: number;
  /** Fortitude = combat cards the minion draws each combat (its attribute). */
  fortitude: number; strength: number; wisdom: number; combatDeck: string;
  ability: string; effectKey: string;
  /** Board location the minion activates onto when its stage begins. */
  location?: LocationId; altLocation?: LocationId;
  /** Game stage (1/2/3) at which the minion activates onto the board. */
  stage?: number;
  copies: number; image: string; finale?: boolean;
}

export type LocationKind = 'haven' | 'wild' | string;
export interface Location {
  id: LocationId; name: string; regionId: RegionId; regionName: string;
  regionColor: string; kind: LocationKind;
  /** Category flags (single source of truth in locations.json). A location
   *  belongs to exactly one geographic region (regionId) and independently
   *  carries these flags. `kind`/`perilous` are derived from them at load. */
  haven: boolean; fortress: boolean; peril: boolean;
  plotSlot: boolean; encounterDeck: CardId[];
  /** Shadow Stronghold only: the red max-influence number on its tower icon. */
  strongholdMax?: number;
  /** Inherently Perilous location (e.g. Ruins of Angmar): always draws a Peril
   *  on entry and skips the Encounter step, regardless of influence. */
  perilous?: boolean;
  coords: { x: number; y: number }; image: string;
}
export interface PathEdge { a: LocationId; b: LocationId; terrain: Terrain; cost: number; water?: boolean; }

export interface EventCard {
  id: CardId; turn: number | string; cardNo: number | string; name: string;
  favor1: string; favor2: string; character: string;
  characterLocation: string; questLocation: string;
  text: string; effectKey: EffectKey;
  ops: EffectOp[]; effectKind: EffectKind;
  tree?: EffTree; partial?: boolean;
}
export interface Mission { id: string; name: string; text: string; effectKey: EffectKey; condition?: MissionCondition | null; }

/** A single mechanical operation parsed from an encounter/event card's text. */
export type EffectOp =
  | { op: 'gainFavor'; n: number }
  | { op: 'loseFavor'; n: number }
  | { op: 'gainCorruption'; n: number }
  | { op: 'removeCorruption'; n: number }
  | { op: 'addInfluence'; n: number }
  | { op: 'removeInfluence'; n: number }
  | { op: 'damage'; n: number };
export type EffectKind = 'mechanical' | 'flavor' | 'empty';

export interface EncounterCard {
  id: CardId; regionGroup: string; priority: number | string; name: string;
  location: string; regionColor: string; effect: string; effectKey: EffectKey;
  ops: EffectOp[]; effectKind: EffectKind;
  /** M4: structured layered effect tree (condition/choice/effect). */
  tree: EffTree;
  /** true when the tree still contains an unmodeled `raw` remainder. */
  partial: boolean;
}

/** M8: Sauron peril card — drawn when a hero enters an influenced/perilous node. */
export interface PerilCard {
  id: CardId; name: string; location: string; region: string;
  effect: string; effectKey: EffectKey; tree: EffTree; partial: boolean;
}

/** M8: Sauron shadow card — the Eye draws these into a hand and plays them. */
export interface ShadowCard {
  id: CardId; name: string; poolRequirement: number | string; timing: string;
  effect: string; effectKey: EffectKey; tree: EffTree; partial: boolean;
}

/** Hero Quest (Starting or Advanced): a per-hero objective with a Setup
 *  instruction, a task, and a reward. Completing the Starting Quest unlocks the
 *  Advanced Quest. */
export interface Quest {
  id: string; hero: HeroId; name: string;
  type: 'Starting Quest' | 'Advanced Quest';
  setup: string; task: string; reward: string; region: string; effectKey: string;
}

/** M8: a Sauron plot — enabling/advancing it costs influence and pushes the
 *  dark story track (the war chest's payoff). */
export interface PlotStep { step: number; effectKey: EffectKey; }
export type StoryMarkerColor = 'yellow' | 'red' | 'black';
export interface Plot {
  id: CardId; name: string; influenceCost: number | string;
  track: PlotStep[]; counterLocation: string; effectKey: EffectKey;
  rulesText: string; image: string;
  /** plots-v2: faithful mechanics read from the card scans. */
  starting?: boolean;
  marker?: StoryMarkerColor;          // which colored story marker it advances
  advance?: number;                   // how far it pushes that marker when played
  favorToCounter?: number;            // favors a hero discards to counter it (scroll)
  affects?: string;                   // board location id ('' if off our map subset)
  affectsText?: string;               // human-readable affected location
  condition?: string;                 // activation requirement text
  effect?: string;                    // short paraphrased ongoing effect
  gollum?: boolean;                   // part of the "Gollum" plot family
  /** plots-v3: authoritative fields from Sauron_Plots.pdf. */
  stage?: string;                     // when it can enter play, e.g. 'I-III', 'II-III', 'III', 'n/a'
  markerName?: 'Ring' | 'Military' | 'Corruption'; // named story marker (yellow/red/black)
  aiLocDifficulty?: number;           // Lidless Eye rating: how hard the location is for heroes
  aiReqEase?: number;                 // Lidless Eye rating: how easy the play requirement is
  aiEffectVal?: number;               // Lidless Eye rating: value of the ongoing effect
  eventDeckPlot?: boolean;            // a plot that enters via the stage event deck (the * plots)
  eventPriority?: string;             // event-deck priority note for eventDeckPlot plots
  character?: string;                 // eventDeckPlot: Character placed on the board with it
  characterLocation?: string;         // eventDeckPlot: where that Character is placed
}

// ---- M4: layered encounter/effect DSL ----------------------------------
// A card's mechanical text compiles to an EffTree. The interpreter walks it,
// evaluating conditions against live game state and pausing at choice/optional
// nodes for the player. See src/engine/encounter.ts.

/** A quantity a condition compares against, read from live game state. */
export type Metric =
  | { stat: 'wisdom' | 'agility' | 'fortitude' | 'strength' }
  | { num: number }
  | { count:
      | 'monstersInRegion' | 'influenceInRegion' | 'influenceShadowPool' | 'influenceHere'
      | 'corruptionOnHero' | 'plotsInPlay' | 'itemsOnHero' | 'handSize' | 'favor'
      | 'adjacentInfluencedLocations' | 'minionsTotal' | 'monstersTotal' | 'shireControl' };

export type Cond =
  | { cmp: 'ge' | 'gt' | 'le' | 'lt' | 'eq'; left: Metric; right: Metric }
  | { cmp: 'noCorruption' }
  | { cmp: 'yellowClosest' }               // Sauron's yellow marker closest to start
  | { cmp: 'plotActive'; plot: string }    // a specific Plot card (by id) is active
  | { cmp: 'always' };

/** Atomic mechanical operation applied by the interpreter. */
export type Atom =
  | { op: 'gainFavor'; n: number }
  | { op: 'loseFavor'; n: number; per?: 'corruptionOnHero' } // n, or n per Corruption card
  | { op: 'gainCorruption'; n: number }        // draw N corruption cards
  | { op: 'discardCorruption'; n: number }
  | { op: 'discardAllCorruption' }
  | { op: 'redeemGrace' }                       // spend min(favor,corruption) favor to discard that many Corruption
  | { op: 'bankFavor'; n: number }              // lose n favor now, banked for later return (Trust in Friendship)
  | { op: 'addInfluence'; n: number; per?: 'corruptionOnHero' } // to Shadow Pool (optionally n per Corruption card)
  | { op: 'removeInfluence'; n: number }        // from Shadow Pool
  | { op: 'discardRegionInfluence'; n: number }
  | { op: 'damage'; n: number }
  | { op: 'damagePer'; n: number; per: 'corruptionOnHero' }
  | { op: 'heal' }                              // rest+damage pools into life
  | { op: 'healPer'; per: 'fortitude' | 'strength' | 'agility' | 'wisdom' } // move N damage→life per stat point
  | { op: 'training'; n: number }
  | { op: 'gainItem'; item: string }
  | { op: 'discardItem'; n: number }
  | { op: 'gainStat'; stat: 'fortitude' | 'strength' | 'agility' | 'wisdom' | 'choice'; n: number }
  | { op: 'moveAdjacent'; to?: LocationId }
  | { op: 'moveToEncounter'; location: string }
  | { op: 'placeCharacter'; who: string; location: string; ifInPlay?: boolean }
  | { op: 'explore'; location: string }
  | { op: 'discardMonsterToken'; n: number }
  | { op: 'forceSauronDiscard'; n: number; pile?: 'shadow' | 'plot' }
  | { op: 'advanceStory'; n: number }
  | { op: 'endTurn' }
  | { op: 'reusable' }                          // shuffle card back into its deck
  | { op: 'lookSauronHand' }
  | { op: 'sauronDrawPlot' }
  | { op: 'sauronDrawShadow'; n: number }         // Sauron draws N Shadow cards
  | { op: 'drawPer'; per: 'fortitude' }
  | { op: 'examineTokens' }
  | { op: 'discardHand'; n: number; toHand?: number; perCorruption?: boolean }
  | { op: 'discardCardId'; id: CardId }           // discard one named card from hand (shield-block, per-card selection)
  // M9: shadow/event/peril mechanics ----------------------------------
  | { op: 'forceCombat'; monster: string }        // "must combat a Balrog"
  | { op: 'combatReward'; favor?: number; training?: number } // reward granted only on defeating the forced foe
  | { op: 'placeInfluence'; where: 'region' | 'shadowPool' | 'location' | 'mordor' | 'shire'; n: number; location?: string; each?: boolean; spread?: number }
  | { op: 'spawnMonster'; n: number }             // place N monster tokens near the hero
  | { op: 'advanceMarker'; marker: 'yellow' | 'red' | 'black' | 'green'; n: number } // advance a named story marker n spaces (green = hero clock; n may be negative)
  | { op: 'combatStatMod'; stat: 'strength' | 'agility' | 'fortitude' | 'wisdom'; n: number; per?: 'corruptionOnHero' }
  | { op: 'restrictMovement'; n: number }         // cap the hero's next Travel step
  | { op: 'forcePeril' }                           // treat the hero's location as perilous now
  | { op: 'redistributeCorruption' }              // give a hero 1 Corruption card
  | { op: 'plotPeekReorder' }                      // saruman's-lies: peek top plot, keep on top or bury it
  | { op: 'plotFromDiscard' }                      // lord-of-the-rings: retrieve the best plot from the discard to hand
  | { op: 'plotTutor'; ids: string[] }             // the-ithil-stone: fetch a named plot from deck/discard to hand
  | { op: 'skipAmbush' }                           // hero avoids the pending ambush this turn
  | { op: 'moveAnywhere' }                          // hero may move to any location (player choice)
  | { op: 'sauronMoveCharacter'; location: string } // Sauron banishes a chosen Character to `location`
  | { op: 'clearMonstersAt'; location: string }     // remove all monster tokens from a named location
  | { op: 'clearAdjacent' }                          // remove all influence + monster tokens within 1 space of the hero
  | { op: 'handToLife' }                             // shuffle the hero's whole hand into his life pool
  | { op: 'placeFavorToken'; location: string; n: number } // place N favor tokens on a named location
  | { op: 'removeCharacter'; region: string }       // Sauron discards one Character token from a region
  | { op: 'damageMinion'; n: number; region: string } // deal N damage to a minion in a region
  | { op: 'counterPlot'; scope?: 'haven' }          // hero removes an active plot from play (optionally one affecting a Haven)
  | { op: 'reviveRelocateMinion' };                 // they-are-terrible: full-heal a minion (board or defeated) and place it on an influenced location

export interface EffOption { label: string; cost?: Atom; eff: EffTree; }

export type EffTree =
  | { k: 'seq'; steps: EffTree[] }
  | { k: 'choice'; prompt: string; options: EffOption[] }
  | { k: 'optional'; prompt: string; cost?: Atom; eff: EffTree }
  | { k: 'if'; cond: Cond; then: EffTree; else?: EffTree }
  | { k: 'op'; atom: Atom }
  | { k: 'raw'; text: string }
  | { k: 'shieldBlock'; damage: number; reward: EffTree } // discard hand cards (shields = combat defense) to reduce `damage`; reward only if reduced to 0
  | { k: 'none' };

/** Structured win predicate for a hero/Sauron mission, evaluated each turn. */
export type MissionCondition =
  | { kind: 'heroCorruptionAtMost'; n: number }
  | { kind: 'heroFavorAtLeast'; n: number }
  | { kind: 'monstersAtMost'; n: number }
  | { kind: 'minionsAtMost'; n: number }
  | { kind: 'activePlotsAtLeast'; n: number }
  | { kind: 'allQuestsComplete' }
  | { kind: 'sauronMarkerAtStageIII'; marker: 'yellow' | 'red' | 'black' }
  | { kind: 'sauronInfluenceAtLeast'; n: number }
  | { kind: 'ringwraithsOrShireInfluence'; n: number };

export interface Scenario {
  storyTrackLength: number;
  heroMission: string; sauronMission: string;
  setup: { sauronInfluence: number; sauronStartLocation: LocationId };
}

export interface MonsterBagToken { monsterId: MonsterId; count: number; }
/** A region-PAIR pile of 10 face-down monster tokens (some blank). Sauron draws
 *  one at random when placing a monster in that region; a blank = false rumor. */
export interface MonsterBag {
  id: string;            // == regionId (geographic pair)
  regionId: string;
  name: string;
  colors: string[];
  blanks: number;
  tokens: MonsterBagToken[];
}

export interface Catalog {
  version: string;
  heroes: Record<HeroId, Hero>;
  locations: Record<LocationId, Location>;
  edges: PathEdge[];
  combatCards: Record<CardId, CombatCard>;
  monsters: Record<MonsterId, Monster>;
  minions: Record<MinionId, Minion>;
  events: EventCard[];
  encounters: Record<CardId, EncounterCard>;
  heroMissions: Record<string, Mission>;
  sauronMissions: Record<string, Mission>;
  scenario: Scenario;
  /** board art dimensions + image path (from locations.json _meta). */
  board: { width: number; height: number; image: string };
  /** cardId lists grouped by deck id, copies expanded. */
  decks: Record<string, CardId[]>;
  /** M8: Sauron peril / shadow decks and plot list. */
  perils: Record<CardId, PerilCard>;
  shadow: Record<CardId, ShadowCard>;
  plots: Plot[];
  /** #14: region-PAIR monster-token piles (with blanks) drawn on placement. */
  monsterBags: Record<string, MonsterBag>;
  /** Hero Starting/Advanced Quests, keyed by quest id. */
  quests: Record<string, Quest>;
  /** Corruption cards (rulebook p.26), keyed by id. */
  corruption: Record<CardId, CorruptionCard>;
}

/** A Corruption card: an ongoing penalty a hero suffers while holding it. `cost`
 *  is the favor needed to discard it at Rest; `effectKey` drives enforcement in
 *  src/engine/corruption.ts. Immediate cards (effectKey `immediate-*`) apply
 *  once and return to the deck rather than being held. */
export interface CorruptionCard {
  id: CardId; name: string; ability: string; cost: string; effectKey: string;
}

// ---- GameState (mutable, per game) ----

export type Phase =
  | 'HeroRefresh' | 'HeroActions'
  | 'SauronRefresh' | 'SauronEvents' | 'SauronMinions'
  | 'StoryAdvance' | 'GameOver';

export type HeroStatus = 'active' | 'defeated';
export interface HeroState {
  id: HeroId; seat: number;
  location: LocationId;
  /** MEQ has no numeric hero health: a hero's "life" IS his deck of cards.
   *  `deck` = the **life pool** (draw source), `discard` = the **rest pool**
   *  (cards played in combat / recycled by resting), `damagePool` = damage
   *  cards taken (face down). A hero is defeated when his life pool AND hand are
   *  both empty. `life` is kept in sync with the life-pool size for display only. */
  life: number;               // display mirror of deck.length (life-pool size)
  corruption: number;
  /** The actual Corruption cards this hero holds (rulebook p.26). `corruption`
   *  is kept in sync as this list's length. Each card imposes an ongoing
   *  penalty (see corruption.ts) and lists a favor cost to discard at Rest. */
  corruptionCards: CardId[];
  favor: number;
  /** Favor banked on the "Trust in Friendship" event, returned to this hero the
   *  next time he explores a location with another Hero or a Character. */
  bankedFavor?: number;
  deck: CardId[]; hand: CardId[]; discard: CardId[]; damagePool: CardId[];
  actionsRemaining: number;
  status: HeroStatus;
  /** M4 subsystems. */
  items: string[];
  training: number;
  /** M7: number of advanced (trained) cards injected into this hero's real
   *  deck. Public knowledge (you see a hero train); identities stay hidden
   *  until first played. */
  trainedCount: number;
  statBonus: Partial<Record<'fortitude' | 'strength' | 'agility' | 'wisdom', number>>;
  /** M9: transient debuffs/buffs cleared at end of combat and hero refresh. */
  combatMods?: { stat: 'fortitude' | 'strength' | 'agility' | 'wisdom'; n: number }[];
  /** M9: cap on Travel steps applied on the hero's next turn (Winter Storm). */
  moveRestriction?: number;
  /** Turn-scoped Travel-step cap derived from `moveRestriction` at refresh; caps
   *  how many Travel steps the hero may take this turn. Cleared each refresh. */
  turnTravelCap?: number;
  /** M9: set by a shadow card's `skipAmbush` atom — the hero avoids the pending
   *  ambush this turn (Flocks of Crebain / Seem Fairer / Creatures of the Wild).
   *  Cleared once the ambush is skipped or at hero refresh. */
  skipAmbush?: boolean;
  /** M3 Combat-or-Peril: locations the hero entered this turn where Sauron chose
   *  Peril instead of forcing a fight — the co-located foe does not block further
   *  travel here. Cleared at hero refresh. */
  perilResolvedAt?: LocationId[];
  /** M10 hero economy: recruited Characters (allies) travelling with the hero,
   *  and quest progress (both quests done => contributes to Spear of the West). */
  allies?: string[];
  quests?: { startingDone: boolean; advancedDone: boolean; startingQuestId?: string; advancedQuestId?: string; advancedUnlocked?: boolean;
    /** Defeat-quest hooks: at `location`, exploring combats `monster` instead of
     *  drawing an Encounter, and defeating it completes `questId`. */
    combats?: { location: LocationId; monster: MonsterId; questId: string }[] };
  /** Dark Path may be chosen at most once per hero turn (manual, Explore). */
  darkPathUsedThisTurn?: boolean;
  /** True once the hero has performed his (optional) Rest step this turn. The
   *  Rest step happens once, before any Travel step (rulebook p.20). Reset each
   *  turn in the refresh step. */
  restedThisTurn?: boolean;
  /** True while the hero still holds the hand dealt at Setup (rulebook p.10):
   *  the first Hero Refresh SKIPS its Draw step so the starting hand is not
   *  double-dealt. Cleared on that first refresh; every later refresh draws. */
  startingHandReady?: boolean;
  favorGainedThisTurn?: number;
  /** Generic once-per-turn hero special-ability flag (Eleanor's favor bonus,
   *  Argalad's token peek). Reset each turn in the refresh step. */
  abilityUsedThisTurn?: boolean;
  /** True once the mandatory end-of-turn Encounter step has been performed this
   *  turn (either via the optional Explore action or the automatic step). Reset
   *  each turn in the refresh step. */
  encounterStepDone?: boolean;
  /** True once the hero has taken a Travel Move this turn. Drives the rule that
   *  a hero who does NOT win a Travel combat loses the rest of his turn (whereas
   *  an Ambush, fought before moving, does not end the turn). Reset each turn. */
  hasMovedThisTurn?: boolean;
  travelStepsThisTurn?: number;
  /** Level tokens: how many times each attribute has been raised (max 2 each,
   *  per game). Absent = never raised. */
  levels?: Partial<Record<'fortitude' | 'strength' | 'agility' | 'wisdom', number>>;
}

export interface PlotMarker { eventId: CardId; step: number; location?: LocationId; }
/** The Eye's play-style doctrine, tuned from expert Sauron strategy (BGG +
 *  owner practice). Steers which plots the automa prioritises and how hard it
 *  presses Shadow attrition:
 *   - 'balanced'  : the historical default — advance whichever coloured marker
 *      is already highest, big advances first (spreads pressure, denies hero
 *      dominance broadly).
 *   - 'tempo'     : the owner's signature "gain tempo" line — CONCENTRATE plots
 *      on ONE marker to burst it toward the Finale fast (a single marker at the
 *      Finale wins outright), so heroes cannot break enough plots in time.
 *   - 'attrition' : "wear the heroes down" — prize plots that force the most
 *      favour to counter and lean hardest on corruption/hand-dump Shadow cards,
 *      trading marker speed for grinding the heroes' economy.
 *  The automa is seated on 'tempo' by default (setup.ts). */
export type SauronDoctrine = 'balanced' | 'tempo' | 'attrition';

export interface SauronState {
  influence: number;
  location: LocationId;
  /** Active play-style doctrine steering the automa (default 'balanced'). */
  doctrine?: SauronDoctrine;
  activeEvents: PlotMarker[];   // this-turn event/plot row (the "plots")
  markers: Record<string, number>;
  /** Influence tokens placed per LOCATION (rulebook pp. 16–18). Drives peril,
   *  monster placement/movement, and plot/encounter requirements. */
  locationInfluence: Record<LocationId, number>;
  /** M7: the Lidless Eye's persistent memory of each hero's revealed trained
   *  (advanced) cards — a high-water-mark multiset of advanced card ids proven
   *  to exist in that hero's deck (once played, always known). */
  heroIntel: Record<HeroId, { revealedTrained: CardId[] }>;
  /** M8: Sauron shadow hand + discard, and per-plot advancement track. */
  shadowHand: CardId[];
  shadowDiscard: CardId[];
  /** M11 Finale: the scaled fortitude of the Ringwraiths (base + Sauron
   *  dominance), applied when a hero engages the finale minion. */
  finaleWraithFortitude?: number;
  /** M11 Finale: the scaled health of the Ringwraiths (Adjust Difficulty). */
  finaleWraithHealth?: number;
  plotTrack: Record<CardId, number>;
  /** M11: the up-to-3 active Plot cards in Sauron's plot slots (persistent
   *  across turns; heroes counter them by paying favor). Distinct from the
   *  per-turn `activeEvents` row. */
  activePlots?: PlotMarker[];
  /** The event-deck "plots" (Of Serpents and Sand, Glades of Orthanc Darken,
   *  Blood of Rhûn, Dark News from Erebor) currently on the board. Each entered
   *  from the stage Event deck, sits at its location with a green token, and
   *  advances its coloured story marker one space every Story Step until a hero
   *  Explores its location to discard it. Kept separate from `activePlots` so it
   *  never counts toward the 3-plot limit or plot-count logic. */
  activeEventPlots?: PlotMarker[];
  /** Sauron's Plot economy (rulebook: plots start shuffled in the Plot deck;
   *  Sauron holds a HAND, plays one/turn from it, and draws more via the "Draw
   *  Shadow and Plot Cards" action, keeping 1 of each draw). `plotHand` are the
   *  ids he may play; `plotDeck` is the shuffled draw pile; `plotDiscard` the
   *  played/discarded pile. Starting-plot ids never enter these (setup-only). */
  plotDeck?: CardId[];
  plotHand?: CardId[];
  plotDiscard?: CardId[];
  /** Event deck (shuffled event ids) and discard. The Event Step draws from
   *  here per dominance instead of a fixed per-turn assignment. */
  eventDeck?: CardId[];
  eventDiscard?: CardId[];
  /** which stage's Event deck (1..3) is currently loaded into eventDeck. */
  eventStage?: number;
  /** Peril deck (shuffled peril ids) + discard. A perilous hero triggers a draw
   *  of three; Sauron resolves the one applicable card he chooses, discarding all
   *  three (rulebook pp.22–23). Reshuffled from the discard when depleted. */
  perilDeck?: CardId[];
  perilDiscard?: CardId[];
  /** #14: per-region remaining monster-token pile (entries are monsterId or
   *  'blank'). Lazily built + reshuffled from the catalog bag when depleted. */
  monsterBagPiles?: Record<string, string[]>;
  /** The Lidless Eye Action Tracks (rulebook pp.16–19). Each track has three
   *  spaces of DEGRADING yield — Place Influence 6/5/4, Draw 2/2/1, Command
   *  3/2/1. An action covers the leftmost free space (its number is the yield).
   *  Tokens PERSIST across Action steps until the 4th token is placed, after
   *  which all but that just-placed token are retrieved. Each field counts how
   *  many of that track's spaces are currently covered (0..3). */
  eye?: { influence: number; draw: number; command: number };
}

export interface MapState {
  heroesAt: Record<LocationId, HeroId[]>;
  monstersAt: Record<LocationId, MonsterId[]>;
  /** Locations whose facedown monster tokens have been REVEALED to the human
   *  hero player (by combat, Argalad's Survivalist, or an "examine tokens"
   *  encounter). The Board shows the monster face here instead of the token
   *  back. Sauron always sees every token; heroes only these. */
  revealedMonstersAt?: LocationId[];
  /** Face-down "false rumor" (blank) monster tokens on the board, counted per
   *  location. To a hero these are indistinguishable from real monster tokens
   *  (both are face-down) so they deter routing, but they hold no monster: when
   *  flipped in a Combat-or-Peril they are discarded with no fight. Sauron knows
   *  which are blank; the hero AI must NOT peek (it weights them like monsters). */
  rumorsAt?: Record<LocationId, number>;
  /** M11: named elite minions positioned on the board (distinct from monsters). */
  minionsAt?: Record<LocationId, MinionId[]>;
  /** M11: persistent current health per minion on the board (VASSAL `strength`
   *  prop). Damage carries over between engagements — heroes wear a minion down
   *  across multiple fights until it is destroyed. */
  minionHealth?: Record<MinionId, number>;
  /** Minions defeated but slated to return (Ringwraiths: "if defeated they
   *  return to Minas Morgul at the start of your Action step"). Redeployed and
   *  cleared at the start of the Sauron turn. */
  minionReturnPending?: MinionId[];
  /** Elite minions defeated PERMANENTLY (everyone except the Ringwraiths, who
   *  alone come back via minionReturnPending). Once a minion id lands here it
   *  is removed from Sauron's deployable reserve for the rest of the game —
   *  it must never redeploy (rulebook: only "The Nine" return after defeat). */
  minionDefeated?: MinionId[];
  /** M10 hero economy: favor tokens sitting on the board (retrievable), and
   *  Characters placed by events (consultable for favor / an ally). */
  favorAt?: Record<LocationId, number>;
  charactersAt?: Record<LocationId, string[]>;
  /** Green Quest markers: which heroes have an active Quest objective at a
   *  location (placed at setup, cleared when the quest completes). */
  questAt?: Record<LocationId, HeroId[]>;
  /** Rewards a card promises only if the hero DEFEATS the foe it forced into
   *  combat (e.g. Khazad-dûm, The Dark Tower). Granted and removed when a foe at
   *  the matching location is defeated. */
  pendingCombatRewards?: { location: LocationId; favor?: number; training?: number }[];
}
/** M10: the real story track (three stages of six spaces after the shared START
 *  space; Finale at space 18). The Hero (green) marker climbs 2 spaces per turn
 *  toward the Finale; the three Sauron markers (yellow/red/black) climb per his
 *  active Plot cards. The Finale begins when any marker reaches the Finale space,
 *  or all three Sauron markers reach The Shadow Falls (the midpoint, space 10).
 *  Dominance = the side whose marker(s) are nearer their goal. */
export interface StoryTrack {
  turn: number; length: number;
  /** the hero (green) marker's position toward the Finale — despite the name,
   *  this IS the live hero-clock value rendered as the green marker (there is
   *  no separate `heroMarker` field; a legacy duplicate field used to exist
   *  and was never updated, which silently froze the on-board hero token). */
  sauronProgress: number;
  /** the three Sauron story markers, 0..STORY_FINALE. */
  sauron?: { yellow: number; red: number; black: number };
  /** whether the Finale (endgame Ringwraith combat window) has begun. */
  finale?: boolean;
  /** which side reached the Finale space first (drives finale adjudication). */
  finaleTrigger?: 'Hero' | 'Sauron';
  /** Finale Step 1 (Check for Immediate Victory): if the dominant side (or, when
   *  neither is dominant, the sole side fulfilling its mission) secured an outright
   *  win, this records it. When set, NO Ringwraith combat happens. */
  finaleWinner?: 'Hero' | 'Sauron';
  /** human-readable reason accompanying finaleWinner. */
  finaleWinnerReason?: string;
  /** true while the single, decisive Finale combat (champion vs the Ringwraiths,
   *  manual step 6) is being played out — its result adjudicates the game. */
  finaleCombat?: boolean;
}
/** Story-track geometry (physical MEQ board). */
export const STAGE_SIZE = 6;           // spaces per stage
export const SHADOW_FALLS = 10;        // midpoint (4th space of stage 2)
export const STORY_FINALE = 18;        // Finale space; markers clamp here
/** A Sauron colored marker entering stage III — the rightmost band starts at
 *  space 13 (spaces 13–18), matching gameStage's `pos > 2*STAGE_SIZE` cutoff. */
export const SAURON_STAGE_III = 2 * STAGE_SIZE + 1;

// ---- Combat sub-machine (numeric in M1) ----
export interface Combatant {
  kind: 'hero' | 'monster';
  refId: HeroId | MonsterId; name: string;
  life: number;
  /** Strength budget (hero: strength attribute + unspent agility from Preparation;
   *  monster/minion: its Strength stat). Cumulative card strength cost may not
   *  exceed this or the combatant is Exhausted. */
  strength: number;
  /** Cumulative strength cost of cards revealed into this combatant's stack. */
  strengthSpent: number;
  /** Once exhausted, the combatant plays no card (presumed 0-atk/0-def, no ability). */
  exhausted: boolean;
  hand: CardId[]; deck: CardId[]; discard: CardId[];
  /** Hero only: the damage pool (cards discarded as damage). Monsters take
   *  numeric damage against `life` (health tokens) and leave this empty. */
  damagePool: CardId[];
}
export interface CombatBoutLog {
  round: number;
  attackerCard?: CardId; defenderCard?: CardId;
  damageToAttacker: number; damageToDefender: number;
  note: string;
}
/** A modifier a combat card schedules onto its own owner for the NEXT round. */
export interface NextMod {
  atk?: number; def?: number;
  ifOwnType?: CombatType;     // apply atk/def only if owner plays this type
  cancelOppType?: CombatType; // cancel opponent's card of this type
  oppRevealFirst?: boolean;   // opponent must reveal first (informational)
  // --- skill-driven next-round carries ---
  reduceOppDef?: number;             // Flaming Arrow: set opponent printed def to this
  dmgToOpp?: number;                 // Set Trap: deal this much damage to the opponent...
  dmgToOppIfOppType?: CombatType;    // ...only if the opponent plays this type
  cancelOppIfPrintedDefGE?: number;  // Concussive Shot: cancel if opp printed def >= n
  cancelOppIfCostGE?: number;        // Shield Smash: cancel if opp strength cost >= n
  cancelOppUnlessType?: CombatType;  // Heightened Senses / Outmaneuver: cancel unless opp plays this type
  freeIfType?: CombatType;           // Ready: strength cost becomes 0 if you play this type
}
export interface CombatState {
  attacker: Combatant; defender: Combatant;
  locationId: LocationId; round: number;
  reveal: { attacker?: CardId; defender?: CardId };
  pendingEffects: EffectKey[];
  report: CombatBoutLog[];
  resolved: boolean; result?: 'attacker' | 'defender' | 'escape' | 'standoff';
  /** type each side played last round (for match-type effects). */
  lastType?: { attacker?: CombatType; defender?: CombatType };
  /** next-round modifiers each side has queued from the prior round. */
  carry?: { attacker: NextMod[]; defender: NextMod[] };
  /** cards each side has played into its combat stack this battle (for
   *  count-the-stack and return-from-stack skill effects). */
  stack?: { attacker: CardId[]; defender: CardId[] };
  /** monster innate "once per battle" ability flags (keyed by ability id). */
  monsterOncePerBattle?: Record<string, boolean>;
  /** Balrog "Fear": the hero must play a random combat card next round. */
  forceHeroRandom?: boolean;
}

// ---- Choices & log ----
/** `cardId` is set when an option represents a specific combat/skill card
 *  (e.g. a training pick) so the UI can render its art/stats/ability instead
 *  of just the text label. */
export interface ChoiceOption { id: string; label: string; cardId?: CardId; }
export interface Choice {
  id: string; seat: number | 'sauron'; kind: string; prompt: string; options: ChoiceOption[];
}
/** Human-readable recap of a just-finished combat, for the post-combat summary
 *  modal (see App.tsx / CombatSummaryModal.tsx). */
export interface CombatSummary {
  result: 'attacker' | 'defender' | 'escape' | 'standoff';
  heroId: HeroId; heroName: string;
  foeName: string; foeKind: 'monster' | 'minion';
  rounds: number; damageTaken: number;
  /** log lines emitted while resolving the outcome (quest reward, defeat
   *  consequences, etc.) — joined for display. */
  notes: string[];
  /** full round-by-round bout log (card vs. card, damage, cancellations) so
   *  the player can review exactly how the combat played out, not just the
   *  final tally — see CombatSummaryModal.tsx. */
  report: CombatBoutLog[];
  /** wall-clock-ish sequence number (log seq at combat end) so history
   *  entries can be sorted/keyed stably. */
  seq: number;
}
export interface LogEvent {
  seq: number;              // monotonic, per-game
  turn: number;             // story turn at emission
  round: number; phase: Phase;
  side: Side;               // whose turn (activeSide)
  type: string; actor: string; detail: string;
  data?: Record<string, unknown>;  // structured payload for analysis
}

export interface GameState {
  seed: number; rngCursor: number;
  round: number; phase: Phase;
  activeSide: Side; activeHeroIndex: number;
  heroes: HeroState[]; sauron: SauronState;
  map: MapState; story: StoryTrack;
  pendingCombat: CombatState | null;
  pendingChoice: Choice | null;
  /** A dismissible "what just happened" summary shown after combat resolves
   *  (independent of pendingCombat, which still nulls immediately so bots/tests
   *  are unaffected). The human UI shows this until the player hits Continue;
   *  a fresh combat simply overwrites it. */
  lastCombatSummary?: CombatSummary | null;
  /** every combat's summary this game, oldest first, kept after the summary
   *  modal is dismissed so the player can review a past combat later (see
   *  the "Combat history" panel in App.tsx / CombatSummaryModal.tsx). */
  combatHistory?: CombatSummary[];
  /** an encounter drawn at a location, awaiting the player to resolve it.
   *  `decisions` records choices made so far (replay-driven resolution).
   *  `drawn` are the (up to 3) Encounter cards revealed this draw; `applicable`
   *  are those that actually affect the location; `revealed` gates the UI reveal
   *  tray (the player reads the cards and confirms/picks before resolving). */
  pendingEncounter:
    | { locationId: LocationId; cardId: CardId; decisions: number[]; drawn?: CardId[]; applicable?: CardId[]; revealed?: boolean }
    | null;
  /** A draw-and-reveal to acknowledge before the game continues: the Event Step
   *  (and Perils) draw several cards from a deck and resolve the one the rules
   *  dictate. This surfaces those cards to the player in a tray — all drawn
   *  cards shown, the resolved one highlighted — to read and confirm (OK). The
   *  card's effect has already been applied; OK simply dismisses the tray. */
  pendingReveal?:
    | { kind: 'event' | 'peril'; title: string; deck: 'events' | 'perils'; drawn: CardId[]; chosen?: CardId; note?: string; resultNote?: string }
    | null;
  /** M3: a human-controlled Sauron's pending "Combat or Peril" decision, raised
   *  when the active hero enters a location that is both perilous and holds a
   *  foe. Resolved via the `combatOrPeril` action. */
  pendingCombatOrPeril?: { heroId: HeroId; loc: LocationId } | null;
  /** A human-controlled Sauron's pending reaction Shadow window (rulebook p.20):
   *  one Shadow card per hero turn, offered at four windows. `window` is the
   *  trigger; `options` are the affordable, matching Shadow cards he may play
   *  (plus an implicit Pass); `resumeCombat` flags a `combat-start` pause that
   *  must run the Preparation step once resolved. Resolved via the
   *  `shadowReaction` action. Only set when `sauronAuto` is false. */
  pendingShadowReaction?: {
    window: 'action' | 'hero-turn' | 'combat-start' | 'enter-nonhaven' | 'hero-defeated';
    heroId?: HeroId; isMinionCombat?: boolean; resumeCombat?: boolean;
    options: { id: CardId; label: string }[];
  } | null;
  /** A card's internal effect-tree decision that the human `actor` must make
   *  (e.g. Sauron choosing Morgul-Blade's effect). The resolver auto-picks the
   *  AI-owned nodes and pauses here; `treeDecision` supplies the chosen option
   *  index and resumes. `resumeCombat` means a combat-start shadow owes a
   *  `queuePreparation` on completion. */
  pendingTree?: {
    sourceKind: 'encounter' | 'event' | 'peril' | 'shadow';
    cardId: string;
    source: string;
    heroId: HeroId;
    actor: 'hero' | 'sauron';
    resumeCombat?: boolean;
    /** A peril paused mid-move owes the "enter non-Haven" Shadow window once the
     *  hero's decision completes (see resolveTreeDecision). */
    resumeEnterWindow?: { heroId: HeroId; loc: LocationId };
    tree: EffTree;
    decisions: number[];
    prompt: string;
    options: { label: string; enabled: boolean }[];
  } | null;
  /** locations whose encounter has already been resolved this game. */
  explored: Record<LocationId, boolean>;
  /** #10: per-region Encounter decks + discard piles (keyed by regionGroup,
   *  incl. 'Haven'). Explore draws 3 from the current region's deck, resolves
   *  the lowest-priority card affecting the location, discards all 3, and
   *  reshuffles the discard when the deck runs out. */
  encounterDecks?: Record<string, CardId[]>;
  encounterDiscards?: Record<string, CardId[]>;
  /** The shared Skill deck (rulebook p.26): the 20 `deck:"skills"` combat cards
   *  shuffled at setup. Training draws the top two, the hero keeps one (added to
   *  his real deck) and discards the other faceup to `skillDiscard`. Depletes as
   *  heroes train; never reshuffled. */
  skillDeck?: CardId[];
  skillDiscard?: CardId[];
  /** A pending "Training: keep one of two drawn Skill cards" decision
   *  (rulebook p.26). `remaining` = additional training levels still owed to
   *  this hero after this pick resolves (usually 0). Resolved via the generic
   *  `resolveChoice` (kind 'training'). */
  pendingTraining?: { heroId: HeroId; remaining: number; a: CardId; b?: CardId } | null;
  /** Shared Corruption deck (rulebook p.26): shuffled at setup. Heroes gain a
   *  card when corrupted; each imposes an ongoing penalty (see corruption.ts)
   *  and lists a favor cost to discard it at Rest. Removed cards return here. */
  corruptionDeck?: CardId[];
  corruptionDiscard?: CardId[];
  log: LogEvent[];
  winner: Side | null; winReason: string;
  catalogRef: string;
  /** M10: the hidden hero + Sauron mission chosen at setup (the difference in
   *  initial setup / objectives). */
  secretHeroMission?: string;
  secretSauronMission?: string;
  /** M15: which side a human controls. 'Hero' (default) = play the heroes vs the
   *  Lidless Eye AI; 'Sauron' = play Sauron interactively vs AI-driven heroes. */
  humanSide?: Side;
  /** M15: actions remaining in the interactive Sauron Action Step (2, or 3 with
   *  three heroes). Set when a human-Sauron turn enters SauronMinions. */
  sauronActionsLeft?: number;
  /** M15: true once the human Sauron has played his ONE own-turn Shadow card this
   *  Sauron turn (rulebook: one Shadow on your turn + one per hero turn). Reset at
   *  the start of each Sauron Action Step. */
  shadowPlayedThisSauronTurn?: boolean;
  /** M15: an Eye Action Track action in progress. A Place Influence action can
   *  yield several board tokens and a Command action several commands; the human
   *  resolves them one at a time. `remaining` counts the sub-effects still owed
   *  by the current action. Cleared when spent or when the turn ends. */
  sauronPending?: { track: 'influence' | 'command'; remaining: number };
  /** Two-player game (a single hero): the hero takes 2 turns per Sauron turn.
   *  True once the hero has taken his first of the two turns this round. */
  heroSecondTurnPending?: boolean;
  /** Shadow timing: true once Sauron has played a Shadow card during the CURRENT
   *  hero activation (rule: at most one Shadow card per hero turn). Reset at the
   *  start of each hero activation (runHeroRefresh). */
  shadowPlayedThisHeroTurn?: boolean;
  /** When set, a non-interactive Sauron plays its hero-turn Shadow reactions
   *  automatically (used by the AI drivers even when humanSide==='Sauron' is a
   *  self-play device). A real human Sauron leaves this unset. */
  sauronReactsAuto?: boolean;
}
