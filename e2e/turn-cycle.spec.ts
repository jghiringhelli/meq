import { test, expect } from '@playwright/test';
import { trackErrors, startNewGame } from './helpers';

test('turn-cycle indicator is visible and shows the active hero', async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto('/');
  await startNewGame(page);

  const turnCycle = page.getByTestId('turn-cycle');
  await expect(turnCycle).toBeVisible();

  // It labels the turn order and names at least one hero seat.
  await expect(turnCycle.getByText(/Turn/)).toBeVisible();
  await expect(turnCycle.locator('.tc-name').first()).toBeVisible();

  expect(errors, `unexpected runtime errors:\n${errors.join('\n')}`).toEqual([]);
});
