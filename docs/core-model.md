# Core Model — entities, state, tracks

> **Schema:** `gs-core-model-v1` · derives from [`../SPEC.md`](../SPEC.md) §2.
> Defines the typed nouns of the game and the exact shape of `GameState`. Numeric bounds marked
> **⟨owner⟩** are placeholders confirmed against the owner's rulebook/VASSAL data before M1 close;
> the *structure* is fixed here, the *values* are catalog data (see `data-schemas.md`).

## 1. Identifiers

All ids are stable kebab-case strings. Types (in `types.ts`):

```ts
type Side = 'Sauron' | 'Hero';
type HeroId = string;        // e.g. 'eomer', 'eowyn', 'beregond', 'thalin'  ⟨owner⟩ confirm roster
type LocationId = string;    // e.g. 'rivendell', 'bree', 'moria-gate'
type RegionId = string;      // e.g. 'eriador', 'rhovanion'
type CardId = string;        // adventure / combat / plot / encounter card ids
type MinionId = string;      // Sauron minion figure types
type EffectKey = string;     // names a handler in handlers/registry
```

## 2. Entities (catalog, immutable)

Loaded from `assets/*.json` into `Catalog`:

- **Hero** — `{ id, name, startLocation, maxLife⟨owner⟩, maxCorruption⟨owner⟩, adventureDeck: CardId[], startingHand?: number }`.
- **Location** — `{ id, name, regionId, kind ('haven'|'city'|'wild'|'stronghold'|...), encounterDeck?: CardId[], plotSlot?: boolean, coords?: {x,y} }`.
- **PathEdge** — undirected `{ a: LocationId, b: LocationId, cost⟨owner⟩ }` in `adjacency.json`.
- **AdventureCard** — `{ id, heroId, name, movementValue, actionType?, effectKey, rulesText, image, copies }`.
- **CombatCard** — `{ id, owner ('hero'|'sauron'|shared), power, effectKey, rulesText, image, copies }`.
- **PlotCard** — `{ id, name, influenceCost⟨owner⟩, track: PlotStep[], effectKey, rulesText, image }`.
- **EncounterCard** — `{ id, locationId?|deck, name, effectKey, rulesText, image }`.
- **Minion** — `{ id, name, combatDeck: CardId[], strength⟨owner⟩, image }`.

## 3. GameState (mutable, per game)

```ts
interface GameState {
  seed: number;                 // rng seed; all randomness derives from here
  round: number;                // 1-based
  phase: Phase;                 // see §4
  activeSide: Side;
  activeHeroIndex: number;      // whose hero turn within Hero Turn
  heroes: HeroState[];          // 1..3 seats
  sauron: SauronState;
  map: MapState;                // location occupancy of heroes + minions
  story: StoryTrack;            // shared master clock
  pendingCombat: CombatState | null;   // non-null while a bout is unresolved
  pendingChoice: Choice | null;        // a decision the active seat must make
  log: LogEvent[];
  winner: Side | null;          // null while game is live
  catalogRef: string;           // catalog version this state was built against
}

interface HeroState {
  id: HeroId; seat: number;
  location: LocationId;
  life: number;                 // 0..maxLife; 0 ⇒ defeated → nearest haven
  corruption: number;           // 0..maxCorruption; at max ⇒ turned (⟨owner⟩ rule)
  deck: CardId[]; hand: CardId[]; discard: CardId[];
  combatDeck: CardId[]; combatHand: CardId[]; combatDiscard: CardId[];
  gear: CardId[];               // items/allies/skills acquired
  actionsRemaining: number;     // per hero turn (base 2 ⟨owner⟩)
  status: 'active' | 'defeated' | 'turned';
}

interface SauronState {
  influence: number;            // spend to play plots / act
  activePlots: PlotInstance[];  // the scheme row
  pathDeck: CardId[]; pathDiscard: CardId[];
  minions: never;               // minion positions live in MapState
  markers: Record<string, number>; // misc track markers (⟨owner⟩ enumerate)
}

interface PlotInstance { cardId: CardId; step: number; }   // progress along PlotCard.track

interface MapState {
  heroesAt: Record<LocationId, HeroId[]>;
  minionsAt: Record<LocationId, MinionId[]>;
}

interface StoryTrack { heroMarker: number; sauronMarker: number; length: number; } // ⟨owner⟩ length
```

`CombatState`, `Choice`, `LogEvent`, `Phase` are defined in §4–§6.

## 4. Phases (the turn machine)

`Phase` is a discriminated string. One **round** = the ordered sequence below. See
`rules-digest.md` for the behavior of each; `phases.ts` implements the transitions.

```
Round N:
  ├─ HeroTurn
  │    for each hero seat in order:
  │      ├─ HeroRefresh   (draw up to hand size, reset actionsRemaining)
  │      └─ HeroActions   (spend up to 2 actions: Move | Rest | Train | Visit | Play)
  │           └─ (Combat sub-machine may open here → pendingCombat)
  └─ SauronTurn
       ├─ SauronRefresh   (gain influence, draw path cards)
       ├─ SauronPlots     (play / advance active plots)
       └─ SauronMinions   (move + act minions; may open Combat)
  └─ StoryAdvance         (resolve markers; check win conditions)
```

Combat is **not** a phase; it is a sub-machine (`pendingCombat`) that suspends the current phase until
resolved, exactly like `reference-swr`'s combat-in-Command-phase model.

## 5. Combat sub-machine (`CombatState`)

M1 scope = numeric only. Structure fixed now so M2/M3 slot in without reshaping state.

```ts
interface CombatState {
  attacker: Combatant; defender: Combatant;
  locationId: LocationId;
  roundOfBout: number;
  reveal: { attacker?: CardId; defender?: CardId } | null; // simultaneous selection buffer
  pendingEffects: EffectKey[];   // M2+: queued effects from revealed cards
  report: CombatBoutLog[];
  resolved: boolean; result?: 'attacker' | 'defender' | 'draw';
}
interface Combatant {
  kind: 'hero' | 'minion';
  refId: HeroId | MinionId;
  hp: number;                    // damage capacity for this bout (⟨owner⟩ source)
  hand: CardId[]; deck: CardId[]; discard: CardId[];
}
```

**Numeric resolution (M1):** each side selects one combat card, both reveal, compare `power`; the
higher `power` deals its difference (or full value — **⟨owner⟩ confirm the exact damage rule**) to the
other's `hp`; repeat bouts until one side's `hp` hits 0 or a side chooses/forced to disengage. Card
`effectKey`s are ignored in M1 (collected into `pendingEffects` but not run).

## 6. Choices, log, win conditions

- **`Choice`** — a serializable request `{ id, seat, kind, options[] }` the active seat must resolve;
  the UI and (future) AI both answer through the same `resolveChoice` surface. Mirrors the reference
  `choices.ts` pattern so hot-seat, tests, and online share one decision path.
- **`LogEvent`** — `{ round, phase, type, actor, detail }`; append-only; the audit trail (SPEC §5).
- **Win check (`StoryAdvance`):** evaluate, in order: Sauron completion condition, Hero completion
  condition, Story-Track exhaustion (compare markers). First satisfied sets `winner`. Exact conditions
  are **⟨owner⟩** scenario data and live in `assets/scenario.json`.

## 7. Open data points to confirm with owner (tracked, not blocking structure)

Hero roster & stats · location/region list & coordinates · path costs · action budget · hand sizes ·
life/corruption maxima · plot influence costs and track lengths · combat damage rule · Story-Track
length · win conditions. All are **catalog values**, not structural — M1 proceeds with sane
placeholders in `assets/*.json` flagged `_meta.provenance: "placeholder"`.
