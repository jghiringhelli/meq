import { test, expect } from '@playwright/test';
import { trackErrors } from './helpers';

// Human Sauron vs AI heroes: setup hand choice, Sauron-first turn, turn-1 skips,
// and the step-by-step hero stepper.
test('playing Sauron: choose starting hand, then step through the heroes', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = trackErrors(page);
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/');
  await page.getByRole('button', { name: 'New game' }).click();
  await page.getByRole('button', { name: /Sauron/ }).first().click();
  await page.getByRole('button', { name: 'Command Sauron' }).click();

  // 1. Influence placement first.
  await expect(page.getByText(/extend your starting influence/)).toBeVisible();
  for (let i = 0; i < 12 && await page.getByText(/extend your starting influence/).isVisible(); i++) {
    const spot = page.locator('svg circle:has(title)').filter({ has: page.locator('title', { hasText: /Place influence at/ }) }).first();
    if (!await spot.isVisible().catch(() => false)) break;
    await spot.click({ force: true });
    await page.waitForTimeout(100);
  }

  // 2. Then the starting-hand choice.
  await expect(page.getByText('choose your starting hand')).toBeVisible({ timeout: 10_000 });
  const boxes = page.locator('.sauron-keep input[type=checkbox]');
  const n = await boxes.count();
  expect(n).toBeGreaterThan(2);
  await expect(page.getByRole('button', { name: 'Confirm starting hand' })).toBeDisabled();
  const labels = await page.locator('.sauron-panel .prompt').allInnerTexts();
  const keeps = labels.map((t) => /Keep (\d+) of/.exec(t)?.[1]).filter(Boolean).map(Number);
  expect(keeps.length).toBe(2);
  // tick first K shadow, then first K plot
  const shadowCount = Number(/of (\d+) Shadow/.exec(labels[0])![1]);
  for (let i = 0; i < keeps[0]; i++) await boxes.nth(i).check();
  for (let i = 0; i < keeps[1]; i++) await boxes.nth(shadowCount + i).check();
  await page.getByRole('button', { name: 'Confirm starting hand' }).click();

  // 3. Hand is visible; turn 1 skips Story/Plot.
  await expect(page.locator('.sauron-hand')).toBeVisible();
  await expect(page.getByText(/Story and Plot steps are skipped/)).toBeVisible();
  await page.getByRole('button', { name: 'Begin first turn' }).click();
  await expect(page.getByText(/Plot Step skipped on the first turn/)).toBeVisible();
  await page.getByRole('button', { name: /Resolve events/ }).click();

  // Sauron's event may ask a hero to choose.
  for (let i = 0; i < 4; i++) {
    const d = page.locator('.tree-decision-overlay button').first();
    if (await d.isVisible().catch(() => false)) { await d.click(); await page.waitForTimeout(150); }
  }
  // 4. Spend the actions, end the turn.
  const endBtn = page.getByRole('button', { name: 'End Sauron turn' });
  for (let i = 0; i < 8 && await endBtn.isDisabled(); i++) {
    await page.getByRole('button', { name: /Draw cards/ }).click();
    await page.waitForTimeout(150);
  }
  await endBtn.click();

  // 5. Heroes act one step at a time, behind a Continue button.
  const step = page.locator('.hero-step-panel');
  await expect(step).toBeVisible({ timeout: 10_000 });
  await expect(step).toContainText('Heroes:');
  await step.getByRole('button', { name: /Continue/ }).click();
  await expect(step.locator('.hero-step-results')).toBeVisible({ timeout: 5_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
