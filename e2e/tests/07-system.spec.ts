import { expect, test } from '@playwright/test';
import { dockApp } from '../support/ui';
import { apiAs, contextAs, unique, world } from '../support/world';

test.describe('Systemverwaltung', () => {
  test('ein Systemadministrator legt eine Organisation an, betritt und löscht sie', async ({ browser }) => {
    const slug = unique('kunde').toLowerCase();
    const name = `Kunde ${slug}`;
    const context = await contextAs(browser, 'root');
    const page = await context.newPage();
    await page.goto('/system/tenants');
    await page.getByRole('button', { name: 'Organisation anlegen' }).click();

    const dialog = page.getByRole('dialog', { name: 'Organisation anlegen' });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Kurzname', { exact: true }).fill(slug);
    await dialog.getByRole('button', { name: 'Organisation anlegen' }).click();
    await expect(dialog).toHaveCount(0);

    const created = page.locator(`tr[data-slug="${slug}"]`);
    await expect(created).toContainText(name);

    // Enter it and create its first administrator and an app there.
    await created.getByRole('button', { name: 'Betreten' }).click();
    await expect(page.getByTestId('tenant-switcher')).toContainText(name);
    const root = await apiAs('root');
    const admin = unique('chef');
    const user = await root.post('/api/v1/admin/users', {
      data: { username: admin, first_name: 'Chef', last_name: 'Kunde', role: 'tenant_admin' },
    });
    expect(user.status()).toBe(201);
    const app = await (
      await root.post('/api/v1/admin/apps', {
        data: { name: 'Kundenportal', type: 'external', url: 'https://demo.velydock.localhost:8443/portal', visible_to_all: true },
      })
    ).json();
    await page.goto('/');
    await expect(dockApp(page, app.id)).toBeVisible();

    // Delete: only with the short name typed out.
    await page.goto('/system/tenants');
    await page.locator(`tr[data-slug="${slug}"]`).getByTestId('tenant-actions').click();
    await page.getByRole('menuitem', { name: 'Löschen' }).click();
    const confirm = page.getByRole('dialog');
    const destroy = confirm.getByRole('button', { name: 'Endgültig löschen' });
    await confirm.getByRole('textbox').fill('falsch');
    await expect(destroy).toBeDisabled();
    await confirm.getByRole('textbox').fill(slug);
    await destroy.click();
    await expect(page.locator(`tr[data-slug="${slug}"]`)).toHaveCount(0);

    // Its administrator is gone with it; the session falls back to another organization.
    const users = await (await root.get(`/api/v1/system/users?search=${admin}`)).json();
    expect(users.items).toEqual([]);
    const me = await (await root.get('/api/v1/me')).json();
    expect(me.active_tenant.slug).not.toBe(slug);
    await root.post('/api/v1/me/active-tenant', { data: { tenant_id: world().tenants.main } });
    await root.dispose();
    await context.close();
  });

  test('ein Fenster, das noch die alte Organisation zeigt, schreibt nicht in die neue', async ({ browser }) => {
    const { tenants, apps } = world();
    const context = await contextAs(browser, 'root');
    try {
      // Window A: the settings of the first organization, loaded and ready to save.
      const windowA = await context.newPage();
      await windowA.goto('/admin/settings');
      await expect(windowA.getByRole('button', { name: 'Speichern' })).toBeVisible();
      await expect(windowA.locator('body')).toContainText('Vorgaben für alle in Admin Cave');

      // Window B: the same session enters Globex.
      const windowB = await context.newPage();
      await windowB.goto('/');
      await windowB.getByTestId('tenant-switcher').click();
      await windowB.getByRole('menuitem', { name: /Globex AG/ }).click();
      await expect(dockApp(windowB, apps.globexCrm)).toBeVisible();

      // Window A was in view the whole time and still shows the first organization. Saving
      // there must not change Globex.
      await windowA.getByText('Position für alle festlegen').click();
      const refused = windowA.waitForResponse(
        (response) => response.url().endsWith('/api/v1/admin/tenant') && response.request().method() === 'PATCH',
      );
      await windowA.getByRole('button', { name: 'Speichern' }).click();
      const answer = await refused;
      expect(answer.status()).toBe(409);
      expect((await answer.json()).error.code).toBe('tenant_changed');

      // The window says what happened and now shows the organization the session is really in.
      await expect(windowA.locator('body')).toContainText('Deine letzte Anfrage wurde deshalb nicht ausgeführt');
      await expect(windowA.locator('body')).toContainText('Vorgaben für alle in Globex AG');
      await expect(dockApp(windowA, apps.globexCrm)).toBeVisible();

      // Neither organization was changed.
      const gina = await apiAs('gina');
      expect((await (await gina.get('/api/v1/admin/tenant')).json()).nav_position_locked).toBe(false);
      await gina.dispose();
      const root = await apiAs('root');
      expect((await root.post('/api/v1/me/active-tenant', { data: { tenant_id: tenants.main } })).status()).toBe(200);
      expect((await (await root.get('/api/v1/admin/tenant')).json()).nav_position_locked).toBe(false);
      await root.dispose();
    } finally {
      // The other tests expect this session in its first organization.
      const root = await apiAs('root');
      await root.post('/api/v1/me/active-tenant', { data: { tenant_id: tenants.main } });
      await root.dispose();
      await context.close();
    }
  });

  test('der Name der Installation erscheint auf der Anmeldeseite', async ({ browser }) => {
    const name = `Admin Cave Dock ${Date.now() % 1000}`;
    const root = await apiAs('root');
    expect((await root.patch('/api/v1/system/settings', { data: { instance_name: name } })).status()).toBe(200);

    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto('/login');
    await expect(page.locator('body')).toContainText(name);
    // Keycloak's page carries the same name.
    await page.getByTestId('login-button').click();
    await expect(page.locator('#kc-header-wrapper')).toContainText(name);
    await visitor.close();

    await root.patch('/api/v1/system/settings', { data: { instance_name: 'Velydock' } });
    await root.dispose();
  });

  test('alle Benutzer sind für den Systemadministrator sichtbar, mit ihren Organisationen', async ({ browser }) => {
    const context = await contextAs(browser, 'root');
    const page = await context.newPage();
    await page.goto('/system/users');
    const table = page.getByTestId('system-users-table');
    await expect(table.locator('tr[data-username="gina"]')).toContainText('Globex AG');
    await expect(table.locator('tr[data-username="mia"]')).toContainText('Acme GmbH');
    await expect(table.locator('tr[data-username="root"]')).toContainText('Admin Cave');
    await context.close();
  });
});
