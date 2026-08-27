import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { trackErrors, startNewGame } from './helpers';

// Drive a real game through the ACTUAL UI (a human hero vs the Sauron AI),
// always clicking the first actionable control, and after EVERY UI action read
// the live engine state (window.__MEQ_STATE__, a DEV-only hook) to assert the
// game stays legal — the same invariants the headless validator enforces, but
// exercised through the rendered React app. The hard guarantees: no runtime /
// console errors, the log never shrinks, and the state never goes illegal.

const PHASES = new Set(['HeroRefresh', 'HeroActions', 'SauronRefresh', 'SauronEvents', 'SauronMinions', 'StoryAdvance', 'GameOver']);

type UiState = {
  phase: string;
  winner: string | null;
  logLen: number;
  sauronPool: number;
  turn: number;
  heroes: { id: string; status: string; life: number; corruption: number; cards: number; favor: number; actions: number; location: string }[];
  pendingChoiceEmpty: boolean;
  pendingTreeNoOption: boolean;
  activeSide: string;
  humanSide: string;
  pend: string;
};

async function readState(page: Page): Promise<UiState | null> {
  return page.evaluate(() => {
    const s = (window as unknown as { __MEQ_STATE__?: unknown }).__MEQ_STATE__ as
      | null
      | {
          phase: string; winner: string | null; log: unknown[];
          sauron: { influence: number }; story: { turn: number };
          heroes: { id: string; status: string; life: number; corruption: number; corruptionCards: unknown[]; favor: number; actionsRemaining: number; location: string }[];
          pendingChoice?: { options?: unknown[] } | null;
          pendingTree?: { options?: { enabled: boolean }[]; actor?: string } | null;
          pendingCombat?: unknown; pendingCombatOrPeril?: unknown;
          pendingShadowReaction?: unknown; pendingEncounter?: unknown;
          activeSide: string; humanSide: string;
        };
    if (!s) return null;
    const pend = [
      s.pendingChoice && 'choice', s.pendingCombat && 'combat', s.pendingCombatOrPeril && 'combatOrPeril',
      s.pendingShadowReaction && 'shadowReaction', s.pendingTree && `tree(${s.pendingTree.actor})`,
      s.pendingEncounter && 'encounter',
    ].filter(Boolean).join(',');
    return {
      phase: s.phase,
      winner: s.winner ?? null,
      logLen: s.log.length,
      sauronPool: s.sauron.influence,
      turn: s.story.turn,
      heroes: s.heroes.map((h) => ({
        id: h.id, status: h.status, life: h.life, corruption: h.corruption,
        cards: h.corruptionCards?.length ?? 0, favor: h.favor, actions: h.actionsRemaining, location: h.location,
      })),
      pendingChoiceEmpty: !!s.pendingChoice && (!s.pendingChoice.options || s.pendingChoice.options.length === 0),
      pendingTreeNoOption: !!s.pendingTree && (!s.pendingTree.options || !s.pendingTree.options.some((o) => o.enabled)),
      activeSide: s.activeSide,
      humanSide: s.humanSide,
      pend,
    };
  });
}

function checkInvariants(s: UiState): string | null {
  if (!PHASES.has(s.phase)) return `illegal phase '${s.phase}'`;
  if (s.winner != null && s.winner !== 'Hero' && s.winner !== 'Sauron') return `illegal winner '${s.winner}'`;
  if (!Number.isFinite(s.sauronPool) || s.sauronPool < 0) return `shadow pool ${s.sauronPool}`;
  if (!Number.isFinite(s.turn) || s.turn < 0) return `turn ${s.turn}`;
  for (const h of s.heroes) {
    if (!Number.isFinite(h.life) || h.life < 0) return `${h.id} life ${h.life}`;
    if (!Number.isFinite(h.corruption) || h.corruption < 0) return `${h.id} corruption ${h.corruption}`;
    if (h.corruption !== h.cards) return `${h.id} corruption ${h.corruption} != cards ${h.cards}`;
    if (!Number.isFinite(h.favor) || h.favor < 0) return `${h.id} favor ${h.favor}`;
    if (!Number.isFinite(h.actions) || h.actions < 0) return `${h.id} actions ${h.actions}`;
    if (h.status !== 'active' && h.status !== 'defeated') return `${h.id} status '${h.status}'`;
  }
  if (s.pendingChoiceEmpty) return 'pendingChoice with no options';
  if (s.pendingTreeNoOption) return 'pendingTree with no enabled option';
  return null;
}

