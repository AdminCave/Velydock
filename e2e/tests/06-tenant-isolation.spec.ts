import { expect, test } from '@playwright/test';
import { apiAs, contextAs, world } from '../support/world';

/**
 * The same isolation rules as in the backend test suite, checked once more against the
 * deployed stack: real sessions, real reverse proxy, real database roles.
 */
test.describe('Mandanten sind voneinander getrennt', () => {
  test('ein Administrator sieht nur Benutzer, Gruppen und Apps der eigenen Organisation', async () => {
    const gina = await apiAs('gina');
    const users = await (await gina.get('/api/v1/admin/users?page_size=200')).json();
    expect(users.items.map((u: { username: string }) => u.username).sort()).toEqual(['gero', 'gina']);
    for (const term of ['mia', 'anna', 'velydock.test', 'Admin']) {
      const found = await (await gina.get(`/api/v1/admin/users?search=${term}`)).json();
      const names = found.items.map((u: { username: string }) => u.username);
      expect(names.every((name: string) => ['gina', 'gero'].includes(name)), term).toBe(true);
    }
    expect(await (await gina.get('/api/v1/admin/groups')).json()).toEqual([]);
    const apps = await (await gina.get('/api/v1/admin/apps')).json();
    expect(apps.map((a: { name: string }) => a.name)).toEqual(['Globex CRM']);
    await gina.dispose();
  });

  test('fremde IDs existieren für ihn nicht', async () => {
    const { users, groups, apps } = world();
    const gina = await apiAs('gina');
    const attempts = [
      gina.get(`/api/v1/admin/users/${users.mia}`),
      gina.patch(`/api/v1/admin/users/${users.mia}`, { data: { first_name: 'Gekapert' } }),
      gina.patch(`/api/v1/admin/users/${users.mia}`, { data: { active: false } }),
      gina.post(`/api/v1/admin/users/${users.mia}/reset-password`),
      gina.post(`/api/v1/admin/users/${users.anna}/reset-password`),
      gina.delete(`/api/v1/admin/users/${users.mia}`),
      gina.get(`/api/v1/admin/groups/${groups.office}`),
      gina.patch(`/api/v1/admin/groups/${groups.office}`, { data: { name: 'Gekapert' } }),
      gina.delete(`/api/v1/admin/groups/${groups.office}`),
      gina.get(`/api/v1/admin/apps/${apps.notes}`),
      gina.patch(`/api/v1/admin/apps/${apps.notes}`, { data: { custom_js: 'alert(1)' } }),
      gina.delete(`/api/v1/admin/apps/${apps.demo}`),
      gina.post(`/api/v1/workspace/apps/${apps.demo}/launch`, { data: {} }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status(), `${response.url()}`).toBe(404);
      expect((await response.json()).error.code).toBe('not_found');
    }
    // Nothing happened on the other side.
    const anna = await apiAs('anna');
    const mia = await (await anna.get(`/api/v1/admin/users/${users.mia}`)).json();
    expect(mia).toMatchObject({ first_name: 'Mia', active: true });
    expect((await (await anna.get(`/api/v1/admin/groups/${groups.office}`)).json()).name).toBe('Büro');
    await anna.dispose();
    await gina.dispose();
  });

  test('fremde IDs lassen sich nicht in eigene Objekte schmuggeln', async () => {
    const { users, groups } = world();
    const gina = await apiAs('gina');
    const cases: [Promise<import('@playwright/test').APIResponse>, string][] = [
      [gina.post('/api/v1/admin/groups', { data: { name: 'X', member_ids: [users.mia] } }), 'unknown_user'],
      [gina.post('/api/v1/admin/apps', { data: { name: 'X', type: 'external', url: 'https://x.example/', group_ids: [groups.office] } }), 'unknown_group'],
      [gina.post('/api/v1/admin/apps', { data: { name: 'X', type: 'external', url: 'https://x.example/', user_ids: [users.mia] } }), 'unknown_user'],
      [gina.patch(`/api/v1/admin/users/${users.gero}`, { data: { group_ids: [groups.office] } }), 'unknown_group'],
    ];
    for (const [request, code] of cases) {
      const response = await request;
      expect(response.status()).toBe(422);
      expect((await response.json()).error.code).toBe(code);
    }
    await gina.dispose();
  });

  test('der Wechsel in eine fremde Organisation und die Systemverwaltung bleiben verschlossen', async () => {
    const { tenants } = world();
    const gina = await apiAs('gina');
    expect((await gina.post('/api/v1/me/active-tenant', { data: { tenant_id: tenants.acme } })).status()).toBe(404);
    const me = await (await gina.get('/api/v1/me')).json();
    expect(me.active_tenant.slug).toBe('globex');
    expect(me.memberships.map((m: { tenant: { slug: string } }) => m.tenant.slug)).toEqual(['globex']);
    for (const path of ['/api/v1/system/tenants', '/api/v1/system/users', '/api/v1/system/settings', '/api/v1/system/audit']) {
      expect((await gina.get(path)).status(), path).toBe(403);
    }
    expect((await gina.post(`/api/v1/system/tenants/${tenants.acme}/delete`, { data: { confirm_slug: 'acme' } })).status()).toBe(403);
    await gina.dispose();
  });

  test('in der Oberfläche taucht nichts aus der anderen Organisation auf', async ({ browser }) => {
    const context = await contextAs(browser, 'gina');
    const page = await context.newPage();
    await page.goto('/admin/users');
    const table = page.getByTestId('users-table');
    await expect(table).toContainText('gero');
    await expect(table).not.toContainText('mia');
    await expect(table).not.toContainText('anna');
    await page.goto('/admin/apps');
    await expect(page.getByTestId('apps-table')).toContainText('Globex CRM');
    await expect(page.getByTestId('apps-table')).not.toContainText('Notizen');
    await context.close();
  });

  test('Rollen begrenzen, was jemand in der eigenen Organisation darf', async () => {
    const { users } = world();
    const mia = await apiAs('mia');
    for (const path of ['/api/v1/admin/users', '/api/v1/admin/groups', '/api/v1/admin/apps', '/api/v1/admin/tenant', '/api/v1/admin/audit']) {
      expect((await mia.get(path)).status(), path).toBe(403);
    }
    await mia.dispose();

    const uwe = await apiAs('uwe'); // user manager
    expect((await uwe.get('/api/v1/admin/users')).status()).toBe(200);
    expect((await uwe.get('/api/v1/admin/apps')).status()).toBe(403);
    expect((await uwe.patch(`/api/v1/admin/users/${users.mia}`, { data: { role: 'tenant_admin' } })).status()).toBe(403);
    expect((await uwe.post(`/api/v1/admin/users/${users.anna}/reset-password`)).status()).toBe(403);
    expect((await uwe.patch(`/api/v1/admin/users/${users.uwe}`, { data: { role: 'tenant_admin' } })).status()).toBe(403);
    await uwe.dispose();
  });
});
