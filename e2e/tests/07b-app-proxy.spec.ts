import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { APPS_HOST, APPS_URL, AUTH_URL, DOCK_URL } from '../support/stack';
import { apiAs, contextAs, unique, world } from '../support/world';

/**
 * One valid value for every field of the Traefik middlewares a system administrator may put into
 * a proxy template. The backend tests check that the list is complete; here the real Traefik reads it.
 */
const MIDDLEWARE_SAMPLES: Record<string, unknown>[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../backend/tests/data/traefik_middlewares.json', import.meta.url)), 'utf8'),
).sets;

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
    // What tied the sign-in to this browser has done its work and is gone.
    expect(cookies.filter((cookie) => cookie.name.includes('velydock-state'))).toEqual([]);
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

  test('ein untergeschobener Anmelde-Link meldet niemanden unter fremdem Namen an', async ({ browser, playwright }) => {
    const name = unique('heft').toLowerCase();
    const anna = await apiAs('anna');
    const app = await (
      await anna.post('/api/v1/admin/apps', {
        data: {
          name: `Heft ${name}`,
          type: 'external',
          user_ids: [world().users.mia, world().users.ben],
          publication: { name, mode: 'subdomain', target_url: 'http://demo', template: 'builtin:header-login' },
        },
      })
    ).json();
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    await routed(anonymous, app.url, (status) => status === 302 || status === 401);
    await anonymous.dispose();

    // Ben may use the app. He begins a sign-in in his own browser and keeps the link that would
    // complete it - to send it to somebody else ("look at this").
    const ben = await apiAs('ben');
    const toVelydock = await ben.get(app.url, { maxRedirects: 0, headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });
    expect(toVelydock.status()).toBe(302);
    const toApp = await ben.get(toVelydock.headers()['location']!, { maxRedirects: 0 });
    expect(toApp.status()).toBe(302);
    const link = toApp.headers()['location']!;
    expect(link).toContain(`${app.url}__velydock/callback?t=`);

    // Mia opens it. She ends up in the app - as herself, after a sign-in of her own.
    const victim = await contextAs(browser, 'mia');
    const page = await victim.newPage();
    const response = await page.goto(link);
    expect(response!.status()).toBe(200);
    expect(page.url()).toBe(app.url);
    expect(seen(await page.locator('body').innerText(), /^X-Velydock-User/i)).toEqual(['X-Velydock-User: mia']);
    await victim.close();

    // Ben's own browser can still finish what it began.
    expect((await ben.get(link, { maxRedirects: 0 })).status()).toBe(302);
    expect(seen(await (await ben.get(app.url)).text(), /^X-Velydock-User/i)).toEqual(['X-Velydock-User: ben']);
    await ben.dispose();
    await anna.dispose();
  });

  test('was Velydock an Traefik-Einstellungen annimmt, versteht Traefik – was es nicht verstünde, wird abgelehnt', async ({ playwright }) => {
    const anna = await apiAs('anna');
    const root = await apiAs('root');
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    const publish = (publication: Record<string, unknown>) =>
      anna.post('/api/v1/admin/apps', {
        data: { name: unique('Probe'), type: 'external', visible_to_all: true, publication: { mode: 'subdomain', target_url: 'http://demo', access: 'public', ...publication } },
      });
    const templates: string[] = [];
    try {
      // Traefik reads the routes of all organizations as one document; a value of the wrong kind
      // makes it refuse the document and keep what it had. This one once got through.
      const poison = await publish({ name: unique('gift').toLowerCase(), options: { rate_limit: { average: true, burst: true } } });
      expect(poison.status()).toBe(422);
      expect((await poison.json()).error.code).toBe('proxy_options_invalid');

      // Every field Velydock accepts in a template, in use. How each route answers shows that
      // its middlewares are in effect: a password is asked for, a host is refused, a limit not reached.
      const answers: ((response: APIResponse) => boolean)[] = [
        (response) => response.status() === 401 && /^Basic/.test(response.headers()['www-authenticate'] ?? ''),
        (response) => response.status() !== 404,
        (response) => response.status() === 200,
      ];
      expect(MIDDLEWARE_SAMPLES).toHaveLength(answers.length);
      const urls: string[] = [];
      for (const [index, sample] of MIDDLEWARE_SAMPLES.entries()) {
        const made = await root.post('/api/v1/system/proxy-templates', { data: { name: unique(`Probe ${index}`), options: { custom_middlewares: sample } } });
        expect(made.status(), await made.text()).toBe(201);
        templates.push((await made.json()).id);
        const created = await publish({ name: unique(`probe${index}`).toLowerCase(), template: templates[index] });
        expect(created.status(), await created.text()).toBe(201);
        urls.push((await created.json()).url);
      }
      // A route published after them exists only if Traefik understood the whole document.
      const after = await (await publish({ name: unique('danach').toLowerCase() })).json();
      await routed(anonymous, after.url, (status) => status === 200);
      for (const [index, url] of urls.entries()) {
        await expect
          .poll(async () => answers[index]!(await anonymous.get(url, { maxRedirects: 0 })), { timeout: 20_000, intervals: [1000], message: `set ${index}` })
          .toBe(true);
      }
    } finally {
      for (const app of await (await anna.get('/api/v1/admin/apps')).json()) {
        if (app.publication && templates.includes(app.publication.template)) await anna.delete(`/api/v1/admin/apps/${app.id}`);
      }
      for (const id of templates) await root.delete(`/api/v1/system/proxy-templates/${id}`);
    }
    await anonymous.dispose();
    await root.dispose();
    await anna.dispose();
  });

  test('schaltet der Systemadministrator Pfad-Adressen für eine Organisation ab, bleiben ihr Subdomains', async ({ playwright }) => {
    const anna = await apiAs('anna');
    const root = await apiAs('root');
    const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    const acme = `/api/v1/system/tenants/${world().tenants.acme}`;
    const name = unique('pfad').toLowerCase();
    const body = (publication: Record<string, unknown>) => ({ publication: { name, target_url: 'http://demo', access: 'public', ...publication } });
    const app = await (await anna.post('/api/v1/admin/apps', { data: { name: `Pfad ${name}`, type: 'external', ...body({}) } })).json();
    expect(app.url).toBe(`${APPS_URL}/${name}/`);
    await routed(anonymous, app.url, (status) => status === 200);
    try {
      const off = await root.patch(acme, { data: { proxy_path_allowed: false } });
      expect(off.status()).toBe(200);
      expect((await off.json()).proxy_path_allowed).toBe(false);
      // What is published by path goes off the proxy, and the app says why.
      await routed(anonymous, app.url, (status) => status === 404);
      expect((await (await anna.get(`/api/v1/admin/apps/${app.id}`)).json()).publication.problem).toBe('mode_not_allowed');
      expect((await (await anna.get('/api/v1/admin/proxy')).json()).path_allowed).toBe(false);
      const refused = await anna.post('/api/v1/admin/apps', { data: { name: unique('Nein'), type: 'external', publication: { name: unique('nein').toLowerCase(), target_url: 'http://demo' } } });
      expect((await refused.json()).error.code).toBe('publication_mode_not_allowed');
      // Under a sub-domain it has an origin of its own, and is back.
      const moved = await anna.patch(`/api/v1/admin/apps/${app.id}`, { data: body({ mode: 'subdomain' }) });
      expect(moved.status()).toBe(200);
      await routed(anonymous, (await moved.json()).url, (status) => status === 200);
    } finally {
      expect((await root.patch(acme, { data: { proxy_path_allowed: true } })).status()).toBe(200);
    }
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
