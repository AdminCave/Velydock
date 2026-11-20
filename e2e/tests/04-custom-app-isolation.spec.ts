import { expect, test, type Page } from '@playwright/test';
import { DOCK_URL, SANDBOX_URL } from '../support/stack';
import { apiAs, contextAs, world } from '../support/world';

type Probe = Record<string, string>;

/** Open a custom app and read what its own JavaScript found out about its surroundings. */
async function runProbe(page: Page, appId: string): Promise<Probe> {
  await page.goto(`/app/${appId}`);
  const frame = page.frameLocator(`[data-testid="app-frame"][data-app-id="${appId}"]`);
  await expect(frame.locator('#probe[data-done="true"]')).toBeVisible({ timeout: 20_000 });
  return JSON.parse((await frame.locator('#probe').textContent())!) as Probe;
}

test.describe('Eigene Apps sind vom Rest isoliert', () => {
  test('der Frame ist eine Sandbox ohne eigenen Origin und kommt vom Sandbox-Host', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto(`/app/${apps.notes}`);
    const frame = page.locator(`[data-testid="app-frame"][data-app-id="${apps.notes}"]`);
    await expect(frame).toHaveAttribute('data-app-type', 'custom');
    await expect(frame).toHaveAttribute('src', new RegExp(`^${SANDBOX_URL}/c/`));

    const sandbox = ((await frame.getAttribute('sandbox')) ?? '').split(/\s+/).filter(Boolean);
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox.filter((flag) => flag.startsWith('allow-top-navigation'))).toEqual([]);
    expect(await frame.getAttribute('allow')).toBeNull();
    await context.close();
  });

  test('eigener Code läuft, erreicht aber weder Cookies noch Speicher noch die Velydock-Seite', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    const probe = await runProbe(page, apps.notes);

    expect(probe.origin).toBe('null'); // an opaque origin: not the sandbox host, not Velydock
    for (const capability of ['cookie', 'localStorage', 'sessionStorage', 'parentDocument', 'parentLocation', 'topNavigation']) {
      expect(probe[capability], capability).toMatch(/^BLOCKED:/);
    }
    // Without the network option the code cannot talk to anything, Velydock's API included.
    expect(probe.api).toMatch(/^BLOCKED:/);
    expect(probe.apiNoCors).toMatch(/^BLOCKED:/);

    // The page is still Velydock (the app could not navigate it away) and the session works.
    expect(page.url()).toBe(`${DOCK_URL}/app/${apps.notes}`);
    expect((await page.request.get('/api/v1/me')).status()).toBe(200);

    // And it is a working app: its script reacts to a click.
    const frame = page.frameLocator(`[data-app-id="${apps.notes}"]`);
    await frame.locator('#count').click();
    await expect(frame.locator('#count')).toHaveText('Geklickt: 1');
    // It received the user's theme.
    expect(['dark', 'light']).toContain(probe.theme);
    await context.close();
  });

  test('auch mit Netzwerkzugriff gehen keine Anmeldedaten an Velydock und nichts wird ausgelöst', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    const toVelydock: { url: string; cookie: string | undefined; method: string }[] = [];
    page.on('request', async (request) => {
      const frame = request.frame();
      if (frame !== page.mainFrame() && request.url().startsWith(`${DOCK_URL}/api/`)) {
        toVelydock.push({ url: request.url(), method: request.method(), cookie: (await request.allHeaders()).cookie });
      }
    });
    const probe = await runProbe(page, apps.netNotes);

    expect(probe.origin).toBe('null');
    // Reading the API fails (no CORS permission) …
    expect(probe.api).toMatch(/^BLOCKED:/);
    // … and the requests that did leave the frame carried no session cookie.
    expect(toVelydock.length).toBeGreaterThan(0);
    for (const request of toVelydock) expect(request.cookie ?? '', request.url).not.toContain('velydock_session');
    // The blind POST to the logout endpoint changed nothing: the user is still signed in.
    expect((await page.request.get('/api/v1/me')).status()).toBe(200);
    for (const capability of ['cookie', 'localStorage', 'parentDocument', 'topNavigation']) {
      expect(probe[capability], capability).toMatch(/^BLOCKED:/);
    }
    await context.close();
  });

  test('auch direkt im Browser geöffnet bleibt die App in der Sandbox', async ({ browser }) => {
    const { apps } = world();
    const mia = await apiAs('mia');
    const launched = await (await mia.post(`/api/v1/workspace/apps/${apps.notes}/launch`, { data: { theme: 'dark', language: 'de' } })).json();
    await mia.dispose();
    expect(launched.url.startsWith(`${SANDBOX_URL}/c/`)).toBe(true);

    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    const response = await page.goto(launched.url);
    const csp = response!.headers()['content-security-policy']!;
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain('allow-same-origin');
    expect(response!.headers()['set-cookie']).toBeUndefined();
    await expect(page.locator('#probe[data-done="true"]')).toBeVisible();
    const probe = JSON.parse((await page.locator('#probe').textContent())!) as Probe;
    expect(probe.origin).toBe('null');
    expect(probe.cookie).toMatch(/^BLOCKED:/);
    expect(probe.localStorage).toMatch(/^BLOCKED:/);
    await context.close();
  });

  test('Links sind kurzlebig signiert; gefälschte werden abgewiesen', async ({ browser }) => {
    const { apps } = world();
    const mia = await apiAs('mia');
    const { url, expires_in } = await (await mia.post(`/api/v1/workspace/apps/${apps.notes}/launch`, { data: {} })).json();
    expect(expires_in).toBeLessThanOrEqual(600);
    const context = await browser.newContext();
    const [payload, signature] = url.split('/c/')[1].split('.');
    for (const forged of [`${payload}.${signature.split('').reverse().join('')}`, `${payload}A.${signature}`, 'abc.def', 'x']) {
      const response = await context.request.get(`${SANDBOX_URL}/c/${forged}`);
      expect(response.status(), forged).toBe(403);
      expect(await response.text()).not.toContain('Notizen');
    }
    // A valid link needs no session – and grants nothing beyond this one document.
    expect((await context.request.get(url)).status()).toBe(200);
    await context.close();
    await mia.dispose();
  });

  test('der Sandbox-Host hat keine API und keine Oberfläche, auch nicht mit Session-Cookie', async () => {
    const mia = await apiAs('mia');
    for (const path of ['/api/v1/me', '/api/v1/workspace/apps', '/api/health', '/', '/admin/users', '/login']) {
      const response = await mia.get(`${SANDBOX_URL}${path}`);
      expect(response.status(), path).toBe(404);
      expect(await response.text(), path).toBe('');
    }
    await mia.dispose();
  });

  test('wer eine eigene App nicht sehen darf, bekommt keinen Link dafür', async () => {
    const { apps } = world();
    const gero = await apiAs('gero'); // member of another organization
    expect((await gero.post(`/api/v1/workspace/apps/${apps.notes}/launch`, { data: {} })).status()).toBe(404);
    await gero.dispose();
  });
});
