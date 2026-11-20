import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';

const username = process.env.INSTALL_ADMIN ?? 'admin';
const oneTimePassword = process.env.INSTALL_ONE_TIME_PASSWORD ?? '';
const password = 'Erstes-Eigenes-Passwort-1';

async function enterCredentials(page: Page, secret: string): Promise<void> {
  await page.locator('#username').fill(username);
  if (!(await page.locator('#password').isVisible())) await page.locator('#kc-login').click();
  await page.locator('#password').fill(secret);
  await page.locator('#kc-login').click();
}

test('der erste Administrator richtet sein Konto ein und kommt nur mit zweitem Faktor hinein', async ({ page }) => {
  expect(oneTimePassword, 'one-time password from setup-admin').not.toBe('');

  // 1. The one-time password from the command line …
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId('login-button').click();
  await enterCredentials(page, oneTimePassword);

  // 2. … must be replaced at once.
  await expect(page.locator('#password-new')).toBeVisible();
  await page.locator('#password-new').fill(password);
  await page.locator('#password-confirm').fill(password);
  await page.locator('[type=submit]').click();

  // 3. Administrators must set up an authenticator app before they get in.
  await expect(page.locator('#totp')).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  await page.locator('#mode-manual').click();
  const secret = ((await page.locator('#kc-totp-secret-key').textContent()) ?? '').replace(/\s+/g, '');
  expect(secret.length).toBeGreaterThanOrEqual(16);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' });
  const enrolmentCode = totp.generate();
  await page.locator('#totp').fill(enrolmentCode);
  await page.locator('#userLabel').fill('Testgerät');
  await page.locator('[type=submit]').first().click();

  // 4. In: system administrator of the first organization.
  await expect(page.getByTestId('dock')).toBeVisible({ timeout: 30_000 });
  const me = await (await page.request.get('/api/v1/me')).json();
  expect(me.user).toMatchObject({ username, is_system_admin: true });
  expect(me.active_tenant.slug).toBe('main');
  expect(me.permissions).toContain('system:admin');
  await page.goto('/system/tenants');
  await expect(page.getByTestId('tenants-table')).toContainText('Hauptorganisation');

  // 5. Signing in again needs the password and the second factor; the one-time password is dead.
  await page.getByTestId('user-menu').click();
  await page.getByRole('menuitem', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1/);
  await page.getByTestId('login-button').click();
  await enterCredentials(page, oneTimePassword);
  await expect(page.locator('#input-error-password, #input-error-username, .pf-v5-c-alert').first()).toBeVisible();
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await expect(page.locator('#otp')).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  // Keycloak accepts each code only once: wait for the next 30-second step.
  await expect.poll(() => totp.generate(), { timeout: 45_000, intervals: [1_000] }).not.toBe(enrolmentCode);
  await page.locator('#otp').fill(totp.generate());
  await page.locator('#kc-login').click();
  await expect(page.getByTestId('dock')).toBeVisible({ timeout: 30_000 });
});
