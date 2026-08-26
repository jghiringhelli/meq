# Engine Architecture

> **Schema:** `gs-engine-v1` · derives from [`../SPEC.md`](../SPEC.md) §3 and
> [`core-model.md`](core-model.md).
> The engine is a **pure-function TypeScript core**: no React, no DOM, deterministic given a seed.
> Every exported function takes `GameState` (and args) and returns a **new** `GameState` (immutable
> update) plus appended log events. This mirrors `reference-swr/src/engine`.

## Module map (`src/engine/`)

| Module | Owns |
|---|---|
| `types.ts` | All entity + state types (core-model §1–§6). No logic. |
| `rng.ts` | Seeded PRNG: `nextInt`, `shuffle`, `rollDie`. The **only** randomness source. |
| `log.ts` | `log(state, event)`, `pushNotice`; append-only event list. |
| `loadCatalog.ts` | Build immutable `Catalog` from parsed `assets/*.json`; validate id references. |
| `setup.ts` | `newGame(catalog, seed, seats) → GameState`: deal decks, place figures, set tracks. |
| `mechanics.ts` | Shared helpers: track clamps, adjacency/pathing, deck draw/discard, damage. |
| `phases.ts` | The turn machine (core-model §4): `advance(state)`, per-phase resolvers, win check. |
| `combat.ts` | Combat sub-machine (core-model §5): `beginCombat`, `revealBout`, `resolveBout`. |
| `choices.ts` | `requestChoice`, `resolveChoice`: the single decision surface for UI/AI/tests. |
| `handlers/registry.ts` | `EffectKey → handler` map; `runEffect(key, ctx)`. M2+ populates it. |
| `codec.ts` | (Deferred) serialize/deserialize `GameState` for the framework/online. |

## Contracts
- **Immutability:** resolvers return new state; never mutate the input. (Structural-share is fine.)
- **Determinism:** given identical `seed` + identical action sequence, states are byte-identical after
  `codec`. No wall-clock, no `Math.random`, no ambient I/O in the engine.
- **Suspension:** when a resolver needs a human/AI decision it sets `pendingChoice` and returns; the
  caller answers via `resolveChoice`, which resumes. Combat sets `pendingCombat` the same way.
- **Effect indirection:** cards/plots never contain code — they carry an `effectKey`; behavior lives in
  `handlers/`. Adding a card in M3 is data + (maybe) one handler, never an engine reshape.

## Effect handler shape (M2+)
```ts
type EffectCtx = { state: GameState; source: CardId; actor: Side; combat?: CombatState };
type EffectHandler = (ctx: EffectCtx) => GameState;
// registry.ts
export const handlers: Record<EffectKey, EffectHandler>;
export function runEffect(key: EffectKey, ctx: EffectCtx): GameState;
```

## Testing (SPEC §4)
- `npm run typecheck` — `tsc --noEmit`, **zero** errors in `src/engine/**`.
- `scripts/verify-effect-coverage.mjs` — every non-empty `effectKey` in `assets/*.json` has a handler;
  fails CI otherwise (reference tripwire pattern).
- Per-milestone headless script under `scripts/`:
  - `test-m1-skeleton.mjs` — scripted 2-player game runs to a Story-Track end; asserts a winner, that
    every phase fired, that a hero moved by spending a card, and that a numeric combat resolved.
  - `test-m2-combat-effects.mjs` — asserts effect handlers change combat outcomes.
  - `test-m3-card-data.mjs` — asserts every base-box combat/plot/encounter card row loads and either
    has a handler or is flagged pure-flavor.
- `scripts/run-all-tests.mjs` runs the suite (mirrors reference).

## What the UI may and may not do
The UI (`src/play/`) may **read** state and **call** engine functions (`advance`, `resolveChoice`,
`revealBout`, …). It must contain **no game rules** — any rule in a component is a bug to migrate into
the engine. This keeps the headless tests authoritative.
