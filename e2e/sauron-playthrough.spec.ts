import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Manual-style full game as human Sauron, UI clicks only. Run with:
//   SAURON_PLAYTHROUGH=1 npx playwright test e2e/sauron-playthrough.spec.ts
// Screenshots + notes land in test-results/sauron-playthrough/.
const OUT = 'test-results/sauron-playthrough';
test.skip(!process.env.SAURON_PLAYTHROUGH, 'manual playthrough');

async function vis(page: Page, sel: string): Promise<boolean> {
  return page.locator(sel).first().isVisible().catch(() => false);
}

test('full Sauron game from the UI', async ({ page }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const notes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto('/');
  await page.getByRole('button', { name: 'New game' }).click();
  await page.getByRole('button', { name: /Sauron/ }).first().click();
  await page.getByRole('button', { name: 'Command Sauron' }).click();

  const seen = new Set<string>();
  let shot = 0;
  const snap = async (tag: string, always = false) => {
    if (!always && seen.has(tag)) return;
    seen.add(tag);
    await page.screenshot({ path: `${OUT}/${String(++shot).padStart(3, '0')}-${tag}.png` });
  };
  const clickMap = async (re: RegExp): Promise<boolean> => {
    const c = page.locator('svg circle:has(title)').filter({ has: page.locator('title', { hasText: re }) }).first();
    if (!await c.count()) return false;
    await c.click({ force: true });
    return true;
  };

  let turn = 0, last = '', same = 0, rot = 0, cop = 0;
  for (let i = 0; i < 1500; i++) {
    await page.waitForTimeout(120);
    let sig = 'idle';
    const click = async (name: string, loc: ReturnType<Page['locator']>) => { sig = name; await snap(name); await loc.first().click({ force: true }); };

    if (await vis(page, '.game-over-banner')) { await snap('game-over', true); notes.push(await page.locator('.game-over-banner').innerText()); break; }

    if (await vis(page, '.cb-choice .cb-opt')) {
      const opts = page.locator('.cb-choice .cb-opt:not(.declare)');
      await click('combat-choice', (await opts.count()) ? opts : page.locator('.cb-choice .cb-opt'));
    } else if (await vis(page, '.cb-min[aria-label="Place combat influence"]')) {
      sig = 'combat-influence'; await snap(sig);
      if (!await clickMap(/Place influence at/)) notes.push('combat influence owed but no map target');
    } else if (await vis(page, '.choice-btn.primary:has-text("Continue")')) {
      await click('combat-summary', page.locator('.choice-btn.primary:has-text("Continue")'));
    } else if (await vis(page, '.tree-decision-overlay button:not([disabled]), .tree-decision-float button:not([disabled])')) {
      await click('tree-decision', page.locator('.tree-decision-overlay button:not([disabled]), .tree-decision-float button:not([disabled])'));
    } else if (await vis(page, '.banner.combat-or-peril')) {
      await click('combat-or-peril', page.locator('.banner.combat-or-peril button').nth(cop++ % 2));
    } else if (await vis(page, '.banner.shadow-reaction')) {
      const b = page.locator('.banner.shadow-reaction button');
      await click('shadow-reaction', rot % 3 === 0 ? b.first() : b.last());
    } else if (await vis(page, '.enc-tray-ok')) {
      await click('reveal-tray', page.locator('.enc-tray-ok'));
    } else if (await vis(page, '.hero-step-panel button:has-text("Continue")')) {
      await click('hero-step', page.locator('.hero-step-panel button:has-text("Continue")'));
    } else if (await vis(page, '.setup-influence-banner')) {
      sig = 'setup-influence'; await snap(sig);
      await clickMap(/Place influence at/);
    } else if (await vis(page, 'button:has-text("Confirm starting hand")')) {
      sig = 'hand-chooser'; await snap(sig);
      const labels = await page.locator('.sauron-panel .prompt').allInnerTexts();
      const keeps = labels.map((t) => /Keep (\d+) of (\d+)/.exec(t)).filter(Boolean).map((m) => [Number(m![1]), Number(m![2])]);
      const boxes = page.locator('.sauron-keep input[type=checkbox]');
      for (let k = 0; k < keeps[0][0]; k++) await boxes.nth(k).check();
      for (let k = 0; k < keeps[1][0]; k++) await boxes.nth(keeps[0][1] + k).check();
      await page.getByRole('button', { name: 'Confirm starting hand' }).click();
    } else if (await vis(page, 'button:has-text("Begin first turn"), button:has-text("Begin Sauron turn")')) {
      turn++;
      await click('begin-turn', page.locator('button:has-text("Begin first turn"), button:has-text("Begin Sauron turn")'));
      notes.push(`turn ${turn} begins`);
    } else if (await vis(page, 'button:has-text("Resolve events")')) {
      const plots = page.locator('.sauron-plot-btn');
      if (await plots.count()) { await snap('plot-picker'); await plots.first().click(); await page.waitForTimeout(200); }
      await click('resolve-events', page.getByRole('button', { name: /Resolve events/ }));
    } else if (await vis(page, '.sauron-panel button:has-text("Done commanding")')) {
      sig = 'command';
      await snap('command-panel');
      const modes = ['Spawn monster', 'Deploy minion', 'Move figure', 'Heal minion'];
      const m = modes[rot++ % modes.length];
      await page.locator(`.sauron-mode-btn:has-text("${m}")`).click();
      if (m === 'Spawn monster' || m === 'Deploy minion') {
        const pick = page.locator('.sauron-picker button').first();
        if (await pick.count()) {
          await pick.click();
          await page.waitForTimeout(150);
          if (!await clickMap(/Target:/)) { notes.push(`${m}: no map target`); }
        }
      } else if (m === 'Move figure') {
        const sel = page.locator('.sauron-picker select');
        if (await sel.count() && (await sel.locator('option').count()) > 1) {
          await sel.selectOption({ index: 1 });
          await page.waitForTimeout(150);
          if (!await clickMap(/Move|Target:|→/)) notes.push('Move figure: no map target');
        }
      } else if (m === 'Heal minion') {
        const b = page.locator('.sauron-picker button').first();
        if (await b.count()) await b.click();
      }
      await page.waitForTimeout(200);
      if (rot % 4 === 0 || !await vis(page, '.sauron-panel button:has-text("Done commanding")')) { /* continue */ }
      else if (rot % 2 === 0) await page.locator('button:has-text("Done commanding")').click();
    } else if (await vis(page, '.sauron-picker:has-text("Place")')) {
      sig = 'place-influence'; await snap(sig);
      if (!await clickMap(/Place influence at/)) await page.waitForTimeout(100);
    } else if (await vis(page, 'button.end-turn')) {
      const endBtn = page.locator('button.end-turn');
      if (!await endBtn.isDisabled()) { await click('end-turn', endBtn); }
      else {
        const order = ['Command', 'Place influence', 'Draw cards', 'Play shadow'];
        const pick = order[rot++ % order.length];
        const b = page.locator(`.sauron-mode-btn:has-text("${pick}")`).first();
        sig = `action-${pick}`;
        await snap('action-tracks');
        if (await b.isEnabled().catch(() => false)) {
          await b.click();
          if (pick === 'Play shadow') {
            const s = page.locator('.sauron-picker button').first();
            if (await s.count()) { await snap('shadow-picker'); await s.click(); }
          }
        } else {
          const d = page.locator('.sauron-mode-btn:has-text("Draw cards")');
          if (await d.isEnabled().catch(() => false)) await d.click();
        }
      }
    }

    if (i % 40 === 0) await snap(`progress-${i}`, true);
    if (sig === last && sig === 'idle') {
      if (++same > 40) { await snap('STUCK', true); notes.push('STUCK idle: no recognised UI to act on'); break; }
    } else if (sig === last) {
      if (++same > 25) { await snap(`STUCK-${sig}`, true); notes.push(`STUCK repeating ${sig}`); break; }
    } else { same = 0; last = sig; }
  }

  notes.push(`console/page errors: ${errors.length}`, ...errors.slice(0, 20));
  const fs = await import('node:fs');
  fs.writeFileSync(`${OUT}/notes.txt`, notes.join('\n'));
  console.log(notes.join('\n'));
  expect(notes.filter((n) => n.startsWith('STUCK'))).toEqual([]);
});
