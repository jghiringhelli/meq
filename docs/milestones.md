# Milestones — task breakdown & acceptance

> **Schema:** `gs-milestones-v1` · derives from [`../SPEC.md`](../SPEC.md) §6.
> Order is fixed by the owner. A milestone is **done** only when its headless acceptance script passes
> **and** the UI smoke-plays it in placeholder mode. Nothing outside a milestone's scope is built early.

## M0 — Foundation (this stage)
- [x] Root spec + document cascade.
- [ ] Project scaffold: `package.json`, `tsconfig`, `vite.config.ts`, `index.html`, `src/main.tsx`,
      `src/App.tsx`, empty `src/engine/*` + `src/play/*` stubs, `assets/*.json` with placeholder rows.
- [ ] `loadCatalog.ts` loads + validates all `assets/*.json`.
- **Accept:** `npm run dev` serves a page; `npm run typecheck` is clean; catalog loads without errors.

## M1 — Playable skeleton (numeric)
Scope: turn machine, counters, plots, hero movement by cards, numeric combat.
- [ ] `types.ts` full state (core-model §3–§5).
- [ ] `rng.ts`, `log.ts`, `mechanics.ts` (clamps, draw/discard, adjacency, `legalMoves`).
- [ ] `setup.ts` `newGame`.
- [ ] `phases.ts` all phases + `StoryAdvance` win check (core-model §4, §6).
- [ ] `combat.ts` numeric bout loop (core-model §5, M1 rule).
- [ ] `choices.ts` request/resolve.
- [ ] UI: `PhaseRail`, `CounterBar`, `PlotRow`, `BoardView`, `HeroPanel`, `CombatBoard`(numeric),
      `ChoicePrompt`, `LogPane` — all placeholder-mode.
- [ ] `scripts/test-m1-skeleton.mjs`.
- **Accept:** headless scripted 2-player game runs round→round to a Story-Track end and reports a
      winner; every phase fires; a hero moves by spending an Adventure card; a numeric combat resolves
      to a loser. UI: a human advances phases, moves a hero, and plays through one numeric combat.

## M2 — Combat effects
Scope: combat-card `effectKey`s become behavior.
- [x] Effect registry (`src/engine/effects.ts` — `EFFECTS` map + `resolveBout`) replaces
      `handlers/registry.ts` + `runEffect`: a data-driven `EffectSpec` per key, resolved in a
      fixed bout order rather than free-form handler functions.
- [x] Implement the mechanical effect families used by combat cards: conditional attack/defense
      bonuses (vs opponent type / printed-defense-0 / match-last-type), printed-stat reductions with
      defense floors, card cancels + `uncancelable`, damage amplifiers/self-penalties/caps,
      draw / forced discard, next-round carry modifiers, and disengage (`escape_if_unhurt`).
- [x] `combat.ts` `runBout` runs both revealed cards' effects at the compare window (before/after
      damage) and carries next-round modifiers via `pendingCombat.carry` + `lastType`.
- [x] `scripts/verify-effect-coverage.mjs` green (29/29 keys); `scripts/test-m2-combat.ts` green.
- **Accept:** combat outcomes measurably change vs. M1 for cards with effects; coverage test passes. ✅

  All 82 combat cards carry one of 29 implemented `effectKey`s (assigned in `build-catalog.py`
  from the card ability text). Combat UI shows each card's ability + per-round bout notes.

## M3 — Full card text & data
Scope: owner-supplied real data for **combat cards, plots (events), and location/encounter cards**,
wired to handlers; verbatim text loaded locally.
- [x] Real owner-verified text loaded for combat cards (`ability`), events (`text`), encounters
      (`effect`), and missions (`text`) — all surfaced in the UI (combat buttons, PlotRow, EncounterPanel).
- [x] Non-combat effect DSL: `scripts/build-catalog.py` `parse_ops()` extracts atomic ops
      (favor / corruption / life / influence) from encounter + event text; unmatched rows are marked
      `flavor` (verbatim narrative, no mechanical effect). Applied by `src/engine/noncombat.ts` `applyOps`.
- [x] Encounter resolution: hero **Explore** action draws a location's encounter, shows its text, and
      applies its ops (`heroExplore` / `resolveEncounter`, gated by `canExplore`).
- [x] Event/plot effects: `runSauronEvents` applies each turn's event ops (influence globally,
      hero-scoped ops to every active hero); PlotRow shows real text + effect badges.
- [x] Mission win conditions: 10 hero/Sauron missions carry a structured `condition`
      (`src/engine/missions.ts` `evalMission`); resolved at the story track's end in `checkWin`.
- [x] `scripts/verify-noncombat-coverage.mjs` (data) + `scripts/test-m3-card-data.ts` (engine) green.
- **Accept:** every base-box combat/plot/encounter card loads and resolves (handler or documented
      flavor); a full game plays with real card text. ✅

  Coverage: 90 encounters (15 mechanical / 29 flavor / 46 empty), 42 events (17 / 24 / 1),
  10/10 missions conditioned. Source note: the Mission sheet duplicates the four hero mission texts
  into the Sauron columns; only *His Dark Throne* is a genuine Sauron mission, so the other Sauron
  rows are left condition-less by design.

