import { expect, test, type Locator, type Page } from '@playwright/test';
import { Authority, presented, type Issued } from '../support/certs';
import { apiAs, contextAs } from '../support/world';

/**
 * Own TLS certificates, through the interface and against the real proxy: what counts is the
 * certificate the proxy presents in a TLS handshake afterwards, not what a page says.
 *
 * The development stack has no certificate resolver, so a name without an own certificate is
 * served with the proxy's self-signed stand-in. What happens next to certificates the proxy
 * fetches by itself is the business of scripts/tests/tls-modes.sh.
 */

const DOCK = 'dock.velydock.localhost';
const AUTH = 'auth.velydock.localhost';
const WIKI = 'wiki.apps.velydock.localhost';
const STAND_IN = /TRAEFIK DEFAULT CERT/;
const API = '/api/v1/system/certificates';

const authority = new Authority();

/** The proxy fetches its configuration every five seconds: wait until a name is served as expected. */
async function served(host: string, expected: string | RegExp): Promise<void> {
  await expect
    .poll(
      async () => {
        const certificate = await presented(host);
        return typeof expected === 'string' ? certificate.fingerprint : certificate.subject;
      },
      { timeout: 30_000, intervals: [1000], message: `certificate presented for ${host}` },
    )
    [typeof expected === 'string' ? 'toBe' : 'toMatch'](expected as never);
}

async function removeAll(): Promise<void> {
  const root = await apiAs('root');
  const listed = (await (await root.get(API)).json()) as { certificates: { id: string }[] };
  for (const certificate of listed.certificates) {
    expect((await root.delete(`${API}/${certificate.id}`)).status()).toBe(204);
  }
  await root.dispose();
}

async function openPage(page: Page): Promise<void> {
  await page.goto('/system/certificates');
  await expect(page.getByTestId('certificates-page')).toBeVisible();
}

/** A file input by its test id (the id is on the input itself or on its field). */
function file(dialog: Locator, testid: string): Locator {
  return dialog.locator(`input[type="file"][data-testid="${testid}"], [data-testid="${testid}"] input[type="file"]`);
}

async function openDialog(page: Page): Promise<Locator> {
  await page.getByTestId('certificate-add').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('certificate-name')).toBeVisible();
  return dialog;
}

async function fillPem(dialog: Locator, name: string, issued: Issued, label: string, key?: string): Promise<void> {
  await dialog.getByTestId('certificate-name').fill(name);
  await file(dialog, 'certificate-file').setInputFiles(`${issued.directory}/${label}.chain.pem`);
  await file(dialog, 'certificate-key-file').setInputFiles(key ?? `${issued.directory}/${label}.key`);
}

const row = (page: Page, name: string) => page.locator(`[data-testid="certificate"][data-name="${name}"]`);
const host = (page: Page, name: string) => page.locator(`[data-testid="certificate-host"][data-host="${name}"]`);

