// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type {
  Certificate,
  CertificateHost,
  CertificatesOverview,
  ServedCertificate,
} from '$lib/api/types';
import ConfirmDialog, { cancelConfirm } from '$lib/components/ui/ConfirmDialog.svelte';
import { setLanguage, translate } from '$lib/i18n';
import { SYSTEM_NAV } from '$lib/nav';
import { navigate } from '$lib/router';
import { resolveRoute } from '$lib/routing';
import { setMe } from '$lib/stores/session';
import { clearToasts, toasts } from '$lib/stores/toasts';
import { resetWorkspace } from '$lib/stores/workspace';
import { routes } from '../routes';
import { PERMISSIONS, errorResponse, jsonResponse, makeMe, stubApi } from '../test/fixtures';
import Certificates from './system/Certificates.svelte';

// System → Zertifikate: the stored certificates, and what the proxy serves for every
// address of the installation.

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn(), reloadPage: vi.fn() }));

beforeEach(() => {
  resetWorkspace();
  localStorage.clear();
  navigate('/', { replace: true });
});

afterEach(() => {
  cancelConfirm();
  cleanup();
  clearToasts();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLanguage('de', { persist: false });
});

const root = makeMe({
  user: { ...makeMe().user, is_system_admin: true },
  role: 'tenant_admin',
  permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
});

const FINGERPRINT = '3f9a1c2b7d4e5f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const OTHER_FINGERPRINT = `9c1d${FINGERPRINT.slice(4)}`;
const LETS_ENCRYPT = 'CN=R11,O=Let’s Encrypt,C=US';

const certificate = (
  id: string,
  name: string,
  overrides: Partial<Certificate> = {},
): Certificate => ({
  id,
  name,
  names: ['*.example.com', 'example.com'],
  subject: 'CN=example.com',
  issuer: LETS_ENCRYPT,
  chain: ['CN=example.com', LETS_ENCRYPT],
  serial: '4F2A99',
  key_type: 'EC P-256',
  fingerprint: FINGERPRINT,
  not_before: '2026-10-01T12:00:00Z',
  not_after: '2027-10-01T12:00:00Z',
  status: 'valid',
  warnings: [],
  created_at: '2026-11-20T12:00:00Z',
  updated_at: '2026-11-21T12:00:00Z',
  ...overrides,
});

const answer = (
  source: ServedCertificate['source'],
  overrides: Partial<ServedCertificate> = {},
): ServedCertificate => ({
  source,
  certificate_id: null,
  subject: '',
  issuer: '',
  not_after: null,
  fingerprint: '',
  valid_for_host: false,
  ...overrides,
});
/** The proxy answers with the stored certificate `id`. */
const own = (id: string, fingerprint = FINGERPRINT) =>
  answer('uploaded', {
    certificate_id: id,
    subject: 'CN=example.com',
    issuer: LETS_ENCRYPT,
    not_after: '2027-10-01T12:00:00Z',
    fingerprint,
    valid_for_host: true,
  });
/** The proxy answers with a certificate that is none of the stored ones. */
const foreign = (overrides: Partial<ServedCertificate> = {}) =>
  answer('other', {
    subject: 'CN=velydock.example.com',
    issuer: LETS_ENCRYPT,
    not_after: '2027-01-15T12:00:00Z',
    fingerprint: 'ee'.repeat(32),
    valid_for_host: true,
    ...overrides,
  });
const fallback = () =>
  answer('default', {
    subject: 'CN=TRAEFIK DEFAULT CERT',
    issuer: 'CN=TRAEFIK DEFAULT CERT',
    not_after: '2027-11-24T12:00:00Z',
    fingerprint: 'dd'.repeat(32),
  });

const host = (
  name: string,
  expected: string | null,
  served: ServedCertificate,
  purpose: CertificateHost['purpose'] = 'velydock',
  label = '',
): CertificateHost => ({ host: name, purpose, label, certificate_id: expected, served });

const overview = (overrides: Partial<CertificatesOverview> = {}): CertificatesOverview => ({
  available: true,
  problem: null,
  acme: true,
  certificates: [],
  hosts: [host('velydock.example.com', null, foreign())],
  ...overrides,
});

/** Mount the page; `state` is the answer to the list, or one answer after the other. */
function page(
  state: CertificatesOverview | CertificatesOverview[],
  extra: Parameters<typeof stubApi>[0] = {},
) {
  setMe(root);
  navigate('/system/certificates', { replace: true });
  let asked = 0;
  const api = stubApi({
    'GET /api/v1/system/certificates': () =>
      Array.isArray(state) ? state[Math.min(asked++, state.length - 1)] : state,
    ...extra,
  });
  render(ConfirmDialog);
  const view = render(Certificates);
  const lists = () =>
    api.calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/system/certificates')
      .length;
  return { ...api, view, lists };
}

const loaded = () => screen.findByTestId('certificate-hosts');
const rows = () => screen.queryAllByTestId('certificate');
const rowOf = (name: string) => rows().find((row) => row.getAttribute('data-name') === name)!;
const hostRows = () => screen.queryAllByTestId('certificate-host');
const hostRow = (name: string) => hostRows().find((row) => row.getAttribute('data-host') === name)!;
const messages = () => get(toasts).map((toast) => toast.message);
const de = (key: string) => translate('de', key);

