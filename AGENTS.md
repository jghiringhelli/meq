# Agent instructions for MEQ

Digital port of Middle-earth Quest (React + TypeScript engine, Playwright e2e).

## Standing rules

- **Human choices are never auto-resolved.** When a human controls a side (Sauron or a hero),
  nothing that is a choice (which card to keep, which pile, which target, which location…) may be
  decided by the AI. Only automatic things are automated. The AI decides only for AI-controlled sides.
- **Faithful to the rulebook** (`text/rules`, v1.3). No balance changes. If the rules and the data
  disagree, the rulebook wins; if the rules are ambiguous, ask the owner.
- Hidden information is real: a drawn monster token is random and only Sauron may look at it.
- New actions that a human performs must be added to the role map in `src/net/roles.ts`
  so online play works.

## Workflow

- Typecheck: `npx tsc --noEmit`. Unit/engine tests: `npm test` (`scripts/test-*.ts` are auto-discovered).
  E2E: `npx playwright test --workers=2` (`reveal-tray` is a known flaky spec).
- Add an engine test in `scripts/` for each rule fix.
- Commits end with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Reply to the owner in Spanish, concisely, and say what was not verified.
