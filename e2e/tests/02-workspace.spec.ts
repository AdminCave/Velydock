import { expect, test, type Page } from '@playwright/test';
import { DEMO_URL } from '../support/stack';
import { contextAs, world, type Account } from '../support/world';

async function dockApps(page: Page): Promise<string[]> {
  await expect(page.getByTestId('dock')).toBeVisible();
  const entries = page.getByTestId('dock-app');
  await expect(entries.first()).toBeVisible();
  return (await entries.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label') ?? n.textContent ?? '')))
    .map((name) => name.trim())
    .sort();
}

test.describe('Workspace', () => {
  const expectations: [Account, string[]][] = [
    ['mia', ['Demo', 'Handbuch', 'Netz-Notizen', 'Notizen']],
    ['ben', ['Demo', 'Netz-Notizen', 'Notizen', 'Nur für Ben']],
    ['gero', ['Globex CRM']],
  ];

  for (const [account, apps] of expectations) {
    test(`${account} sieht genau die freigegebenen Apps`, async ({ browser }) => {
      const context = await contextAs(browser, account);
      const page = await context.newPage();
      await page.goto('/');
      expect(await dockApps(page)).toEqual(apps);
      // The dashboard shows the same set as tiles.
      const tiles = await page.getByTestId('app-tile').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-app-id')));
      expect(tiles.length).toBe(apps.length);
      await context.close();
    });
  }

  test('eine eingebettete App läuft im Workspace und bleibt beim Wechsel geladen', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto('/');
    await page.getByTestId('dock').getByRole('link', { name: 'Demo' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/${apps.demo}$`));

    const frame = page.locator(`[data-testid="app-frame"][data-app-id="${apps.demo}"]`);
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('src', new RegExp(`^${DEMO_URL}/`));
    // The demo app echoes the request; its content proves the page really loaded in the frame.
    await expect(page.frameLocator(`[data-app-id="${apps.demo}"]`).locator('body')).toContainText('Hostname');
    // Embedded apps must not be able to replace the Velydock page on their own.
    const sandbox = (await frame.getAttribute('sandbox')) ?? '';
    expect(sandbox.split(/\s+/)).not.toContain('allow-top-navigation');

    // Mark the frame element, switch away and back: the very same element (and page) is still there.
    await frame.evaluate((element) => ((element as HTMLIFrameElement).dataset.marker = 'kept'));
    await page.getByTestId('dock').getByRole('link', { name: 'Notizen', exact: true }).click();
    await expect(page.locator(`[data-testid="app-frame"][data-app-id="${apps.notes}"]`)).toBeVisible();
    await expect(frame).toBeHidden();
    await page.getByTestId('dock').getByRole('link', { name: 'Demo' }).click();
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('data-marker', 'kept');
    await context.close();
  });

  test('eine externe App öffnet sich in einem neuen Tab', async ({ browser }) => {
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    await page.goto('/');
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.getByTestId('dock').getByRole('link', { name: 'Handbuch' }).click(),
    ]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe(`${DEMO_URL}/handbuch`);
    // The new tab has no handle on Velydock's window.
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await context.close();
  });

  test('eine nicht einbettbare App wird erklärt statt leer angezeigt', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'mia');
    const page = await context.newPage();
    // The embeddability check itself is covered by backend tests; here the app is reported as blocked.
    await page.route('**/api/v1/workspace/apps', async (route) => {
      const response = await route.fetch();
      const list = (await response.json()) as { id: string; embed_status: string }[];
      for (const app of list) if (app.id === apps.demo) app.embed_status = 'blocked';
      await route.fulfill({ response, json: list });
    });
    await page.goto(`/app/${apps.demo}`);
    await expect(page.getByTestId('app-blocked-notice')).toBeVisible();
    await expect(page.locator(`[data-testid="app-frame"][data-app-id="${apps.demo}"]`)).toHaveCount(0);
    const [popup] = await Promise.all([context.waitForEvent('page'), page.getByTestId('app-open-external').click()]);
    expect(popup.url()).toBe(`${DEMO_URL}/`);
    await context.close();
  });

  test('die Adresse einer nicht freigegebenen App zeigt nichts an', async ({ browser }) => {
    const { apps } = world();
    const context = await contextAs(browser, 'ben');
    const page = await context.newPage();
    await page.goto(`/app/${apps.manual}`);
    await expect(page.getByTestId('dock')).toBeVisible();
    await expect(page.getByTestId('app-frame')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Handbuch');
    await context.close();
  });

  test('ein Systemadministrator wechselt zwischen Organisationen', async ({ browser }) => {
    const context = await contextAs(browser, 'root');
    const page = await context.newPage();
    await page.goto('/');
    await page.getByTestId('tenant-switcher').click();
    await page.getByRole('menuitem', { name: /Globex AG/ }).click();
    await expect(page.getByTestId('dock').getByRole('link', { name: 'Globex CRM' })).toBeVisible();
    await page.getByTestId('tenant-switcher').click();
    await page.getByRole('menuitem', { name: /Admin Cave/ }).click();
    await expect(page.getByTestId('dock').getByRole('link', { name: 'Globex CRM' })).toHaveCount(0);
    await context.close();
  });
});
