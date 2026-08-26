import { test, expect } from '@playwright/test';
import { trackErrors, startNewGame } from './helpers';

test('starting a new game renders the board and HUD without runtime errors', async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto('/');
  await startNewGame(page);

  // The board/map and the CounterBar HUD must render after starting.
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('hud')).toBeVisible();

  // Sanity-check the HUD shows the Story Track / Sauron counters.
  await expect(page.getByText('Story Track')).toBeVisible();
  await expect(page.getByTestId('hud').locator('.counter.sauron')).toContainText('influence');

  // Guard against the assignStartingQuest crash and any other uncaught error
  // during new-game setup.
  expect(errors, `unexpected runtime errors during new game:\n${errors.join('\n')}`).toEqual([]);
});