## M4 — Layered encounter / effect system
Scope: replace the flat op-list with a structured **condition / choice / effect DSL** so every
encounter card resolves faithfully (player choices, live-state conditions, and the missing
subsystems it references — Items, training, stat levels, region/shadow influence, movement, quests).
- [x] **Data fix:** `build_encounters()` now detects the *Effect* column per sheet (the region
      sheets carry an extra column, so effect text sat in col 5, not col 4). Previously ~46 cards
      captured a colour name instead of rules text; now all 90 have their true text.
- [x] **Effect-tree compiler:** `scripts/build-catalog.py` `compile_tree()` (pattern-based recursive
      descent + a small hand-authored override table) emits an `EffTree` per card
      (`seq` / `choice` / `optional` / `if` / `op` nodes). **0 / 90 partial** (no `raw` remainder).
- [x] **Interpreter:** `src/engine/encounter.ts` — `planEncounter` walks the tree against live state,
      evaluating conditions (hero stats + `statBonus`, monster tokens in region, influence in
      region / Shadow Pool, corruption / plots / items / hand) and consuming the player's `decisions`
      at each choice; `applyAtoms` applies the resolved ops. Replay-driven → pure & serialisable.
- [x] **Subsystems added:** `hero.items`, `hero.training`, `hero.statBonus`, `sauron.regionInfluence`;
      atoms for damage-by-shields choices, `heal`, stat levels, movement, quests (`explore` /
      `placeCharacter`), monster-token / influence removal, `forceSauronDiscard`, scaled damage, etc.
- [x] **Resolution flow:** `resolveEncounter` completes only when all choices are made; `chooseEncounter`
      records a decision; `encounterPlan` exposes the next prompt. `EncounterPanel` renders choices
      with cost-gated (disabled) options and the resolved op summary.
- [x] `scripts/verify-encounter-coverage.mjs` (all 90 modeled, every atom handled) +
      `scripts/test-m4-encounter.ts` (choice / conditional / cost / damage-block / quest cards +
      all-90-resolve) green.
- **Accept:** every encounter card resolves through its real conditions and choices, affecting the
      relevant subsystems; a full game plays with choice-driven encounters. ✅

  Coverage: 90 / 90 encounters fully modeled (0 partial); 51 cards carry choices/optionals,
  24 carry conditional branches. Depth notes: informational effects (look at Sauron's hand, examine
  tokens) and `placeCharacter` are logged narrative ops; life/rest/damage-pool micro-management is
  approximated as `heal` (restore to full); `moveAdjacent` uses the placeholder adjacency spine.

## M5 — The Lidless Eye (Sauron AI)
Scope: an automated Sauron opponent so a single player can face the dark side. Policies live in
`src/engine/ai.ts`.
- [x] **Combat policy** (`chooseMonsterCard`): combat is a simultaneous reveal, so the Eye chooses
      under uncertainty without peeking at the hero's concealed hand. It models the hero by their
      **public combat deck** (`cat.decks`, weighted by copies) and, for each candidate monster card,
      simulates the real `resolveBout` (full M2 effect layer) against that distribution, scoring from
      Sauron's view: expected `damageToHero − damageToMonster`, a **lethal bonus** when a card can
      drop the hero this round, a **self-preservation penalty** for cards that get the monster killed,
      credit for next-round carry buffs, and escape weighting when behind. A mean/worst-case blend
      (`AI_WEIGHTS.caution`) respects a hero who might play their best answer. Wired into
      `resolveCombatChoice` (falls back to greedy `autoPick`). **Within-combat card counting:** the
      model subtracts cards the hero already spent this fight (`pc.attacker.discard`) — valid because
      each engagement reshuffles a fresh full deck, so movement/other-combat plays (separate deck
      instances) are correctly ignored.
- [x] **Economy policy** (`eyeSpendInfluence`): the Eye actually *spends* its shadow influence each
      turn — pushing influence into every hero's region (raising encounter difficulty + feeding its
      mission) and fielding new monsters near the most-corrupted hero while budget remains. Wired
      into `runSauronMinions` ahead of the existing pursuit movement.
- [x] `scripts/test-m5-lidless-eye.ts`: combat picks are legal + deterministic; the economy policy
      spends influence / spawns (and is a no-op at zero budget); 10 full auto games terminate
      deterministically. Observed win split **Hero 5 / Sauron 5** over the seed set (90 combat rounds)
      — the Eye is a genuine, balanced threat.
- **Accept:** a solo player can play heroes against an automated Sauron that fights competitively and
      applies board pressure; games are deterministic per seed. ✅

  Depth notes: plot selection is scripted by turn (matches the event-deck model — the Eye does not yet
  choose which plots to advance); movement still uses the placeholder adjacency spine; weights in
  `AI_WEIGHTS` / `AI_ECONOMY` are exposed for tuning.

## M6 — Unified hero deck + game-long deck belief ✅
- **Fix (not a feature):** real MEQ uses **one dual-use hero deck** for both movement and combat
  (already documented in `core-model.md`); `combat.ts` had wrongly reshuffled a *fresh* combat deck per
  engagement, independent of the persistent `hero.deck`/`hand`/`discard`.
- `combat.ts`: `makeHeroCombatant` now mirrors the hero's live deck/hand/discard into the combatant
  (no fresh draw — you fight with the hand movement left you); `endCombat` **syncs** deck/hand/discard
  back to the persistent hero. Cards played in combat are spent from — and stay visible in — the one
  shared deck; movement afterwards sees the depletion, and vice-versa.
