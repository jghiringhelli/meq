# Rules Digest — functional breakdown

> **Schema:** `gs-rules-digest-v1` · derives from [`../SPEC.md`](../SPEC.md) and
> [`core-model.md`](core-model.md).
> This is a **paraphrased, mechanics-only** breakdown of the base-box rulebook into engine behavior.
> It is **not** the rulebook and contains no verbatim FFG prose (SPEC §1). Where a numeric value or an
> edge-case ruling is uncertain, it is marked **⟨owner⟩** and resolved from the owner's own materials.
> Each subsection names the engine module that owns the behavior.

## A. Round & turn order (`phases.ts`)
1. A round is **Hero Turn** then **Sauron Turn**, then a **Story Advance / win check**.
2. Hero Turn: seats act in fixed order. Each hero first refreshes (Hero Draw: draw a number of NEW
   cards equal to fortitude — cards accumulate, there is no hand limit — and reset the action
   budget), then spends its actions.
3. Sauron Turn: refresh (gain influence, draw path cards), resolve plots, then move/act minions.

## B. Hero actions (`phases.ts` + `handlers/`)
A hero spends up to **⟨owner⟩ 2** actions per turn, chosen from:
- **Move** — traverse one path edge per movement point; movement points come from **Adventure cards
  played from hand** (a card's `movementValue`). Entering a location may trigger its encounter deck.
- **Rest** — recover **⟨owner⟩** life and/or reduce corruption (typically only in safe/haven kinds).
- **Train** — acquire new Adventure/skill cards into the deck (cost/source **⟨owner⟩**).
- **Visit** — interact with the current location: draw/resolve an encounter, pursue a quest step,
  gather rumor/quest progress.
- **Play** — resolve a non-movement Adventure card's `effectKey`.
Combat opens when a hero and a minion share a location and either side engages (§E).

## C. Sauron turn (`phases.ts` + `handlers/`)
1. **Refresh:** gain **⟨owner⟩** influence; draw path cards to hand size.
2. **Plots:** Sauron may pay `influenceCost` to **launch** a new plot into the active row, and/or
   **advance** existing plots one `step`. Reaching the end of a plot's `track` fires its terminal
   `effectKey` (a dark-side gain / global effect). Heroes counter plots by reaching the plot's location
   and resolving the counter condition (**⟨owner⟩**).
3. **Minions:** move minions along path edges and resolve their location effects; engaging a hero opens
   combat.

## D. Tracks & counters (`mechanics.ts` + `heroLife.ts`)
- **Life = the hero's deck of cards** (no numeric HP). Cards live in four zones:
  **life pool** (`deck`, the draw source), **hand**, **rest pool** (`discard`,
  cards played in combat), and **damage pool** (`damagePool`, damage taken, face
  down). Damage discards from the top of the life pool (or a hand card when the
  pool is empty) into the damage pool; a hero is **defeated** when his life pool
  AND hand are both empty. Resting recycles the rest pool into the life pool;
  healing (in a Haven) recycles the damage pool; a defeated hero **Recovers**
  (rest + damage → life pool) at the closest Haven after Sauron advances a marker
  and the hero loses a favor or item. See `src/engine/heroLife.ts`.
- **Corruption** (per hero): raised by dark effects; at maximum the hero is **turned** (removed / flips
  to Sauron per **⟨owner⟩** rule) — a Sauron win vector.
- **Influence** (Sauron): the plot-fuel resource; gained on refresh, spent on plots/actions.
- **Story Track** (shared): the master clock. Both markers advance on qualifying events; the game ends
  when it is exhausted or a side meets its completion condition, whichever first (§F).

## E. Combat (`combat.ts`) — layered by milestone
- **M1 (numeric):** a bout = both combatants pick one **Combat card**, reveal simultaneously, compare
  `power`. Higher power deals damage to the loser's `hp` (**exact rule ⟨owner⟩**: difference vs. full
  value). Bouts repeat until one `hp` reaches 0 (that side loses / is defeated) or a legal disengage.
  Card `effectKey`s are queued but **not executed**.
- **M2 (effects):** before/after the numeric compare, each revealed card's `effectKey` runs via
  `handlers/` — damage modifiers, extra draws/discards, conditional wins, healing, etc.
- **M3 (data):** real per-card `power`, `effectKey`, `rulesText`, and art are loaded from
  `assets/combat-cards.json` (owner-populated).

## F. Victory (`phases.ts` StoryAdvance + `assets/scenario.json`)
Evaluated at each Story Advance, first match wins:
1. **Sauron completion** — plots/track condition met (**⟨owner⟩**), or all heroes defeated/turned.
2. **Hero completion** — the scenario quest goal met (**⟨owner⟩**).
3. **Track exhaustion** — Story Track full ⇒ compare markers/objectives; higher wins, tie rule
   **⟨owner⟩**.

## G. Determinism & hidden information
- All shuffles/draws use `rng.ts` seeded from `GameState.seed` (SPEC §3). No `Math.random`.
- Hidden hands (combat/adventure/path) are real state but the UI reveals only the active seat's hand;
  hot-seat relies on the human passing the device. Online (deferred) enforces this server-side.

## H. Confirmation checklist (feeds `assets/*.json`, not code structure)
`[ ]` roster/stats · `[ ]` locations+regions+coords · `[ ]` path costs · `[ ]` action budget ·
`[ ]` rest/heal amounts · `[ ]` corruption-turn rule · `[ ]` influence gain · `[ ]` plot costs/tracks ·
`[ ]` combat damage rule · `[ ]` defeat penalty · `[ ]` story-track length · `[ ]` win conditions.
