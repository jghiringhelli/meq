# UI Architecture

> **Schema:** `gs-ui-v1` · derives from [`../SPEC.md`](../SPEC.md) §3 and [`engine.md`](engine.md).
> React + Vite. Components call the engine directly and hold `GameState` in React state. **No game
> rules in the UI** (engine.md). Inspired by the reference `PlayTab` layout, adapted to MEQ's map +
> hero-panels + phase-rail + plot-row + combat-board.

## Placeholder-asset policy (SPEC §1 rule 2)
The UI must be fully playable with **zero FFG art**. Every image renders through a single
`<Art src fallback />` wrapper: if the file is missing under `public/dev-assets/`, it draws an
original placeholder (a labeled colored shape) instead of a broken `<img>`. Board locations render as
labeled nodes on an SVG graph when no board image is present. This is the deployed/default mode; art is
a local opt-in enhancement.

## Component tree (`src/play/`)
```
PlayTab                      ← owns GameState, wires engine ↔ view; hot-seat controller
├─ PhaseRail                 ← current round/phase; "advance phase" button; whose turn
├─ CounterBar                ← Story Track, per-hero Life/Corruption, Sauron Influence
├─ PlotRow                   ← Sauron's active plots + step progress (counters)
├─ BoardView (SVG)           ← locations as nodes, path edges, hero + minion tokens
│   └─ LocationNode          ← click to select move target when it's a legal move
├─ HeroPanel (× seats)       ← active hero: hand of Adventure cards, actions remaining, gear
│   └─ AdventureCardView     ← play/move; disabled when not legal
├─ CombatBoard               ← shown while pendingCombat ≠ null
│   ├─ CombatantStrip (×2)   ← hp counters, hand (own side only)
│   └─ RevealArea            ← select-and-reveal one combat card; shows numeric compare (M1)
├─ ChoicePrompt              ← renders pendingChoice options; calls resolveChoice
└─ LogPane                   ← scrollable event log (audit; engine log.ts)
```

## Interaction model
- One `state`; every user action calls an engine function and replaces `state` with the result.
- Legal-move highlighting is derived by asking the engine (`mechanics.legalMoves(state)`), never
  recomputed in the component.
- Hot-seat: `PlayTab` shows only the active seat's hidden hand; a "pass device" interstitial appears at
  seat handoff. Combat reveals are staged so neither side sees the other's pick before both commit.
- In `vite dev`, `state` is mirrored to `game-logs/latest.json` on every action (reference debug loop).

## Dev tabs (optional, `?dev=1`)
Mirror the reference's data-inspector tabs: `heroes`, `locations`, `adjacency`, `cards`, `plots` —
render each `assets/*.json` collection as a table for catalog QA. Not shipped to normal players.

## Styling
Single `styles.css`; dark parchment theme; counters are the primary visual language (SPEC M1 wants
"phases with counters and plots" visible first). No dependency on art for legibility.
