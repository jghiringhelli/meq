import type { Page } from '@playwright/test';

// Attach uncaught-error and console-error collectors to a page. Returns an
// array that accumulates any runtime error surfaced by the app so a test can
// assert it stayed empty. This is how we catch regressions such as the
// "Cannot convert undefined or null to object at assignStartingQuest" crash.
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore noisy network/resource 404s for missing art assets — those are
      // not game-logic errors and are unrelated to the flows under test.
      if (/Failed to load resource|net::ERR|404|favicon/i.test(text)) return;
      errors.push(`console.error: ${text}`);
    }
  });
  return errors;
}

// Start a brand-new game from the app's landing screen: dismiss any resume
// confirm dialog, open the setup screen, and begin the quest with the default
// hero selection. Leaves the page on the in-game board.
export async function startNewGame(page: Page): Promise<void> {
  // Auto-accept the "delete saved game?" confirm() if one appears.
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.getByRole('button', { name: 'New game' }).click();
  // NewGameSetup: default heroes are pre-selected; just begin.
  await page.getByRole('button', { name: 'Begin quest' }).click();
}
