import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { APPS_HOST, APPS_URL } from '../support/stack';
import { appFrame, dockApp } from '../support/ui';
import { apiAs, contextAs, unique, world } from '../support/world';

/** The proxy fetches its routes every five seconds; wait until a route is there (or gone). */
async function routed(request: APIRequestContext, url: string, expected: (status: number) => boolean): Promise<void> {
  await expect
    .poll(async () => expected((await request.get(url, { maxRedirects: 0 })).status()), { timeout: 20_000, intervals: [1000] })
    .toBe(true);
}

type Organization = 'acme' | 'main';

/** "demo" (the name of the demo container for the proxy) is released for an organization, or not. */
async function release(wanted: boolean, organization: Organization = 'acme'): Promise<void> {
  const targets = `/api/v1/system/tenants/${world().tenants[organization]}/proxy-targets`;
  const root = await apiAs('root');
  const found = (await (await root.get(targets)).json()).find((target: { value: string }) => target.value === 'demo');
  if (wanted && !found) expect((await root.post(targets, { data: { value: 'demo' } })).status()).toBe(201);
  if (!wanted && found) expect((await root.delete(`${targets}/${found.id}`)).status()).toBe(204);
  await root.dispose();
}

/** System → Organisationen → the releases of Acme. */
async function openReleases(page: Page): Promise<Locator> {
  await page.goto('/system/tenants');
  await page.locator(`tr[data-tenant-id="${world().tenants.acme}"]`).getByTestId('tenant-proxy').click();
  const dialog = page.getByRole('dialog', { name: 'Proxy-Freigaben für Acme GmbH' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Verwaltung → Apps → "App hinzufügen", with name and type filled in and publishing switched on. */
async function openPublishDialog(page: Page, name: string): Promise<Locator> {
  await page.goto('/admin/apps');
  // An organization without apps offers the button twice: above the table and in the empty table.
  await page.getByRole('button', { name: 'App hinzufügen' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'App hinzufügen' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByTestId('app-type').locator('label:has(input[value="embedded"])').click();
  await dialog.getByTestId('app-publish-toggle').check();
  return dialog;
}

test.describe('Veröffentlichen über den Proxy in der Oberfläche', () => {
  test.afterAll(async () => {
    const anna = await apiAs('anna');
    for (const app of await (await anna.get('/api/v1/admin/apps')).json()) {
      if (app.publication) await anna.delete(`/api/v1/admin/apps/${app.id}`);
    }
    await anna.dispose();
    const root = await apiAs('root');
    await root.patch(`/api/v1/system/tenants/${world().tenants.acme}`, { data: { proxy_path_allowed: true } });
    for (const app of await (await root.get('/api/v1/admin/apps')).json()) {
      if (app.publication) await root.delete(`/api/v1/admin/apps/${app.id}`);
    }
    for (const template of await (await root.get('/api/v1/system/proxy-templates')).json()) {
      if (!template.builtin) await root.delete(`/api/v1/system/proxy-templates/${template.id}`);
    }
    await root.dispose();
    await release(false);
    await release(false, 'main');
  });

  test('der Systemadministrator gibt frei, die Organisation veröffentlicht, ein Mitglied arbeitet in der App', async ({ browser, browserName, playwright }) => {
    await release(false);

    // Nothing released yet: the dialog says what is missing and does not offer to save.
    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    const name = unique('Laufwerk');
    const slug = name.toLowerCase();
    let dialog = await openPublishDialog(page, name);
    await expect(dialog.getByTestId('app-publish-targets')).toContainText('Noch nichts freigegeben');
    await expect(dialog.getByRole('button', { name: 'App anlegen' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();

    // The system administrator releases the demo service for Acme - and cannot release a part
    // of the installation itself.
    const system = await contextAs(browser, 'root');
    const systemPage = await system.newPage();
    const releases = await openReleases(systemPage);
    await expect(releases.getByTestId('proxy-targets-empty')).toBeVisible();
    await releases.getByTestId('proxy-target-value').fill('keycloak');
    await releases.getByTestId('proxy-target-add').click();
    await expect(releases).toContainText('Dieser Name gehört zur Installation selbst');
    await expect(releases.getByTestId('proxy-target')).toHaveCount(0);
    await releases.getByTestId('proxy-target-value').fill('demo');
    await releases.getByTestId('proxy-target-note').fill('Demo-Dienst');
    await releases.getByTestId('proxy-target-add').click();
    await expect(releases.locator('[data-testid="proxy-target"][data-value="demo"]')).toBeVisible();
    await expect(releases.getByTestId('proxy-path-allowed')).toBeChecked();
    await releases.getByRole('button', { name: 'Fertig' }).click();
    await expect(releases).toHaveCount(0);
    await system.close();

    // Now the organization's administrator publishes an embedded app.
    dialog = await openPublishDialog(page, name);
    await expect(dialog.getByTestId('app-publish-targets')).toContainText('demo');
    await expect(dialog.getByTestId('app-publish-name')).toHaveValue(slug); // suggested from the app's name
    // What is not released is refused at the field, and nothing is created.
    await dialog.getByTestId('app-publish-target').fill('http://keycloak:8080');
    await dialog.getByRole('button', { name: 'App anlegen' }).click();
    await expect(dialog.getByTestId('app-publish-target')).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByTestId('app-publish-target').fill('http://demo');
    await expect(dialog.getByTestId('app-publish-preview')).toHaveText(`${APPS_URL}/${slug}/`);
    await expect(dialog.getByTestId('app-publish-access').locator('input[value="protected"]')).toBeChecked();
    await dialog.getByTestId('app-publish-template').selectOption('builtin:header-login');
    await dialog.getByRole('button', { name: 'App anlegen' }).click();
    await expect(dialog).toHaveCount(0);

    const row = page.getByTestId('apps-table').locator('tr', { hasText: name });
    await expect(row.getByTestId('app-published')).toHaveAttribute('data-url', `${APPS_URL}/${slug}/`);
    await expect(row).toContainText('Veröffentlicht · geschützt');
    await expect(row.getByTestId('app-publication-problem')).toHaveCount(0);
    const appId = (await row.getAttribute('data-app-id'))!;
    await admin.close();

    // A member opens it from the dock. The sign-in for the app happens inside the frame, without
    // anything to do for her; the app is told who she is (this template).
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    await routed(anonymous, `${APPS_URL}/${slug}/`, (status) => status === 302 || status === 401);
    await anonymous.dispose();
    const member = await contextAs(browser, 'mia');
    const memberPage = await member.newPage();
    await memberPage.goto('/');
    await expect(dockApp(memberPage, appId)).toBeVisible();
    let shown: Locator;
    if (browserName === 'webkit') {
      // WebKit takes every *.localhost name for a site of its own and keeps no cookie of a framed
      // one - so the sign-in inside the frame cannot complete on this stack. Under a real domain
      // it keeps them (tried with a page of its own, see docs/tests.md). Here: in a tab of its own.
      await memberPage.goto(`${APPS_URL}/${slug}/`);
      shown = memberPage.locator('body');
    } else {
      await dockApp(memberPage, appId).click();
      shown = appFrame(memberPage, appId).contentFrame().locator('body');
    }
    await expect(shown).toContainText('X-Velydock-User: mia', { timeout: 20_000 });
    await expect(shown).toContainText(`X-Forwarded-Prefix: /${slug}`);
    await member.close();
  });

  test('zieht der Systemadministrator die Freigabe zurück, nennt die App-Liste den Grund', async ({ browser, playwright }) => {
    await release(true);
    const name = unique('Ablage');
    const anna = await apiAs('anna');
    const created = await anna.post('/api/v1/admin/apps', {
      data: { name, type: 'external', visible_to_all: true, publication: { name: name.toLowerCase(), mode: 'subdomain', target_url: 'http://demo', access: 'public' } },
    });
    expect(created.status()).toBe(201);
    const url = (await created.json()).url as string;
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    await routed(anonymous, url, (status) => status === 200);

    // Withdrawn in the interface; it asks first.
    const system = await contextAs(browser, 'root');
    const systemPage = await system.newPage();
    const releases = await openReleases(systemPage);
    await releases.locator('[data-testid="proxy-target"][data-value="demo"]').getByTestId('proxy-target-remove').click();
    await systemPage.getByRole('dialog', { name: 'Freigabe zurückziehen' }).getByRole('button', { name: 'Freigabe zurückziehen' }).click();
    await expect(releases.getByTestId('proxy-target')).toHaveCount(0);
    await system.close();

    // The address is gone a few seconds later, and the organization sees why.
    await routed(anonymous, url, (status) => status === 404);
    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    await page.goto('/admin/apps');
    const row = page.getByTestId('apps-table').locator('tr', { hasText: name });
    await expect(row.getByTestId('app-publication-problem')).toHaveAttribute('data-problem', 'target_not_allowed');
    await expect(row).toContainText('Veröffentlicht · öffentlich');
    await admin.close();
    await anonymous.dispose();
    await anna.dispose();
  });

  test('sind Pfad-Adressen für die Organisation abgeschaltet, bietet der Dialog nur die Subdomain', async ({ browser }) => {
    await release(true);
    const system = await contextAs(browser, 'root');
    const systemPage = await system.newPage();
    const releases = await openReleases(systemPage);
    await releases.getByTestId('proxy-path-allowed').uncheck();
    await systemPage.getByRole('dialog', { name: 'Pfad-Adressen abschalten' }).getByRole('button', { name: 'Abschalten' }).click();
    await expect(releases.getByTestId('proxy-path-allowed')).not.toBeChecked();
    await system.close();

    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    const name = unique('Kasse');
    const slug = name.toLowerCase();
    const dialog = await openPublishDialog(page, name);
    await expect(dialog.getByTestId('app-publish-mode').locator('input[value="path"]')).toHaveCount(0);
    await dialog.getByTestId('app-publish-target').fill('http://demo');
    await expect(dialog.getByTestId('app-publish-preview')).toHaveText(`https://${slug}.${APPS_HOST}/`);
    // Open to everybody is said plainly before it is saved.
    await dialog.getByTestId('app-publish-access').locator('label:has(input[value="public"])').click();
    await expect(dialog.getByTestId('app-publish-public')).toContainText('Ohne Anmeldung erreichbar');
    await dialog.getByRole('button', { name: 'App anlegen' }).click();
    await expect(dialog).toHaveCount(0);
    const row = page.getByTestId('apps-table').locator('tr', { hasText: name });
    await expect(row.getByTestId('app-published')).toHaveAttribute('data-url', `https://${slug}.${APPS_HOST}/`);
    await expect(row).toContainText('Veröffentlicht · öffentlich');
    await admin.close();
  });

  test('der Systemadministrator gibt einer einzelnen App eigene Traefik-Einstellungen mit – und sie wirken', async ({ browser, playwright }) => {
    // In his own organization, where he administers the apps himself.
    await release(true, 'main');
    const system = await contextAs(browser, 'root');
    const page = await system.newPage();
    const name = unique('Messwerte');
    const slug = name.toLowerCase();
    const dialog = await openPublishDialog(page, name);
    await dialog.getByTestId('app-publish-target').fill('http://demo');
    await dialog.getByTestId('app-publish-mode').locator('label:has(input[value="subdomain"])').click();
    await dialog.getByTestId('app-publish-access').locator('label:has(input[value="public"])').click();
    await dialog.getByTestId('app-publish-options').locator('summary').click();
    const own = dialog.getByTestId('app-publish-middlewares');
    // A field Traefik does not know would make it refuse the routes of everybody: refused here,
    // with the name of the field.
    await own.fill('{ "10-kennwort": { "basicAuth": { "user": ["test:x"] } } }');
    await dialog.getByRole('button', { name: 'App anlegen' }).click();
    await expect(dialog.getByTestId('app-publish-middlewares-refused')).toContainText("'user'");
    await own.fill('{ "10-kennwort": { "basicAuth": { "users": ["test:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"], "realm": "Messwerte" } } }');
    await dialog.getByRole('button', { name: 'App anlegen' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('apps-table').locator('tr', { hasText: name }).getByTestId('app-published')).toHaveAttribute(
      'data-url',
      `https://${slug}.${APPS_HOST}/`,
    );
    await system.close();

    // The proxy asks for the password now: what was typed into the dialog is in effect.
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    const url = `https://${slug}.${APPS_HOST}/`;
    await routed(anonymous, url, (status) => status === 401);
    expect((await anonymous.get(url)).headers()['www-authenticate']).toContain('Basic realm="Messwerte"');
    expect((await anonymous.get(url, { headers: { Authorization: `Basic ${Buffer.from('test:test').toString('base64')}` } })).status()).toBe(200);
    await anonymous.dispose();
  });

  test('eigene Proxy-Vorlagen: was Traefik nicht verstünde, wird am Feld abgelehnt; was verwendet wird, bleibt', async ({ browser }) => {
    await release(true);
    const name = unique('Nur Büro');
    const system = await contextAs(browser, 'root');
    const page = await system.newPage();
    await page.goto('/system/proxy-templates');
    const table = page.getByTestId('proxy-templates-table');
    // The templates that come with Velydock are there and cannot be changed.
    const builtin = table.locator('[data-testid="proxy-template"][data-builtin="true"]');
    await expect(builtin).toHaveCount(5);
    await expect(builtin.getByTestId('proxy-template-edit')).toHaveCount(0);

    await page.getByTestId('proxy-template-new').click();
    const dialog = page.getByRole('dialog', { name: 'Vorlage anlegen' });
    await dialog.getByTestId('proxy-template-name').fill(name);
    const own = dialog.getByTestId('proxy-template-custom');
    // Not JSON at all: caught before anything is sent.
    await own.fill('{ "buero": ');
    await dialog.getByTestId('proxy-template-save').click();
    await expect(dialog).toContainText('Das ist kein gültiges JSON');
    // JSON, but a field Traefik does not know: the server names it.
    await own.fill('{ "buero": { "ipAllowList": { "sourceRanges": ["10.0.0.0/8"] } } }');
    await dialog.getByTestId('proxy-template-save').click();
    await expect(dialog.getByTestId('proxy-template-refused')).toContainText('sourceRanges');
    await own.fill('{ "buero": { "ipAllowList": { "sourceRange": ["10.0.0.0/8"] } } }');
    await dialog.getByTestId('proxy-template-save').click();
    await expect(dialog).toHaveCount(0);
    const row = table.locator('[data-testid="proxy-template"]', { hasText: name });
    await expect(row).toHaveAttribute('data-builtin', 'false');
    const templateId = (await row.getAttribute('data-id'))!;

    // An organization uses it. Deleting it would lift what it restricts: refused, with the app named.
    const anna = await apiAs('anna');
    const slug = unique('intern').toLowerCase();
    const used = await anna.post('/api/v1/admin/apps', {
      data: { name: unique('Intern'), type: 'external', publication: { name: slug, mode: 'subdomain', target_url: 'http://demo', template: templateId } },
    });
    expect(used.status()).toBe(201);
    await row.getByTestId('proxy-template-delete').click();
    await page.getByRole('dialog', { name: 'Vorlage löschen' }).getByRole('button', { name: 'Vorlage löschen' }).click();
    await expect(page.getByTestId('proxy-template-in-use')).toContainText(slug);
    await expect(row).toBeVisible();

    // No longer used, it goes.
    expect((await anna.delete(`/api/v1/admin/apps/${(await used.json()).id}`)).status()).toBe(204);
    await anna.dispose();
    await row.getByTestId('proxy-template-delete').click();
    await page.getByRole('dialog', { name: 'Vorlage löschen' }).getByRole('button', { name: 'Vorlage löschen' }).click();
    await expect(row).toHaveCount(0);
    await system.close();
  });
});
