import { request as https } from 'node:https';
import { expect, test } from '@playwright/test';
import { AUTH_URL, DOCK_URL, SANDBOX_URL, compose } from '../support/stack';

test.describe('Die Docker-Installation', () => {
  test('alle Dienste laufen und melden sich gesund', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect((await health.json()).status).toBe('ok');
    const services = compose('ps', '--format', '{{.Service}} {{.State}} {{.Health}}').trim().split('\n').sort();
    expect(services).toEqual(
      expect.arrayContaining([
        'keycloak running healthy',
        'postgres running healthy',
        'velydock running healthy',
      ]),
    );
    expect(services.some((line) => line.startsWith('traefik running'))).toBe(true);
  });

  test('die Oberfläche wird mit strengen Sicherheits-Headern ausgeliefert', async ({ request }) => {
    const response = await request.get('/');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    const csp = headers['content-security-policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toContain('max-age=');
    // The policy forbids inline scripts, so the page must not contain any.
    const html = await response.text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });

  test('die Oberfläche lädt ohne Fehler und ohne Verstoß gegen die Content Security Policy', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('requestfailed', (request) => problems.push(`failed: ${request.url()}`));
    await page.goto('/login');
    await expect(page.getByTestId('login-button')).toBeVisible();
    // The only expected "error" is the 401 of the session check on a public page.
    expect(problems.filter((p) => !p.includes('401'))).toEqual([]);
    // No request left the installation (fonts and icons are bundled).
    const hosts = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => new URL(entry.name).host),
    );
    expect([...new Set(hosts)]).toEqual([new URL(DOCK_URL).host]);
  });

  test('Keycloaks Verwaltung und der master-Realm sind von außen nicht erreichbar', async ({ request }) => {
    for (const path of [
      '/admin/',
      '/admin/master/console/',
      '/admin/realms/velydock/users',
      '/realms/master/.well-known/openid-configuration',
      '/realms/master/protocol/openid-connect/token',
      '/metrics',
      '/health',
    ]) {
      expect((await request.get(`${AUTH_URL}${path}`)).status(), path).toBe(404);
    }
    expect((await request.get(`${AUTH_URL}/realms/velydock/.well-known/openid-configuration`)).status()).toBe(200);
  });

  test('die Anmeldeseite trägt das Velydock-Theme', async ({ page }) => {
    const failed: string[] = [];
    page.on('response', (response) => {
      // The login page asks whether a session exists; 401 is the expected answer here.
      if (response.status() >= 400 && !response.url().endsWith('/api/v1/me')) failed.push(`${response.status()} ${response.url()}`);
    });
    await page.goto('/login');
    await page.getByTestId('login-button').click();
    await expect(page.locator('#username')).toBeVisible();
    const styles = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((l) => l.getAttribute('href') ?? ''));
    // Installed under a content hash, so browsers never keep an outdated copy.
    expect(styles.some((href) => /\/login\/velydock\/v-[0-9a-f]{12}\/css\/velydock\.css$/.test(href))).toBe(true);
    expect(await page.locator('#kc-page-title').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Geist');
    // One centred card at every width (the stock theme narrows it on wide screens).
    for (const width of [1440, 1280, 800, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const card = (await page.locator('.pf-v5-c-login__main').boundingBox())!;
      expect(card.width, `card at ${width}px`).toBeGreaterThanOrEqual(Math.min(width - 40, 380));
      expect(card.width, `card at ${width}px`).toBeLessThanOrEqual(420);
      expect(Math.abs(card.x + card.width / 2 - width / 2), `centred at ${width}px`).toBeLessThan(12);
    }
    expect(failed).toEqual([]);
  });

  test('Überwachung per HEAD bekommt eine Antwort', async ({ request }) => {
    expect((await request.head('/')).status()).toBe(200);
    expect((await request.head('/api/health')).status()).toBe(200);
  });

  test('übergroße Anfragen werden abgewiesen, auch ohne Anmeldung', async ({ request }) => {
    const response = await request.post('/api/auth/backchannel-logout', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: 'logout_token=' + 'a'.repeat(5 * 1024 * 1024),
    });
    expect(response.status()).toBe(413);
  });

  test('ein kodierter Schrägstrich führt nicht an den Proxy-Regeln vorbei', async ({ request }) => {
    // The backend would read "/api%2Fhealth" as "/api/health"; the proxy must not pass it on.
    expect((await request.get('/api%2Fhealth')).status()).toBe(400);
    expect((await request.get('/api%2fv1/me')).status()).toBe(400);
  });

  test('der Sandbox-Host bleibt Sandbox, auch mit Punkt am Ende des Namens', async () => {
    // "sandbox.example.com." is the same host. Sent as Host header to the same address.
    const sandbox = new URL(SANDBOX_URL);
    const status = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = https(
          {
            host: '127.0.0.1',
            port: sandbox.port,
            servername: sandbox.hostname,
            path,
            method: 'GET',
            headers: { Host: `${sandbox.hostname}.:${sandbox.port}` },
            rejectUnauthorized: false,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await status('/api/health')).toBe(404);
    expect(await status('/api/v1/public')).toBe(404);
    expect(await status('/')).toBe(404);
  });

  test('der Anwendungscontainer läuft unprivilegiert auf schreibgeschütztem Dateisystem', async () => {
    expect(compose('exec', '-T', 'velydock', 'id', '-u').trim()).toBe('10001');
    expect(compose('exec', '-T', 'velydock', 'velydock', 'version').trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => compose('exec', '-T', 'velydock', 'sh', '-c', 'echo x > /app/probe')).toThrow();
  });

  test('die Datenbankrolle der Anwendung kann die Mandantentrennung nicht umgehen', async () => {
    const sql = 'SELECT rolsuper::int + rolbypassrls::int + rolcreaterole::int + rolcreatedb::int FROM pg_roles WHERE rolname = \'velydock\'';
    expect(compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-Atc', sql).trim()).toBe('0');
    const unprotected =
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' " +
      "AND c.relkind = 'r' AND relname <> 'alembic_version' AND NOT (relrowsecurity AND relforcerowsecurity)";
    expect(compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'velydock', '-Atc', unprotected).trim()).toBe('0');
  });

  // Last on purpose: it uses up the allowance of this client address for a few seconds.
  test('der Proxy begrenzt Anfragen an die API, nicht aber an die Oberfläche', async ({ request }) => {
    let limited = 0;
    let served = 0;
    for (let round = 0; round < 12 && limited === 0; round++) {
      const statuses = await Promise.all(
        Array.from({ length: 300 }, () => request.get('/api/health').then((response) => response.status())),
      );
      limited += statuses.filter((status) => status === 429).length;
      served += statuses.filter((status) => status === 200).length;
    }
    expect(limited, 'a burst is throttled').toBeGreaterThan(0);
    expect(served, 'normal use is not').toBeGreaterThanOrEqual(300);
    // The page itself is not behind the limit: it loads while the API allowance is used up.
    expect((await request.get('/login')).status()).toBe(200);
    // Let the allowance recover before anything else talks to the API.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect((await request.get('/api/health')).status()).toBe(200);
  });
});