// Click the first actionable control in priority order. Returns a short tag of
// what it did, or 'idle' if nothing was actionable this tick.
async function step(page: Page, allowMove: boolean): Promise<string> {
  const clickFirst = async (locator: ReturnType<Page['locator']>, tag: string): Promise<string | null> => {
    const el = locator.first();
    if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
      await el.click().catch(() => {});
      return tag;
    }
    return null;
  };

  // 1. Interactive card decision (hero's Dark Promises / Peril / Event choice).
  const treeBtn = page.locator('.banner.tree-decision button:not([disabled])');
  let r = await clickFirst(treeBtn, 'tree');
  if (r) return r;

  // 2. Sauron banners (only when a human plays the Eye; harmless otherwise).
  r = await clickFirst(page.locator('.banner.combat-or-peril button'), 'combat-or-peril');
  if (r) return r;
  r = await clickFirst(page.locator('.banner.shadow-reaction button'), 'shadow-reaction');
  if (r) return r;

  // 3. Combat card / preparation choice.
  r = await clickFirst(page.locator('.cb-options .cb-opt:not([disabled])'), 'combat');
  if (r) return r;

  // 4. Generic choice modal (quest reward, etc).
  r = await clickFirst(page.locator('.choice-modal .choice-btn:not([disabled])'), 'choice');
  if (r) return r;

  // 5. Encounter reveal tray: confirm (OK) or pick an applicable card. Use
  //    class selectors + a short-timeout force click so a transient
  //    pointer-events/scroll state can never silently stall the driver.
  const okBtn = page.locator('.enc-tray-ok');
  if (await okBtn.isVisible().catch(() => false)) {
    await okBtn.click({ force: true, timeout: 4000 }).catch(() => {});
    return 'tray-ok';
  }
  const trayPick = page.locator('button.enc-tray-card.applies:not([disabled])');
  if (await trayPick.first().isVisible().catch(() => false)) {
    await trayPick.first().click({ force: true, timeout: 4000 }).catch(() => {});
    return 'tray-pick';
  }

  // 6. Encounter resolution overlay: choose an option or resolve.
  r = await clickFirst(page.locator('.enc-options .enc-option:not([disabled])'), 'enc-option');
  if (r) return r;
  const encResolve = page.locator('.enc-resolve-main button.primary');
  if (await encResolve.isVisible().catch(() => false)) {
    await encResolve.click({ force: true, timeout: 4000 }).catch(() => {});
    return 'enc-resolve';
  }

  // 7. Hero actions (HeroActions phase). Prefer turn-consuming, game-advancing
  //    actions so the hero side actually ENDS its turn and hands control to the
  //    Sauron AI (which drives the story to a conclusion). Explore surfaces
  //    encounters/combat; then we end the turn. Movement is bounded (see caller)
  //    and kept below End turn so it can never stall turn progression.
  r = await clickFirst(page.locator('.actions button.danger'), 'engage');
  if (r) return r;
  r = await clickFirst(page.locator('.actions').getByRole('button', { name: 'Complete quest' }), 'quest');
  if (r) return r;
  r = await clickFirst(page.locator('.actions').getByRole('button', { name: 'Explore' }), 'explore');
  if (r) return r;
  const moveTarget = page.locator('g.node.target');
  if (allowMove && await moveTarget.first().isVisible().catch(() => false)) {
    await moveTarget.first().click().catch(() => {});
    return 'move';
  }
  r = await clickFirst(page.getByRole('button', { name: 'End turn' }), 'end-turn');
  if (r) return r;
  r = await clickFirst(page.locator('.actions').getByRole('button', { name: 'Rest', exact: true }), 'rest');
  if (r) return r;

  // 8. Phase flow (non-HeroActions steps a human must click through).
  r = await clickFirst(page.getByRole('button', { name: /Advance phase/ }), 'advance');
  if (r) return r;

  return 'idle';
}

test('a full UI-driven game stays legal at every action', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);

  await page.goto('/');
  await startNewGame(page);
  await expect(page.getByTestId('board')).toBeVisible();

  let prevLogLen = -1;
  let idleStreak = 0;
  let moveStreak = 0;
  let finished = false;
  const actionTally: Record<string, number> = {};

  for (let i = 0; i < 600; i++) {
    const s = await readState(page);
    if (s) {
      const v = checkInvariants(s);
      expect(v, `invariant violated at iteration ${i}: ${v}\n  phase=${s?.phase} turn=${s?.turn} heroes=${JSON.stringify(s?.heroes)}`).toBeNull();
      if (s.logLen < prevLogLen) {
        expect(s.logLen, `log shrank ${prevLogLen} -> ${s.logLen} at iteration ${i}`).toBeGreaterThanOrEqual(prevLogLen);
      }
      prevLogLen = s.logLen;
      if (s.winner) { finished = true; break; }
    }

    const tag = await step(page, moveStreak < 3);
    actionTally[tag] = (actionTally[tag] ?? 0) + 1;
    moveStreak = tag === 'move' ? moveStreak + 1 : 0;
    if (tag === 'idle') {
      idleStreak++;
      await page.waitForTimeout(120);
      // Long idle usually means an AI (Sauron) step is running; keep waiting a
      // bounded number of times, then stop (no error — just nothing to drive).
      if (idleStreak > 25) {
        const st = await readState(page);
        const overlay = await page.locator('.combat-overlay, .enc-tray, .choice-modal, .banner').first()
          .evaluate((el) => (el as HTMLElement).outerHTML.slice(0, 1200)).catch(() => '(none)');
        console.log(`[full-game] idle stall at iter ${i}: phase=${st?.phase} active=${st?.activeSide} human=${st?.humanSide} pend=[${st?.pend}] turn=${st?.turn}`);
        console.log(`[full-game] overlay HTML:\n${overlay}`);
        break;
      }
    } else {
      idleStreak = 0;
      await page.waitForTimeout(60);
    }

    // Errors must stay empty throughout, not just at the end.
    expect(errors, `runtime errors at iteration ${i}:\n${errors.join('\n')}`).toEqual([]);
  }

  console.log(`[full-game] finished=${finished} actions=${JSON.stringify(actionTally)}`);
  expect(errors, `unexpected runtime errors:\n${errors.join('\n')}`).toEqual([]);
});
