import { expect, test, type Page } from '@playwright/test';
import { appFrame, chooseSetting, dockApp } from '../support/ui';
import { apiAs, contextAs, world } from '../support/world';

// A 16x16 PNG, one colour.
const LOGO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGklEQVR42mM85MjDQApgYiARjGoY1TB0NAAAcMUBL+p9mbMAAAAASUVORK5CYII=',
  'base64',
);
const ORANGE = '#c2410c';
const TEAL = '#0f766e';
const YELLOW = '#facc15';

/** The accent colour that is in effect, as the page states it (absent: the built-in one). */
const accentOf = (page: Page) => page.locator('html').getAttribute('data-accent');

/**
 * Contrast of the accent as text against the page background, both as the browser computed them.
 * This is what counts in the end: not what was stored, but what is on screen.
 */
async function accentContrast(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.cssText = 'color: var(--accent); background: var(--bg); position: absolute; left: -9999px';
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const luminance = (colour: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [text, background] = [luminance(style.color), luminance(style.backgroundColor)];
    probe.remove();
    return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
  });
}

test.describe('Erscheinungsbild je Organisation und je Benutzer', () => {
  test.afterEach(async () => {
    // Other tests expect the defaults: nothing chosen, nothing fixed, no logo.
    for (const account of ['mia', 'ben'] as const) {
      const user = await apiAs(account);
      await user.patch('/api/v1/me/settings', { data: { theme: null, accent_color: null, app_bar: null, nav_position: null } });
      await user.dispose();
    }
    for (const account of ['anna', 'gina'] as const) {
      const admin = await apiAs(account);
      await admin.patch('/api/v1/admin/tenant', {
        data: {
          default_theme: null,
          theme_locked: false,
          accent_color: null,
          accent_locked: false,
          default_nav_position: null,
          nav_position_locked: false,
          default_app_bar: null,
          app_bar_locked: false,
          logo: null,
        },
      });
      await admin.dispose();
    }
  });

  test('eine Organisation gibt Logo und Akzentfarbe vor – nur ihre Mitglieder sehen beides', async ({ browser }) => {
    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    await page.goto('/admin/settings');
    await expect(page.locator('body')).toContainText('Vorgaben für alle in Acme GmbH');

    await page.getByTestId('tenant-logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: LOGO });
    await expect(page.getByTestId('tenant-logo-preview')).toBeVisible();
    await page.getByTestId('tenant-accent').getByTestId('accent-custom').fill(ORANGE);
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/admin/tenant') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Speichern' }).click();
    expect((await saved).status()).toBe(200);
    // The administrator sees the result at once, without loading the page again.
    await expect(page.locator('html')).toHaveAttribute('data-accent', ORANGE);
    await expect(page.getByTestId('dock-logo')).toBeVisible();
    await admin.close();

    // A member of the organization: the logo is really an image, the colour really applies.
    const member = await contextAs(browser, 'mia');
    const memberPage = await member.newPage();
    await memberPage.goto('/');
    const logo = memberPage.getByTestId('dock-logo');
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('alt', /Acme GmbH/);
    expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(16);
    expect(await accentOf(memberPage)).toBe(ORANGE);
    expect(await accentContrast(memberPage)).toBeGreaterThanOrEqual(4.5);
    await member.close();

    // Another organization is untouched.
    const other = await contextAs(browser, 'gero');
    const otherPage = await other.newPage();
    await otherPage.goto('/');
    await expect(otherPage.getByTestId('dock')).toBeVisible();
    await expect(otherPage.getByTestId('dock-logo')).toHaveCount(0);
    expect(await accentOf(otherPage)).toBeNull();
    // And there is no address under which it could fetch the other one's logo.
    expect((await otherPage.request.get('/api/v1/tenant/logo')).status()).toBe(404);
    await other.close();
  });

  test('die eigene Akzentfarbe gilt, bis die Organisation ihre für alle festlegt', async ({ browser }) => {
    const anna = await apiAs('anna');
    await anna.patch('/api/v1/admin/tenant', { data: { accent_color: ORANGE } });

    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto('/settings');
    expect(await accentOf(page)).toBe(ORANGE); // nothing chosen: the organization's default

    // An own colour, chosen in the interface: applies at once and is stored on the server.
    const stored = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/me/settings') && response.request().method() === 'PATCH',
    );
    await page.getByTestId('setting-accent').locator(`[data-testid="accent-swatch"][data-color="${TEAL}"]`).click();
    expect((await stored).status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('data-accent', TEAL);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-accent', TEAL);

    // The organization fixes its colour: the own one no longer applies, and the page says why.
    await anna.patch('/api/v1/admin/tenant', { data: { accent_locked: true } });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-accent', ORANGE);
    await expect(page.getByTestId('setting-accent-locked')).toBeVisible();
    await expect(page.getByTestId('setting-accent').locator('[data-testid="accent-swatch"]').first()).toBeDisabled();

    // Released again, the own choice is back: it was kept, not thrown away.
    await anna.patch('/api/v1/admin/tenant', { data: { accent_locked: false } });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-accent', TEAL);
    await expect(page.getByTestId('setting-accent-locked')).toHaveCount(0);
    await anna.dispose();
    await context.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`auch eine ungünstige Akzentfarbe bleibt im ${scheme === 'light' ? 'hellen' : 'dunklen'} Design lesbar`, async ({ browser }) => {
      const mia = await apiAs('mia');
      const context = await contextAs(browser, 'mia');
      const page = await context.newPage();
      // Yellow on white, near-black on black: what an administrator may well pick from a logo.
      for (const colour of [YELLOW, '#ffffff', '#0a0a0a', ORANGE]) {
        await mia.patch('/api/v1/me/settings', { data: { theme: scheme, accent_color: colour } });
        await page.goto('/settings');
        await expect(page.locator('html')).toHaveAttribute('data-accent', colour);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        expect(await accentContrast(page), `${colour} in the ${scheme} theme`).toBeGreaterThanOrEqual(4.5);
      }
      await mia.dispose();
      await context.close();
    });
  }

  test('eine App hat keine Leiste, bis jemand sie einschaltet: oben oder unten – die Aktionen bleiben erreichbar', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    const bar = page.getByTestId('app-bar');
    const frame = appFrame(page, apps.notes);
    const top = async (locator: typeof bar) => (await locator.boundingBox())!.y;
    const viewport = page.viewportSize()!;

    // Nobody chose anything: no bar, the app has the whole height …
    await page.goto(`/app/${apps.notes}`);
    await expect(frame).toBeVisible();
    await expect(bar).toHaveCount(0);
    expect((await frame.boundingBox())!.height).toBeGreaterThan(viewport.height - 4);
    // … it still has its name for assistive technology …
    await expect(page.getByRole('heading', { level: 1, name: 'Notizen' })).toBeAttached();
    // … and "reload" is in the user menu: the counter in the app starts over.
    const app = frame.contentFrame().frameLocator('body > iframe');
    await app.locator('#count').click();
    await expect(app.locator('#count')).toHaveText('Geklickt: 1');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'App neu laden' }).click();
    await expect(app.locator('#count')).not.toHaveText('Geklickt: 1');

    // Switched on, it sits above the app, and "reload" is in it …
    await page.goto('/settings');
    await expect(page.getByTestId('setting-app-bar')).toHaveAttribute('data-value', 'default');
    await chooseSetting(page, 'setting-app-bar', 'top');
    await dockApp(page, apps.notes).click();
    await expect(bar).toHaveAttribute('data-position', 'top');
    expect(await top(bar)).toBeLessThan(await top(frame));
    await app.locator('#count').click();
    await expect(app.locator('#count')).toHaveText('Geklickt: 1');
    await page.getByTestId('app-reload').click();
    await expect(app.locator('#count')).not.toHaveText('Geklickt: 1');
    // … and no longer in the user menu.
    await page.getByTestId('user-menu').click();
    await expect(page.getByRole('menuitem', { name: 'Abmelden' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'App neu laden' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // … or below it …
    await page.goto('/settings');
    await chooseSetting(page, 'setting-app-bar', 'bottom');
    await dockApp(page, apps.notes).click();
    await expect(bar).toHaveAttribute('data-position', 'bottom');
    expect(await top(bar)).toBeGreaterThan(await top(frame));

    // … and "Standard" takes it away again.
    await page.goto('/settings');
    await chooseSetting(page, 'setting-app-bar', 'default');
    await dockApp(page, apps.notes).click();
    await expect(frame).toBeVisible();
    await expect(bar).toHaveCount(0);
    expect((await frame.boundingBox())!.height).toBeGreaterThan(viewport.height - 4);
    await context.close();
  });

  test('legt die Organisation Design und App-Leiste fest, gelten sie für alle', async ({ browser }) => {
    const { apps } = world();
    const mia = await apiAs('mia');
    await mia.patch('/api/v1/me/settings', { data: { theme: 'dark', app_bar: 'hidden' } });
    await mia.dispose();
    const anna = await apiAs('anna');
    await anna.patch('/api/v1/admin/tenant', {
      data: { default_theme: 'light', theme_locked: true, default_app_bar: 'bottom', app_bar_locked: true },
    });
    await anna.dispose();

    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto(`/app/${apps.notes}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByTestId('app-bar')).toHaveAttribute('data-position', 'bottom');

    await page.goto('/settings');
    await expect(page.getByTestId('setting-theme-locked')).toBeVisible();
    await expect(page.getByTestId('setting-app-bar-locked')).toBeVisible();
    await expect(page.getByTestId('setting-theme').locator('input').first()).toBeDisabled();
    await expect(page.getByTestId('setting-app-bar').locator('input').first()).toBeDisabled();
    await context.close();
  });
});