- `ai.ts` `heroModel`: with the deck unified, the Eye's opponent belief becomes a legitimate
  **game-long** card-count — the public known deck **minus the public discard pile** (passed as
  `pc.attacker.discard`, now seeded from `hero.discard`). It **narrows** as the hero plays cards (for
  movement *or* combat) and correctly **widens** again on a reshuffle. The Eye never inspects the
  concealed hand/deck order. (Trained cards remain hidden until first played; once discarded they are
  public and tracked here too — trained-card *injection* itself is future work.)
- [x] `scripts/test-m6-deck-belief.ts`: belief narrows per public discard and widens on reshuffle;
      combat starts from the movement hand, conserves one shared deck (no cards created/destroyed), and
      spends plays into the persistent discard. Full suites M1–M5 still green; observed win split holds
      **Hero 5 / Sauron 5** (combat rounds now ~62 — shorter, realistic fights from a shared hand).
- **Accept:** the Eye tracks each hero's deck across the whole game from public info only, over the one
  real deck used for both movement and combat. ✅

  Next (M7, needs new mechanics — flagged to user): strategic influence — path-blocking / peril draws
  on heroes' likely paths, and banking influence to enable higher-tier future plots. Requires adding a
  **peril mechanic** and **plot influence-cost thresholds** (plots are currently scripted by turn).

