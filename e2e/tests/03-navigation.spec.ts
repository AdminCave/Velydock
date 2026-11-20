import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { chooseSetting, dockApp, dockEdge, type Edge } from '../support/ui';
import { apiAs, contextAs, stateFile, world } from '../support/world';

type Position = Edge;

test.describe('Navigation und persönliche Einstellungen', () => {
  test.afterEach(async () => {
    const mia = await apiAs('mia');
    await mia.patch('/api/v1/me/settings', { data: { nav_position: null, theme: null, language: null } });
    await mia.dispose();
    const anna = await apiAs('anna');
    await anna.patch('/api/v1/admin/tenant', { data: { default_nav_position: null, nav_position_locked: false } });
    await anna.dispose();
  });

  for (const position of ['left', 'right', 'top', 'bottom'] as const) {
    test(`die Navigation lässt sich nach ${position} legen und bleibt dort`, async ({ browser }) => {
      const context = await contextAs(browser, 'mia');
      const page = await context.newPage();
      await page.goto('/settings');
      await chooseSetting(page, 'setting-nav-position', position);

      // Applies immediately, without a reload …
      await expect(page.getByTestId('dock')).toHaveAttribute('data-nav', position);
      expect(await dockEdge(page)).toBe(position);
      // … the app list is still usable there …
      await expect(dockApp(page, world().apps.demo)).toBeVisible();
      // … survives a reload …
      await page.reload();
      await expect(page.getByTestId('dock')).toHaveAttribute('data-nav', position);
      expect(await dockEdge(page)).toBe(position);
      await context.close();

      // … and is stored on the server, not in this browser: a pristine browser profile shows it too.
      const other = await browser.newContext({ storageState: { cookies: sessionCookies('mia'), origins: [] } });
      const otherPage = await other.newPage();
      await otherPage.goto('/');
      await expect(otherPage.getByTestId('dock')).toHaveAttribute('data-nav', position);
      await other.close();
    });
  }

  test('der Administrator legt einen Standard fest und kann ihn für alle erzwingen', async ({ browser }) => {
    const anna = await apiAs('anna');
    const mia = await apiAs('mia');
    await mia.patch('/api/v1/me/settings', { data: { nav_position: 'bottom' } });

    await anna.patch('/api/v1/admin/tenant', { data: { default_nav_position: 'top' } });
    const benContext = await contextAs(browser, 'ben');
    const benPage = await benContext.newPage();
    await benPage.goto('/');
    expect(await dockEdge(benPage)).toBe('top'); // no own choice: the organization's default
    await benContext.close();

    const miaContext = await contextAs(browser, 'mia');
    const miaPage = await miaContext.newPage();
    await miaPage.goto('/settings');
    expect(await dockEdge(miaPage)).toBe('bottom'); // own choice wins
    await anna.patch('/api/v1/admin/tenant', { data: { nav_position_locked: true } });
    await miaPage.reload();
    expect(await dockEdge(miaPage)).toBe('top'); // locked: the default applies to everyone
    await expect(miaPage.getByTestId('setting-nav-locked')).toBeVisible();
    for (const option of await miaPage.getByTestId('setting-nav-position').locator('input').all()) {
      await expect(option).toBeDisabled();
    }
    await miaContext.close();
    await anna.dispose();
    await mia.dispose();
  });

  test('helles und dunkles Design lassen sich umschalten und bleiben gespeichert', async ({ browser }) => {
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto('/settings');
    const html = page.locator('html');
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await chooseSetting(page, 'setting-theme', 'dark');
    await expect(html).not.toHaveAttribute('data-theme', 'light');
    const dark = await background();

    await chooseSetting(page, 'setting-theme', 'light');
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await background()).not.toBe(dark); // the page really looks different
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await background()).not.toBe(dark);

    await chooseSetting(page, 'setting-theme', 'dark');
    await page.reload();
    await expect(html).not.toHaveAttribute('data-theme', 'light');
    expect(await background()).toBe(dark);
    await context.close();
  });

  test('auf einem Telefon bleibt alles erreichbar', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: stateFile('mia'),
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto('/');
    const dock = page.getByTestId('dock');
    await expect(dock).toBeVisible();
    const box = (await dock.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    // No horizontal scrolling of the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await dockApp(page, world().apps.notes).click();
    await expect(page.getByTestId('app-frame').first()).toBeVisible();
    await page.getByTestId('user-menu').click();
    await expect(page.getByRole('menuitem', { name: 'Abmelden' })).toBeVisible();
    await context.close();
  });
});

function sessionCookies(account: 'mia') {
  const state = JSON.parse(readFileSync(stateFile(account), 'utf8')) as { cookies: never[] };
  return state.cookies;
}
