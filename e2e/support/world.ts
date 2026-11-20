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
  await page.goto('/login');
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
