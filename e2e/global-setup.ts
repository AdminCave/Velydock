import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect, request, type APIRequestContext, type Browser } from '@playwright/test';
import { DEMO_URL, DOCK_URL, AUTH_DIR, PASSWORD, compose } from './support/stack';
import { firstSignIn, stateFile, WORLD_FILE, type Account, type World } from './support/world';

/**
 * Prepares a freshly installed stack the way an operator would:
 *
 *   1. `velydock setup-admin` creates the first system administrator (one-time password).
 *   2. That administrator signs in, is forced to choose a password, and creates two
 *      organizations with users, a group and apps through the API the UI uses.
 *   3. Every user signs in once and chooses a password.
 *
 * The signed-in browser states are stored for the tests.
 */

const CUSTOM_HTML = `<main>
  <h1 id="title">Notizen</h1>
  <button id="count" type="button">Geklickt: 0</button>
  <pre id="probe">läuft …</pre>
</main>`;

const CUSTOM_CSS = `body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; }
html[data-theme="dark"] body { background: #17181b; color: #ededee; }`;

// Reports what the sandbox lets this code do; the tests read the result from the page.
const probeScript = (dock: string) => `
let clicks = 0;
document.getElementById('count').addEventListener('click', (event) => {
  event.target.textContent = 'Geklickt: ' + (++clicks);
});
(async () => {
  const result = { origin: self.origin, theme: document.documentElement.dataset.theme };
  const attempt = async (name, action) => {
    try { result[name] = String(await action()); } catch (error) { result[name] = 'BLOCKED:' + error.name; }
  };
  await attempt('cookie', () => document.cookie);
  await attempt('localStorage', () => { localStorage.setItem('probe', '1'); return 'writable'; });
  await attempt('sessionStorage', () => { sessionStorage.setItem('probe', '1'); return 'writable'; });
  await attempt('indexedDB', () => { indexedDB.open('probe'); return 'opened'; });
  await attempt('parentDocument', () => window.parent.document.title);
  await attempt('parentLocation', () => window.parent.location.href);
  await attempt('topNavigation', () => { window.top.location = 'https://example.org/'; return 'navigated'; });
  await attempt('api', async () => {
    const response = await fetch('${dock}/api/v1/me', { credentials: 'include' });
    return 'status ' + response.status;
  });
  await attempt('apiNoCors', async () => {
    const response = await fetch('${dock}/api/auth/logout', { method: 'POST', credentials: 'include', mode: 'no-cors' });
    return 'sent:' + response.type;
  });
  document.getElementById('probe').textContent = JSON.stringify(result);
  document.getElementById('probe').dataset.done = 'true';
})();`;

async function ok<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  if (!response.ok()) throw new Error(`${response.url()} → ${response.status()} ${await response.text()}`);
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

