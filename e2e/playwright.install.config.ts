import { defineConfig, devices } from '@playwright/test';

/**
 * Installation smoke test: a stack installed exactly as docs/installation.md describes
 * (production Compose file, scripts/install.sh, velydock setup-admin). Started by
 * scripts/tests/install-smoke.sh, which passes the address and the one-time password.
 */
export default defineConfig({
  testDir: './install',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.INSTALL_URL,
    ignoreHTTPSErrors: true,
    locale: 'de-DE',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
