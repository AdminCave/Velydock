import { expect, test } from '@playwright/test';
import { keycloakAdmin, keycloakUserId, submitCredentials } from '../support/keycloak';
import { AUTH_URL } from '../support/stack';
import { apiAs, removeUser, signIn, stateFile, throwawayUser } from '../support/world';

test.describe('Anmeldung und Sitzung', () => {
  test('ohne Anmeldung führt alles zur Login-Seite', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('login-button')).toBeVisible();
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);
    expect((await page.request.get('/api/v1/workspace/apps')).status()).toBe(401);
  });

  test('ein Benutzer meldet sich über Keycloak an und wieder ab', async ({ page }) => {
    await signIn(page, 'mia');
    await expect(page.getByTestId('dock')).toBeVisible();
    expect((await page.request.get('/api/v1/me')).status()).toBe(200);

    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'Abmelden' }).click();
    await expect(page).toHaveURL(/\/login\?signed_out=1/);
    await expect(page.getByTestId('login-message')).toBeVisible();
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);

    // The Keycloak session is gone as well: signing in again asks for the credentials.
    await page.getByTestId('login-button').click();
    await expect(page).toHaveURL(new RegExp(`^${AUTH_URL}/realms/velydock/`));
    await expect(page.locator('#username')).toBeVisible();
  });

  test('nach der Anmeldung landet man auf der ursprünglich aufgerufenen Seite', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);
    await page.getByTestId('login-button').click();
    await submitCredentials(page, 'mia', 'Velydock-E2E-Passwort-1');
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId('setting-theme')).toBeVisible();
  });

  test('ein falsches Passwort meldet niemanden an', async ({ page }) => {
    await signIn(page, 'mia', 'ganz-falsches-passwort');
    await expect(page).toHaveURL(new RegExp(`^${AUTH_URL}/`));
    await expect(page.locator('#input-error-password, #input-error-username, .pf-v5-c-alert').first()).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('das Session-Cookie ist für Skripte unsichtbar und an den Host gebunden', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('mia') });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('dock')).toBeVisible();
    const cookie = (await context.cookies()).find((c) => c.name === '__Host-velydock_session');
    expect(cookie).toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie!.domain.startsWith('.')).toBe(false);
    expect(await page.evaluate(() => document.cookie)).not.toContain('velydock_session');
    // Nothing that looks like a token is kept in the browser.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    await context.close();
  });

  test('meldet Keycloak den Benutzer ab, endet auch die Velydock-Sitzung (Back-Channel-Logout)', async ({ browser }) => {
    const user = await throwawayUser(browser);
    expect((await user.page.request.get('/api/v1/me')).status()).toBe(200);

    // What an operator does in Keycloak's console: "Sign out all sessions" of this user.
    const response = await keycloakAdmin('POST', `/users/${await keycloakUserId(user.username)}/logout`);
    expect(response.status).toBe(204);

    // Keycloak notifies Velydock server-to-server; no browser is involved.
    await expect.poll(async () => (await user.page.request.get('/api/v1/me')).status(), { timeout: 15_000 }).toBe(401);
    await user.page.reload();
    await expect(user.page).toHaveURL(/\/login/);
    await user.context.close();
    await removeUser(user.id);
  });

  test('beendet ein Administrator die Sitzungen eines Benutzers, ist dieser sofort abgemeldet', async ({ browser }) => {
    const user = await throwawayUser(browser);
    const anna = await apiAs('anna');
    expect((await anna.post(`/api/v1/admin/users/${user.id}/end-sessions`)).status()).toBe(204);
    await anna.dispose();

    expect((await user.page.request.get('/api/v1/me')).status()).toBe(401);
    await user.page.goto('/');
    await expect(user.page).toHaveURL(/\/login/);
    // The Keycloak session is gone as well: no silent sign-in.
    await user.page.getByTestId('login-button').click();
    await expect(user.page.locator('#username')).toBeVisible();
    await user.context.close();
    await removeUser(user.id);
  });

  test('ohne CSRF-Header werden Änderungen abgelehnt', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile('anna') });
    const response = await context.request.post('/api/v1/admin/groups', { data: { name: 'Eingeschleust' } });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('csrf');
    await context.close();
  });
});
