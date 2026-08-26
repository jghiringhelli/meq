# Middle-earth Quest — Digital Port · Generative Specification (root)

> **Schema:** `gs-root-v1` · **Supersedes:** none · **Status:** draft M0
> **Methodology:** Generative Specification (Zenodo 10.5281/zenodo.21726017), tooled with ForgeCraft.
> A *stateless reader* (human or agent) must be able to derive correct output from this file plus
> the document cascade it links. Nothing architectural is left implicit.

---

## 0. What this is (Self-describing)

A non-commercial, fan-made, in-browser digital port of the Fantasy Flight Games board game
**Middle-earth Quest** (2009). One "Sauron" player opposes one to three "Hero" players. The port is a
**pure-function TypeScript engine** plus a **React + Vite** UI, mirroring the architecture of the
reference project `star-wars-rebellion` (studied locally under `reference-swr/`, not part of this repo)
and built on the public `digital-boardgame-framework` package.

This document is the **root**. It fixes purpose, scope, the domain model at a glance, the seven GS
property commitments, and the milestone contract. Every deeper decision is delegated to a linked
cascade document (§7). If a deeper document contradicts this one, **this one wins** until it is amended.

### Non-goals (Bounded — see also §6)
- No online multiplayer in M1–M3 (the framework supports it; deferred).
- No AI Sauron opponent in M1–M3 (hot-seat / pass-and-play only).
- No expansion content; **base box only**.
- No reproduction of FFG-copyrighted text or art in this repository (§1).

---

## 1. Intellectual-property boundary (Defended)

Middle-earth Quest and its text/art are © Fantasy Flight Games and the Tolkien estate. FFG has an
informal policy tolerating **non-commercial** fan tools; the reference project and its VASSAL module
operate under it. This project follows the identical model:

| Class of content | Where it lives | Committed to git? |
|---|---|---|
| **Engine code, UI code, schemas** (original work) | `src/`, `docs/`, `assets/*.json` structure | ✅ yes (MIT) |
| **Game *mechanics*** (rules as behavior — not copyrightable) | encoded in engine + `assets/*.json` | ✅ yes |
| **Verbatim card / rulebook prose, flavor text** | `assets/*.json` `rulesText` fields | ⚠️ user-populated locally; treated as reference data |
| **VASSAL-derived art (board, cards, tokens, figures)** | `vmod_extracted/`, `public/dev-assets/` | ❌ never — gitignored |

**Hard rules for any contributor or agent:**
1. Never commit files under `vmod_extracted/`, `public/dev-assets/`, `*.vmod`, `*.pdf`.
2. The engine and UI must run **without any FFG asset present** (text-mode / placeholder shapes),
   exactly as the reference deploy does. Art is a local enhancement, never a dependency.
3. `assets/*.json` ships with **structure, ids, numeric values, and effect keys** (mechanics).
   Human-readable `rulesText`/`name` may be blank or a paraphrase in the committed copy; the verbatim
   strings are dropped in by the owner locally from their own materials.

---

## 2. Domain model at a glance (Self-describing)

Full model in [`docs/core-model.md`](docs/core-model.md); this is the orientation sketch.

- **Sides:** exactly one `Sauron`; one to three `Hero` seats. Asymmetric.
- **Round = two turns:** a **Hero Turn** (each hero acts) then a **Sauron Turn**.
- **Map:** a graph of `Location` nodes grouped into regions, connected by `path` edges. Heroes and
  Sauron's minions occupy locations; movement is edge traversal paid for with cards.
- **Hero state:** a `Life` track, a `Corruption` track, a personal **Adventure deck** (movement +
  action cards), a hand, equipment/allies/skills gained in play, and a location.
- **Sauron state:** an `Influence` resource, an **active Plot** row (schemes that tick toward the dark
  victory), a Path/encounter deck, and minion figures on the map.
- **Story Track:** the shared master clock. Both sides advance markers; reaching an end state or a
  side's completion condition triggers scoring.
- **Combat:** local, card-driven. Both combatants hold a **Combat deck**; a bout is a sequence of
  **simultaneous reveals** of cards carrying a numeric value plus an optional effect. M1 resolves the
  **numeric** exchange; M2 adds effects; M3 wires per-card verbatim text/art.

Every noun above becomes a typed entity in `src/engine/types.ts` and, where it is data, a row in an
`assets/*.json` file with the reference schema shape `{ _meta, <collection>: [...] }`.

---

## 3. Architecture commitments (Composable)

Mirrors `reference-swr`; rationale in [`docs/engine.md`](docs/engine.md).

- **Engine** (`src/engine/`): pure functions, no React, no DOM, deterministic given a seeded RNG.
  `types.ts` (state), `setup.ts` (initial state from catalog), `phases.ts` (turn machine),
  `combat.ts` (combat sub-machine held in `state.pendingCombat`), `handlers/` (card/plot effect
  registry keyed by `effectKey`), `mechanics.ts` (shared helpers), `rng.ts`, `log.ts`, `codec.ts`.
