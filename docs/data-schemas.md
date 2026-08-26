# Data Schemas — `assets/*.json`

> **Schema:** `gs-data-schemas-v1` · derives from [`core-model.md`](core-model.md).
> Every data file uses the reference envelope `{ "_meta": {...}, "<collection>": [ ... ] }`.
> `_meta` is mandatory: `{ schema, provenance, source, notes[] }`.
> `provenance ∈ { "placeholder" | "owner-verified" | "paraphrase" }` — the IP/audit signal (SPEC §5).

## Files & collections

| File | Collection | Row type (core-model §2) |
|---|---|---|
| `heroes.json` | `heroes` | Hero |
| `locations.json` | `locations` | Location |
| `adjacency.json` | `edges` | PathEdge |
| `adventure-cards.json` | `cards` | AdventureCard |
| `combat-cards.json` | `cards` | CombatCard |
| `plots.json` | `plots` | PlotCard |
| `encounters.json` | `cards` | EncounterCard |
| `minions.json` | `minions` | Minion |
| `scenario.json` | `scenario` | win conditions, setup, story-track length |

## Field contracts (the parts the engine reads)

**heroes.json / `heroes[]`**
```jsonc
{ "id": "eomer", "name": "", "startLocation": "loc-id",
  "maxLife": 0, "maxCorruption": 0, "handSize": 0,
  "adventureDeck": ["adv-card-id", ...], "combatDeck": ["cmb-card-id", ...],
  "image": "HeroEomer.png", "copies": 1 }
```
**locations.json / `locations[]`**
```jsonc
{ "id": "bree", "name": "", "regionId": "eriador", "kind": "city",
  "encounterDeck": ["enc-id", ...], "plotSlot": false,
  "coords": { "x": 0, "y": 0 }, "image": "LocBree.png" }
```
**adjacency.json / `edges[]`** — `{ "a": "loc-a", "b": "loc-b", "cost": 1 }` (undirected).

**adventure-cards.json / `cards[]`**
```jsonc
{ "id": "eomer-swift-ride", "heroId": "eomer", "name": "",
  "movementValue": 0, "actionType": "move|play|both",
  "effectKey": "", "rulesText": "", "image": "", "copies": 1 }
```
**combat-cards.json / `cards[]`**
```jsonc
{ "id": "cmb-strike", "owner": "hero|sauron|shared", "power": 0,
  "effectKey": "", "rulesText": "", "image": "", "copies": 1 }
```
**plots.json / `plots[]`**
```jsonc
{ "id": "plot-gathering-storm", "name": "", "influenceCost": 0,
  "track": [ { "step": 0, "effectKey": "" } ], "counterLocation": "loc-id?",
  "effectKey": "", "rulesText": "", "image": "" }
```
**encounters.json / `cards[]`**
```jsonc
{ "id": "enc-bree-01", "deck": "bree|region-eriador|generic",
  "name": "", "effectKey": "", "rulesText": "", "image": "" }
```
**minions.json / `minions[]`**
```jsonc
{ "id": "orc-band", "name": "", "strength": 0,
  "combatDeck": ["cmb-id", ...], "image": "", "copies": 1 }
```
**scenario.json / `scenario`**
```jsonc
{ "storyTrackLength": 0, "heroWin": { "effectKey": "" },
  "sauronWin": { "effectKey": "" }, "setup": { "sauronInfluence": 0 } }
```

## Rules for all files
1. `id` unique within its collection; referenced ids must resolve at load (`loadAssets.ts` validates).
2. `image` is a filename only; resolved at runtime against `public/dev-assets/`. Missing image ⇒
   placeholder render (never an error) — SPEC §1 rule 2.
3. `effectKey === ""` means "no mechanical effect yet"; allowed through M1. A non-empty key **must**
   have a handler (coverage test, SPEC §4).
4. Committed copies may have empty `name`/`rulesText` with `provenance: "placeholder"`; the owner drops
   verbatim strings in locally, flipping provenance to `owner-verified`.
5. `copies` expands a single row into N identical deck entries at load time.