async function signInOnce(browser: Browser, account: Account, username: string, oneTimePassword: string): Promise<void> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE' });
  const page = await context.newPage();
  await firstSignIn(page, username, oneTimePassword);
  await expect(page.getByTestId('dock')).toBeVisible({ timeout: 30_000 });
  await context.storageState({ path: stateFile(account) });
  await context.close();
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });

  const output = compose(
    'exec', '-T', 'velydock', 'velydock', 'setup-admin',
    '--username', 'root', '--email', 'root@velydock.test',
    '--first-name', 'Ronja', '--last-name', 'Root',
    '--tenant-name', 'Admin Cave', '--tenant-slug', 'main',
  );
  const rootPassword = /One-time password:\s+(\S+)/.exec(output)?.[1];
  if (!rootPassword) throw new Error(`setup-admin printed no password:\n${output}`);

  const browser = await chromium.launch();
  await signInOnce(browser, 'root', 'root', rootPassword);

  const api = await request.newContext({
    baseURL: DOCK_URL,
    ignoreHTTPSErrors: true,
    storageState: stateFile('root'),
    extraHTTPHeaders: { 'X-Velydock-CSRF': '1' },
  });

  const me = await ok<{ active_tenant: { id: string }; user: { id: string } }>(await api.get('/api/v1/me'));
  const tenant = async (slug: string, name: string) =>
    (await ok<{ id: string }>(await api.post('/api/v1/system/tenants', { data: { slug, name } }))).id;
  const enter = async (tenantId: string) =>
    ok(await api.post('/api/v1/me/active-tenant', { data: { tenant_id: tenantId } }));

  const oneTime: Partial<Record<Account, string>> = {};
  const ids: Partial<Record<Account, string>> = { root: me.user.id };
  const user = async (account: Account, firstName: string, lastName: string, role: string, groups: string[] = []) => {
    const created = await ok<{ user: { id: string }; temporary_password: string }>(
      await api.post('/api/v1/admin/users', {
        data: {
          username: account,
          first_name: firstName,
          last_name: lastName,
          email: `${account}@velydock.test`,
          role,
          group_ids: groups,
        },
      }),
    );
    oneTime[account] = created.temporary_password;
    ids[account] = created.user.id;
    return created.user.id;
  };
  const app = async (data: Record<string, unknown>) =>
    (await ok<{ id: string }>(await api.post('/api/v1/admin/apps', { data }))).id;

  const acme = await tenant('acme', 'Acme GmbH');
  const globex = await tenant('globex', 'Globex AG');

  await enter(acme);
  const office = (await ok<{ id: string }>(await api.post('/api/v1/admin/groups', { data: { name: 'Büro' } }))).id;
  await user('anna', 'Anna', 'Admin', 'tenant_admin');
  await user('uwe', 'Uwe', 'Verwalter', 'user_manager');
  await user('mia', 'Mia', 'Mitglied', 'member', [office]);
  const ben = await user('ben', 'Ben', 'Beispiel', 'member');

  const apps = {
    demo: await app({
      name: 'Demo', description: 'Eingebettete Beispielanwendung', type: 'embedded', url: `${DEMO_URL}/`,
      visible_to_all: true, icon: { name: 'globe' },
    }),
    manual: await app({
      name: 'Handbuch', description: 'Öffnet in einem neuen Tab', type: 'external', url: `${DEMO_URL}/handbuch`,
      group_ids: [office], icon: { name: 'book-open' },
    }),
    notes: await app({
      name: 'Notizen', description: 'Eigene App in der Sandbox', type: 'custom', visible_to_all: true,
      custom_html: CUSTOM_HTML, custom_css: CUSTOM_CSS, custom_js: probeScript(DOCK_URL), icon: { name: 'notebook-pen' },
    }),
    netNotes: await app({
      name: 'Netz-Notizen', description: 'Eigene App mit Netzwerkzugriff', type: 'custom', visible_to_all: true,
      custom_html: CUSTOM_HTML, custom_css: CUSTOM_CSS, custom_js: probeScript(DOCK_URL), custom_allow_network: true,
      icon: { name: 'wifi' },
    }),
    onlyBen: await app({
      name: 'Nur für Ben', type: 'external', url: `${DEMO_URL}/ben`, user_ids: [ben], icon: { name: 'lock' },
    }),
    globexCrm: '',
  };

  await enter(globex);
  await user('gina', 'Gina', 'Globex', 'tenant_admin');
  await user('gero', 'Gero', 'Globex', 'member');
  apps.globexCrm = await app({
    name: 'Globex CRM', type: 'external', url: `${DEMO_URL}/crm`, visible_to_all: true, icon: { name: 'users' },
  });
  await enter(me.active_tenant.id);
  await api.dispose();

  for (const account of ['anna', 'uwe', 'mia', 'ben', 'gina', 'gero'] as const) {
    await signInOnce(browser, account, account, oneTime[account]!);
  }
  await browser.close();

  const seeded: World = {
    tenants: { main: me.active_tenant.id, acme, globex },
    users: ids as Record<Account, string>,
    groups: { office },
    apps,
  };
  writeFileSync(WORLD_FILE, JSON.stringify(seeded, null, 2));
  if (PASSWORD.length < 12) throw new Error('test password must satisfy the realm policy');
}
