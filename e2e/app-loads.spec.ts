import { test, expect } from '@playwright/test';
import { trackErrors } from './helpers';

test('app loads and shows the new-game landing screen', async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto('/');

  // The title header renders on every screen.
  await expect(page.getByRole('heading', { name: 'Middle-earth Quest' })).toBeVisible();

  // The landing screen offers a "New game" button and reports loaded assets.
  await expect(page.getByRole('button', { name: 'New game' })).toBeVisible();
  await expect(page.getByText(/heroes ·.*locations ·.*combat cards loaded/)).toBeVisible();

  expect(errors, `unexpected runtime errors:\n${errors.join('\n')}`).toEqual([]);
});
