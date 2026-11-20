import { expect, test, type Page } from '@playwright/test';
import { attemptSignIn } from '../support/keycloak';
import { AUTH_URL, DOCK_URL, PASSWORD } from '../support/stack';
import { dockApp, dockAppNames } from '../support/ui';
import { apiAs, contextAs, firstSignIn, signIn, unique, world } from '../support/world';

function row(page: Page, attribute: string, value: string) {
  return page.locator(`tr[${attribute}="${value}"]`);
}

async function rowAction(page: Page, rowLocator: ReturnType<typeof row>, testid: string, item: string | RegExp) {
  await rowLocator.getByTestId(testid).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe('Verwaltung einer Organisation', () => {
  test('ein Administrator legt einen Benutzer an, der sich danach anmelden kann', async ({ browser }) => {
    const username = unique('neu');
    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Benutzer anlegen' }).click();

    const dialog = page.getByRole('dialog', { name: 'Benutzer anlegen' });
    await dialog.getByLabel('Benutzername', { exact: true }).fill(username);
    await dialog.getByLabel('Vorname', { exact: true }).fill('Nora');
    await dialog.getByLabel('Nachname', { exact: true }).fill('Neuling');
    await dialog.getByLabel('E-Mail-Adresse', { exact: true }).fill(`${username}@velydock.test`);
    await dialog.getByRole('group', { name: 'Gruppen' }).locator('label', { hasText: 'Büro' }).click();
    await dialog.getByRole('button', { name: 'Konto anlegen' }).click();

    // The one-time password is shown once.
    const oneTimePassword = (await page.getByTestId('temp-password').textContent())!.trim();
    expect(oneTimePassword.length).toBeGreaterThanOrEqual(16);
    await page.getByRole('button', { name: 'Notiert, schließen' }).click();
    await expect(page.getByTestId('temp-password')).toHaveCount(0);

    const created = row(page, 'data-username', username);
    await expect(created).toContainText('Nora Neuling');
    await expect(created).toContainText('Mitglied');
    await expect(created).toContainText('Büro');
    await expect(created).toContainText('noch nie');
    // It cannot be read again afterwards.
    await page.reload();
    await expect(row(page, 'data-username', username)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(oneTimePassword);

    // The new user signs in with it, must choose an own password, and sees the group's apps.
    const fresh = await browser.newContext();
    const userPage = await fresh.newPage();
    await firstSignIn(userPage, username, oneTimePassword);
    expect((await dockAppNames(userPage)).sort()).toEqual(['Demo', 'Handbuch', 'Netz-Notizen', 'Notizen']);
    // The handed-over password no longer works.
    await fresh.clearCookies();
    await signIn(userPage, username, oneTimePassword);
    await expect(userPage).toHaveURL(new RegExp(`^${AUTH_URL}/`));
    await fresh.close();

    await page.reload();
    await expect(row(page, 'data-username', username)).not.toContainText('noch nie');
    await admin.close();
  });

  test('Benutzer lassen sich suchen, bearbeiten und deaktivieren – Deaktivierte kommen nicht mehr hinein', async ({ browser }) => {
    const username = unique('temp');
    const anna = await apiAs('anna');
    const created = await (
      await anna.post('/api/v1/admin/users', { data: { username, first_name: 'Tim', last_name: 'Temporär' } })
    ).json();
    const setup = await browser.newContext();
    const setupPage = await setup.newPage();
    await firstSignIn(setupPage, username, created.temporary_password);
    await expect(setupPage.getByTestId('dock')).toBeVisible();

    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    await page.goto('/admin/users');

    // Search narrows the table on the server.
    await page.getByRole('searchbox').fill('Temporär');
    await expect(row(page, 'data-username', username)).toBeVisible();
    await expect(row(page, 'data-username', 'mia')).toHaveCount(0);

    // Edit the name and assign the role "Benutzerverwaltung".
    await rowAction(page, row(page, 'data-username', username), 'user-actions', 'Bearbeiten');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Nachname', { exact: true }).fill('Dauerhaft');
    await dialog.getByLabel('Rolle', { exact: true }).selectOption('user_manager');
    const saved = page.waitForResponse((r) => r.url().includes('/api/v1/admin/users/') && r.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    const answer = await saved;
    expect(answer.status(), await answer.text()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await page.getByRole('searchbox').fill('Dauerhaft');
    await expect(row(page, 'data-username', username)).toContainText('Tim Dauerhaft');
    await expect(row(page, 'data-username', username)).toContainText('Benutzerverwaltung');

    // Deactivate: the running session ends at once …
    await rowAction(page, row(page, 'data-username', username), 'user-actions', 'Deaktivieren');
    await page.getByRole('dialog').getByRole('button', { name: 'Deaktivieren' }).click();
    await expect(row(page, 'data-username', username)).toContainText('Deaktiviert');
    expect((await setupPage.request.get('/api/v1/me')).status()).toBe(401);
    // … and signing in again is refused by Keycloak.
    await setup.clearCookies();
    await setupPage.goto('/login');
    await setupPage.getByTestId('login-button').click();
    const answer2 = await attemptSignIn(setupPage, username, PASSWORD);
    expect(setupPage.url().startsWith(AUTH_URL)).toBe(true);
    expect(answer2).toMatch(/deaktiviert|disabled|stimmt nicht/i);
    expect((await setupPage.request.get(`${DOCK_URL}/api/v1/me`)).status()).toBe(401);
    await setup.close();

    // Remove the account again.
    await rowAction(page, row(page, 'data-username', username), 'user-actions', 'Konto löschen');
    await page.getByRole('dialog').getByRole('button', { name: 'Konto löschen' }).click();
    await expect(row(page, 'data-username', username)).toHaveCount(0);
    await admin.close();
    await anna.dispose();
  });

  test('ein Administrator verwaltet Gruppen', async ({ browser }) => {
    const name = unique('Vertrieb');
    const context = await contextAs(browser, 'anna');
    const page = await context.newPage();
    await page.goto('/admin/groups');
    await page.getByRole('button', { name: 'Gruppe anlegen' }).click();

    const dialog = page.getByRole('dialog', { name: 'Gruppe anlegen' });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Beschreibung', { exact: true }).fill('Alle im Vertrieb');
    await dialog.getByRole('group', { name: 'Mitglieder' }).locator('label', { hasText: 'Mia Mitglied' }).click();
    await dialog.getByRole('group', { name: 'Mitglieder' }).locator('label', { hasText: 'Ben Beispiel' }).click();
    await dialog.getByRole('button', { name: 'Gruppe anlegen' }).click();

    const table = page.getByTestId('groups-table');
    const created = table.locator('tr', { hasText: name });
    await expect(created).toBeVisible();
    await expect(created).toContainText('2');

    // Rename it and remove a member.
    await created.getByTestId('group-actions').click();
    await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('Name', { exact: true }).fill(`${name} Nord`);
    await edit.getByRole('group', { name: 'Mitglieder' }).locator('label', { hasText: 'Ben Beispiel' }).click();
    await edit.getByRole('button', { name: 'Speichern' }).click();
    await expect(table.locator('tr', { hasText: `${name} Nord` })).toContainText('1');

    // The membership is visible in the user list.
    await page.goto('/admin/users');
    await expect(row(page, 'data-username', 'mia')).toContainText(`${name} Nord`);
    await expect(row(page, 'data-username', 'ben')).not.toContainText(name);

    await page.goto('/admin/groups');
    await table.locator('tr', { hasText: `${name} Nord` }).getByTestId('group-actions').click();
    await page.getByRole('menuitem', { name: 'Löschen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Gruppe löschen' }).click();
    await expect(table.locator('tr', { hasText: name })).toHaveCount(0);
    await context.close();
  });

  test('Apps werden angelegt, einer Gruppe freigegeben, abgeschaltet und gelöscht', async ({ browser }) => {
    const name = unique('Wiki');
    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    await page.goto('/admin/apps');
    await page.getByRole('button', { name: 'App hinzufügen' }).click();

    const dialog = page.getByRole('dialog', { name: 'App hinzufügen' });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Beschreibung', { exact: true }).fill('Unser Handbuch');
    await dialog.getByTestId('app-type').locator('label:has(input[value="external"])').click();
    await dialog.getByLabel('Adresse (URL)', { exact: true }).fill('https://demo.velydock.localhost:8443/wiki');
    await dialog.getByTestId('app-audience').locator('label:has(input[value="selected"])').click();
    await dialog.getByRole('group', { name: 'Gruppen' }).locator('label', { hasText: 'Büro' }).click();
    await dialog.getByRole('button', { name: 'App anlegen' }).click();
    await expect(dialog).toHaveCount(0);

    const created = page.getByTestId('apps-table').locator('tr', { hasText: name });
    await expect(created).toContainText('Neuer Tab');
    await expect(created).toContainText('1 Gruppe');
    const appId = (await created.getAttribute('data-app-id'))!;

    // Mia is in the group and sees the app, Ben is not and does not.
    const mia = await contextAs(browser, 'mia');
    const miaPage = await mia.newPage();
    await miaPage.goto('/');
    await expect(dockApp(miaPage, appId)).toBeVisible();
    const ben = await contextAs(browser, 'ben');
    const benPage = await ben.newPage();
    await benPage.goto('/');
    await expect(benPage.getByTestId('dock')).toBeVisible();
    await expect(dockApp(benPage, appId)).toHaveCount(0);
    await ben.close();

    // Switched off: it disappears for everyone.
    await created.getByTestId('app-actions').click();
    await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('App ist aktiv').uncheck();
    await edit.getByRole('button', { name: 'Speichern' }).click();
    await expect(edit).toHaveCount(0);
    await expect(created).toContainText('Deaktiviert');
    await miaPage.reload();
    await expect(miaPage.getByTestId('dock')).toBeVisible();
    await expect(dockApp(miaPage, appId)).toHaveCount(0);
    await mia.close();

    await created.getByTestId('app-actions').click();
    await page.getByRole('menuitem', { name: 'Löschen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'App löschen' }).click();
    await expect(page.getByTestId('apps-table').locator('tr', { hasText: name })).toHaveCount(0);
    await admin.close();
  });

  test('eine eigene App wird in der Oberfläche angelegt und läuft in der Sandbox', async ({ browser }) => {
    const name = unique('Hinweis');
    const admin = await contextAs(browser, 'anna');
    const page = await admin.newPage();
    await page.goto('/admin/apps');
    await page.getByRole('button', { name: 'App hinzufügen' }).click();
    const dialog = page.getByRole('dialog', { name: 'App hinzufügen' });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByTestId('app-type').locator('label:has(input[value="custom"])').click();
    await dialog.getByLabel('HTML', { exact: true }).fill('<h1 id="hello">Hallo Team</h1><p id="origin"></p>');
    await dialog.getByLabel('CSS', { exact: true }).fill('h1 { color: rgb(1, 2, 3); }');
    await dialog.getByLabel('JavaScript', { exact: true }).fill("document.getElementById('origin').textContent = self.origin;");
    await dialog.getByRole('button', { name: 'App anlegen' }).click();
    await expect(dialog).toHaveCount(0);
    const created = page.getByTestId('apps-table').locator('tr', { hasText: name });
    await expect(created).toContainText('Eigene App');
    const appId = (await created.getAttribute('data-app-id'))!;

    await page.goto(`/app/${appId}`);
    const frame = page.locator(`[data-testid="app-frame"][data-app-id="${appId}"]`).contentFrame();
    await expect(frame.locator('#hello')).toHaveText('Hallo Team');
    expect(await frame.locator('#hello').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(1, 2, 3)');
    await expect(frame.locator('#origin')).toHaveText('null');

    const anna = await apiAs('anna');
    expect((await anna.delete(`/api/v1/admin/apps/${appId}`)).status()).toBe(204);
    await anna.dispose();
    await admin.close();
  });

  test('das Protokoll zeigt, wer was getan hat', async ({ browser }) => {
    const anna = await apiAs('anna');
    const name = unique('Protokollgruppe');
    const group = await (await anna.post('/api/v1/admin/groups', { data: { name } })).json();
    await anna.delete(`/api/v1/admin/groups/${group.id}`);
    await anna.dispose();

    const context = await contextAs(browser, 'anna');
    const page = await context.newPage();
    await page.goto('/admin/audit');
    const table = page.getByTestId('audit-table');
    await expect(table.locator('tr', { hasText: name }).first()).toContainText('Gruppe gelöscht');
    await expect(table.locator('tr', { hasText: name }).nth(1)).toContainText('Gruppe angelegt');
    await expect(table.locator('tr', { hasText: name }).first()).toContainText('anna');
    await context.close();
  });

  test('Benutzerverwalter und Mitglieder sehen nur, was ihre Rolle erlaubt', async ({ browser }) => {
    const uwe = await contextAs(browser, 'uwe');
    const uwePage = await uwe.newPage();
    await uwePage.goto('/');
    await uwePage.getByTestId('dock-admin').click();
    await expect(uwePage.getByTestId('users-table')).toBeVisible();
    const adminNav = uwePage.getByRole('navigation', { name: 'Verwaltung' });
    await expect(adminNav.getByRole('link', { name: 'Gruppen' })).toBeVisible();
    await expect(adminNav.getByRole('link', { name: 'Apps' })).toHaveCount(0);
    await expect(adminNav.getByRole('link', { name: 'Protokoll' })).toHaveCount(0);
    await uwePage.goto('/admin/apps');
    await expect(uwePage.getByTestId('forbidden-page')).toBeVisible();
    await uwePage.goto('/system/tenants');
    await expect(uwePage.getByTestId('forbidden-page')).toBeVisible();
    await uwe.close();

    const mia = await contextAs(browser, 'mia');
    const miaPage = await mia.newPage();
    await miaPage.goto('/');
    await expect(miaPage.getByTestId('dock')).toBeVisible();
    await expect(miaPage.getByTestId('dock-admin')).toHaveCount(0);
    await miaPage.goto('/admin/users');
    await expect(miaPage.getByTestId('forbidden-page')).toBeVisible();
    await expect(miaPage.getByTestId('users-table')).toHaveCount(0);
    await mia.close();
  });

  test('das eigene Profil lässt sich ändern, die E-Mail-Adresse nicht', async ({ browser }) => {
    const context = await contextAs(browser, 'ben');
    const page = await context.newPage();
    await page.goto('/profile');
    await page.getByLabel('Nachname', { exact: true }).fill('Beispielhaft');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByTestId('toast')).toContainText('Profil gespeichert');
    await page.reload();
    await expect(page.getByLabel('Nachname', { exact: true })).toHaveValue('Beispielhaft');
    await expect(page.getByLabel('E-Mail-Adresse', { exact: true })).not.toBeEditable();
    await expect(page.getByTestId('account-link')).toHaveAttribute('href', new RegExp(`^${AUTH_URL}/realms/velydock/account`));
    const ben = await apiAs('ben');
    await ben.patch('/api/v1/me/profile', { data: { first_name: 'Ben', last_name: 'Beispiel' } });
    await ben.dispose();
    await context.close();
  });
});
