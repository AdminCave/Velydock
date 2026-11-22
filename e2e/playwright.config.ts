import { defineConfig, devices } from '@playwright/test';
import { DOCK_URL } from './support/stack';

/**
 * Browser tests against the complete stack (Traefik, Velydock, Keycloak, PostgreSQL), started
 * with scripts/dev-stack.sh. Nothing is mocked: sign-in runs through Keycloak's real pages.
 *
 * The suite seeds its own data once (global-setup.ts) and expects a fresh stack; see
 * scripts/tests/e2e.sh.
 */
const DEVICES = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' } as const;
type BrowserName = keyof typeof DEVICES;

/**
 * Chromium unless told otherwise: E2E_BROWSERS=firefox,webkit runs the suite in those (install
 * them once with `npx playwright install firefox webkit`). The stack is seeded with Chromium in
 * any case.
 */
const browsers = (process.env.E2E_BROWSERS ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is BrowserName => name in DEVICES);
if (browsers.length === 0) throw new Error(`E2E_BROWSERS names no known browser (${Object.keys(DEVICES).join(', ')})`);

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // Tests share seeded data and some change it; one worker keeps them deterministic.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: DOCK_URL,
    // The development stack uses Traefik's self-signed certificate.
    ignoreHTTPSErrors: true,
    locale: 'de-DE',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: browsers.map((name) => ({ name, use: { ...devices[DEVICES[name]] } })),
});
