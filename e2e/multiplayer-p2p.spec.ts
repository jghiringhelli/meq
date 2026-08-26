import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { PeerServer } from 'peer';

// Real peer-to-peer smoke test: a host browser and one or more client browsers
// connect through a LOCAL PeerJS signaling broker (no cloud), exercising the
// actual WebRTC transport in src/net/session.ts — the one piece the in-memory
// multiplayer unit test cannot cover. Verifies connect, host→client state
// broadcast, and the roster round-trip (claim a role → all peers see it).

const BROKER_PORT = 9412;
let broker: ReturnType<typeof PeerServer> | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  broker = PeerServer({ port: BROKER_PORT, path: '/' });
  // give the broker a moment to bind
  await new Promise((r) => setTimeout(r, 500));
});

test.afterAll(async () => {
  broker?.close?.();
  broker = null;
});

// Point the app at our local broker before any of its scripts run.
async function useLocalBroker(page: Page) {
  await page.addInitScript((port) => {
    (window as unknown as { __MEQ_PEER__: unknown }).__MEQ_PEER__ = {
      host: 'localhost', port, path: '/', secure: false,
    };
  }, BROKER_PORT);
  page.on('dialog', (d) => d.accept().catch(() => {}));
}

test('host + client connect over a local P2P broker and share state + roster', async ({ browser }) => {
  const hostCtx: BrowserContext = await browser.newContext();
  const clientCtx: BrowserContext = await browser.newContext();
  const host = await hostCtx.newPage();
  const client = await clientCtx.newPage();

  try {
    await useLocalBroker(host);
    await useLocalBroker(client);

    // --- Host: start an online game ---
    await host.goto('/');
    await host.getByRole('button', { name: 'Host online game' }).click();
    await host.getByRole('button', { name: 'Begin quest' }).click();

    // In-game board with the net panel showing our host role + the game code.
    await expect(host.locator('.net-panel')).toBeVisible();
    await expect(host.locator('.net-role')).toHaveText('host');
    const code = (await host.locator('.net-code').innerText()).trim();
    expect(code.length).toBeGreaterThanOrEqual(5);

    // --- Client: join with the code ---
    await client.goto('/');
    await client.getByRole('button', { name: 'Join online game' }).click();
    await client.getByLabel('Your name').fill('Tester');
    await client.getByLabel('Game code').fill(code);
    await client.getByRole('button', { name: 'Connect' }).click();

    // Client receives the broadcast state → board + net panel render.
    await expect(client.locator('.net-panel')).toBeVisible({ timeout: 20_000 });
    await expect(client.locator('.net-role')).toHaveText('client');
    await expect(client.locator('.net-dot.ok')).toBeVisible();

    // Host sees the client seated.
    await expect(host.locator('.net-players')).toContainText('Tester');

    // State sync: same round subtitle on both peers.
    const hostRound = await host.locator('.app-header .subtitle').innerText();
    await expect(client.locator('.app-header .subtitle')).toHaveText(hostRound);

    // --- Roster round-trip: client claims the first open role ---
    const claimBtn = client.locator('.net-role-row button', { hasText: 'claim' }).first();
    await claimBtn.click();

    // The host applied it and re-broadcast the roster; the client now owns a
    // role, so a "release" control appears on its side (proves roster arrived).
    await expect(client.locator('.net-role-row button', { hasText: 'release' })).toBeVisible({ timeout: 20_000 });
  } finally {
    await hostCtx.close();
    await clientCtx.close();
  }
});
