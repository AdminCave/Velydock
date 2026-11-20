import { defineConfig, devices } from '@playwright/test';
import { DOCK_URL } from './support/stack';

/**
 * Browser tests against the complete stack (Traefik, Velydock, Keycloak, PostgreSQL), started
 * with scripts/dev-stack.sh. Nothing is mocked: sign-in runs through Keycloak's real pages.
 *
 * The suite seeds its own data once (global-setup.ts) and expects a fresh stack; see
 * scripts/tests/e2e.sh.
 */
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
