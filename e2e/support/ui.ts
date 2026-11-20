import { expect, type Locator, type Page } from '@playwright/test';

/** The entry of an app in the dock. */
export function dockApp(page: Page, appId: string): Locator {
  return page.locator(`[data-testid="dock-app"][data-app-id="${appId}"]`);
}

export function appFrame(page: Page, appId: string): Locator {
  return page.locator(`[data-testid="app-frame"][data-app-id="${appId}"]`);
}

/** Names of the apps in the dock, in the order shown. */
export async function dockAppNames(page: Page): Promise<string[]> {
  await expect(page.getByTestId('dock')).toBeVisible();
  await expect(page.getByTestId('dock-app').first()).toBeVisible();
  const names = await page
    .getByTestId('dock-app')
    .evaluateAll((nodes) => nodes.map((n) => (n.getAttribute('aria-label') ?? n.textContent ?? '').trim()));
  // The accessible name may carry a hint such as "öffnet in neuem Tab" after the app name.
  return names.map((name) => name.split(/\s+[–(,]/)[0]!.trim());
}

/**
 * Choose an option of a settings control (a radio group) and wait until the server stored it.
 * `value` is the option's value attribute, e.g. "top" or "light".
 */
export async function chooseSetting(page: Page, testid: string, value: string): Promise<void> {
  const control = page.getByTestId(testid);
  await expect(control).toBeVisible();
  if ((await control.getAttribute('data-value')) === value) return;
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/me/settings') && response.request().method() === 'PATCH',
  );
  await control.locator(`label:has(input[value="${value}"])`).click();
  expect((await saved).status()).toBe(200);
  await expect(control).toHaveAttribute('data-value', value);
}

export type Edge = 'left' | 'right' | 'top' | 'bottom';

/** Where the dock really sits on screen, judged by its geometry, not by an attribute. */
export async function dockEdge(page: Page): Promise<Edge> {
  const dock = page.getByTestId('dock');
  await expect(dock).toBeVisible();
  const box = (await dock.boundingBox())!;
  const viewport = page.viewportSize()!;
  if (box.height > box.width) return box.x + box.width / 2 < viewport.width / 2 ? 'left' : 'right';
  return box.y + box.height / 2 < viewport.height / 2 ? 'top' : 'bottom';
}
