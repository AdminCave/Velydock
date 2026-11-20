import { expect, test, type Page } from '@playwright/test';
import { apiAs, contextAs, stateFile } from '../support/world';

type Position = 'left' | 'right' | 'top' | 'bottom';

/** Where the dock really sits on screen, judged by its geometry. */
async function dockEdge(page: Page): Promise<Position> {
  const dock = page.getByTestId('dock');
  await expect(dock).toBeVisible();
  const box = (await dock.boundingBox())!;
  const viewport = page.viewportSize()!;
  const vertical = box.height > box.width;
  if (vertical) return box.x < viewport.width / 2 ? 'left' : 'right';
  return box.y < viewport.height / 2 ? 'top' : 'bottom';
}

async function choosePosition(page: Page, position: Position | ''): Promise<void> {
  const control = page.getByTestId('setting-nav-position');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/me/settings') && r.request().method() === 'PATCH');
  if ((await control.evaluate((el) => el.tagName)) === 'SELECT') {
    await control.selectOption(position);
  } else {
    await control.locator(`[value="${position}"], [data-value="${position}"]`).first().click();
  }
  expect((await saved).status()).toBe(200);
}

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
      await choosePosition(page, position);

      // Applies immediately, without a reload …
      await expect(page.getByTestId('dock')).toHaveAttribute('data-nav', position);
      expect(await dockEdge(page)).toBe(position);
      // … the app list is still usable there …
      await expect(page.getByTestId('dock').getByRole('link', { name: 'Demo' })).toBeVisible();
      // … survives a reload …
      await page.reload();
      await expect(page.getByTestId('dock')).toHaveAttribute('data-nav', position);
      expect(await dockEdge(page)).toBe(position);
      await context.close();

      // … and is stored on the server, not in this browser: a pristine browser profile shows it too.
      const other = await browser.newContext({ storageState: { cookies: (await readCookies('mia')), origins: [] } });
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
    await expect(miaPage.getByTestId('setting-nav-position')).toBeDisabled();
    await miaContext.close();
    await anna.dispose();
    await mia.dispose();
  });

  test('helles und dunkles Design lassen sich umschalten und bleiben gespeichert', async ({ browser }) => {
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto('/settings');
    const html = page.locator('html');
    const control = page.getByTestId('setting-theme');
    for (const theme of ['light', 'dark'] as const) {
      const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/me/settings') && r.request().method() === 'PATCH');
      if ((await control.evaluate((el) => el.tagName)) === 'SELECT') await control.selectOption(theme);
      else await control.locator(`[value="${theme}"], [data-value="${theme}"]`).first().click();
      await saved;
      if (theme === 'light') await expect(html).toHaveAttribute('data-theme', 'light');
      else await expect(html).not.toHaveAttribute('data-theme', 'light');
      await page.reload();
      if (theme === 'light') await expect(html).toHaveAttribute('data-theme', 'light');
      else await expect(html).not.toHaveAttribute('data-theme', 'light');
    }
    // The page background really differs between the themes.
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const dark = await background();
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/me/settings') && r.request().method() === 'PATCH');
    if ((await control.evaluate((el) => el.tagName)) === 'SELECT') await control.selectOption('light');
    else await control.locator('[value="light"], [data-value="light"]').first().click();
    await saved;
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await background()).not.toBe(dark);
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
    await dock.getByRole('link', { name: 'Notizen', exact: true }).click();
    await expect(page.getByTestId('app-frame').first()).toBeVisible();
    await page.getByTestId('user-menu').click();
    await expect(page.getByRole('menuitem', { name: 'Abmelden' })).toBeVisible();
    await context.close();
  });
});

async function readCookies(account: 'mia') {
  const { readFileSync } = await import('node:fs');
  const state = JSON.parse(readFileSync(stateFile(account), 'utf8')) as { cookies: never[] };
  return state.cookies;
}
