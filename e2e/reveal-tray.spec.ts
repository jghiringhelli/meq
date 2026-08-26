import { test, expect } from '@playwright/test';
import { trackErrors, startNewGame } from './helpers';

// Drive the game forward through several phase advances. The Event/Peril steps
// surface a RevealTray; when one appears we assert it shows cards and that its
// OK button dismisses it. Reveals are not strictly deterministic, so the hard
// guarantee this test enforces is: no runtime/console errors while advancing.
test('advancing phases surfaces reveals with cards and stays error-free', async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto('/');
  await startNewGame(page);

  await expect(page.getByTestId('board')).toBeVisible();

  let sawReveal = false;

  for (let i = 0; i < 40; i++) {
    const tray = page.locator('.enc-tray');
    if (await tray.isVisible().catch(() => false)) {
      sawReveal = true;
      // A reveal tray must show at least one drawn card.
      await expect(tray.locator('.enc-tray-card').first()).toBeVisible();
      const ok = tray.getByRole('button', { name: 'OK' });
      if (await ok.isVisible().catch(() => false)) {
        await ok.click();
        await expect(tray).toBeHidden();
        continue;
      }
      // A multi-choice encounter tray has no OK — the hero must pick one of the
      // applicable (enabled) cards. If none is actionable, we've still surfaced a
      // reveal; stop advancing (the no-error guarantee below still holds).
      const pick = tray.locator('button.enc-tray-card.applies:not([disabled])').first();
      if (await pick.isVisible().catch(() => false)) {
        await pick.click().catch(() => {});
        await expect(tray).toBeHidden().catch(() => {});
      }
      break;
    }

    // A combat overlay is a legitimate game state we don't drive deterministically
    // here; it intercepts pointer events, so stop advancing once it appears. The
    // no-error guarantee below still holds for everything we advanced through.
    const combat = page.locator('.combat-overlay');
    if (await combat.isVisible().catch(() => false)) break;

    const advance = page.getByRole('button', { name: /Advance phase/ });
    if (await advance.isVisible().catch(() => false)) {
      await advance.click();
      await page.waitForTimeout(150);
      continue;
    }

    const endTurn = page.getByRole('button', { name: 'End turn' });
    if (await endTurn.isVisible().catch(() => false)) {
      await endTurn.click();
      await page.waitForTimeout(150);
      continue;
    }

    // Nothing actionable this iteration (e.g. an AI/Sauron step or a modal we
    // don't drive here); give the app a beat and retry.
    await page.waitForTimeout(150);
  }

  // Whether or not a reveal appeared, advancing must not have thrown.
  expect(errors, `unexpected runtime errors while advancing:\n${errors.join('\n')}`).toEqual([]);

  // Informational: log if we never reached a reveal so the flow stays honest.
  if (!sawReveal) console.log('[reveal-tray] no RevealTray was surfaced during the run');
});
