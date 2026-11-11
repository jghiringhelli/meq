import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { startNewGame } from './helpers';
import { makeShots } from './shots';

// Manual-style hero game, UI clicks only, with focused screenshots of each
// distinct action. Run with:
//   $env:PLAYTHROUGH=1; npx playwright test e2e/hero-playthrough.spec.ts --workers=1
// Output: test-results/hero-playthrough/ (images + notes.txt)
const OUT = 'test-results/hero-playthrough';
test.skip(!process.env.PLAYTHROUGH, 'manual playthrough');

const vis = (page: Page, sel: string) => page.locator(sel).first().isVisible().catch(() => false);

test('hero game from the UI with screenshots', async ({ page }) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const notes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const { snap, flush } = makeShots(page, OUT);

  await page.goto('/');
  await page.setInputFiles('input[accept=".vmod,.zip"]', path.resolve(process.cwd(), 'Middle_Earth_Quest_1.6.vmod'));
  await expect(page.locator('.art-status--on')).toBeVisible({ timeout: 30_000 });
  await snap('menu-art-loaded', { focus: '.art-status--on' });
  await page.getByRole('button', { name: 'New game' }).click();
  await snap('new-game-setup', { always: true });
  await page.getByRole('button', { name: 'Begin quest' }).click();
  await page.waitForTimeout(1500);
  await snap('game-start-full', { always: true });

  const clickF = async (loc: ReturnType<Page['locator']>) => { await loc.first().click({ force: true, timeout: 3000 }).catch(() => {}); };
  let last = '', same = 0, moves = 0, turnsEnded = 0, exploresDone = 0;
  for (let i = 0; i < 900; i++) {
    await page.waitForTimeout(150);
    let sig = 'idle';
    const act = async (tag: string, focus: string | undefined, loc: ReturnType<Page['locator']>) => {
      sig = tag; await snap(tag, { focus }); await clickF(loc);
    };

    if (await vis(page, '.game-over-banner')) { await snap('game-over', { focus: '.game-over-banner', always: true }); notes.push(await page.locator('.game-over-banner').innerText()); break; }

    if (await vis(page, '.cb-choice .cb-opt')) {
      const prep = await vis(page, '.cb-choice.prep');
      const opts = page.locator('.cb-choice .cb-opt:not(.declare)');
      await act(prep ? 'combat-prep' : 'combat-card-choice', '.cb-board', (await opts.count()) ? opts : page.locator('.cb-choice .cb-opt'));
      await page.waitForTimeout(200);
      await snap(prep ? 'combat-after-prep' : 'combat-after-card', { focus: '.cb-board' });
    } else if (await vis(page, '.choice-btn.primary:has-text("Continue")')) {
      await act('combat-summary', '.combat-summary', page.locator('.choice-btn.primary:has-text("Continue")'));
    } else if (await vis(page, '.tree-decision-overlay button:not([disabled]), .tree-decision-float button:not([disabled])')) {
      await act('tree-decision', '.tree-decision-overlay, .tree-decision-float', page.locator('.tree-decision-overlay button:not([disabled]), .tree-decision-float button:not([disabled])'));
    } else if (await vis(page, '.travel-modal')) {
      await snap('travel-modal', { focus: '.travel-modal' });
      sig = 'travel-confirm'; await clickF(page.locator('.travel-modal button.primary'));
      await page.waitForTimeout(500);
      await snap('after-travel', { focus: '[data-testid=board]' });
    } else if (await vis(page, '.choice-modal .choice-btn:not([disabled]), .choice-overlay .choice-btn:not([disabled])')) {
      await act('choice-modal', '.choice-modal', page.locator('.choice-overlay .choice-btn:not([disabled])'));
    } else if (await vis(page, '.enc-tray-ok')) {
      await act('reveal-tray', '.enc-tray', page.locator('.enc-tray-ok'));
    } else if (await vis(page, 'button.enc-tray-card.applies:not([disabled])')) {
      await act('tray-pick', '.enc-tray', page.locator('button.enc-tray-card.applies:not([disabled])'));
    } else if (await vis(page, '.enc-options .enc-option:not([disabled])')) {
      await act('encounter-option', '.enc-resolve-main, .enc-options', page.locator('.enc-options .enc-option:not([disabled])'));
    } else if (await vis(page, '.enc-resolve-main button.primary')) {
      await act('encounter-resolve', '.enc-resolve-main', page.locator('.enc-resolve-main button.primary'));
    } else if (await vis(page, '.hero-step-panel button:has-text("Continue")')) {
      await act('hero-step', '.hero-step-panel', page.locator('.hero-step-panel button:has-text("Continue")'));
    } else if (await vis(page, '.actions button.danger')) {
      await snap('engage-available', { focus: '.hero-step-panel, .actions' });
      await act('engage', undefined, page.locator('.actions button.danger'));
    } else if (await vis(page, '.actions button:has-text("Complete quest")')) {
      await act('complete-quest', '.actions', page.locator('.actions button:has-text("Complete quest")'));
    } else if (await vis(page, '.actions button:has-text("Rest")') && moves === 0 && turnsEnded === 0) {
      await snap('hero-turn-start', { focus: '.hero-step-panel' });
      await snap('map-arrows', { focus: '[data-testid=board]' });
      sig = 'rest'; await clickF(page.locator('.actions').getByRole('button', { name: 'Rest', exact: true }));
      await page.waitForTimeout(300);
      await snap('after-rest', { focus: '.hero-step-panel' });
      moves++;
    } else if (moves < 3 + turnsEnded && await vis(page, '.move-arrow')) {
      sig = 'move';
      await snap('arrows-before-move', { focus: '[data-testid=board]' });
      await page.locator('.move-arrow').last().dispatchEvent('click');
      moves++;
    } else if (await vis(page, '.actions button:has-text("Explore")') && exploresDone < 3) {
      sig = 'explore'; exploresDone++;
      await snap('before-explore', { focus: '.hero-step-panel, .actions' });
      await clickF(page.locator('.actions').getByRole('button', { name: 'Explore' }));
    } else if (await vis(page, 'button:has-text("End turn")')) {
      sig = 'end-turn'; turnsEnded++;
      await snap('before-end-turn', { focus: '.hero-step-panel, .actions' });
      await clickF(page.getByRole('button', { name: 'End turn' }));
    } else if (await vis(page, 'button:has-text("Advance phase")')) {
      await act('advance-phase', 'header, .phase-strip', page.getByRole('button', { name: /Advance phase/ }));
    }

    if (sig === last && sig !== 'idle') {
      if (++same > 12) { await snap(`STUCK-${sig}`, { always: true }); notes.push(`STUCK repeating ${sig}`); break; }
    } else if (sig === 'idle' && last === 'idle') {
      if (++same > 60) { await snap('STUCK-idle', { always: true }); notes.push('STUCK idle'); break; }
    } else { same = 0; last = sig; }
    if (i % 60 === 0) await snap(`progress-${i}`, { always: true });
  }
  notes.push(`moves=${moves} turnsEnded=${turnsEnded} explores=${exploresDone}`, `console/page errors: ${errors.length}`, ...errors.slice(0, 20));
  flush(notes);
  console.log(notes.join('\n'));
});