- **Catalog/data** (`assets/*.json` → loaded by `src/data/loadAssets.ts`): heroes, locations,
  adjacency, combat cards, adventure cards, plots, encounters. Reference schema envelope reused.
- **UI** (`src/play/`): React components calling engine functions directly (no engine logic in the UI).
  A `PlayTab` root; board, hero panels, phase/counter rail, plot row, and a live combat board.
- **Adapter** (`src/adapter/`, deferred past M1): glue to `digital-boardgame-framework` for
  serialization/online. M1 may call the engine directly and keep state in React.
- **Determinism rule:** all randomness flows through `rng.ts`; no `Math.random` in engine or UI game
  logic. This is what makes states replayable and bug reports reproducible.

---

## 4. Verification (Verifiable)

Details in [`docs/engine.md`](docs/engine.md) §Testing. Commitments:

- `npm run typecheck` (`tsc --noEmit`) must be **zero errors** for `src/engine/**`.
- Every `effectKey` present in `assets/*.json` must have a registered handler; a coverage test
  (`scripts/verify-effect-coverage`) fails CI if a key is orphaned (mirrors the reference tripwire).
- Each milestone ships a headless engine test script under `scripts/` that plays a scripted game and
  asserts the milestone's acceptance criteria (§6) without a browser.
- The UI must render a full playable turn with **no FFG assets present** (placeholder mode) — a manual
  Playwright smoke check per milestone.

---

## 5. Auditability (Auditable)

- Engine emits a structured event log (`log.ts`) for every state transition; the UI mirrors it to
  `game-logs/latest.json` in `vite dev`, as the reference does, for agent-in-the-loop debugging.
- Data provenance: every `assets/*.json` carries `_meta.provenance` and `_meta.source` describing how
  its rows were derived and by whom, so verbatim-vs-paraphrase status is always inspectable.
- This spec and the cascade are versioned by `Schema:` header; changes are amendments, not silent edits.

---

## 6. Milestone contract (Bounded + Executable)

The build proceeds in the order the owner set. Full breakdown in
[`docs/milestones.md`](docs/milestones.md). Each milestone is **done only when its acceptance test
passes headlessly and the UI smoke-plays it**.

- **M1 — Playable skeleton.** Turn machine with all phases; visible **counters** (Life, Corruption,
  Influence, Story Track) and the **Plot** row; heroes **move** across the map by spending Adventure
  cards from their deck; combat resolves its **numeric** exchange (values only, no card effects).
  *Accept:* a scripted 2-player game runs round→round to a Story-Track end and reports a winner; UI
  shows every counter/phase and lets a human move a hero and win/lose a numeric combat.
- **M2 — Combat effects.** Combat cards carry an `effectKey`; `handlers/` implements the mechanical
  effects (damage modifiers, draws, discards, conditions). *Accept:* combat outcomes change per the
  effect handlers; effect-coverage test green.
- **M3 — Full card text & data.** Owner-supplied real data for **combat cards, plots, and location
  (encounter) cards** wired to `effectKey`s; verbatim `rulesText`/art loaded locally. *Accept:* every
  base-box card of those three classes is represented with a handler or documented as pure-flavor.

Nothing outside a milestone's scope is built early. If a milestone reveals a needed cross-cutting
change, it is amended here first.

---

## 7. Document cascade (Composable)

A stateless reader descends these in order; each is self-describing and cites this root.

| Doc | Purpose |
|---|---|
| [`docs/core-model.md`](docs/core-model.md) | Entities, state shape, exact tracks and their bounds. |
| [`docs/rules-digest.md`](docs/rules-digest.md) | Functional (paraphrased) breakdown of the rulebook into engine behavior. |
| [`docs/data-schemas.md`](docs/data-schemas.md) | JSON schema for every `assets/*.json` collection. |
| [`docs/engine.md`](docs/engine.md) | Engine architecture, module contracts, testing. |
| [`docs/ui.md`](docs/ui.md) | UI component tree, placeholder-asset policy, layout. |
| [`docs/milestones.md`](docs/milestones.md) | Task-level breakdown and acceptance tests per milestone. |

---

## 8. Glossary (Self-describing)

- **Catalog:** the immutable data loaded from `assets/*.json`; the "rules content".
- **State (`GameState`):** the mutable per-game snapshot the engine advances.
- **Effect key:** a string id on a card/plot row that names a handler function implementing its effect.
- **Bout / round of combat:** one simultaneous-reveal exchange inside `pendingCombat`.
- **Placeholder mode:** the UI rendering with original shapes/labels when no FFG art is present.
