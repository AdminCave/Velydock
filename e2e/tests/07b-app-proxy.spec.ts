import { expect, test, type APIRequestContext } from '@playwright/test';
import { APPS_HOST, APPS_URL, AUTH_URL, DOCK_URL } from '../support/stack';
import { apiAs, contextAs, unique, world } from '../support/world';

/** What the demo app (traefik/whoami) echoes of the request it received. */
const seen = (body: string, pattern: RegExp) =>
  body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => pattern.test(line));

/** The proxy fetches its routes every five seconds; wait until a route is there (or gone). */
async function routed(request: APIRequestContext, url: string, expected: (status: number) => boolean): Promise<void> {
  await expect
    .poll(async () => expected((await request.get(url, { maxRedirects: 0 })).status()), { timeout: 20_000, intervals: [1000] })
    .toBe(true);
}

test.describe('Apps über den eingebauten Proxy veröffentlichen', () => {
  // The demo container is reachable for the proxy under the name "demo". Released for Acme only.
  let releaseId = '';

  test.beforeAll(async () => {
    const root = await apiAs('root');
    const added = await root.post(`/api/v1/system/tenants/${world().tenants.acme}/proxy-targets`, { data: { value: 'demo' } });
    expect([201, 409]).toContain(added.status());
    const all = await (await root.get(`/api/v1/system/tenants/${world().tenants.acme}/proxy-targets`)).json();
    releaseId = all.find((target: { value: string }) => target.value === 'demo').id;
    await root.dispose();
  });

  test.afterAll(async () => {
    const anna = await apiAs('anna');
    for (const app of await (await anna.get('/api/v1/admin/apps')).json()) {
      if (app.publication) await anna.delete(`/api/v1/admin/apps/${app.id}`);
    }
    await anna.dispose();
    const root = await apiAs('root');
    await root.delete(`/api/v1/system/tenants/${world().tenants.acme}/proxy-targets/${releaseId}`);
    await root.dispose();
  });

  test('eine geschützte App erreicht nur, wer angemeldet ist und sie freigegeben bekam', async ({ browser, playwright }) => {
    const name = unique('wiki').toLowerCase();
    const anna = await apiAs('anna');
    const created = await anna.post('/api/v1/admin/apps', {
      data: {
        name: `Wiki ${name}`,
        type: 'external',
        user_ids: [world().users.mia],
        publication: { name, target_url: 'http://demo', template: 'builtin:header-login' },
      },
    });
    expect(created.status()).toBe(201);
    const app = await created.json();
    expect(app.url).toBe(`${APPS_URL}/${name}/`);
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    await routed(anonymous, app.url, (status) => status === 302 || status === 401);

    // Not signed in: a page is led to Velydock's sign-in, a script's request is refused.
    const nobody = await browser.newContext();
    const visitor = await nobody.newPage();
    await visitor.goto(`${app.url}geheim`);
    await expect(visitor).toHaveURL(new RegExp(`^${DOCK_URL}/login`));
    expect((await anonymous.get(`${app.url}api`, { headers: { 'Sec-Fetch-Mode': 'cors', Accept: 'application/json' } })).status()).toBe(401);
    await nobody.close();

    // Signed in and granted: straight into the app, at the page that was asked for.
    const granted = await contextAs(browser, 'mia');
    const page = await granted.newPage();
    const response = await page.goto(`${app.url}sub/seite?x=1`);
    expect(response!.status()).toBe(200);
    expect(page.url()).toBe(`${app.url}sub/seite?x=1`);
    const body = await page.locator('body').innerText();
    // The app gets the path without the name, and is told who is signed in (this template).
    expect(seen(body, /^GET /)).toEqual(['GET /sub/seite?x=1 HTTP/1.1']);
    expect(seen(body, /^X-Forwarded-Prefix/i)).toEqual([`X-Forwarded-Prefix: /${name}`]);
    expect(seen(body, /^X-Velydock-User/i)).toEqual(['X-Velydock-User: mia']);
    // Its cookie is for this app's path only, and no script can read it.
    const cookies = await granted.cookies(app.url);
    const own = cookies.filter((cookie) => cookie.name === `__Secure-velydock-app-${name}`);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ path: `/${name}/`, httpOnly: true, secure: true, sameSite: 'Lax' });
    // Nobody can tell the app to be somebody else.
    const forged = await page.request.get(app.url, { headers: { 'X-Velydock-User': 'root', 'X-Velydock-Email': 'x@evil.example' } });
    expect(seen(await forged.text(), /^X-Velydock-(User|Email)/i).sort()).toEqual(['X-Velydock-Email: mia@velydock.test', 'X-Velydock-User: mia'].sort());
    await granted.close();

    // Signed in, but not granted (Ben) - and somebody from another organization.
    for (const account of ['ben', 'gero'] as const) {
      const other = await contextAs(browser, account);
      const otherPage = await other.newPage();
      const refused = await otherPage.goto(app.url);
      expect(refused!.status(), account).toBe(403);
      expect(otherPage.url().startsWith(DOCK_URL)).toBe(true);
      await other.close();
    }
    await anonymous.dispose();
    await anna.dispose();
  });

  test('eine öffentliche App auf eigener Subdomain braucht keine Anmeldung – und erfährt nichts über Angemeldete', async ({ playwright }) => {
    const name = unique('seite').toLowerCase();
    const anna = await apiAs('anna');
    const app = await (
      await anna.post('/api/v1/admin/apps', {
        data: { name: `Seite ${name}`, type: 'external', visible_to_all: true, publication: { name, mode: 'subdomain', target_url: 'http://demo', access: 'public' } },
      })
    ).json();
    expect(app.url).toBe(`https://${name}.${APPS_HOST}/`);
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    await routed(anonymous, app.url, (status) => status === 200);
    const answer = await anonymous.get(`${app.url}hallo`, { headers: { 'X-Velydock-User': 'root' } });
    expect(answer.status()).toBe(200);
    expect(seen(await answer.text(), /^GET /)).toEqual(['GET /hallo HTTP/1.1']);
    expect(seen(await answer.text(), /^X-Velydock/i)).toEqual([]);
    await anonymous.dispose();
    await anna.dispose();
  });

  test('veröffentlicht wird nur, was freigegeben ist – und nie etwas von Velydock selbst', async () => {
    const anna = await apiAs('anna');
    const attempt = async (target_url: string, name = unique('x').toLowerCase()) =>
      (await (await anna.post('/api/v1/admin/apps', { data: { name: unique('Versuch'), type: 'external', publication: { name, target_url } } })).json()).error?.code;
    for (const target of ['http://keycloak:8080', 'http://velydock:8000', 'http://postgres:5432', 'http://127.0.0.1:8000', 'http://169.254.169.254', 'http://mail:8025']) {
      expect(await attempt(target), target).toBe('proxy_target_not_allowed');
    }
    // Names that would spell a part of the installation, or more than a name.
    for (const name of ['api', 'www', 'dock', 'demo`) || Host(`dock.velydock.localhost']) {
      expect(await attempt('http://demo', name), name).toBe('publication_name_invalid');
    }
    // Another organization has nothing released, and cannot take a name that is in use.
    const gina = await apiAs('gina');
    const refused = await gina.post('/api/v1/admin/apps', { data: { name: 'Fremd', type: 'external', publication: { name: unique('g').toLowerCase(), target_url: 'http://demo' } } });
    expect((await refused.json()).error.code).toBe('proxy_target_not_allowed');
    await gina.dispose();
    await anna.dispose();
  });

  test('wird die Freigabe zurückgezogen oder die App nicht mehr veröffentlicht, ist die Adresse wenige Sekunden später weg', async ({ playwright }) => {
    const anna = await apiAs('anna');
    const root = await apiAs('root');
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    const make = async () => {
      const name = unique('kurz').toLowerCase();
      const app = await (
        await anna.post('/api/v1/admin/apps', { data: { name: `Kurz ${name}`, type: 'external', publication: { name, mode: 'subdomain', target_url: 'http://demo', access: 'public' } } })
      ).json();
      await routed(anonymous, app.url, (status) => status === 200);
      return app;
    };

    const first = await make();
    expect((await anna.patch(`/api/v1/admin/apps/${first.id}`, { data: { publication: null, url: 'https://example.org/' } })).status()).toBe(200);
    await routed(anonymous, first.url, (status) => status === 404);

    const second = await make();
    expect((await root.delete(`/api/v1/system/tenants/${world().tenants.acme}/proxy-targets/${releaseId}`)).status()).toBe(204);
    await routed(anonymous, second.url, (status) => status === 404);
    expect((await (await anna.get(`/api/v1/admin/apps/${second.id}`)).json()).publication.problem).toBe('target_not_allowed');
    // Released again, it is back without anybody touching the app.
    releaseId = (await (await root.post(`/api/v1/system/tenants/${world().tenants.acme}/proxy-targets`, { data: { value: 'demo' } })).json()).id;
    await routed(anonymous, second.url, (status) => status === 200);
    await anonymous.dispose();
    await root.dispose();
    await anna.dispose();
  });

  test('die Wege, auf denen der Proxy Velydock fragt, gibt es von außen nicht', async ({ request }) => {
    for (const path of ['/internal/proxy/traefik', `/internal/proxy/auth/${world().apps.demo}`]) {
      const attempts: Record<string, string>[] = [{}, { 'X-Velydock-Proxy-Secret': 'dev-proxy-secret-0123456789' }, { Host: 'velydock:8000' }];
      for (const headers of attempts) {
        expect((await request.get(path, { headers })).status(), `${path} ${JSON.stringify(headers)}`).toBe(404);
      }
    }
    // And the sign-in of Keycloak is not reachable through an app's address either.
    expect(AUTH_URL).not.toContain(APPS_HOST);
  });
});
