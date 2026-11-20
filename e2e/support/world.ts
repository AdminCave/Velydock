import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { chooseNewPassword, submitCredentials } from './keycloak';
import { AUTH_DIR, DOCK_URL, PASSWORD } from './stack';

/** The accounts created by global-setup.ts. */
export type Account = 'root' | 'anna' | 'uwe' | 'mia' | 'ben' | 'gina' | 'gero';

export interface World {
  tenants: { main: string; acme: string; globex: string };
  users: Record<Account, string>;
  groups: { office: string };
  apps: { demo: string; manual: string; notes: string; netNotes: string; onlyBen: string; globexCrm: string };
}

export const WORLD_FILE = resolve(AUTH_DIR, 'world.json');

export function world(): World {
  if (!existsSync(WORLD_FILE)) throw new Error('test data missing – global setup did not run');
  return JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as World;
}

export function stateFile(account: Account): string {
  return resolve(AUTH_DIR, `${account}.json`);
}

/** A browser context that is already signed in as the given account. */
export async function contextAs(browser: Browser, account: Account): Promise<BrowserContext> {
  return browser.newContext({ storageState: stateFile(account) });
}

/** An API client with the account's session, sending what the UI sends on every write. */
export async function apiAs(account: Account): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: DOCK_URL,
    ignoreHTTPSErrors: true,
    storageState: stateFile(account),
    extraHTTPHeaders: { 'X-Velydock-CSRF': '1' },
  });
}

/** Go through the real sign-in: Velydock's login page, then Keycloak. */
export async function signIn(page: Page, username: string, password: string = PASSWORD): Promise<void> {
  await page.goto(`${DOCK_URL}/login`);
  await page.getByTestId('login-button').click();
  await submitCredentials(page, username, password);
}

/** First sign-in of a freshly created account: one-time password, then a forced change. */
export async function firstSignIn(page: Page, username: string, oneTimePassword: string): Promise<void> {
  await signIn(page, username, oneTimePassword);
  await chooseNewPassword(page);
}

/** A name that does not collide when the suite runs twice against the same stack. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export interface Throwaway {
  username: string;
  id: string;
  context: BrowserContext;
  page: Page;
}

/**
 * A fresh member of Acme with its own signed-in browser, for tests that end sessions or disable
 * accounts. The shared accounts must keep their sessions for the other tests.
 */
export async function throwawayUser(browser: Browser, prefix = 'gast'): Promise<Throwaway> {
  const username = unique(prefix);
  const anna = await apiAs('anna');
  const response = await anna.post('/api/v1/admin/users', {
    data: { username, first_name: 'Test', last_name: 'Person' },
  });
  if (response.status() !== 201) throw new Error(`could not create ${username}: ${await response.text()}`);
  const created = (await response.json()) as { user: { id: string }; temporary_password: string };
  await anna.dispose();
  const context = await browser.newContext();
  const page = await context.newPage();
  await firstSignIn(page, username, created.temporary_password);
  await page.getByTestId('dock').waitFor();
  return { username, id: created.user.id, context, page };
}

export async function removeUser(id: string): Promise<void> {
  const anna = await apiAs('anna');
  await anna.delete(`/api/v1/admin/users/${id}`);
  await anna.dispose();
}