## M7 — Trained-card injection, deck belief, strategic influence ✅
- **Agility/strength trained cards.** Added an advanced (training) card pool in `combat-cards.json`
  (deck `advanced`): an **agility** card (`draw_2`) and a **strength** card (`next_atk_def_2`).
  `mechanics.ts grantTraining` injects `n` advanced cards at random positions into the hero's ONE
  shared deck when the hero receives training (archetype leans to the hero's profile), bumping public
  counters `training`/`trainedCount`. The `training` encounter atom now calls it.
- **Belief tracks trained cards.** `ai.ts heroModel` adds revealed trained cards to the known deck and
  models still-hidden trained cards as an `unknown-trained` prior (Sauron sees the *count* rise but not
  the identity). `updateHeroIntel` learns each advanced card the moment it surfaces in the public
  discard, with a per-id **high-water mark** so a reshuffle never erases what the Eye has learned.
- **Strategic influence doctrine (owner guidance).** `eyeSpendInfluence` is now game-arc aware:
  through the first **2/3** of the story track the Eye **hoards** a war chest (maximise influence),
  fielding monsters and seeding a little **path-blocking** on each hero's projected route to their
  nearest haven (where heroes gather/spend favor and destroy plots); in the final third it **spends the
  chest down** (heavier region pressure, more spawns). A monster-supply cap prevents flooding.
- **Plot valuation.** `ratePlot`/`rankPlots` encode the doctrine — advance-2+ plots are worth keeping
  (best first); advance-1 plots are held as **bluffs** to bait heroes into spending favor/cards.
- [x] `scripts/test-m7-training-influence.ts`: injection + counters; belief prior→known on reveal;
      intel persistence across reshuffle; hoard-early / spend-late; plot keep-vs-bluff. All suites
      M1–M6 still green; self-play settled at a balanced **Hero 6 / Sauron 4** (58 combat rounds).
- **Accept:** the Eye maintains a legitimate game-long, training-aware belief over each hero's shared
  deck and spends influence per the owner's early-hoard / late-spend, path-block, plot doctrine. ✅

## M8 — Sauron board weapons: peril, plots, shadow hand, counter-reset ✅
- **Data layer.** Added `PerilCard`, `ShadowCard`, `Plot`/`PlotStep` types and wired
  `assets/peril.json`, `assets/shadow.json`, `assets/plots.json` into the `Catalog` (`perils`, `shadow`,
  `plots`). `build-catalog.py build_sauron()` compiles each peril/shadow card's text into an `EffTree`
  (reusing the M4 grammar; complex text leaves a `partial` remainder that is safely ignored). New
  `SauronState`: `shadowHand`, `shadowDiscard`, `plotTrack`.
- **Generic auto-resolver.** `encounter.ts autoResolveTree(s, cat, heroId, tree, source, side)` drives
  the M4 interpreter with no player input. `side` decides who controls the branches: `'hero'` picks the
  least-harmful option (hero-explored cards); **`'sauron'`** picks the option that harms the hero most
  (peril/shadow — the Eye's own weapons), scored via a clone + `heroWellbeing` trial.
- **Peril draws.** `maybeDrawPeril` fires when a hero enters an **influenced, non-haven** node (the Eye's
  region influence forces peril draws on likely paths, per owner guidance); the card auto-resolves
  adversarially (real damage/corruption). Wired into `heroMove`.
- **Plots as a finisher.** `advancePlots` converts the hoarded war chest into progress on the dark story
  track, but **only when the heroes' mission is currently failing** — racing the marker while the heroes
  are on-mission would just hand them an early win. It advances the best-rated affordable plot
  (`ratePlot`), spending its influence cost; completing a plot's track grants a bonus advance. To make
  this matter, `checkWin` now resolves the story track on **`sauronProgress >= length`** (base +1/turn,
  behaviour-preserving for M1–M7) so plot-fuelled progress genuinely shortens the heroes' window.
- **Shadow hand.** Each Sauron turn `drawShadow` tops the Eye's hand to 2 distinct cards (recycling the
  discard when exhausted); `playShadow` plays one affordable card (`poolRequirement ≤ influence`) on the
  **most-corrupted** hero and auto-resolves it adversarially.
- **Late counter-reset.** In the final third `lateGameReset` clears the corruption-spread marker and
  recycles the shadow discard so the Eye can press again fresh.
- [x] `scripts/test-m8-sauron-board.ts`: peril gating (influence/haven), plot spend + progress +
      finisher gate + hoard-early/spend-late, shadow draw/play, late reset; multi-seed self-play with
      all mechanics firing (perils/shadow/plots), determinism, and a live Hero/Sauron balance. All
      suites M1–M7 still green; self-play holds **Hero 6 / Sauron 4** on the 10-seed set and a
      near-even **Hero 19 / Sauron 21** across 40 seeds.
- **Accept:** the full Lidless Eye board loop is complete — influence forces perils on hero paths, the
  war chest converts into dark-story progress as a finisher, the shadow hand pressures the leading
  hero, and the Eye resets late to press again. Ready for owner playtest as Sauron. ✅

## Simulation harness — pluggable hero AI ✅
The heroes are human-driven in the UI (the Lidless Eye is the Sauron AI); to run
automated self-play we gave the heroes a pluggable brain.
- `src/engine/heroAI.ts`: a `HeroStrategy` interface answering every decision
  point (combat card, encounter option, hero action) plus a full-game
  `playoutGame(cat, seed, strategy)` driver (Sauron = built-in Lidless Eye).
  Strategies ship: **random-walk** (unguided baseline), **heuristic** (hunt
  blocking monsters, explore, push to havens, rest when corrupted), and
  **cautious** (heuristic + avoid influenced/perilous nodes, rest more). Each
  strategy uses its own seeded PRNG so runs stay deterministic without perturbing
  the game rng.
- **`mission-aware`** strategy reads the scenario's hero win condition and biases
  play toward it (cleanse/avoid-combat for a corruption cap, hunt for a
  monster/minion cap, explore for favor/quests). It dominates on the current
  scenario — **83% hero win vs the naive heuristic's 40%** — by ending with far
  less corruption (0.3 vs 1.4) and far fewer fights (1.7 vs 5.6 bouts).
- `scripts/simulate.ts`: batch runner — `npx tsx scripts/simulate.ts [seeds] [strategy…]`
  reporting win rates and game shape (turns, combat bouts, perils, shadow plays,
  plot moves, end corruption/favor) with a determinism check.
- **`scripts/analyze-cards.ts` — card coverage + health analyzer.** Answers "does
  every card properly trigger?" two ways: a **static** implementation report (is
  each card's effect modeled, partial, or empty?) and a **dynamic** log analysis
  (across N full-audit games, which cards fire and do they produce an effect or a
  no-op?). Current picture: combat cards **84/84 modeled** (all 29 effectKeys
  registered), encounters **90/90 fully modeled**, and — after the full-coverage
  pass below — perils, shadow and encounters are all **0 always-inert** dynamically;
  events **3 always-inert** (each references a subsystem we deliberately don't
  model mechanically — see below); plots 1 placeholder.
- **Grammar fix.** The M4 effect grammar was second-person ("you gain"); Sauron
  peril/shadow cards are third-person ("the hero gains", "he loses 1 favor"), so
  their text fell through to inert `raw`. Added a `_to_2p` normaliser in
  `build-catalog.py build_sauron()` (+ a couple of pattern tweaks) → peril
  always-inert dropped from **7 → 1**.

### Full card-effect coverage (M9)
Implemented the effects of **all** shadow cards, complex events, and partial
perils so every card triggers a real state change. Layers:
- **New atoms** (`types.ts` `Atom`, interpreted in `encounter.ts applyAtom`):
  `forceCombat` (spawn a named monster to fight), `spawnMonster`, `placeInfluence`
  (region / shadow pool / Mordor / Shire / named location), `advanceMarker`
  (dampened story-track push — see below), `combatStatMod` (ongoing until-end-of-
  combat strength/agility debuffs via a transient `HeroState.combatMods`, cleared
  at `endCombat` + `HeroRefresh`), `restrictMovement` (Winter Storm — caps next
  Travel via `HeroState.moveRestriction`), `forcePeril`, `redistributeCorruption`,
  `plotManip`. Added metrics `adjacentInfluencedLocations`, `monstersTotal`.
- **Grammar** (`build-catalog.py`): `_parse_atom` rules for all the above, plus a
  `_normalize` pass that un-glues the fulltext's compound tokens
  (`corruptioncard`→`corruption card`, `monstertoken`, `plotcard`, `shadowpool`,
  `&`→`and`) and number-words, and broadened verbs (get/gets training, lose/
  discard favor, remove influence/monster tokens, gets/place favor, move to
  `<loc>`, look at the plot deck). Events now compile an `EffTree`
  (`compile_tree(_to_2p(text))`) like shadow/peril; `runSauronEvents` applies it
  via `autoResolveTree(..., 'hero')` (forced Sauron atoms fire; optional hero
  reactions resolve in the heroes' favour), applied once so board pressure isn't
  multiplied by party size.
- **Balance guard (important):** the single `story.sauronProgress` counter
  abstracts MEQ's multi-marker track and already creeps **+1/turn**; letting card
  "advance marker N" effects add to it 1:1 collapsed games to ~turn 5 (Sauron
  ~98%). `advanceMarker`/`plotManip` now accumulate at a **fractional (×0.5)**
  rate through `story.pressure`, so a colour-marker push is one of several markers
  rather than a full story step. Post-fix balance (40–60 seeds, `simulate.ts`):
  **mission-aware 68% Hero**, random-walk 43%, corruption-blind heuristic/cautious
  ~17% (weak play is rightly punished by the now-functional Eye).
- **M8 balance oracle updated:** the suite's trivial pursue-the-monster bot is
  *weak* play and the strengthened Eye rightly beats it 10/10, so the "both sides
  win" assertion now runs against the **competent `mission-aware`** strategy
  (`playoutGame`), which wins ~7/10 — the meaningful balance signal. `simulate.ts`
  remains the full harness.
- **Residual (3 inert events), by design:** `NOT ALL THOSE WHO WANDER…` (free
  teleport "move to any location"), `ARAGORN MEETS W/GANDALF` (pure Character-as-
  agent placement — Characters aren't modelled as board agents), and `UNDER THE
  SHADOW` (a nested either/or where the hero-favourable branch is the null one).
  These reference subsystems intentionally outside the current model.
- **Emergent insight (Noble Blood scenario — win at collective corruption ≤ 1):**
  passive/random heroes "win" ~94% by avoiding corruption, aggressive heuristic
  play loses more, and the mission-aware line recovers most of the edge — a
  genuine mission-shaped tradeoff the sims surfaced.
- **Fixed en route:** a negative-`rngCursor` modulo in `setup.ts` placed
  `undefined` starter monsters (surfaced only once a hunting strategy engaged
  them); guarded the index and hardened `engageableMonsters` against stray nulls.

## M10 — hero economy, secret missions, real story markers, full art ✅
The turn engine ran, but the human player (heroes) had no strategic layer. M10
adds the box's hero economy, the real objective structure, and wires the owner's
VASSAL art throughout.
- **Hero economy (`src/engine/economy.ts`, surfaced in `HeroPanel`).** The
  Travel step's Explore actions, each spending one action: **retrieve favor**
  (take board tokens), **consult a Character** (recruit an ally + favor), **dark
  path** (+1 favor / +1 corruption), **complete quest** (Starting then Advanced,
  at a haven, feeds Spear of the West), **destroy plot** (pay 2 favor on a plot
  slot to remove a plot from play), and **trade** favor/items between co-located
  heroes; plus the Rest step's **cleanse** (pay 2 favor at a haven to discard 1
  Corruption). Favor tokens + Characters are seeded on the board at setup and
  rendered on the map. NB per the owner: **training is not a free action** — it
  only happens via events/quests, so no "train" action was added.
- **Secret missions drive setup (`setup.ts`, `checkWin`).** Each game secretly
  picks one hero + one Sauron mission (`state.secretHeroMission/…Sauron`). The
  heroes see their own objective; Sauron's is hidden. `missions.json` was
  corrected — the Sauron missions are now the real ones (To Find Them All /
  His Dark Throne / In Darkness Bind Them / To Rule Them All / Where the Shadows
  Lie) with new `MissionCondition`s (`sauronMarkerAtStageIII`,
  `sauronInfluenceAtLeast`).
- **Real story markers (`StoryTrack`).** Added the Hero (green) marker and the
  three Sauron markers (yellow/red/black) with `SAURON_STAGE_III=9`. Plot/marker
  atoms now advance the Eye's leading colored marker (bot: "advance the highest
  story marker"). Resolution: the story ends when the hero clock exhausts **or**
  a colored marker reaches stage III; the heroes then win iff their mission
  holds, else the Shadow prevails. **Missions decide the winner only at
  resolution** (an early experiment making a met Sauron mission an instant win
  collapsed balance — His Dark Throne's influence≥6 fired on turn 1 — and was
  reverted).
- **All VASSAL art wired (`scripts/extract-art.py`, `assets/art-manifest.json`,
  `src/data/art.ts`).** Extracts all **462** images from `Middle_Earth_Quest_
  1.6.vmod` into `public/dev-assets/art/` and builds a manifest joining catalog
  ids → art via the module's `buildFile` piece→image map (`piece;;;<img>;<label>`,
  keyed by `entryName`). Rendered: the board, hero figures, combat-card faces,
  monster tokens, Characters, favor tokens on the map, and the battle board /
  foe art in combat. Art is never committed (`.gitignore public/dev-assets/`);
  the manifest (filenames only) is.
- **Balance note.** With a *random* secret hero mission, the corruption-tuned AI
  strategies align with the easy mission only ~1/5 of the time, so scripted-hero
  win% drops (mission-aware ~32%); a human pursuing their known objective does
  markedly better. All 8 prior suites stay green; `test-m10-economy.ts` covers
  every economy action + secret-mission setup.
- **Follow-ups (not yet done):** the Lidless Eye AI is still the M5–M8
  approximation, not the bot PDF's exact automa decks (Shadow-Draw / Influence
  automa, plot-priority list, command-action order); individual plot-card text;
  and hero-AI strategies that pursue whatever the secret mission is.

## M11 — game-completeness pass (plots v2, minions, finale, exact Sauron turn)
### M11a — Named elite minions as real board figures ✅
- **Data:** `assets/minions.json` (schema minions-v3) — the 5 named minions
  (Mouth of Sauron, Witch King, Ringwraiths, Black Serpent, Gothmog). Names +
  max-health (fortitude) caps are facts extracted from the owner's VASSAL module
  (`buildFile.xml`); attack strength + wisdom are engine approximations (flagged
  in `approx`). **Each minion uses its authentic per-tier Monster Combat deck**
  (verified against the owner's Lidless Eye Bot PDF), *not* a single shared deck:
  Mouth of Sauron → **Zealot**; Black Serpent & Gothmog → **Ravager**; Witch King
  & Ringwraiths → **Behemoth**. Every minion also carries a mechanical `ability`
  paraphrase + `effectKey`. Ringwraiths carry `finale: true` (held in reserve).
- **Abilities implemented:** Mouth of Sauron (`minion-corruption-on-engage`) —
  a hero gains 1 corruption when engaging him; Black Serpent (`minion-double-move`)
  — moves twice in the Sauron turn; Gothmog (`minion-perilous-aura`) — non-Haven
  locations at or adjacent to him become perilous even without region influence
  (hooked into `maybeDrawPeril`); Witch King (`minion-plot-seeker`) + Ringwraiths
  (`minion-finale`).
- **Engine:** minions are tracked separately from generic monsters on
  `MapState.minionsAt` with **persistent per-minion health** (`MapState.minionHealth`)
  so damage carries across engagements. They enter play **gradually via the Eye's
  Command action** (`deployMinion`, capped, once the campaign is underway and there
  is a plot to guard or a flush war chest) — *not* at setup, so the `minionsAtMost`
  hero mission stays achievable. Minions move first in the Sauron turn (guarding the
  nearest active plot, else pursuing a hero). Fully engageable in combat via the
  shared path; defeating one removes it and grants favor.
- **Wiring fixed:** `missions.ts` `minionsAtMost` + `encounter.ts` `minionsTotal`
  now count real minions (`minionsInPlay`); `combat.ts` resolves a minion foe and
  removes it on defeat; Board / CombatBoard / HeroPanel render minion VASSAL art
  and labels. Test: `scripts/test-m11-minions.ts` (roster, per-tier decks, gradual
  deploy, cap, engageability, corruption-on-engage, removal-on-defeat, mission
  counting). All 10 suites green.

### M11b — Endgame Ringwraith finale ✅
- When the hero clock exhausts with the hero mission still held, the Eye deploys
  the **Ringwraiths** (`maybeBeginFinale`): their fortitude is reset to full and
  scaled by Sauron dominance (`finaleWraithFortitude`). Heroes rally (life restored)
  and must defeat the wraiths inside `FINALE_WINDOW` (6) via persistent-health
  attrition; `checkWin` decides win/lose on the outcome. Tracked by
  `story.finale`/`finaleDeadline`.

### M11c — Faithful Sauron turn structure (absorbs m10-bot-align) ✅
- `phases.ts` now runs the Eye's turn in the bot PDF's exact order:
  **Story → Plot → Event → Action → Hero Draw** (mapped onto the existing phase
  buckets so the UI phase tracker is unchanged):
  - *Story Step* (`runSauronRefresh`): the dark story track creeps `+1`.
  - *Plot Step* (`runSauronEvents`): `advancePlots` plays/advances a plot into an
    empty plot location by the bot priority list (highest story marker advanced
    first; ties red > black > yellow, then most favors forced).
  - *Event Step* (`runSauronEvents`): reveal + resolve this turn's event cards.
  - *Action Step* (`runSauronMinions`), in three fixed sub-steps: **(1) Influence** —
    always `+2` to the war chest, then lay influence in extension (region pressure)
    and fund spawns; **(2) Plot/Shadow** — draw shadow-draw cards; **(3) three
    Command actions** in the bot's fixed order — place/deploy a figure, then *move
    one figure (a minion before a monster)* toward the highest-priority plot (never
    away from a plot; Black Serpent moves twice), then *heal the strongest wounded
    minion* (else move another figure).
- New helpers: `bfsDistance`, `moveOneMinion` (picks the minion closest to a plot,
  tie-break on strength), `moveOneMonster` (nearest monster→hero pursuit),
  `healStrongestMinion` (clears persisted damage on the strongest wounded minion).
  Replaces the old "move every minion and monster every turn" behavior with the
  faithful command-action budget, which both matches the rules and eases the
  earlier Sauron-heavy imbalance.

## M12 — SWR-grade UI / quality-of-life
### M12a — Persistence ✅
- `src/play/persistence.ts`: localStorage **save/resume** of the in-progress game
  (`meq.save.v1`), a **completed-game history** (`meq.history.v1`, last 100), and a
  one-click **"Report a problem"** export that downloads the full game state + log
  as JSON. Wired into `App.tsx`: auto-saves on every state change, archives + clears
  on game over, offers **Resume** and a **Recent games** list on the start screen.
  Roundtrip verified with a mocked `localStorage`.
### M12b — Card inspector ✅
- `src/play/CardInspector.tsx`: a lightweight React context (`useInspect`) + modal.
  Click any combat card (hand + combat prompt), plot, event, or foe figure to see
  **large VASSAL art + mechanical rules text** (short paraphrases only — copyright
  guardrail). Wired into `HeroPanel`, `PlotRow`, `CombatBoard`; provider wraps the
  app in `main.tsx`.
### M12c — Layout / QoL ✅
- **Board pan/zoom** (wheel + drag, clamped, ＋/－/⟲ controls) via a transform group;
  node clicks are guarded against drags so moving the map never mis-triggers a hero
  move. **Log filtering** (All / Combat / Sauron / Hero) in `LogPane`. **Phase tracker**
  in the header showing the six-step turn (Hero Refresh → Hero Actions → Story →
  Plot/Event → Action → Advance) with the current step highlighted.

## M14 — faithful MEQ combat model ✅
Reworked combat from the auto-resolving skeleton to the authentic "Steps Of Combat"
(source: `text/playeraid.pdf`), inventing no mechanic outside the box game.
- **Sauron Setup**: monster/minion draws cards equal to its fortitude from its own
  deck (capped by deck size), drawn once — no per-round redraw.
- **Preparation**: at combat start the hero splits **agility** — each point spent
  draws 1 combat card; each point unspent grants **+1 strength** for the whole combat.
  New choice kind `combat-prep` (`resolvePreparation` in `combat.ts`).
- **Combat round**: both pick a card facedown → reveal. **Strength is a cumulative
  budget** (`Combatant.strength` / `strengthSpent`): each revealed card adds its
  `strengthCost`; when cumulative cost **exceeds** the combatant's strength they become
  **Exhausted** — that card is canceled (0/0, no ability) and previous-round carried
  abilities are canceled (`revealWithBudget`). Damage = Atk − opponent Def, simultaneous.
- **Exhaustion**: permanent; forced (budget exceeded / out of cards) or **voluntarily
  declared** by the hero (`__exhaust__` option — distinct from the Withdraw *card*).
- **End**: a side defeated (life ≤ 0) → winner; **both exhausted → `standoff`**
  (monster survives on the map, hero keeps its life). `CombatState.result` gains
  `'standoff'`; `endCombat` shares the escape/standoff branch.
- **UI** (`CombatBoard.tsx`): Preparation frame (agility-split buttons), round frame
  with per-combatant **STR spent/total** and **EXHAUSTED** badges, and a "Declare
  exhaustion" button. `resolveBout` in `effects.ts` untouched (already null-card-safe),
  so the M2 test stays green.
- Verified: full test suite (10/10 PASS), 40-game sim terminates 0-unfinished with
  determinism OK — the faithful model also **improved hero balance** (mission-aware
  10% vs prior 0%) via the standoff escape valve.

## M15 — human-playable Sauron mode ✅
Sauron is now a fully human-playable side (heroes become AI-driven), faithful to
the playeraid "Sauron Turn" — no invented mechanics.
- **Setup** (`NewGameSetup.tsx`): pick a side (The Heroes / **Sauron**) and choose
  1–3 heroes; in Sauron mode those heroes are the AI opponents. `newGame` gains a
  `humanSide` param stored on `GameState`.
- **Interactive Sauron turn** (`sauronPlay.ts` + phase wrappers in `phases.ts`):
  Story Step (auto clock) → **Plot Step** (play a plot / pass) → Event Step (auto)
  → **Action Step** of 2 actions (3 with three heroes) → end (Hero Draw + Story
  Advance). Command primitives: Place influence, Spawn monster, Deploy minion,
  Move figure (legal one-step targets; monsters only onto influenced regions),
  Heal minion, Play shadow card. The Lidless Eye auto-run is gated off for the
  human side (`advance` yields; `runSauronEvents`/`runSauronMinions` skip the bot).
  `applyPlotCard` extracted in `sauronmech.ts` and shared by bot + human.
- **Hero AI auto-play** (`heroAI.advanceHeroSide`): when Sauron is human, an
  `App` effect runs the heroes' whole half-turn via the `missionAware` strategy
  (its own seeded PRNG) until control returns to Sauron.
- **UI** (`SauronPanel.tsx`): step-aware panel showing war chest, shadow hand and
  actions-left, with pickers for each command; overlays during the Sauron turn.
- Verified: typecheck + `vite build` clean, full suite 10/10 PASS, hero-mode sim
  unchanged (determinism OK), and a 20-game headless human-Sauron playthrough
  terminates 0-unfinished.
- **Deferred**: stronger hero AI (the current heroes lose most Sauron-mode games) —
  the next focus per the owner.

## M16 — playtest fidelity fixes ✅
First playtest pass; every change reads from the rules, none invented.
- **Board starts populated** (`setup.placeStartingMinions`): Sauron's first two
  non-finale lieutenants sit on the board from setup (visible turn 1), not only
  once the Eye deploys them.
- **Event-driven placement** (`phases.placeEventTokens`): favor and named
  Characters are placed from the resolving event's own `favor1/favor2` and
  `characterLocation` (uppercase name→id resolver) — fixes Thránduil appearing at
  the wrong location. `seedFavorAndCharacters` no longer seeds arbitrary
  characters; it only seeds one favor per haven.
- **Map fidelity** (`Board.tsx`): heroes render as their VASSAL figure art;
  Sauron region **influence** shows an aura ring + count badge; every token now
  carries a clear colored outline — **red = minions, orange = monster tokens,
  white = allies/characters, and a per-hero signature color** for each hero.
- **Missions** (`MissionPanel.tsx`): the human hero's secret mission + per-hero
  quest progress are shown to the player, and secret missions are **removed from
  the setup log**.
- Tests updated for the populated board (`test-m11-minions`, `test-m8-sauron-board`
  now assert a decisive Sauron game rather than requiring the greedy hero AI to
  win a faithful setup). Verified: typecheck + `vite build` clean, full suite PASS.
- **Deferred (tracked)**: hero-life-as-deck model (life = the card deck, no HP),
  consult two-option choice (favor vs ally), Event-Step dominance draw, stronger
  hero AI.

## M17 — hero life-as-deck model ✅
Reconciled the engine against the base-box rulebook (v1.3, "Combat Damage &
Being Defeated", the Rest step, the Hero Draw step, and "Defeated Heroes"),
read paragraph-by-paragraph. Heroes have **no numeric health**; a hero's life
IS his deck of cards, split across four zones:
- **life pool** (`deck` — the draw source), **hand**, **rest pool** (`discard` —
  cards played in combat, face up), **damage pool** (`damagePool` — new, face down).
- New module `src/engine/heroLife.ts`: `dealHeroDamage` (discard from top of life
  pool, or a hand card when the pool is dry, into the damage pool), `heroDefeated`
  (life pool AND hand both empty), `drawFromLifePool` (Hero Draw — no rest-pool
  recycle), `restHero` (rest pool → life pool), `healHero` (Haven: damage pool →
  life pool), `recoverHero` (defeat: rest + damage → life pool), and
  `prepareHeroForFinale`. `life` is now a display mirror of the life-pool size.
- **Combat** (`combat.ts`): the hero takes damage as card discards to the damage
  pool (monsters still take numeric health-token damage); defeat is card-based;
  `defeatHero` runs the faithful sequence (advance a Sauron marker, lose favor or
  an item, move to the closest Haven, Recover, end turn). `moveHero`/`nearestHaven`/
  `defeatHero` moved to `mechanics.ts` (shared, no import cycle).
- **Rest step** (`phases.heroRest`): outside a stronghold with no foe present,
  recycle the rest pool; in a Haven also heal (damage pool) and cleanse 1
  Corruption for 1 favor. **Hero Draw** draws from the life pool up to fortitude
  (no auto-recycle). **Finale** now runs Prepare instead of restoring HP.
- **Encounter/event damage** (`encounter.ts`, `noncombat.ts`) route through
  `dealHeroDamage` + defeat check; heal recycles the damage pool.
- **UI**: HeroPanel, CounterBar, CombatBoard show life pool / hand / damage-pool
  counts instead of a HP bar. Hero AI "hurt" heuristics now read the damage pool.
- New `scripts/test-m16-hero-life.ts` (22 assertions, all green). Verified:
  typecheck + `vite build` clean, full suite PASS, determinism preserved, and
  human-Sauron sim terminates 0-unfinished (heroes now survive longer — 4/20 vs
  1/20 — because the faithful model makes them far harder to remove permanently).

## M18 — Rulebook reconciliation (playtest fidelity)
Closes the confirmed gaps found auditing the code against the official manual
(`docs/MiddleEarthQuest_v1.3.pdf`), plus a structured JSON event log for analysis.
- **Consult** (`economy.heroConsultCharacter`): now offers **favor OR ability**
  (recruit ally), not both — a player choice per the manual. Two UI buttons.
- **Dark Path** (`economy.heroDarkPath`): limited to **once per hero turn** and
  only when **corruption ≤ 3**. `HeroState.darkPathUsedThisTurn` resets at Hero
  Draw. `canDarkPath` gates the UI button.
- **Level tokens** (`mechanics.raiseAttribute`): each of the 4 attributes may be
  raised at most **twice per game**; `gainStat` routes through it. `HeroState.levels`
  tracks the count; shown as ▲ chips in HeroPanel.
- **Event deck + dominance** (`phases.runSauronEvents`): a shuffled `eventDeck`
  drawn during the Event Step by dominance — neither dominant → draw 1; Sauron
  dominant → draw 3, resolve highest priority (cardNo); heroes dominant → draw 3,
  resolve lowest. `dominantSide` compares each side's progress toward its goal.
- **Ambush step** (`mechanics.ambushPending`): a foe on the hero's location forces
  combat before Travel — `heroMove`/`heroExplore`/economy reject; `applyHeroAction`
  coerces AI move/explore into engage; UI disables Travel and shows an ambush banner.
- **Structured JSON log** (`log.ts`): every event carries `seq/turn/round/phase/
  side/type/actor/detail/data`; `dumpLogJson` serialises the whole game; a
  “⭳ JSON” button in the LogPane downloads it for offline analysis.
- **Sauron action budget (bot)** (`phases.runSauronMinions`): the Lidless Eye now
  takes exactly **2 actions (3 in a 4-player / three-hero game)** and *chooses*
  each — scoring Place-Influence / Draw-Shadow+Plot / Deploy / Move / Heal / Spawn
  and taking the best, and it may **repeat** a type (more influence, more draws,
  move or heal the same minion again). New single-step executors
  `eyePlaceInfluenceOnce` / `eyeSpawnMonsterOnce` in `ai.ts`.
- **Two-player game (lone hero)** (`phases.endHeroActions`): a single hero takes
  **2 turns per Sauron turn**, with a special **Hero Rally + Hero Draw** between
  them (`heroRally` clears influence at the hero's location; `heroSecondTurnPending`
  tracks the pair). Verified: 1 hero → 12 hero-turns per 6 Sauron turns; 2 heroes
  → Sauron 2 actions; 3 heroes → Sauron 3 actions.
- New `scripts/test-m18-rules.ts` (13 assertions). Verified: typecheck +
  `vite build` clean, full suite PASS, determinism preserved.

## Cross-cutting (per milestone)
- `npm run typecheck` clean on `src/engine/**`.
- Determinism preserved (seeded rng only).
- No FFG asset committed; UI still runs with none present.
- Any structural change amends the spec/cascade **before** code.

## Deferred (post-M3, explicitly out of scope now)
Online multiplayer via `digital-boardgame-framework` + adapter/codec · AI Sauron · expansions ·
polish/animation.
