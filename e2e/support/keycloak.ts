import { expect, type Page } from '@playwright/test';
import { AUTH_URL, KEYCLOAK_ADMIN_URL, KEYCLOAK_BOOTSTRAP, PASSWORD } from './stack';

/**
 * Fill in Keycloak's sign-in pages. With organizations enabled Keycloak asks for the user name
 * first and for the password on a second page; without any organization both are on one page.
 */
export async function submitCredentials(page: Page, username: string, password: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${AUTH_URL}/realms/velydock/`));
  await page.locator('#username').fill(username);
  if (!(await page.locator('#password').isVisible())) {
    await page.locator('#kc-login').click();
  }
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

/** Keycloak's forced password change after signing in with a one-time password. */
export async function chooseNewPassword(page: Page, password: string = PASSWORD): Promise<void> {
  await expect(page.locator('#password-new')).toBeVisible();
  await page.locator('#password-new').fill(password);
  await page.locator('#password-confirm').fill(password);
  await page.locator('[type=submit]').click();
}

async function adminToken(): Promise<string> {
  const response = await fetch(`${KEYCLOAK_ADMIN_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KEYCLOAK_BOOTSTRAP.id,
      client_secret: KEYCLOAK_BOOTSTRAP.secret,
    }),
  });
  if (!response.ok) throw new Error(`Keycloak admin token: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Call Keycloak's Admin API directly – what an operator would do in Keycloak's own console. */
export async function keycloakAdmin(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${KEYCLOAK_ADMIN_URL}/admin/realms/velydock${path}`, {
    method,
    headers: { authorization: `Bearer ${await adminToken()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function keycloakUserId(username: string): Promise<string> {
  const response = await keycloakAdmin('GET', `/users?username=${encodeURIComponent(username)}&exact=true`);
  const users = (await response.json()) as { id: string }[];
  if (!users[0]) throw new Error(`no Keycloak user ${username}`);
  return users[0].id;
}
