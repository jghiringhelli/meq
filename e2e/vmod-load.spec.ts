import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Throwaway smoke test: load the real .vmod through the ArtLoader UI and assert
// the browser unzip + match pipeline reports (near-)full coverage. The module
// is copyrighted and gitignored, so skip when it isn't present locally.
test('loads art directly from the .vmod module', async ({ page }) => {
  const vmod = path.resolve(process.cwd(), 'Middle_Earth_Quest_1.6.vmod');
  test.skip(!fs.existsSync(vmod), 'Middle_Earth_Quest_1.6.vmod not present (BYO copyrighted module)');
  await page.goto('/');
  await page.setInputFiles('input[accept=".vmod,.zip"]', vmod);
  const summary = page.locator('.art-loader__summary').filter({ hasText: 'matched' });
  await expect(summary).toBeVisible({ timeout: 30_000 });
  const text = await summary.textContent();
  const m = text?.match(/matched (\d+) \/ (\d+)/);
  expect(m).not.toBeNull();
  const matched = Number(m![1]);
  console.log('[vmod] summary:', text?.trim());
  expect(matched).toBeGreaterThan(300);
});

