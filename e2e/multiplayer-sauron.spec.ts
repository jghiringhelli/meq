import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { PeerServer } from 'peer';
import { trackErrors } from './helpers';

// Real peer-to-peer test for the scenario the user specifically asked to
// verify: one browser plays a hero, ANOTHER browser (a networked client)
// claims and plays SAURON. This is what src/play/SauronPanel.tsx +
// src/engine/actions.ts's sauron* Action variants + the App.tsx
// roster->humanSide sync effect exist to support — before that work, a
// remote client could not see or drive Sauron's turn at all.

const BROKER_PORT = 9413;
let broker: ReturnType<typeof PeerServer> | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  broker = PeerServer({ port: BROKER_PORT, path: '/' });
  await new Promise((r) => setTimeout(r, 500));
});

test.afterAll(async () => {
  broker?.close?.();
  broker = null;
});

async function useLocalBroker(page: Page) {
  await page.addInitScript((port) => {
    (window as unknown as { __MEQ_PEER__: unknown }).__MEQ_PEER__ = {
      host: 'localhost', port, path: '/', secure: false,
    };
  }, BROKER_PORT);
  page.on('dialog', (d) => d.accept().catch(() => {}));
}

type MiniState = { phase: string; activeSide: string; humanSide: string; winner: string | null; pend: string };

async function readMini(page: Page): Promise<MiniState | null> {
  return page.evaluate(() => {
    const s = (window as unknown as { __MEQ_STATE__?: unknown }).__MEQ_STATE__ as
      | null | {
          phase: string; activeSide: string; humanSide: string; winner: string | null;
          pendingChoice?: unknown; pendingTree?: { actor?: string } | null; pendingCombat?: unknown;
          pendingCombatOrPeril?: unknown; pendingShadowReaction?: unknown; pendingEncounter?: unknown;
        };
    if (!s) return null;
    const pend = [
      s.pendingChoice && 'choice', s.pendingCombat && 'combat', s.pendingCombatOrPeril && 'combatOrPeril',
      s.pendingShadowReaction && 'shadowReaction', s.pendingTree && `tree(${s.pendingTree.actor})`,
      s.pendingEncounter && 'encounter',
    ].filter(Boolean).join(',');
    return { phase: s.phase, activeSide: s.activeSide, humanSide: s.humanSide, winner: s.winner ?? null, pend };
  });
}

// Minimal hero-side UI driver: click through the first actionable control,
// same priority list as e2e/full-game-invariants.spec.ts's `step()`, trimmed
// to what a default fresh game actually needs to reach Sauron's turn.
async function heroStep(page: Page): Promise<string> {
  const clickFirst = async (locator: ReturnType<Page['locator']>, tag: string): Promise<string | null> => {
    const el = locator.first();
    if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
      await el.click().catch(() => {});
      return tag;
    }
    return null;
  };
  let r = await clickFirst(page.locator('.banner.tree-decision button:not([disabled])'), 'tree');
  if (r) return r;
  r = await clickFirst(page.locator('.cb-options .cb-opt:not([disabled])'), 'combat');
  if (r) return r;
  r = await clickFirst(page.locator('.choice-modal .choice-btn:not([disabled])'), 'choice');
  if (r) return r;
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
  r = await clickFirst(page.locator('.enc-options .enc-option:not([disabled])'), 'enc-option');
  if (r) return r;
  const encResolve = page.locator('.enc-resolve-main button.primary');
  if (await encResolve.isVisible().catch(() => false)) {
    await encResolve.click({ force: true, timeout: 4000 }).catch(() => {});
    return 'enc-resolve';
  }
  r = await clickFirst(page.locator('.actions').getByRole('button', { name: 'End turn' }), 'end-turn');
  if (r) return r;
  r = await clickFirst(page.locator('.actions').getByRole('button', { name: 'Rest', exact: true }), 'rest');
  if (r) return r;
  r = await clickFirst(page.getByRole('button', { name: /Advance phase/ }), 'advance');
  if (r) return r;
  return 'idle';
}

