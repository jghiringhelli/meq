import { defineConfig, devices } from '@playwright/test';

// The Vite dev server is expected to already be running at :5174. We do NOT
// spawn our own webServer; we simply reuse the existing one.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