test.describe('Eigene Zertifikate', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(removeAll);
  test.afterAll(async () => {
    // The other tests expect the stack as it was: every name with the stand-in.
    await removeAll();
    await served(DOCK, STAND_IN);
  });

  test('ein hochgeladenes Zertifikat wird vom Proxy ausgeliefert – für genau seine Namen', async ({ browser }) => {
    const issued = authority.issue('dock', [DOCK, '*.apps.velydock.localhost']);
    await served(DOCK, STAND_IN);

    const context = await contextAs(browser, 'root');
    const page = await context.newPage();
    await openPage(page);
    // Before: every address of the installation gets the proxy's stand-in, and the page says so.
    await expect(host(page, DOCK)).toHaveAttribute('data-source', 'default');
    await expect(page.getByTestId('certificates-unavailable')).toHaveCount(0);

    const dialog = await openDialog(page);
    await fillPem(dialog, 'Firma', issued, 'dock');
    await dialog.getByTestId('certificate-save').click();
    await expect(dialog).toBeHidden();

    const stored = row(page, 'Firma');
    await expect(stored).toBeVisible();
    await expect(stored).toHaveAttribute('data-status', 'valid');
    await expect(stored.getByTestId('certificate-names')).toContainText(DOCK);
    await expect(stored.getByTestId('certificate-names')).toContainText('*.apps.velydock.localhost');
    await expect(stored.getByTestId('certificate-warning')).toHaveCount(0);

    // What a browser gets now: the uploaded certificate for the names in it …
    await served(DOCK, issued.fingerprint);
    await served(WIKI, issued.fingerprint);
    // … and still the stand-in for a name that is not in it.
    expect((await presented(AUTH)).subject).toMatch(STAND_IN);
    expect((await presented('apps.velydock.localhost')).subject).toMatch(STAND_IN);

    // The page shows the same, by itself, without a reload by hand.
    await expect(host(page, DOCK)).toHaveAttribute('data-source', 'uploaded', { timeout: 30_000 });
    await expect(host(page, DOCK)).toHaveAttribute('data-certificate', 'Firma');
    await expect(host(page, AUTH)).toHaveAttribute('data-source', 'default');

    // Velydock itself still works over the connection with the new certificate.
    await page.goto('/system/tenants');
    await expect(page.locator('body')).toContainText('Acme GmbH');

    // The key was sent once and is in no answer since.
    const root = await apiAs('root');
    const answer = await (await root.get(API)).text();
    expect(answer).not.toContain('PRIVATE KEY');
    expect(answer).not.toContain(issued.key.split('\n')[2]);
    await root.dispose();
    await context.close();
  });

  test('was nicht zusammenpasst, sagt der Dialog an Ort und Stelle', async ({ browser }) => {
    const other = authority.issue('auth', [AUTH]);
    const context = await contextAs(browser, 'root');
    const page = await context.newPage();
    await openPage(page);

    // A key that belongs to another certificate.
    let dialog = await openDialog(page);
    await fillPem(dialog, 'Anmeldung', other, 'auth', `${other.directory}/dock.key`);
    await dialog.getByTestId('certificate-save').click();
    await expect(dialog.getByTestId('certificate-error')).toHaveAttribute('data-code', 'key_mismatch');
    await expect(row(page, 'Anmeldung')).toHaveCount(0);

    // A protected key: asked for its passphrase, wrong once, then right.
    await file(dialog, 'certificate-key-file').setInputFiles(authority.protectedKey('auth', 'sehr-geheim'));
    await dialog.getByTestId('certificate-save').click();
    await expect(dialog.getByTestId('certificate-error')).toHaveAttribute('data-code', 'key_encrypted');
    await dialog.getByTestId('certificate-passphrase').fill('falsch');
    await dialog.getByTestId('certificate-save').click();
    await expect(dialog.getByTestId('certificate-error')).toHaveAttribute('data-code', 'passphrase_wrong');
    await dialog.getByTestId('certificate-passphrase').fill('sehr-geheim');
    await dialog.getByTestId('certificate-save').click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Anmeldung')).toBeVisible();
    await served(AUTH, other.fingerprint);

    // A second certificate for a name that has one: refused, with the name of the one in the way.
    const again = authority.issue('dock-again', [DOCK]);
    dialog = await openDialog(page);
    await fillPem(dialog, 'Noch eins', again, 'dock-again');
    await dialog.getByTestId('certificate-save').click();
    const refusal = dialog.getByTestId('certificate-error');
    await expect(refusal).toHaveAttribute('data-code', 'names_taken');
    await expect(refusal).toContainText('Firma');
    await expect(refusal).toContainText(DOCK);
    await context.close();
  });

  test('eine PKCS#12-Datei mit Passphrase', async ({ browser }) => {
    const issued = authority.issue('sandbox', ['sandbox.velydock.localhost']);
    const context = await contextAs(browser, 'root');
    const page = await context.newPage();
    await openPage(page);
    const dialog = await openDialog(page);
    await dialog.getByTestId('certificate-name').fill('Sandbox');
    await dialog.getByTestId('certificate-format').locator('label:has(input[value="pkcs12"])').click();
    await file(dialog, 'certificate-pkcs12-file').setInputFiles(authority.pkcs12('sandbox', 'p12-geheim'));
    await dialog.getByTestId('certificate-passphrase').fill('p12-geheim');
    await dialog.getByTestId('certificate-save').click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Sandbox')).toBeVisible();
    await served('sandbox.velydock.localhost', issued.fingerprint);
    await context.close();
  });

  test('ersetzen ist eine Verlängerung, entfernen bringt das Ersatzzertifikat zurück', async ({ browser }) => {
    const renewed = authority.issue('dock-neu', [DOCK, '*.apps.velydock.localhost'], 20);
    const context = await contextAs(browser, 'root');
    const page = await context.newPage();
    await openPage(page);
    const before = (await presented(DOCK)).fingerprint;

    await row(page, 'Firma').getByTestId('certificate-replace').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('certificate-name')).toHaveValue('Firma');
    await file(dialog, 'certificate-file').setInputFiles(`${renewed.directory}/dock-neu.chain.pem`);
    await file(dialog, 'certificate-key-file').setInputFiles(`${renewed.directory}/dock-neu.key`);
    await dialog.getByTestId('certificate-save').click();
    await expect(dialog).toBeHidden();

    // Same entry, new certificate - and the proxy serves the new one, not the old.
    await expect(page.getByTestId('certificate')).toHaveCount(3);
    await served(DOCK, renewed.fingerprint);
    expect(renewed.fingerprint).not.toBe(before);
    // 20 days to go: the page says that it runs out soon.
    await expect(row(page, 'Firma')).toHaveAttribute('data-status', 'expires_soon');

    await row(page, 'Firma').getByTestId('certificate-remove').click();
    await page.getByTestId('certificate-remove-confirm').click();
    await expect(row(page, 'Firma')).toHaveCount(0);
    await served(DOCK, STAND_IN);
    await served(WIKI, STAND_IN);
    // The others are untouched.
    expect((await presented(AUTH)).subject).not.toMatch(STAND_IN);
    await expect(host(page, DOCK)).toHaveAttribute('data-source', 'default', { timeout: 30_000 });
    await context.close();
  });

  test('nur Systemadministratoren: keine Seite und keine Antwort für andere', async ({ browser }) => {
    const context = await contextAs(browser, 'anna');
    const page = await context.newPage();
    await page.goto('/system/certificates');
    await expect(page.getByTestId('certificates-page')).toHaveCount(0);
    await expect(page.getByTestId('certificate-add')).toHaveCount(0);
    const anna = await apiAs('anna');
    expect((await anna.get(API)).status()).toBe(403);
    expect((await anna.post(API, { data: { name: 'x', certificate: 'x', private_key: 'x' } })).status()).toBe(403);
    await anna.dispose();
    await context.close();
  });
});