test('a remote client can claim and play Sauron over the network', async ({ browser }) => {
  test.setTimeout(180_000);
  const hostCtx: BrowserContext = await browser.newContext();
  const clientCtx: BrowserContext = await browser.newContext();
  const host = await hostCtx.newPage();
  const client = await clientCtx.newPage();
  const hostErrors = trackErrors(host);
  const clientErrors = trackErrors(client);

  try {
    await useLocalBroker(host);
    await useLocalBroker(client);

    // --- Host: start an online game playing the Hero side (default). ---
    await host.goto('/');
    await host.getByRole('button', { name: 'Host online game' }).click();
    await host.getByRole('button', { name: 'Begin quest' }).click();
    await expect(host.locator('.net-panel')).toBeVisible();
    // Host claims a hero role for themselves, same as any real online host
    // would — otherwise the hero side is fully AI-driven and completes each
    // turn atomically, giving the test no observable "it's Hero's turn" tick
    // to assert on between Sauron turns.
    await host.locator('.net-random-claim').click();
    const code = (await host.locator('.net-code').innerText()).trim();

    // --- Client: join and claim the Sauron role. ---
    await client.goto('/');
    await client.getByRole('button', { name: 'Join online game' }).click();
    await client.getByLabel('Your name').fill('SauronPlayer');
    await client.getByLabel('Game code').fill(code);
    await client.getByRole('button', { name: 'Connect' }).click();
    await expect(client.locator('.net-panel')).toBeVisible({ timeout: 20_000 });

    const sauronRow = client.locator('.net-role-row', { hasText: 'Sauron' });
    await expect(sauronRow).toBeVisible({ timeout: 20_000 });
    await sauronRow.getByRole('button', { name: 'claim' }).click();
    // Host's roster mirror reflects the claim.
    await expect(host.locator('.net-role-row', { hasText: 'Sauron' })).toContainText('SauronPlayer', { timeout: 20_000 });

    // --- Drive the host's hero turn(s) via the real UI until it's Sauron's turn. ---
    let reachedSauron = false;
    for (let i = 0; i < 200; i++) {
      const s = await readMini(host);
      if (s?.winner) break;
      if (s?.activeSide === 'Sauron') { reachedSauron = true; break; }
      await heroStep(host);
      await host.waitForTimeout(30);
    }
    expect(reachedSauron, 'never reached Sauron\'s turn').toBe(true);

    // The engine now pauses for the human client instead of auto-playing the
    // Lidless Eye — the whole point of the roster->humanSide sync fix.
    await expect.poll(async () => (await readMini(host))?.humanSide, { timeout: 10_000 }).toBe('Sauron');

    // --- The CLIENT (not the host) sees and drives the Sauron panel. ---
    await expect(client.locator('.sauron-panel')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('.sauron-panel')).toHaveCount(0);

    // The host's generic "Advance phase" button must not be able to silently
    // steal/auto-play the client's Sauron turn out from under them.
    const hostAdvance = host.getByRole('button', { name: /Advance phase/ });
    if (await hostAdvance.isVisible().catch(() => false)) {
      await hostAdvance.click().catch(() => {});
    }
    await host.waitForTimeout(200);
    expect((await readMini(host))?.phase).toBe('SauronRefresh');

    // Story Step.
    await client.getByRole('button', { name: 'Begin Sauron turn' }).click();
    await expect.poll(async () => (await readMini(client))?.phase, { timeout: 10_000 }).toBe('SauronEvents');

    // Plot/Event Step: pass on plots, resolve events.
    await client.getByRole('button', { name: 'Resolve events & begin actions' }).click();
    await expect.poll(async () => (await readMini(client))?.phase, { timeout: 10_000 }).toBe('SauronMinions');

    // Action Step: end immediately (proves the whole round-trip works without
    // needing to model every possible action UI).
    await client.getByRole('button', { name: 'End Sauron turn' }).click();

    // Both mirrors converge back to a hero turn (or the story advancing further).
    await expect.poll(async () => (await readMini(host))?.activeSide, { timeout: 15_000 }).toBe('Hero');
    await expect.poll(async () => (await readMini(client))?.activeSide, { timeout: 15_000 }).toBe('Hero');
    const hostRound = await host.locator('.app-header .subtitle').innerText();
    await expect(client.locator('.app-header .subtitle')).toHaveText(hostRound);

    expect(hostErrors, `host runtime errors: ${hostErrors.join('\n')}`).toEqual([]);
    expect(clientErrors, `client runtime errors: ${clientErrors.join('\n')}`).toEqual([]);
  } finally {
    await hostCtx.close();
    await clientCtx.close();
  }
});