describe('System administration: certificates', () => {
  it('has its place in the system pages after the proxy templates, for system administrators only', () => {
    const paths = SYSTEM_NAV.map((entry) => entry.path);
    expect(paths.indexOf('/system/certificates')).toBe(
      paths.indexOf('/system/proxy-templates') + 1,
    );
    const entry = SYSTEM_NAV.find((item) => item.path === '/system/certificates')!;
    expect(entry.permission).toBe('system:admin');
    expect(de(entry.label)).toBe('Zertifikate');
    expect(translate('en', entry.label)).toBe('Certificates');
    const found = resolveRoute(routes, '/system/certificates', ['system:admin']);
    expect(found).toMatchObject({
      kind: 'page',
      route: { component: Certificates, title: 'nav.system.certificates' },
    });
    expect(resolveRoute(routes, '/system/certificates', PERMISSIONS.tenantAdmin).kind).toBe(
      'forbidden',
    );
  });

  it('says what it is for, and what addresses without an own certificate get', async () => {
    page(overview({ acme: true }));
    await loaded();
    const main = screen.getByTestId('certificates-page');
    expect(within(main).getByRole('heading', { level: 1, name: 'Zertifikate' })).toBeVisible();
    expect(main).toHaveTextContent(
      'Der Proxy liefert ein hochgeladenes Zertifikat für jede Adresse aus, für die es gilt.',
    );
    expect(main).toHaveTextContent(
      'Adressen ohne eigenes Zertifikat bekommen eines von Let’s Encrypt.',
    );
    expect(main).not.toHaveTextContent('selbstsignierte');
    expect(screen.queryByTestId('certificates-unavailable')).toBeNull();
    expect(screen.getByTestId('certificate-add')).toBeEnabled();
  });

  it('says that browsers warn where the proxy fetches no certificates itself', async () => {
    page(overview({ acme: false }));
    await loaded();
    const main = screen.getByTestId('certificates-page');
    expect(main).toHaveTextContent(
      'Adressen ohne eigenes Zertifikat bekommen das selbstsignierte Zertifikat des Proxys – Browser warnen davor.',
    );
    expect(main).not.toHaveTextContent('Let’s Encrypt.');
  });

  describe('where the installation cannot serve own certificates', () => {
    const REASONS = {
      no_directory: 'VELYDOCK_CERTS_DIR ist nicht gesetzt',
      no_secret: 'VELYDOCK_PROXY_SECRET ist nicht gesetzt',
      not_writable:
        'Velydock kann in das Verzeichnis für Zertifikate (VELYDOCK_CERTS_DIR) nicht schreiben',
    } as const;

    it.each(Object.entries(REASONS))('%s: says why, in words to act on', async (problem, text) => {
      page(
        overview({
          available: false,
          problem: problem as keyof typeof REASONS,
          certificates: [certificate('c-1', 'Wildcard')],
        }),
      );
      const notice = await screen.findByTestId('certificates-unavailable');
      expect(notice).toHaveAttribute('data-problem', problem);
      expect(within(notice).getByRole('status')).toHaveTextContent(
        'Eigene Zertifikate sind auf dieser Installation nicht eingerichtet',
      );
      expect(notice).toHaveTextContent(text);
      expect(notice).toHaveTextContent(de(`certificates.problem.${problem}`));
      expect(notice).toHaveTextContent(
        'Bis das behoben ist, lässt sich kein Zertifikat hinzufügen oder ersetzen.',
      );
      // Nothing can be added or replaced; what is stored is shown, and can still go.
      expect(screen.getByTestId('certificate-add')).toBeDisabled();
      expect(screen.getByTestId('certificates-table')).toBeInTheDocument();
      expect(screen.getByTestId('certificate-hosts')).toBeInTheDocument();
      expect(rows()).toHaveLength(1);
      expect(hostRows()).toHaveLength(1);
      expect(screen.getByTestId('certificate-replace')).toBeDisabled();
      expect(screen.getByTestId('certificate-remove')).toBeEnabled();
    });

    it('names a reason it does not know by its code', async () => {
      page(overview({ available: false, problem: 'brand_new' as CertificatesOverview['problem'] }));
      const notice = await screen.findByTestId('certificates-unavailable');
      expect(notice).toHaveAttribute('data-problem', 'brand_new');
      expect(notice).toHaveTextContent(
        'Den Grund kennt diese Version der Oberfläche nicht (brand_new).',
      );
    });

    it('keeps the button of the empty list disabled as well', async () => {
      page(overview({ available: false, problem: 'no_secret' }));
      await loaded();
      expect(screen.getByTestId('certificate-add-empty')).toBeDisabled();
      // Nor does a click that reaches the page all the same open the dialog.
      await fireEvent.click(screen.getByTestId('certificate-add'));
      await fireEvent.click(screen.getByTestId('certificate-add-empty'));
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('says in one sentence what to do while nothing is stored, and offers it', async () => {
    page(overview());
    await loaded();
    expect(rows()).toHaveLength(0);
    const main = screen.getByTestId('certificates-page');
    expect(
      within(main).getByRole('heading', { name: 'Noch kein eigenes Zertifikat' }),
    ).toBeVisible();
    expect(main).toHaveTextContent(
      'Lad ein Zertifikat mit seinem privaten Schlüssel hoch, dann liefert der Proxy es aus.',
    );
    // One hook for the browser tests, wherever the second button stands.
    expect(screen.getAllByTestId('certificate-add')).toHaveLength(1);
    await fireEvent.click(screen.getByTestId('certificate-add-empty'));
    expect(await screen.findByRole('dialog', { name: 'Zertifikat hinzufügen' })).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await fireEvent.click(screen.getByTestId('certificate-add'));
    expect(await screen.findByRole('dialog', { name: 'Zertifikat hinzufügen' })).toBeVisible();
  });

  describe('the stored certificates', () => {
    const LIST = [
      certificate('c-1', 'Wildcard'),
      certificate('c-2', 'Mail', {
        names: ['mail.example.com'],
        status: 'expires_soon',
        not_after: '2026-12-05T12:00:00Z',
        key_type: 'RSA 2048',
        issuer: 'CN=Haus-CA',
        chain: ['CN=mail.example.com'],
        warnings: ['no_intermediate'],
        fingerprint: OTHER_FINGERPRINT,
      }),
      certificate('c-3', 'Alt', {
        names: ['alt.example.com'],
        status: 'expired',
        not_after: '2026-03-01T12:00:00Z',
        fingerprint: 'aa'.repeat(32),
      }),
      certificate('c-4', 'Neu', {
        names: ['neu.example.com'],
        status: 'not_yet_valid',
        not_before: '2027-01-01T12:00:00Z',
        not_after: '2028-01-01T12:00:00Z',
        fingerprint: 'bb'.repeat(32),
      }),
    ];
    const list = async (certificates = LIST) => {
      const api = page(overview({ certificates }));
      await loaded();
      return api;
    };

    it('are listed with name, names, issuer, validity and key', async () => {
      await list();
      expect(
        rows().map((row) => [
          row.getAttribute('data-id'),
          row.getAttribute('data-name'),
          row.getAttribute('data-status'),
        ]),
      ).toEqual([
        ['c-1', 'Wildcard', 'valid'],
        ['c-2', 'Mail', 'expires_soon'],
        ['c-3', 'Alt', 'expired'],
        ['c-4', 'Neu', 'not_yet_valid'],
      ]);
      const wildcard = rowOf('Wildcard');
      expect(
        [...within(wildcard).getByTestId('certificate-names').querySelectorAll('li')].map(
          (item) => item.textContent,
        ),
      ).toEqual(['*.example.com', 'example.com']);
      // The issuer in short, in full for whoever points at it.
      expect(within(wildcard).getByText('Let’s Encrypt (R11)')).toHaveAttribute(
        'title',
        LETS_ENCRYPT,
      );
      expect(wildcard).toHaveTextContent('01.10.2027');
      expect(wildcard).toHaveTextContent('EC P-256');
      expect(rowOf('Mail')).toHaveTextContent('RSA 2048');
      expect(rowOf('Mail')).toHaveTextContent('Haus-CA');
      expect(
        [...screen.getByTestId('certificates-table').querySelectorAll('thead th')].map(
          (cell) => cell.textContent,
        ),
      ).toEqual(['Name', 'Gilt für', 'Aussteller', 'Gültig bis', 'Schlüssel', 'Aktionen']);
    });

    it('mark the ones that run out soon, have run out or are not valid yet', async () => {
      await list();
      const marks = (name: string) =>
        [...rowOf(name).querySelectorAll('.pill')].map((pill) => pill.textContent?.trim());
      expect(marks('Wildcard')).toEqual([]);
      expect(marks('Mail')).toEqual(['läuft bald ab']);
      expect(marks('Alt')).toEqual(['abgelaufen']);
      expect(marks('Neu')).toEqual(['noch nicht gültig']);
      expect(rowOf('Mail')).toHaveTextContent('05.12.2026');
      expect(rowOf('Alt').querySelector('.pill')).toHaveClass('pill-crit');
      expect(rowOf('Mail').querySelector('.pill')).toHaveClass('pill-warn');
    });

    it('show a state they do not know as its code', async () => {
      await list([certificate('c-9', 'Seltsam', { status: 'revoked' as Certificate['status'] })]);
      expect(rowOf('Seltsam')).toHaveAttribute('data-status', 'revoked');
      expect(rowOf('Seltsam').querySelector('.pill')).toHaveTextContent('revoked');
    });

    it('warn about a certificate that came without the one of its issuer', async () => {
      await list();
      const warning = within(rowOf('Mail')).getByTestId('certificate-warning');
      expect(warning).toHaveAttribute('data-warning', 'no_intermediate');
      expect(warning).toHaveTextContent(
        'Ohne Zertifikat des Ausstellers – Browser, die den Aussteller nicht kennen, lehnen die Verbindung ab. Ersetz es durch eines mit vollständiger Kette.',
      );
      expect(screen.getAllByTestId('certificate-warning')).toHaveLength(1);
      expect(within(rowOf('Wildcard')).queryByTestId('certificate-warning')).toBeNull();
    });

    it('keep the details for whoever asks for them', async () => {
      await list();
      const details = within(rowOf('Wildcard')).getByTestId(
        'certificate-details',
      ) as HTMLDetailsElement;
      // Closed until its line is clicked: the browser's own disclosure.
      expect(details.tagName).toBe('DETAILS');
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')).toHaveTextContent('Details: Wildcard');
      const entries = Object.fromEntries(
        [...details.querySelectorAll('dt')].map((term) => [
          term.textContent,
          term.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim(),
        ]),
      );
      expect(entries).toEqual({
        Inhaber: 'CN=example.com',
        Aussteller: LETS_ENCRYPT,
        Kette: expect.stringContaining('CN=example.com'),
        Seriennummer: '4F2A99',
        'Fingerabdruck (SHA-256)': FINGERPRINT,
        'Gültig ab': expect.stringContaining('01.10.2026'),
        'Gültig bis': expect.stringContaining('01.10.2027'),
        Gespeichert: expect.stringContaining('20.11.2026'),
        Geändert: expect.stringContaining('21.11.2026'),
      });
      expect([...details.querySelectorAll('ol li')].map((item) => item.textContent)).toEqual([
        'CN=example.com',
        LETS_ENCRYPT,
      ]);
      // The fingerprint reads as the API gives it, whatever sets its pairs apart.
      const fingerprint = within(rowOf('Mail')).getByTestId('certificate-fingerprint');
      expect(fingerprint.textContent?.trim()).toBe(OTHER_FINGERPRINT);
      expect(fingerprint.querySelectorAll('span')).toHaveLength(32);
    });

    it('can be replaced and removed, each named by its certificate', async () => {
      await list();
      expect(within(rowOf('Mail')).getByTestId('certificate-replace')).toHaveAccessibleName(
        'Zertifikat Mail ersetzen',
      );
      expect(within(rowOf('Mail')).getByTestId('certificate-replace')).toHaveTextContent(
        'Ersetzen',
      );
      expect(within(rowOf('Mail')).getByTestId('certificate-remove')).toHaveAccessibleName(
        'Zertifikat Mail entfernen',
      );
      expect(within(rowOf('Mail')).getByTestId('certificate-remove')).toHaveTextContent(
        'Entfernen',
      );
      expect(screen.queryByTestId('certificate-add-empty')).toBeNull();
      await fireEvent.click(within(rowOf('Mail')).getByTestId('certificate-replace'));
      const dialog = await screen.findByRole('dialog', { name: 'Zertifikat „Mail“ ersetzen' });
      expect(within(dialog).getByTestId('certificate-name')).toHaveValue('Mail');
    });

    it('are shown in English on an English page', async () => {
      await list();
      setLanguage('en', { persist: false });
      expect(await screen.findByRole('heading', { level: 1, name: 'Certificates' })).toBeVisible();
      expect(rowOf('Mail').querySelector('.pill')).toHaveTextContent('expires soon');
      expect(within(rowOf('Mail')).getByTestId('certificate-warning')).toHaveTextContent(
        'Without the certificate of its issuer',
      );
      expect(rowOf('Wildcard')).toHaveTextContent('1 Oct 2027');
      expect(screen.getByRole('heading', { name: 'Addresses of this installation' })).toBeVisible();
    });
  });

  describe('the addresses of the installation', () => {
    const wildcard = certificate('c-1', 'Wildcard');
    const HOSTS = [
      host('velydock.example.com', 'c-1', own('c-1')),
      host('auth.example.com', null, foreign(), 'keycloak'),
      host('sandbox.example.org', null, fallback(), 'sandbox'),
      host('apps.example.com', null, answer('unreachable'), 'apps'),
      host('wiki.apps.example.com', null, answer('unknown'), 'app', 'wiki'),
    ];
    const hosts = async (list = HOSTS, certificates = [wildcard]) => {
      const api = page(overview({ certificates, hosts: list }));
      await loaded();
      return api;
    };

    it('are listed with what each is for', async () => {
      await hosts();
      expect(
        screen.getByRole('heading', { level: 2, name: 'Adressen dieser Installation' }),
      ).toBeVisible();
      expect(
        hostRows().map((row) => [
          row.getAttribute('data-host'),
          row.querySelectorAll('td')[1].textContent?.trim(),
        ]),
      ).toEqual([
        ['velydock.example.com', 'Velydock'],
        ['auth.example.com', 'Anmeldung'],
        ['sandbox.example.org', 'Eigene Apps'],
        ['apps.example.com', 'Veröffentlichte Apps'],
        ['wiki.apps.example.com', 'App „wiki“'],
      ]);
      expect(
        [...screen.getByTestId('certificate-hosts').querySelectorAll('thead th')].map(
          (cell) => cell.textContent,
        ),
      ).toEqual(['Adresse', 'Verwendung', 'Ausgeliefert wird', 'Gültig bis']);
    });

    it('say what the proxy really answers with, for every kind of answer', async () => {
      await hosts();
      const served = (name: string) => hostRow(name).querySelectorAll('td')[2];
      const until = (name: string) => hostRow(name).querySelectorAll('td')[3].textContent?.trim();
      expect(
        hostRows().map((row) => [
          row.getAttribute('data-source'),
          row.getAttribute('data-certificate'),
        ]),
      ).toEqual([
        ['uploaded', 'Wildcard'],
        ['other', ''],
        ['default', ''],
        ['unreachable', ''],
        ['unknown', ''],
      ]);
      // A stored certificate by its name, another one by its issuer.
      expect(served('velydock.example.com')).toHaveTextContent('Wildcard');
      expect(served('velydock.example.com')).toHaveTextContent('eigenes Zertifikat');
      expect(until('velydock.example.com')).toBe('01.10.2027');
      expect(served('auth.example.com')).toHaveTextContent('Aussteller: Let’s Encrypt (R11)');
      expect(until('auth.example.com')).toBe('15.01.2027');
      expect(served('sandbox.example.org')).toHaveTextContent('kein Zertifikat – Browser warnen');
      expect(served('apps.example.com')).toHaveTextContent('Proxy antwortet nicht');
      expect(until('apps.example.com')).toBe('–');
      expect(served('wiki.apps.example.com')).toHaveTextContent('nicht prüfbar');
      expect(until('wiki.apps.example.com')).toBe('–');
      // Nothing is stored for the others, so nothing is awaited or meant for them.
      expect(screen.queryByTestId('certificate-host-pending')).toBeNull();
      expect(screen.queryByTestId('certificate-host-expected')).toBeNull();
      expect(screen.queryByTestId('certificate-host-mismatch')).toBeNull();
    });

    it('say once why the proxy may not answer, and what cannot be checked', async () => {
      await hosts();
      const notice = screen.getByTestId('certificate-hosts-unreachable');
      expect(notice).toHaveTextContent('Der mitgelieferte Proxy antwortet nicht');
      expect(notice).toHaveTextContent(
        'Läuft Velydock hinter einem eigenen Reverse-Proxy, wirken hochgeladene Zertifikate dort nicht',
      );
      expect(screen.getByTestId('certificates-page')).toHaveTextContent(
        'Nicht prüfbar heißt: Diese Installation kann den Proxy nicht fragen',
      );
    });

    it('say neither while the proxy answers for every address', async () => {
      await hosts(HOSTS.slice(0, 3));
      expect(screen.queryByTestId('certificate-hosts-unreachable')).toBeNull();
      expect(screen.getByTestId('certificates-page')).not.toHaveTextContent('Nicht prüfbar heißt');
    });

    it('warn when what is served is not valid for the address, or has run out', async () => {
      await hosts([
        host('velydock.example.com', 'c-1', { ...own('c-1'), valid_for_host: false }),
        host(
          'auth.example.com',
          null,
          foreign({ valid_for_host: false, not_after: '2020-01-01T12:00:00Z' }),
          'keycloak',
        ),
        host('sandbox.example.org', null, fallback(), 'sandbox'),
        host('apps.example.com', null, answer('unreachable'), 'apps'),
        host('ok.example.com', null, foreign(), 'app', 'ok'),
      ]);
      const warned = hostRows()
        .filter((row) => within(row).queryByTestId('certificate-host-mismatch'))
        .map((row) => row.getAttribute('data-host'));
      // The stand-in of the proxy has its own warning; an answer that never came has none.
      expect(warned).toEqual(['velydock.example.com', 'auth.example.com']);
      expect(
        within(hostRow('auth.example.com')).getByTestId('certificate-host-mismatch'),
      ).toHaveTextContent('gilt nicht für diese Adresse – Browser warnen');
      expect(hostRow('auth.example.com').querySelector('.pill')).toHaveTextContent('abgelaufen');
      expect(hostRow('ok.example.com').querySelector('.pill')).toBeNull();
    });

    const mail = certificate('c-2', 'Mail', { fingerprint: OTHER_FINGERPRINT });
    const EXPECTING = [
      host('velydock.example.com', 'c-1', own('c-1')),
      // The proxy answers with a certificate it fetched itself, not with the stored one.
      host('auth.example.com', 'c-1', foreign(), 'keycloak'),
      host('sandbox.example.org', 'c-1', fallback(), 'sandbox'),
      // Served with a stored certificate, but another one than is meant for the name.
      host('mail.example.com', 'c-2', own('c-1'), 'app', 'mail'),
      host('apps.example.com', 'c-1', answer('unreachable'), 'apps'),
      host('wiki.apps.example.com', 'c-2', answer('unknown'), 'app', 'wiki'),
    ];
    const note = (testid: string) => (name: string) =>
      within(hostRow(name)).queryByTestId(testid)?.textContent?.trim();
    const pending = note('certificate-host-pending');
    const shadowedAt = note('certificate-host-shadowed');

    it('warn where the proxy keeps serving a certificate it fetched itself instead of the stored one', async () => {
      await hosts(EXPECTING, [wildcard, mail]);
      // No change was just made: this is not a matter of seconds, and the page says what is.
      expect(shadowedAt('auth.example.com')).toBe(
        'Der Proxy liefert für diesen Namen weiter ein Zertifikat aus, das er selbst geholt hat. Damit „Wildcard“ gilt, muss das geholte auf dem Server entfernt werden: Betriebshandbuch, Abschnitt „Zertifikate (TLS)“.',
      );
      expect(pending('auth.example.com')).toBeUndefined();
      expect(hostRow('auth.example.com')).toHaveAttribute('data-source', 'other');
      expect(hostRow('auth.example.com')).toHaveAttribute('data-certificate', '');
      // It names the manual, and no command: that differs from one installation to the next.
      const warning = within(hostRow('auth.example.com')).getByTestId('certificate-host-shadowed');
      expect(warning.querySelector('code, pre, kbd')).toBeNull();
      expect(warning.textContent).not.toMatch(/docker|rm |acme\.json|sudo/i);
      // Only there: every other answer means something else.
      expect(screen.getAllByTestId('certificate-host-shadowed')).toHaveLength(1);
      // Nor is it something the proxy would say in its log.
      expect(screen.queryByTestId('certificate-hosts-stalled')).toBeNull();
    });

    it('warn of nothing where no stored certificate is meant for the address', async () => {
      await hosts([
        host('velydock.example.com', null, foreign()),
        host('auth.example.com', 'c-1', own('c-1'), 'keycloak'),
      ]);
      expect(screen.queryByTestId('certificate-host-shadowed')).toBeNull();
      expect(screen.queryByTestId('certificate-host-pending')).toBeNull();
    });

    it('say the warning in English on an English page', async () => {
      await hosts(EXPECTING, [wildcard, mail]);
      setLanguage('en', { persist: false });
      await waitFor(() =>
        expect(shadowedAt('auth.example.com')).toBe(
          'For this name the proxy keeps serving a certificate it fetched itself. For “Wildcard” to apply, the fetched one has to be removed on the server: operations manual (Betriebshandbuch), section “Zertifikate (TLS)”.',
        ),
      );
    });

    it('say that the proxy takes a stored certificate over where it has none of its own for the address yet', async () => {
      await hosts(EXPECTING, [wildcard, mail]);
      expect(pending('velydock.example.com')).toBeUndefined();
      // The stand-in of the proxy: it has not taken the stored one over, or cannot read it.
      expect(pending('sandbox.example.org')).toBe(
        'Der Proxy übernimmt „Wildcard“ in wenigen Sekunden.',
      );
      expect(shadowedAt('sandbox.example.org')).toBeUndefined();
      expect(pending('mail.example.com')).toBe('Der Proxy übernimmt „Mail“ in wenigen Sekunden.');
      expect(shadowedAt('mail.example.com')).toBeUndefined();
      // What is served is named as it is: the hook holds the certificate that answers.
      expect(hostRow('mail.example.com')).toHaveAttribute('data-certificate', 'Wildcard');
      expect(shadowedAt('apps.example.com')).toBeUndefined();
      expect(shadowedAt('wiki.apps.example.com')).toBeUndefined();
      // Where nothing can be known, the page says what is meant for the name, and no more.
      expect(pending('apps.example.com')).toBeUndefined();
      expect(pending('wiki.apps.example.com')).toBeUndefined();
      const expected = (name: string) =>
        within(hostRow(name)).queryByTestId('certificate-host-expected')?.textContent?.trim();
      expect(expected('apps.example.com')).toBe('Vorgesehen: „Wildcard“');
      expect(expected('wiki.apps.example.com')).toBe('Vorgesehen: „Mail“');
      expect(expected('velydock.example.com')).toBeUndefined();
      expect(expected('auth.example.com')).toBeUndefined();
    });

    it('show an answer they do not know as it came', async () => {
      await hosts([
        host(
          'velydock.example.com',
          null,
          answer('quantum' as ServedCertificate['source']),
          'tunnel' as CertificateHost['purpose'],
        ),
      ]);
      expect(hostRow('velydock.example.com')).toHaveAttribute('data-source', 'quantum');
      expect(hostRow('velydock.example.com')).toHaveTextContent('quantum');
      expect(hostRow('velydock.example.com')).toHaveTextContent('tunnel');
    });

    it('are asked again with "Neu prüfen"', async () => {
      const { lists } = page([
        overview({
          certificates: [wildcard],
          hosts: [host('velydock.example.com', 'c-1', fallback())],
        }),
        overview({
          certificates: [wildcard],
          hosts: [host('velydock.example.com', 'c-1', own('c-1'))],
        }),
      ]);
      await loaded();
      expect(hostRow('velydock.example.com')).toHaveAttribute('data-source', 'default');
      const button = screen.getByTestId('certificate-hosts-refresh');
      expect(button).toHaveTextContent('Neu prüfen');
      await fireEvent.click(button);
      await waitFor(() =>
        expect(hostRow('velydock.example.com')).toHaveAttribute('data-source', 'uploaded'),
      );
      expect(hostRow('velydock.example.com')).toHaveAttribute('data-certificate', 'Wildcard');
      expect(lists()).toBe(2);
      expect(messages()).toEqual([]);
      await waitFor(() => expect(button).toBeEnabled());
    });

    it('keep what they showed when asking again fails, and say that it did', async () => {
      let fail = false;
      const { lists } = page(overview({ certificates: [wildcard], hosts: HOSTS }), {
        'GET /api/v1/system/certificates': () =>
          fail
            ? errorResponse(503, 'unavailable')
            : overview({ certificates: [wildcard], hosts: HOSTS }),
      });
      await loaded();
      fail = true;
      await fireEvent.click(screen.getByTestId('certificate-hosts-refresh'));
      await waitFor(() => expect(messages()).toHaveLength(1));
      expect(messages()[0]).toContain('Datenbank nicht erreichbar');
      expect(lists()).toBe(2);
      expect(hostRows()).toHaveLength(5);
      expect(rows()).toHaveLength(1);
    });
  });

  it('offers to try again when the list cannot be read', async () => {
    let fail = true;
    page(overview(), {
      'GET /api/v1/system/certificates': () =>
        fail ? errorResponse(503, 'unavailable') : overview(),
    });
    const retry = await screen.findByRole('button', { name: 'Erneut versuchen' });
    expect(messages()).toHaveLength(1);
    expect(screen.queryByTestId('certificate-hosts')).toBeNull();
    expect(screen.getByTestId('certificate-add')).toBeDisabled();
    fail = false;
    await fireEvent.click(retry);
    await loaded();
    expect(screen.getByTestId('certificate-add')).toBeEnabled();
  });

  describe('removing a certificate', () => {
    const wildcard = certificate('c-1', 'Wildcard');
    const mail = certificate('c-2', 'Mail', {
      names: ['mail.example.com'],
      fingerprint: OTHER_FINGERPRINT,
    });
    const before = (acme = true) =>
      overview({
        acme,
        certificates: [wildcard, mail],
        hosts: [
          host('velydock.example.com', 'c-1', own('c-1')),
          host('auth.example.com', 'c-1', foreign(), 'keycloak'),
          host('sandbox.example.org', null, fallback(), 'sandbox'),
        ],
      });
    const after = overview({
      certificates: [mail],
      hosts: [
        host('velydock.example.com', null, foreign()),
        host('auth.example.com', null, foreign(), 'keycloak'),
        host('sandbox.example.org', null, fallback(), 'sandbox'),
      ],
    });
    const removal = {
      'DELETE /api/v1/system/certificates/c-1': () => new Response(null, { status: 204 }),
    };
    const deletes = (calls: { method: string; url: string }[]) =>
      calls.filter((call) => call.method === 'DELETE').map((call) => call.url);

    it('asks first, and names the addresses that lose it and what they get instead', async () => {
      const { calls } = page([before(), after], removal);
      await loaded();
      await fireEvent.click(within(rowOf('Wildcard')).getByTestId('certificate-remove'));
      const question = await screen.findByRole('dialog', { name: 'Zertifikat entfernen' });
      expect(question).toHaveTextContent('Zertifikat „Wildcard“ entfernen?');
      // Those the certificate is meant for, whatever the proxy serves at the moment.
      expect(question).toHaveTextContent(
        'Diese Adressen verlieren es: velydock.example.com, auth.example.com. Der Proxy holt für sie danach ein Zertifikat von Let’s Encrypt.',
      );
      expect(question).not.toHaveTextContent('sandbox.example.org');
      const confirm = within(question).getByTestId('certificate-remove-confirm');
      expect(confirm).toHaveTextContent('Zertifikat entfernen');

      await fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Zertifikat entfernen' })).toBeNull(),
      );
      expect(deletes(calls)).toEqual([]);
      expect(rows()).toHaveLength(2);
    });

    it('removes it once that is confirmed, and shows the list as it is then', async () => {
      const { calls, lists } = page([before(), after], removal);
      await loaded();
      const button = within(rowOf('Wildcard')).getByTestId('certificate-remove');
      button.focus();
      await fireEvent.click(button);
      await fireEvent.click(await screen.findByTestId('certificate-remove-confirm'));
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(deletes(calls)).toEqual(['/api/v1/system/certificates/c-1']);
      expect(messages()).toEqual(['Zertifikat „Wildcard“ entfernt.']);
      expect(lists()).toBe(2);
      expect(rowOf('Mail')).toBeDefined();
      // The entry that took its place has the focus.
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(rowOf('Mail')).getByTestId('certificate-replace'),
        ),
      );
    });

    it('says that browsers will warn where the proxy fetches no certificates itself', async () => {
      page([before(false), after], removal);
      await loaded();
      await fireEvent.click(within(rowOf('Wildcard')).getByTestId('certificate-remove'));
      expect(await screen.findByRole('dialog', { name: 'Zertifikat entfernen' })).toHaveTextContent(
        'Diese Adressen verlieren es: velydock.example.com, auth.example.com. Sie bekommen danach das selbstsignierte Zertifikat des Proxys – Browser warnen davor.',
      );
    });

    it('says so when no address of the installation uses it', async () => {
      page([before(), after], removal);
      await loaded();
      await fireEvent.click(within(rowOf('Mail')).getByTestId('certificate-remove'));
      const question = await screen.findByRole('dialog', { name: 'Zertifikat entfernen' });
      expect(question).toHaveTextContent('Zertifikat „Mail“ entfernen?');
      expect(question).toHaveTextContent('Keine Adresse dieser Installation verwendet es.');
      expect(question).not.toHaveTextContent('verlieren');
    });

    it('says when it did not work, and reads the list again if the certificate was gone already', async () => {
      const { lists } = page([before(), after], {
        'DELETE /api/v1/system/certificates/c-1': () => errorResponse(404, 'not_found'),
      });
      await loaded();
      await fireEvent.click(within(rowOf('Wildcard')).getByTestId('certificate-remove'));
      await fireEvent.click(await screen.findByTestId('certificate-remove-confirm'));
      await waitFor(() => expect(messages()).toHaveLength(1));
      expect(messages()[0]).toContain('nicht gefunden');
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(lists()).toBe(2);
    });
  });

  describe('after a change', () => {
    const OLD = 'cc'.repeat(32);
    const wildcard = certificate('c-1', 'Wildcard', { fingerprint: OLD });
    const renewed = certificate('c-1', 'Wildcard');
    const fresh = certificate('c-new', 'Neu');
    const PEM =
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';
    const one = (served: ServedCertificate, expected: string | null, certificates: Certificate[]) =>
      overview({ certificates, hosts: [host('velydock.example.com', expected, served)] });

    // Only the clock of the page is in the test's hands; requests answer as they come.
    const settle = async () => {
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    };
    const wait = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await settle();
    };
    async function start(
      answers: CertificatesOverview[],
      extra: Parameters<typeof stubApi>[0] = {},
    ) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const api = page(answers, {
        'POST /api/v1/system/certificates': () => jsonResponse(fresh, 201),
        'PUT /api/v1/system/certificates/c-1': () => renewed,
        'DELETE /api/v1/system/certificates/c-1': () => new Response(null, { status: 204 }),
        ...extra,
      });
      await settle();
      expect(api.lists()).toBe(1);
      return api;
    }
    async function upload(name = 'Neu') {
      await fireEvent.click(screen.getByTestId('certificate-add'));
      await fireEvent.input(screen.getByTestId('certificate-name'), { target: { value: name } });
      await fireEvent.input(screen.getByTestId('certificate-text'), { target: { value: PEM } });
      await fireEvent.click(screen.getByTestId('certificate-save'));
      await settle();
    }
    async function replace() {
      await fireEvent.click(screen.getByTestId('certificate-replace'));
      await fireEvent.input(screen.getByTestId('certificate-text'), { target: { value: PEM } });
      await fireEvent.click(screen.getByTestId('certificate-save'));
      await settle();
    }
    async function removeIt() {
      await fireEvent.click(screen.getByTestId('certificate-remove'));
      await settle();
      await fireEvent.click(screen.getByTestId('certificate-remove-confirm'));
      await settle();
    }
    const source = () => hostRow('velydock.example.com').getAttribute('data-source');

    it('an upload: says so, closes the dialog, reads the list and asks again until the proxy serves it', async () => {
      const waiting = one(fallback(), 'c-new', [fresh]);
      const { lists, calls } = await start([
        one(fallback(), null, []),
        waiting,
        waiting,
        one(own('c-new'), 'c-new', [fresh]),
      ]);
      await upload();
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      expect(messages()).toEqual([
        'Zertifikat „Neu“ hinzugefügt. Der Proxy übernimmt es in wenigen Sekunden.',
      ]);
      expect(screen.queryByRole('dialog')).toBeNull();
      // Read again at once: the new entry is there, the proxy is not yet.
      expect(lists()).toBe(2);
      expect(rows()).toHaveLength(1);
      expect(screen.getByTestId('certificate-host-pending')).toHaveTextContent(
        'Der Proxy übernimmt „Neu“ in wenigen Sekunden.',
      );
      // Every three seconds, not sooner.
      await wait(2999);
      expect(lists()).toBe(2);
      await wait(1);
      expect(lists()).toBe(3);
      expect(source()).toBe('default');
      await wait(3000);
      expect(lists()).toBe(4);
      expect(source()).toBe('uploaded');
      expect(screen.queryByTestId('certificate-host-pending')).toBeNull();
      // Served: nothing left to ask for.
      await wait(60_000);
      expect(lists()).toBe(4);
      expect(screen.queryByTestId('certificate-hosts-stalled')).toBeNull();
    });

    it('asks five times at most, then says that the proxy is behind and where to look', async () => {
      const { lists } = await start([one(fallback(), null, []), one(fallback(), 'c-new', [fresh])]);
      await upload();
      expect(lists()).toBe(2);
      for (let round = 1; round <= 5; round++) {
        expect(screen.queryByTestId('certificate-hosts-stalled')).toBeNull();
        await wait(3000);
        expect(lists()).toBe(2 + round);
      }
      expect(screen.getByTestId('certificate-hosts-stalled')).toHaveTextContent(
        'Der Proxy liefert noch nicht überall aus, was gespeichert ist.',
      );
      await wait(60_000);
      expect(lists()).toBe(7);
      // Asking by hand takes the notice back; the line of the address still says what is awaited.
      await fireEvent.click(screen.getByTestId('certificate-hosts-refresh'));
      await settle();
      expect(lists()).toBe(8);
      expect(screen.queryByTestId('certificate-hosts-stalled')).toBeNull();
      expect(screen.getByTestId('certificate-host-pending')).toBeInTheDocument();
    });

    it('says "in a few seconds" while it asks again, and only then that the proxy prefers a certificate of its own', async () => {
      // The proxy fetched a certificate for the address itself, and goes on serving it.
      const fetched = foreign();
      const { lists } = await start([one(fetched, null, []), one(fetched, 'c-new', [fresh])]);
      const row = () => hostRow('velydock.example.com');
      await upload();
      expect(lists()).toBe(2);
      for (let round = 1; round <= 5; round++) {
        // The proxy may still catch up: nothing is said that only holds if it does not.
        expect(within(row()).getByTestId('certificate-host-pending')).toHaveTextContent(
          'Der Proxy übernimmt „Neu“ in wenigen Sekunden.',
        );
        expect(within(row()).queryByTestId('certificate-host-shadowed')).toBeNull();
        await wait(3000);
        expect(lists()).toBe(2 + round);
      }
      // Asked five times, and it is still the other certificate: this does not pass by itself.
      expect(within(row()).getByTestId('certificate-host-shadowed')).toHaveTextContent(
        'Damit „Neu“ gilt, muss das geholte auf dem Server entfernt werden: Betriebshandbuch, Abschnitt „Zertifikate (TLS)“.',
      );
      expect(within(row()).queryByTestId('certificate-host-pending')).toBeNull();
      expect(row()).toHaveAttribute('data-source', 'other');
      // The row says what is wrong; the notice about the proxy's log would point the wrong way.
      expect(screen.queryByTestId('certificate-hosts-stalled')).toBeNull();
      await wait(60_000);
      expect(lists()).toBe(7);
      // Asking by hand finds the same, and says the same.
      await fireEvent.click(screen.getByTestId('certificate-hosts-refresh'));
      await settle();
      expect(lists()).toBe(8);
      expect(within(row()).getByTestId('certificate-host-shadowed')).toBeInTheDocument();
    });

    it('says both where one address waits for the proxy and another is held by a fetched certificate', async () => {
      const two = (certificates: Certificate[], expected: string | null) =>
        overview({
          certificates,
          hosts: [
            host('velydock.example.com', expected, foreign()),
            host('sandbox.example.org', expected, fallback(), 'sandbox'),
          ],
        });
      await start([two([], null), two([fresh], 'c-new')]);
      await upload();
      expect(screen.getAllByTestId('certificate-host-pending')).toHaveLength(2);
      for (let round = 1; round <= 5; round++) await wait(3000);
      expect(
        within(hostRow('velydock.example.com')).getByTestId('certificate-host-shadowed'),
      ).toBeInTheDocument();
      expect(
        within(hostRow('sandbox.example.org')).getByTestId('certificate-host-pending'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('certificate-hosts-stalled')).toBeInTheDocument();
    });

    it('does not take the certificate that was just replaced for one the proxy fetched', async () => {
      // The proxy is slow: after all five questions it still answers with the old one.
      const { lists } = await start([
        one(own('c-1', OLD), 'c-1', [wildcard]),
        one(foreign({ fingerprint: OLD }), 'c-1', [renewed]),
      ]);
      await replace();
      for (let round = 1; round <= 5; round++) await wait(3000);
      expect(lists()).toBe(7);
      expect(screen.queryByTestId('certificate-host-shadowed')).toBeNull();
      expect(screen.getByTestId('certificate-host-pending')).toBeInTheDocument();
      expect(screen.getByTestId('certificate-hosts-stalled')).toBeInTheDocument();
    });

    it('stops asking when the page is left', async () => {
      const { lists, view } = await start([
        one(fallback(), null, []),
        one(fallback(), 'c-new', [fresh]),
      ]);
      await upload();
      await wait(3000);
      expect(lists()).toBe(3);
      view.unmount();
      await wait(60_000);
      expect(lists()).toBe(3);
    });

    it('asks no more once the page is left, even when an answer was still under way', async () => {
      const waiting = one(fallback(), 'c-new', [fresh]);
      let release: (answer: CertificatesOverview) => void = () => {};
      let asked = 0;
      const { lists, view } = await start([], {
        'GET /api/v1/system/certificates': () => {
          asked += 1;
          if (asked === 1) return one(fallback(), null, []);
          if (asked === 2) return waiting;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      });
      await upload();
      await wait(3000);
      expect(lists()).toBe(3);
      view.unmount();
      release(waiting);
      await wait(60_000);
      expect(lists()).toBe(3);
    });

    it('keeps the newer answer when an older one arrives after it', async () => {
      const waiting = one(fallback(), 'c-new', [fresh]);
      let release: (answer: CertificatesOverview) => void = () => {};
      let asked = 0;
      const { lists } = await start([], {
        'GET /api/v1/system/certificates': () => {
          asked += 1;
          if (asked === 1) return one(fallback(), null, []);
          if (asked === 2) return waiting;
          // The page's own question is slow; the one asked by hand right after is not.
          if (asked === 3) {
            return new Promise((resolve) => {
              release = resolve;
            });
          }
          return one(own('c-new'), 'c-new', [fresh]);
        },
      });
      await upload();
      await wait(3000);
      expect(lists()).toBe(3);
      await fireEvent.click(screen.getByTestId('certificate-hosts-refresh'));
      await settle();
      expect(lists()).toBe(4);
      expect(source()).toBe('uploaded');
      release(waiting);
      await settle();
      expect(source()).toBe('uploaded');
      await wait(60_000);
      expect(lists()).toBe(4);
    });

    it('does not ask again where the proxy serves it at once, or cannot be asked', async () => {
      const first = await start([one(fallback(), null, []), one(own('c-new'), 'c-new', [fresh])]);
      await upload();
      await wait(60_000);
      expect(first.lists()).toBe(2);
      cleanup();
      clearToasts();

      const second = await start([
        one(answer('unknown'), null, []),
        one(answer('unknown'), 'c-new', [fresh]),
      ]);
      await upload();
      await wait(60_000);
      expect(second.lists()).toBe(2);
      expect(screen.getByTestId('certificate-host-expected')).toHaveTextContent(
        'Vorgesehen: „Neu“',
      );
    });

    it('a replacement: asks again until the new certificate is served under the same entry', async () => {
      // Until the proxy has it, the old one answers: no stored certificate any more.
      const stale = foreign({ fingerprint: OLD });
      const { lists, calls } = await start([
        one(own('c-1', OLD), 'c-1', [wildcard]),
        one(stale, 'c-1', [renewed]),
        one(own('c-1'), 'c-1', [renewed]),
      ]);
      await replace();
      expect(calls.filter((call) => call.method === 'PUT').map((call) => call.url)).toEqual([
        '/api/v1/system/certificates/c-1',
      ]);
      expect(messages()).toEqual([
        'Zertifikat „Wildcard“ ersetzt. Der Proxy übernimmt das neue in wenigen Sekunden.',
      ]);
      expect(lists()).toBe(2);
      expect(source()).toBe('other');
      await wait(3000);
      expect(lists()).toBe(3);
      expect(source()).toBe('uploaded');
      await wait(60_000);
      expect(lists()).toBe(3);
    });

    it('a replacement that covers fewer names: asks until the old certificate is served nowhere', async () => {
      const dropped = (served: ServedCertificate) =>
        overview({
          certificates: [renewed],
          hosts: [
            host('velydock.example.com', 'c-1', own('c-1')),
            host('auth.example.com', null, served, 'keycloak'),
          ],
        });
      const { lists } = await start([
        overview({
          certificates: [wildcard],
          hosts: [
            host('velydock.example.com', 'c-1', own('c-1', OLD)),
            host('auth.example.com', 'c-1', own('c-1', OLD), 'keycloak'),
          ],
        }),
        dropped(foreign({ fingerprint: OLD })),
        dropped(foreign({ fingerprint: OLD })),
        dropped(fallback()),
      ]);
      await replace();
      expect(lists()).toBe(2);
      await wait(3000);
      expect(lists()).toBe(3);
      await wait(3000);
      expect(lists()).toBe(4);
      await wait(60_000);
      expect(lists()).toBe(4);
      expect(screen.queryByTestId('certificate-hosts-stalled')).toBeNull();
    });

    it('a removal: asks again until the proxy has stopped serving what was removed', async () => {
      const { lists } = await start([
        one(own('c-1', OLD), 'c-1', [wildcard]),
        one(foreign({ fingerprint: OLD }), null, []),
        one(foreign({ fingerprint: OLD }), null, []),
        one(fallback(), null, []),
      ]);
      await removeIt();
      expect(messages()).toEqual(['Zertifikat „Wildcard“ entfernt.']);
      expect(lists()).toBe(2);
      expect(rows()).toHaveLength(0);
      await wait(3000);
      expect(lists()).toBe(3);
      await wait(3000);
      expect(lists()).toBe(4);
      expect(source()).toBe('default');
      await wait(60_000);
      expect(lists()).toBe(4);
    });

    it('a removal the proxy has followed already: nothing more to ask', async () => {
      const { lists } = await start([
        one(own('c-1', OLD), 'c-1', [wildcard]),
        // Another certificate answers now, for example the one the proxy fetched itself.
        one(foreign(), null, []),
      ]);
      await removeIt();
      await wait(60_000);
      expect(lists()).toBe(2);
    });

    it('starts over with the next change instead of asking twice as often', async () => {
      const waiting = one(fallback(), 'c-new', [fresh]);
      const { lists } = await start([one(fallback(), null, []), waiting]);
      await upload();
      await wait(2000);
      expect(lists()).toBe(2);
      await upload('Noch eins');
      expect(lists()).toBe(3);
      // Three seconds from the second change on, and one chain of questions, not two.
      await wait(2999);
      expect(lists()).toBe(3);
      await wait(1);
      expect(lists()).toBe(4);
      await wait(3000);
      expect(lists()).toBe(5);
    });

    it('ends quietly when asking again fails', async () => {
      let asked = 0;
      const { lists } = await start([], {
        'GET /api/v1/system/certificates': () => {
          asked += 1;
          if (asked === 1) return one(fallback(), null, []);
          if (asked === 2) return one(fallback(), 'c-new', [fresh]);
          return errorResponse(503, 'unavailable');
        },
      });
      await upload();
      clearToasts();
      await wait(3000);
      expect(lists()).toBe(3);
      // Nobody asked for this request: no toast (looked at before one would go by itself).
      expect(messages()).toEqual([]);
      await wait(60_000);
      expect(lists()).toBe(3);
      // And what was shown stays.
      expect(rows()).toHaveLength(1);
      expect(screen.queryByTestId('certificate-hosts-stalled')).toBeNull();
    });
  });
});
