# Contributing

Thanks for helping! This is a fan-made, non-commercial digital port of
*Middle-earth Quest*. Everyone is welcome: rules fixes, bugs, UI polish,
tests, translations, docs.

## Ground rules

1. **Faithful to the rulebook.** No balance changes or house rules in the
   default game. If you think a rule is implemented wrong, quote the rulebook
   page or card text in the issue/PR.
2. **Players decide.** If the physical game lets a player choose, the app must
   ask the player (never auto-pick for a human). The AI may auto-pick.
3. **No copyrighted art or scans.** The repo ships no artwork. Never commit
   the `.vmod`, card scans or images from the game. Card *data* lives in
   `assets/*.json` (generated, see below).
4. Be kind. See `CODE_OF_CONDUCT.md`.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npx tsc --noEmit   # typecheck
npm test           # engine tests (scripts/test-*.ts, verify-*.mjs)
npm run e2e        # Playwright (needs: npx playwright install chromium)
```

Load the free community VASSAL module from the start screen to see the art
(see README).

## Where things live

- `src/engine/` rules engine: pure functions, no UI. Most rules fixes go here.
- `src/play/` React UI. `src/net/` peer-to-peer multiplayer (PeerJS/WebRTC).
- `assets/*.json` card and map data. **Generated** by
  `scripts/build-catalog.py` from `text/`; fix data in the script (see
  `build_events` overrides) rather than only editing the JSON, or your fix is
  lost on the next regeneration.
- `docs/state-machine.md` phase flow; `docs/rules-digest.md` rules summary.
- `scripts/test-*.ts` focused engine tests; `e2e/` browser tests.

## Making a change

1. Open or comment on an issue first for anything non-trivial.
2. Branch from `main`, keep PRs small and focused.
3. Add a test for the behavior you fix (an engine test in `scripts/` named
   `test-*.ts` is picked up automatically by `npm test`).
4. Run `npx tsc --noEmit` and `npm test` before opening the PR. CI (`verify`)
   must pass.
5. In the PR, say what you verified and what you did not (e.g. "not tested on
   mobile").

## Good first contributions

- Cards whose text isn't implemented exactly (look for `good first issue` and `help wanted`).
- Missing marker locations or wrong card data (with the card photo or text).
- UI clarity: tooltips, quest descriptions, mobile layout.
- Strengthening the hero AI (it is currently passive).
- More tests for online play and reconnection.

## Reporting bugs

Use **Report a problem** inside the game: it downloads a JSON with the full
state and opens a prefilled issue. Attach that JSON.
