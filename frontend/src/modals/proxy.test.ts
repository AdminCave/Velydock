// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { AdminApp, ProxyInfo, ProxyTemplate, Publication, Tenant } from '$lib/api/types';
import ConfirmDialog, { cancelConfirm } from '$lib/components/ui/ConfirmDialog.svelte';
import { translate } from '$lib/i18n';
import { clearToasts, toasts } from '$lib/stores/toasts';
import { ACME, errorResponse, jsonResponse, stubApi } from '../test/fixtures';
import AppModal from './AppModal.svelte';
import ProxyTemplateModal from './ProxyTemplateModal.svelte';
import TenantProxyModal from './TenantProxyModal.svelte';

// Publishing apps through the bundled proxy: the section of the app dialog, the releases
// of an organization and the dialog for a template.

const de = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('de', key, vars);

afterEach(() => {
  cancelConfirm();
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

// jsdom has no layout and no scrollIntoView: what a form asks to bring into view is recorded.
function recordReveals(): Element[] {
  const revealed: Element[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    revealed.push(this);
  };
  return revealed;
}

const DEFAULTS = {
  strip_prefix: true,
  pass_host_header: true,
  verify_upstream_tls: true,
  allow_embedding: false,
  identity_headers: false,
  rate_limit: null,
  request_headers: {},
  response_headers: {},
};

const template = (
  id: string,
  name: string,
  options: Record<string, unknown> = {},
  description = '',
): ProxyTemplate => ({ id, name, description, options, builtin: id.startsWith('builtin:') });

const TEMPLATES = [
  template('builtin:standard', 'Standard (server)', {}, 'Forwards requests as they are.'),
  template('builtin:embeddable', 'Embeddable (server)', { allow_embedding: true }),
  template('builtin:header-login', 'Header login (server)', { identity_headers: true }),
  template(
    't-office',
    'Büro-Netz',
    { rate_limit: { average: 50, burst: 100 } },
    'Nur aus dem Büro erreichbar.',
  ),
];

const info = (overrides: Partial<ProxyInfo> = {}): ProxyInfo => ({
  enabled: true,
  path_base: 'https://apps.example.com/',
  path_allowed: true,
  subdomain_suffix: '.apps.example.com',
  subdomain_scheme: 'https',
  targets: ['10.20.0.0/16', 'nas.intern'],
  templates: TEMPLATES,
  defaults: DEFAULTS,
  ...overrides,
});

const storedApp = (overrides: Partial<AdminApp> = {}): AdminApp => ({
  id: 'a1',
  name: 'Wiki',
  description: '',
  type: 'embedded',
  url: 'https://wiki.example/',
  enabled: true,
  sort_order: 10,
  visible_to_all: true,
  group_ids: [],
  user_ids: [],
  icon_name: 'book-open',
  icon_url: null,
  frame_permissions: [],
  embed_status: 'ok',
  embed_detail: '',
  embed_checked_at: null,
  custom_html: '',
  custom_css: '',
  custom_js: '',
  custom_allow_network: false,
  created_at: '',
  updated_at: '',
  ...overrides,
});

const publication = (overrides: Partial<Publication> = {}): Publication => ({
  name: 'wiki',
  mode: 'path',
  target_url: 'http://10.20.0.7:8080',
  access: 'protected',
  template: 'builtin:standard',
  options: {},
  public_url: 'https://apps.example.com/wiki/',
  problem: null,
  ...overrides,
});

const publishedApp = (overrides: Partial<Publication> = {}): AdminApp =>
  storedApp({ url: 'https://apps.example.com/wiki/', publication: publication(overrides) });

const refusal = (status: number, code: string, message = code) =>
  jsonResponse({ error: { code, message, details: {} } }, status);

const type = (testid: string, value: string) =>
  fireEvent.input(screen.getByTestId(testid), { target: { value } });
const choose = (group: string, value: string) =>
  fireEvent.click(
    screen.getByTestId(group).querySelector<HTMLInputElement>(`input[value="${value}"]`)!,
  );
const optionIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid^="app-publish-option-"]')]
    .map((el) => el.dataset.testid!.replace('app-publish-option-', ''))
    .filter((id) => !id.includes('rate_limit-'));

describe('AppModal: publishing through the proxy', () => {
  const base = {
    open: true,
    groups: [],
    canReadUsers: false,
    systemAdmin: false,
    onClose: () => {},
  };

  /** A new app with a name; the dialog knows what can be published. */
  async function newApp(proxy: ProxyInfo = info(), routes: Parameters<typeof stubApi>[0] = {}) {
    const onSaved = vi.fn();
    const api = stubApi({
      'GET /api/v1/admin/proxy': () => proxy,
      'POST /api/v1/admin/apps': ({ body }) => ({ ...storedApp(), ...(body as object) }),
      ...routes,
    });
    render(AppModal, { ...base, app: null, onSaved });
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Wiki' } });
    await screen.findByTestId('app-publish-toggle');
    return { ...api, onSaved };
  }

  async function editApp(
    app: AdminApp,
    proxy: ProxyInfo = info(),
    routes: Parameters<typeof stubApi>[0] = {},
  ) {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const api = stubApi({
      'GET /api/v1/admin/proxy': () => proxy,
      [`PATCH /api/v1/admin/apps/${app.id}`]: ({ body }) => ({ ...app, ...(body as object) }),
      ...routes,
    });
    render(AppModal, { ...base, app, onSaved, onClose });
    await screen.findByTestId('app-publish-toggle');
    if (!app.publication) return { ...api, onSaved, onClose };
    // What the installation offers has arrived: the template is known by its name (until
    // then its place is held by "…").
    await waitFor(() =>
      expect(
        [...screen.getByTestId('app-publish-template').querySelectorAll('option')].map(
          (option) => option.textContent,
        ),
      ).not.toContain('…'),
    );
    return { ...api, onSaved, onClose };
  }

  const publish = () => fireEvent.click(screen.getByTestId('app-publish-toggle'));
  const save = (name = 'Speichern') => fireEvent.click(screen.getByRole('button', { name }));
  const sent = (calls: { method: string; body: unknown }[], method: string) =>
    calls.filter((call) => call.method === method).map((call) => call.body);

  describe('is offered', () => {
    it('for embedded apps and apps in a new tab, where the installation has it set up', async () => {
      await newApp();
      const toggle = screen.getByTestId('app-publish-toggle');
      expect(toggle).toHaveAttribute('role', 'switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(toggle).toHaveAccessibleName('Über den Proxy veröffentlichen');
      await choose('app-type', 'external');
      expect(screen.getByTestId('app-publish-toggle')).toBeInTheDocument();
      // A custom app has no address the proxy could forward to.
      await choose('app-type', 'custom');
      expect(screen.queryByTestId('app-publish-toggle')).toBeNull();
    });

    it('not where publishing is not set up, and not while the installation has not answered', async () => {
      const { calls } = stubApi({ 'GET /api/v1/admin/proxy': () => ({ enabled: false }) });
      render(AppModal, { ...base, app: null, onSaved: () => {} });
      await waitFor(() => expect(calls).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByTestId('app-publish-toggle')).toBeNull();
      expect(screen.getByLabelText('Adresse (URL)')).toBeInTheDocument();
      cleanup();

      // No answer at all (an older server, a failure): the dialog works as it always did.
      stubApi({});
      render(AppModal, { ...base, app: null, onSaved: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByTestId('app-publish-toggle')).toBeNull();
      expect(screen.getByLabelText('Adresse (URL)')).toBeInTheDocument();
    });
  });

  describe('switched on', () => {
    it('takes the address field away and asks for what a publication consists of', async () => {
      await newApp();
      expect(screen.getByLabelText('Adresse (URL)')).toBeInTheDocument();
      expect(screen.queryByTestId('app-publish-target')).toBeNull();
      await publish();
      expect(screen.queryByLabelText('Adresse (URL)')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Einbettbarkeit prüfen' })).toBeNull();
      expect(screen.getByTestId('app-publish-target')).toHaveAccessibleName('Interne Adresse');
      expect(screen.getByTestId('app-publish-mode')).toHaveAttribute('role', 'radiogroup');
      expect(screen.getByTestId('app-publish-mode')).toHaveAccessibleName('Adresse');
      expect(screen.getByTestId('app-publish-mode')).toHaveAttribute('data-value', 'path');
      expect(screen.getByTestId('app-publish-access')).toHaveAccessibleName('Zugriff');
      expect(screen.getByTestId('app-publish-access')).toHaveAttribute('data-value', 'protected');
      expect(screen.getByTestId('app-publish-template').tagName).toBe('SELECT');
      expect(screen.getByTestId('app-publish-template')).toHaveAccessibleName('Vorlage');
      expect(screen.getByTestId('app-publish-template')).toHaveValue('builtin:standard');
      const labels = (group: string) =>
        [...screen.getByTestId(group).querySelectorAll('label')].map((label) =>
          label.textContent?.trim(),
        );
      expect(labels('app-publish-mode')).toEqual(['Pfad', 'Subdomain']);
      expect(labels('app-publish-access')).toEqual(['Geschützt', 'Öffentlich']);
    });

    it('shows what the system administrator released for the organization', async () => {
      await newApp();
      await publish();
      const released = screen.getByTestId('app-publish-targets');
      expect(released).toHaveTextContent('Für deine Organisation freigegeben');
      expect([...released.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        '10.20.0.0/16',
        'nas.intern',
      ]);
    });

    it('builds the public address while the name is typed, by path or by sub-domain', async () => {
      await newApp();
      await publish();
      // The name starts as the app's.
      expect(screen.getByTestId('app-publish-name')).toHaveValue('wiki');
      const preview = screen.getByTestId('app-publish-preview');
      expect(preview).toHaveTextContent('https://apps.example.com/wiki/');
      await type('app-publish-name', 'Handbuch');
      expect(preview).toHaveTextContent('https://apps.example.com/handbuch/');
      await choose('app-publish-mode', 'subdomain');
      expect(screen.getByTestId('app-publish-mode')).toHaveAttribute('data-value', 'subdomain');
      expect(preview).toHaveTextContent('https://handbuch.apps.example.com/');
      await type('app-publish-name', '');
      expect(preview).toHaveTextContent('Ergibt sich aus dem Namen.');
    });

    it('lets the name in the address follow the name of the app until it is edited by hand', async () => {
      await newApp();
      await publish();
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Wiki für alle' } });
      expect(screen.getByTestId('app-publish-name')).toHaveValue('wiki-fuer-alle');
      await type('app-publish-name', 'handbuch');
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Etwas anderes' } });
      expect(screen.getByTestId('app-publish-name')).toHaveValue('handbuch');
    });

    it('offers only the sub-domain where path addresses are not allowed, and says why', async () => {
      await newApp(info({ path_allowed: false }));
      await publish();
      const mode = screen.getByTestId('app-publish-mode');
      expect([...mode.querySelectorAll('input')].map((input) => input.value)).toEqual([
        'subdomain',
      ]);
      expect(mode).toHaveAttribute('data-value', 'subdomain');
      expect(mode.closest('fieldset')).toHaveTextContent(
        'Der Systemadministrator erlaubt deiner Organisation nur Subdomains.',
      );
      expect(screen.getByTestId('app-publish-preview')).toHaveTextContent(
        'https://wiki.apps.example.com/',
      );
    });

    it('says nothing of the kind where both are allowed', async () => {
      await newApp();
      await publish();
      expect(screen.getByTestId('app-publish-mode').closest('fieldset')).not.toHaveTextContent(
        'nur Subdomains',
      );
    });

    it('warns plainly when the app is made public', async () => {
      await newApp();
      await publish();
      expect(screen.queryByTestId('app-publish-public')).toBeNull();
      await choose('app-publish-access', 'public');
      const warning = screen.getByTestId('app-publish-public');
      expect(warning).toHaveTextContent('Ohne Anmeldung erreichbar');
      expect(warning).toHaveTextContent(
        'Jeder, der die Adresse kennt, erreicht die App – ohne sich anzumelden',
      );
      await choose('app-publish-access', 'protected');
      expect(screen.queryByTestId('app-publish-public')).toBeNull();
    });

    it('names built-in templates in the language of the page and own ones as they were named', async () => {
      await newApp();
      await publish();
      const select = screen.getByTestId('app-publish-template');
      expect([...select.querySelectorAll('option')].map((o) => [o.value, o.textContent])).toEqual([
        ['builtin:standard', 'Standard'],
        ['builtin:embeddable', 'In Velydock einbettbar'],
        ['builtin:header-login', 'Anmeldung per Kopfzeile'],
        ['t-office', 'Büro-Netz'],
      ]);
      const field = select.closest('.ui-field') as HTMLElement;
      expect(field).toHaveTextContent('Leitet Anfragen unverändert weiter.');
      await fireEvent.change(select, { target: { value: 't-office' } });
      expect(field).toHaveTextContent('Nur aus dem Büro erreichbar.');
      await fireEvent.change(select, { target: { value: 'builtin:embeddable' } });
      expect(field).toHaveTextContent('Entfernt X-Frame-Options');
    });
  });

  describe('with nothing released for the organization', () => {
    it('says that a release by the system administrator is needed, and offers no save', async () => {
      const { calls } = await newApp(info({ targets: [] }));
      await publish();
      const released = screen.getByTestId('app-publish-targets');
      expect(released).toHaveTextContent('Noch nichts freigegeben');
      expect(released).toHaveTextContent('muss der Systemadministrator erst freigeben');
      expect(screen.queryByTestId('app-publish-target')).toBeNull();
      expect(screen.queryByTestId('app-publish-name')).toBeNull();
      const submit = screen.getByRole('button', { name: 'App anlegen' });
      expect(submit).toBeDisabled();
      await fireEvent.submit(document.querySelector('form')!);
      expect(sent(calls, 'POST')).toEqual([]);
      // Without the publication the app can be saved as any other.
      await publish();
      expect(screen.getByRole('button', { name: 'App anlegen' })).toBeEnabled();
      expect(screen.getByLabelText('Adresse (URL)')).toBeInTheDocument();
    });

    it('still shows a publication that exists, so that it can be changed or ended', async () => {
      await editApp(publishedApp({ problem: 'target_not_allowed' }), info({ targets: [] }));
      expect(screen.getByTestId('app-publish-target')).toHaveValue('http://10.20.0.7:8080');
      expect(screen.getByTestId('app-publish-targets')).toHaveTextContent(
        'Noch nichts freigegeben',
      );
      expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled();
    });
  });

  describe('the settings', () => {
    it('are collapsed, and hold the options of the manual and no field for own middlewares', async () => {
      await newApp();
      await publish();
      await type('app-publish-target', 'https://nas.intern');
      const details = screen.getByTestId('app-publish-options');
      expect(details.tagName).toBe('DETAILS');
      expect(details).not.toHaveAttribute('open');
      expect(within(details).getByText('Einstellungen anpassen')).toBeInTheDocument();
      expect(optionIds()).toEqual([
        'strip_prefix',
        'allow_embedding',
        'verify_upstream_tls',
        'identity_headers',
        'pass_host_header',
        'rate_limit',
        'request_headers',
        'response_headers',
      ]);
      expect(details).not.toHaveTextContent('Middleware');
      const label = (key: string) =>
        screen.getByTestId(`app-publish-option-${key}`).getAttribute('aria-label');
      expect(label('strip_prefix')).toBe('Namen aus dem Pfad entfernen');
      expect(label('allow_embedding')).toBe('Einbettung erlauben');
      expect(label('verify_upstream_tls')).toBe('Zertifikat des Ziels nicht prüfen');
      expect(label('identity_headers')).toBe('Anmeldung per Kopfzeile');
      expect(label('pass_host_header')).toBe('Öffentlichen Hostnamen weitergeben');
      expect(label('rate_limit')).toBe('Anfragen begrenzen');
    });

    it('show per option what the template gives', async () => {
      await newApp();
      await publish();
      await type('app-publish-target', 'https://nas.intern');
      const option = (key: string) =>
        screen.getByTestId(`app-publish-option-${key}`).closest('.option') as HTMLElement;
      const on = (key: string) =>
        screen.getByTestId(`app-publish-option-${key}`).getAttribute('aria-checked');
      expect(on('allow_embedding')).toBe('false');
      expect(option('allow_embedding')).toHaveTextContent('Vorlage: aus');
      expect(on('strip_prefix')).toBe('true');
      expect(option('strip_prefix')).toHaveTextContent('Vorlage: an');
      // "Do not verify" is off while the certificate is verified.
      expect(on('verify_upstream_tls')).toBe('false');
      expect(option('verify_upstream_tls')).toHaveTextContent('Vorlage: aus');
      expect(option('rate_limit')).toHaveTextContent('Vorlage: aus');
      expect(option('request_headers')).toHaveTextContent('Vorlage: keine');

      await fireEvent.change(screen.getByTestId('app-publish-template'), {
        target: { value: 'builtin:embeddable' },
      });
      expect(on('allow_embedding')).toBe('true');
      expect(option('allow_embedding')).toHaveTextContent('Vorlage: an');
      expect(option('allow_embedding')).not.toHaveTextContent('abweichend');
      await fireEvent.change(screen.getByTestId('app-publish-template'), {
        target: { value: 't-office' },
      });
      expect(on('rate_limit')).toBe('true');
      expect(option('rate_limit')).toHaveTextContent('Vorlage: 50 pro Sekunde');
      expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('50');
      expect(screen.getByTestId('app-publish-option-rate_limit-burst')).toHaveValue('100');
    });

    it('send an option only when it was set differently from the template', async () => {
      const { calls } = await newApp();
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      await fireEvent.change(screen.getByTestId('app-publish-template'), {
        target: { value: 'builtin:embeddable' },
      });
      const details = screen.getByTestId('app-publish-options');
      expect(details).not.toHaveTextContent('abweichend von der Vorlage');
      await fireEvent.click(screen.getByTestId('app-publish-option-strip_prefix'));
      expect(
        screen.getByTestId('app-publish-option-strip_prefix').closest('.option'),
      ).toHaveTextContent('abweichend');
      expect(details).toHaveTextContent('1 abweichend von der Vorlage');
      // Set differently and back again: no deviation is left of it.
      await fireEvent.click(screen.getByTestId('app-publish-option-pass_host_header'));
      await fireEvent.click(screen.getByTestId('app-publish-option-pass_host_header'));
      expect(details).toHaveTextContent('1 abweichend von der Vorlage');
      await save('App anlegen');
      await waitFor(() => expect(sent(calls, 'POST')).toHaveLength(1));
      expect(sent(calls, 'POST')[0]).toMatchObject({
        name: 'Wiki',
        type: 'embedded',
        url: null,
        publication: {
          name: 'wiki',
          mode: 'path',
          target_url: 'http://10.20.0.7:8080',
          access: 'protected',
          template: 'builtin:embeddable',
          options: { strip_prefix: false },
        },
      });
    });

    it('drop a deviation that the newly chosen template gives anyway', async () => {
      const { calls } = await newApp();
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      await fireEvent.click(screen.getByTestId('app-publish-option-allow_embedding'));
      expect(screen.getByTestId('app-publish-options')).toHaveTextContent('1 abweichend');
      await fireEvent.change(screen.getByTestId('app-publish-template'), {
        target: { value: 'builtin:embeddable' },
      });
      expect(screen.getByTestId('app-publish-options')).not.toHaveTextContent('abweichend');
      await save('App anlegen');
      await waitFor(() => expect(sent(calls, 'POST')).toHaveLength(1));
      expect((sent(calls, 'POST')[0] as { publication: Publication }).publication.options).toEqual(
        {},
      );
    });

    it('hide what has no effect for this publication', async () => {
      await newApp();
      await publish();
      // http://: there is no certificate to verify.
      await type('app-publish-target', 'http://10.20.0.7:8080');
      expect(optionIds()).not.toContain('verify_upstream_tls');
      await type('app-publish-target', 'https://10.20.0.7');
      expect(optionIds()).toContain('verify_upstream_tls');
      // By sub-domain there is no name in the path.
      expect(optionIds()).toContain('strip_prefix');
      await choose('app-publish-mode', 'subdomain');
      expect(optionIds()).not.toContain('strip_prefix');
      // A public app has nobody signed in whom a header could name.
      expect(optionIds()).toContain('identity_headers');
      await choose('app-publish-access', 'public');
      expect(optionIds()).not.toContain('identity_headers');
    });

    it('do not send what was set for another kind of address, target or access', async () => {
      const { calls } = await newApp();
      await publish();
      await type('app-publish-target', 'https://nas.intern');
      await fireEvent.click(screen.getByTestId('app-publish-option-strip_prefix'));
      await fireEvent.click(screen.getByTestId('app-publish-option-verify_upstream_tls'));
      await fireEvent.click(screen.getByTestId('app-publish-option-identity_headers'));
      await fireEvent.click(screen.getByTestId('app-publish-option-allow_embedding'));
      await choose('app-publish-mode', 'subdomain');
      await choose('app-publish-access', 'public');
      await type('app-publish-target', 'http://nas.intern');
      await save('App anlegen');
      await waitFor(() => expect(sent(calls, 'POST')).toHaveLength(1));
      expect((sent(calls, 'POST')[0] as { publication: Publication }).publication).toEqual({
        name: 'wiki',
        mode: 'subdomain',
        target_url: 'http://nas.intern',
        access: 'public',
        template: 'builtin:standard',
        options: { allow_embedding: true },
      });
    });

    it('send "do not verify the certificate" as the option that is switched off', async () => {
      const { calls } = await newApp();
      await publish();
      await type('app-publish-target', 'https://nas.intern');
      await fireEvent.click(screen.getByTestId('app-publish-option-verify_upstream_tls'));
      expect(screen.getByTestId('app-publish-option-verify_upstream_tls')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await save('App anlegen');
      await waitFor(() => expect(sent(calls, 'POST')).toHaveLength(1));
      expect((sent(calls, 'POST')[0] as { publication: Publication }).publication.options).toEqual({
        verify_upstream_tls: false,
      });
    });

    it('take a limit and additional headers, and send them as the API stores them', async () => {
      const { calls } = await newApp();
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      expect(screen.queryByTestId('app-publish-option-rate_limit-average')).toBeNull();
      await fireEvent.click(screen.getByTestId('app-publish-option-rate_limit'));
      await type('app-publish-option-rate_limit-average', '30');
      await type('app-publish-option-rate_limit-burst', '90');
      await type('app-publish-option-request_headers', 'X-Api-Key: abc\nAuthorization: Basic eA==');
      await save('App anlegen');
      await waitFor(() => expect(sent(calls, 'POST')).toHaveLength(1));
      expect((sent(calls, 'POST')[0] as { publication: Publication }).publication.options).toEqual({
        rate_limit: { average: 30, burst: 90 },
        request_headers: { 'X-Api-Key': 'abc', Authorization: 'Basic eA==' },
      });
    });

    it('do not rewrite what is being typed when another setting is changed', async () => {
      await newApp();
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      // Half a header: not one yet, and so not part of the publication yet.
      await type('app-publish-option-request_headers', 'X-Api-Key');
      await fireEvent.click(screen.getByTestId('app-publish-option-allow_embedding'));
      expect(screen.getByTestId('app-publish-option-request_headers')).toHaveValue('X-Api-Key');
      await fireEvent.click(screen.getByTestId('app-publish-option-rate_limit'));
      await type('app-publish-option-rate_limit-average', '');
      await fireEvent.click(screen.getByTestId('app-publish-option-pass_host_header'));
      expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('');
      expect(screen.getByTestId('app-publish-option-request_headers')).toHaveValue('X-Api-Key');
      // The same for a limit that comes from the template and is being changed.
      await fireEvent.click(screen.getByTestId('app-publish-option-rate_limit'));
      await fireEvent.change(screen.getByTestId('app-publish-template'), {
        target: { value: 't-office' },
      });
      expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('50');
      await type('app-publish-option-rate_limit-average', '');
      await fireEvent.click(screen.getByTestId('app-publish-option-pass_host_header'));
      expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('');
    });

    it('follow another template where nothing was set by hand, and keep what was', async () => {
      await newApp();
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      await fireEvent.click(screen.getByTestId('app-publish-option-rate_limit'));
      await type('app-publish-option-rate_limit-average', '5');
      await type('app-publish-option-rate_limit-burst', '9');
      await fireEvent.change(screen.getByTestId('app-publish-template'), {
        target: { value: 't-office' },
      });
      // Set by hand: stays, and now deviates from what the template gives.
      expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('5');
      expect(
        screen.getByTestId('app-publish-option-rate_limit').closest('.option'),
      ).toHaveTextContent('Vorlage: 50 pro Sekunde · abweichend');
      // Switched off and on again, the limit starts from the template's.
      await fireEvent.click(screen.getByTestId('app-publish-option-rate_limit'));
      await fireEvent.click(screen.getByTestId('app-publish-option-rate_limit'));
      expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('50');
      expect(screen.getByTestId('app-publish-option-rate_limit-burst')).toHaveValue('100');
    });

    it('say at the setting what cannot be saved, open themselves, and send nothing', async () => {
      const { calls } = await newApp();
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      await fireEvent.click(screen.getByTestId('app-publish-option-rate_limit'));
      await type('app-publish-option-rate_limit-average', '0');
      const details = screen.getByTestId('app-publish-options') as HTMLDetailsElement;
      details.open = false;
      await fireEvent(details, new Event('toggle'));
      const revealed = recordReveals();
      await save('App anlegen');
      await waitFor(() => expect(details.open).toBe(true));
      expect(within(details).getByRole('alert')).toHaveTextContent(
        'Zwischen 1 und 10 000 Anfragen pro Sekunde',
      );
      await waitFor(() =>
        expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveFocus(),
      );
      // The setting comes into view as a whole: the field together with what is said about it.
      expect(revealed.at(-1)).toContainElement(within(details).getByRole('alert'));
      expect(revealed.at(-1)).toContainElement(
        screen.getByTestId('app-publish-option-rate_limit-average'),
      );
      expect(sent(calls, 'POST')).toEqual([]);
      // A header the proxy sets itself is refused where it is typed.
      await type('app-publish-option-rate_limit-average', '20');
      await type('app-publish-option-rate_limit-burst', '40');
      await type('app-publish-option-response_headers', 'X-Forwarded-For: 1.2.3.4');
      expect(within(details).getByRole('alert')).toHaveTextContent(
        'Die Kopfzeile X-Forwarded-For setzt der Proxy selbst',
      );
      await save('App anlegen');
      expect(sent(calls, 'POST')).toEqual([]);
    });
  });

  describe('checks before sending', () => {
    it('asks for the internal address and a name that can be part of an address', async () => {
      const { calls } = await newApp();
      await publish();
      await type('app-publish-name', '');
      await save('App anlegen');
      expect(screen.getByTestId('app-publish-target')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByTestId('app-publish-name')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getAllByText('Dieses Feld wird gebraucht.')).toHaveLength(2);
      await type('app-publish-target', 'http://10.20.0.7:8080/wiki');
      await type('app-publish-name', 'Mein Wiki');
      await save('App anlegen');
      expect(screen.getByText(de('proxy.target.path'))).toBeInTheDocument();
      expect(screen.getByText(de('proxy.name.invalid'))).toBeInTheDocument();
      await type('app-publish-target', '10.20.0.7:8080');
      await type('app-publish-name', 'api');
      await save('App anlegen');
      expect(screen.getByText(de('proxy.target.invalid'))).toBeInTheDocument();
      expect(screen.getByText(de('proxy.name.reserved'))).toBeInTheDocument();
      expect(sent(calls, 'POST')).toEqual([]);
    });

    it('does not ask a published app for an address of its own', async () => {
      const { calls, onSaved } = await newApp();
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      await save('App anlegen');
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'POST')[0]).toMatchObject({ url: null });
    });
  });

  describe('for an app that is published', () => {
    it('shows the publication as it is stored', async () => {
      await editApp(
        publishedApp({
          mode: 'subdomain',
          access: 'public',
          template: 'builtin:embeddable',
          options: { pass_host_header: false },
          public_url: 'https://wiki.apps.example.com/',
        }),
      );
      expect(screen.getByTestId('app-publish-toggle')).toHaveAttribute('aria-checked', 'true');
      expect(screen.queryByLabelText('Adresse (URL)')).toBeNull();
      expect(screen.getByTestId('app-publish-target')).toHaveValue('http://10.20.0.7:8080');
      expect(screen.getByTestId('app-publish-mode')).toHaveAttribute('data-value', 'subdomain');
      expect(screen.getByTestId('app-publish-name')).toHaveValue('wiki');
      expect(screen.getByTestId('app-publish-access')).toHaveAttribute('data-value', 'public');
      expect(screen.getByTestId('app-publish-template')).toHaveValue('builtin:embeddable');
      expect(screen.getByTestId('app-publish-preview')).toHaveTextContent(
        'https://wiki.apps.example.com/',
      );
      // Something deviates from the template: the settings are open, and say what.
      expect(screen.getByTestId('app-publish-options')).toHaveAttribute('open');
      expect(screen.getByTestId('app-publish-option-pass_host_header')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(screen.getByTestId('app-publish-options')).toHaveTextContent(
        '1 abweichend von der Vorlage',
      );
    });

    it('shows a stored limit and stored headers in their fields', async () => {
      await editApp(
        publishedApp({
          options: {
            rate_limit: { average: 30, burst: 90 },
            response_headers: { 'X-Robots-Tag': 'noindex' },
          },
        }),
      );
      await waitFor(() =>
        expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('30'),
      );
      expect(screen.getByTestId('app-publish-option-rate_limit-burst')).toHaveValue('90');
      expect(screen.getByTestId('app-publish-option-response_headers')).toHaveValue(
        'X-Robots-Tag: noindex',
      );
      expect(screen.getByTestId('app-publish-option-request_headers')).toHaveValue('');
    });

    it('holds the place of the stored template until the installation has said what it offers', async () => {
      let answer: (info: ProxyInfo) => void = () => {};
      stubApi({
        'GET /api/v1/admin/proxy': () => new Promise<ProxyInfo>((resolve) => (answer = resolve)),
      });
      render(AppModal, {
        ...base,
        app: publishedApp({ template: 'builtin:embeddable' }),
        onSaved: () => {},
      });
      const select = await screen.findByTestId('app-publish-template');
      expect(select).toHaveValue('builtin:embeddable');
      // Not known yet is not the same as gone.
      expect(
        within(select).queryByRole('option', { name: 'Vorlage nicht mehr vorhanden' }),
      ).toBeNull();
      expect(
        screen.queryByText(/Die Vorlage dieser Veröffentlichung gibt es nicht mehr/),
      ).toBeNull();
      // What is stored is shown at once: the address needs no answer.
      expect(screen.getByTestId('app-publish-preview')).toHaveTextContent(
        'https://apps.example.com/wiki/',
      );
      answer(info());
      await waitFor(() =>
        expect(within(select).getByRole('option', { name: 'In Velydock einbettbar' })).toHaveValue(
          'builtin:embeddable',
        ),
      );
      expect(select).toHaveValue('builtin:embeddable');
      expect(
        within(select).queryByRole('option', { name: 'Vorlage nicht mehr vorhanden' }),
      ).toBeNull();
    });

    it('shows what its template limits to, once the installation has said what the template gives', async () => {
      // Nothing set at the app itself: the limit is the template's, which arrives later.
      await editApp(publishedApp({ template: 't-office' }));
      await fireEvent.click(screen.getByTestId('app-publish-options').querySelector('summary')!);
      expect(screen.getByTestId('app-publish-option-rate_limit')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await waitFor(() =>
        expect(screen.getByTestId('app-publish-option-rate_limit-average')).toHaveValue('50'),
      );
      expect(screen.getByTestId('app-publish-option-rate_limit-burst')).toHaveValue('100');
    });

    it('sends nothing when nothing was changed', async () => {
      const { calls, onClose } = await editApp(publishedApp({ options: { strip_prefix: false } }));
      await save();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([]);
    });

    it('leaves the publication alone when something else was changed, and never sends the address', async () => {
      const { calls, onSaved } = await editApp(publishedApp());
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Handbuch' } });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([{ name: 'Handbuch' }]);
      // The name in the address is a stored one: it does not follow the app's name.
      expect(screen.getByTestId('app-publish-name')).toHaveValue('wiki');
    });

    it('does not take a stored setting that has no effect here for a change', async () => {
      // Stored for an https:// target once; the target is http:// now, where it does nothing.
      const { calls, onSaved } = await editApp(
        publishedApp({ options: { verify_upstream_tls: false } }),
      );
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Handbuch' } });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([{ name: 'Handbuch' }]);
    });

    it('sends the whole publication when something about it was changed', async () => {
      const { calls, onSaved } = await editApp(publishedApp({ options: { strip_prefix: false } }));
      await choose('app-publish-access', 'public');
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([
        {
          publication: {
            name: 'wiki',
            mode: 'path',
            target_url: 'http://10.20.0.7:8080',
            access: 'public',
            template: 'builtin:standard',
            options: { strip_prefix: false },
          },
        },
      ]);
    });

    it('counts a changed setting as a change of the publication', async () => {
      const { calls, onSaved } = await editApp(publishedApp());
      await fireEvent.click(screen.getByTestId('app-publish-option-allow_embedding'));
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toMatchObject([
        { publication: { options: { allow_embedding: true } } },
      ]);
    });

    it('publishes an app that was not published, without sending its old address', async () => {
      const { calls, onSaved } = await editApp(storedApp());
      await publish();
      expect(screen.getByTestId('app-publish-name')).toHaveValue('wiki');
      await type('app-publish-target', 'http://nas.intern');
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([
        {
          publication: {
            name: 'wiki',
            mode: 'path',
            target_url: 'http://nas.intern',
            access: 'protected',
            template: 'builtin:standard',
            options: {},
          },
        },
      ]);
    });

    it('keeps a template that no longer exists selected, and says so', async () => {
      const { calls, onSaved } = await editApp(
        publishedApp({ template: 't-gone', problem: 'template_missing' }),
      );
      const select = screen.getByTestId('app-publish-template');
      expect(select).toHaveValue('t-gone');
      expect(
        within(select).getByRole('option', { name: 'Vorlage nicht mehr vorhanden' }),
      ).toHaveValue('t-gone');
      expect(select.closest('.group')).toHaveTextContent(
        'Die Vorlage dieser Veröffentlichung gibt es nicht mehr. Wähl eine andere.',
      );
      // Something else can still be saved without touching the publication.
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Handbuch' } });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([{ name: 'Handbuch' }]);
    });

    it('says that a stored path address is switched off, and offers the sub-domain only', async () => {
      await editApp(publishedApp({ problem: 'mode_not_allowed' }), info({ path_allowed: false }));
      const mode = screen.getByTestId('app-publish-mode');
      expect([...mode.querySelectorAll('input')].map((input) => input.value)).toEqual([
        'subdomain',
      ]);
      expect(screen.getByTestId('app-publish-mode-refused')).toHaveTextContent(
        'Pfad-Adressen sind für deine Organisation aber abgeschaltet',
      );
      await choose('app-publish-mode', 'subdomain');
      expect(screen.queryByTestId('app-publish-mode-refused')).toBeNull();
      expect(screen.getByTestId('app-publish-preview')).toHaveTextContent(
        'https://wiki.apps.example.com/',
      );
    });

    it('tells an organization administrator about middlewares of a system administrator, without a field for them', async () => {
      const custom = {
        '20-limit': { inFlightReq: { amount: 5 } },
        '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } },
      };
      await editApp(publishedApp({ options: { custom_middlewares: custom } }));
      const notice = screen.getByTestId('app-publish-custom');
      expect(notice).toHaveTextContent(
        'hat ein Systemadministrator eigene Traefik-Middlewares hinterlegt (10-buero, 20-limit)',
      );
      expect(notice).toHaveTextContent('Sie bleiben bei allem erhalten, was du hier änderst');
      expect(screen.queryByTestId('app-publish-middlewares')).toBeNull();
      expect(optionIds()).not.toContain('custom_middlewares');
      // They are no deviation of the organization's: nothing to open the settings for.
      expect(screen.getByTestId('app-publish-options')).not.toHaveAttribute('open');
      expect(screen.getByTestId('app-publish-options')).not.toHaveTextContent('abweichend');
    });

    it('never sends those middlewares for an organization administrator: the server keeps them', async () => {
      const custom = { '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } } };
      const { calls, onSaved } = await editApp(
        publishedApp({ options: { custom_middlewares: custom, allow_embedding: true } }),
      );
      await choose('app-publish-access', 'public');
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([
        {
          publication: {
            name: 'wiki',
            mode: 'path',
            target_url: 'http://10.20.0.7:8080',
            access: 'public',
            template: 'builtin:standard',
            options: { allow_embedding: true },
          },
        },
      ]);
    });

    it('does not take those middlewares for a change of the publication either', async () => {
      const { calls, onSaved } = await editApp(
        publishedApp({ options: { custom_middlewares: { a: { compress: {} } } } }),
      );
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Handbuch' } });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([{ name: 'Handbuch' }]);
    });

    it('shows no such notice where there are none', async () => {
      await editApp(publishedApp({ options: { allow_embedding: true } }));
      expect(screen.queryByTestId('app-publish-custom')).toBeNull();
    });

    it('is still shown where publishing is no longer set up, and can be ended there', async () => {
      const app = storedApp({
        url: '',
        publication: publication({ public_url: '', problem: 'proxy_disabled' }),
      });
      const api = stubApi({ 'GET /api/v1/admin/proxy': () => ({ enabled: false }) });
      render(AppModal, { ...base, app, onSaved: () => {} });
      expect(await screen.findByTestId('app-publish-unavailable')).toHaveTextContent(
        'Veröffentlichen ist auf dieser Installation nicht eingerichtet',
      );
      expect(screen.getByTestId('app-publish-toggle')).toHaveAttribute('aria-checked', 'true');
      await publish();
      expect(screen.getByLabelText('Adresse (URL)')).toBeInTheDocument();
      expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });
  });

  describe('for a system administrator', () => {
    const office = { '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } } };
    const asRoot = { ...base, systemAdmin: true };
    const field = () => screen.getByTestId('app-publish-middlewares') as HTMLTextAreaElement;
    const fieldBlock = () => field().closest('.ui-field') as HTMLElement;

    async function newPublished(routes: Parameters<typeof stubApi>[0] = {}) {
      const onSaved = vi.fn();
      const api = stubApi({
        'GET /api/v1/admin/proxy': () => info(),
        'POST /api/v1/admin/apps': ({ body }) => ({ ...storedApp(), ...(body as object) }),
        ...routes,
      });
      render(AppModal, { ...asRoot, app: null, onSaved });
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Wiki' } });
      await fireEvent.click(await screen.findByTestId('app-publish-toggle'));
      await type('app-publish-target', 'http://10.20.0.7:8080');
      return { ...api, onSaved };
    }

    async function editPublished(
      options: Record<string, unknown>,
      routes: Parameters<typeof stubApi>[0] = {},
    ) {
      const app = publishedApp({ options });
      const onSaved = vi.fn();
      const onClose = vi.fn();
      const api = stubApi({
        'GET /api/v1/admin/proxy': () => info(),
        [`PATCH /api/v1/admin/apps/${app.id}`]: ({ body }) => ({ ...app, ...(body as object) }),
        ...routes,
      });
      render(AppModal, { ...asRoot, app, onSaved, onClose });
      await screen.findByTestId('app-publish-toggle');
      await waitFor(() =>
        expect(
          [...screen.getByTestId('app-publish-template').querySelectorAll('option')].map(
            (option) => option.textContent,
          ),
        ).not.toContain('…'),
      );
      return { ...api, onSaved, onClose };
    }

    it('offers "Eigene Traefik-Middlewares" among the settings, and says how they join the template\'s', async () => {
      await newPublished();
      const details = screen.getByTestId('app-publish-options');
      expect(details).toContainElement(field());
      expect(field()).toHaveAccessibleName('Eigene Traefik-Middlewares');
      expect(field()).toHaveValue('');
      expect(fieldBlock()).toHaveTextContent('Nur für Systemadministratoren.');
      expect(fieldBlock()).toHaveTextContent(
        'Sie kommen zu denen der Vorlage hinzu – bei gleichem Namen gilt die der App',
      );
      expect(fieldBlock()).toHaveTextContent(
        'Die Organisation kann sie weder ändern noch entfernen.',
      );
    });

    it('is not offered to anybody else', async () => {
      await newApp();
      await publish();
      expect(screen.queryByTestId('app-publish-middlewares')).toBeNull();
      expect(screen.getByTestId('app-publish-options')).not.toHaveTextContent('Middleware');
    });

    it('sends the middlewares of a new publication as the JSON says', async () => {
      const { calls, onSaved } = await newPublished();
      await type('app-publish-middlewares', JSON.stringify(office));
      await save('App anlegen');
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect((sent(calls, 'POST')[0] as { publication: Publication }).publication.options).toEqual({
        custom_middlewares: office,
      });
    });

    it('sends no such key for a publication without middlewares', async () => {
      const { calls, onSaved } = await newPublished();
      await type('app-publish-middlewares', '  ');
      await save('App anlegen');
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect((sent(calls, 'POST')[0] as { publication: Publication }).publication.options).toEqual(
        {},
      );
    });

    it('shows what is stored in the field, with the settings open, and no notice about it', async () => {
      await editPublished({ custom_middlewares: office });
      expect(JSON.parse(field().value)).toEqual(office);
      expect(screen.getByTestId('app-publish-options')).toHaveAttribute('open');
      expect(screen.queryByTestId('app-publish-custom')).toBeNull();
    });

    it('sends nothing when nothing was changed', async () => {
      const { calls, onClose } = await editPublished({ custom_middlewares: office });
      await save();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([]);
    });

    it('sends the middlewares along when something else about the publication changes: left out, the server would take them away', async () => {
      const { calls, onSaved } = await editPublished({ custom_middlewares: office });
      await choose('app-publish-access', 'public');
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toMatchObject([
        { publication: { access: 'public', options: { custom_middlewares: office } } },
      ]);
    });

    it('counts changed middlewares as a change of the publication', async () => {
      const { calls, onSaved } = await editPublished({ custom_middlewares: office });
      const changed = { '10-buero': { ipAllowList: { sourceRange: ['198.51.100.0/24'] } } };
      await type('app-publish-middlewares', JSON.stringify(changed));
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toMatchObject([
        { publication: { access: 'protected', options: { custom_middlewares: changed } } },
      ]);
    });

    it('does not take the same middlewares written differently for a change', async () => {
      const { calls, onClose } = await editPublished({ custom_middlewares: office });
      await type(
        'app-publish-middlewares',
        '{"10-buero":{"ipAllowList":{"sourceRange":["203.0.113.0/24"]}}}',
      );
      await save();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([]);
    });

    it('takes them away by emptying the field: the publication goes without the key', async () => {
      const { calls, onSaved } = await editPublished({
        custom_middlewares: office,
        allow_embedding: true,
      });
      await type('app-publish-middlewares', '');
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect((sent(calls, 'PATCH')[0] as { publication: Publication }).publication.options).toEqual(
        { allow_embedding: true },
      );
    });

    it('leaves the publication alone when only something else about the app changes', async () => {
      const { calls, onSaved } = await editPublished({ custom_middlewares: office });
      await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Handbuch' } });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([{ name: 'Handbuch' }]);
    });

    it('checks the JSON before sending, opens the settings and says at the field what is wrong', async () => {
      const { calls } = await newPublished();
      const details = screen.getByTestId('app-publish-options') as HTMLDetailsElement;
      await type('app-publish-middlewares', '{ "10-buero": { "ipAllowList": } }');
      // Not at every key while it is written.
      expect(field()).not.toHaveAttribute('aria-invalid');
      expect(details.open).toBe(false);
      await save('App anlegen');
      await waitFor(() => expect(details.open).toBe(true));
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(fieldBlock()).toHaveTextContent('Das ist kein gültiges JSON:');
      await waitFor(() => expect(field()).toHaveFocus());
      await type('app-publish-middlewares', '{"Büro": {"compress": {}}}');
      await save('App anlegen');
      expect(fieldBlock()).toHaveTextContent('„Büro“ kann kein Name einer Middleware sein');
      await type('app-publish-middlewares', '{"10-buero": {"compress": {}, "headers": {}}}');
      await save('App anlegen');
      expect(fieldBlock()).toHaveTextContent('Unter „10-buero“ steht nicht genau eine Middleware.');
      expect(sent(calls, 'POST')).toEqual([]);
    });

    it('shows what the server says about middlewares it does not accept, under the field', async () => {
      const message =
        "10-buero: the middleware 'forwardAuth' is not available. Allowed: addPrefix, basicAuth.";
      await newPublished({
        'POST /api/v1/admin/apps': () => refusal(422, 'proxy_options_invalid', message),
      });
      await type('app-publish-middlewares', '{"10-buero": {"forwardAuth": {}}}');
      await save('App anlegen');
      expect(await screen.findByTestId('app-publish-middlewares-refused')).toHaveTextContent(
        message,
      );
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(fieldBlock()).toHaveTextContent('Diese Middlewares nimmt der Server nicht an.');
      expect(screen.getByTestId('app-publish-options')).toHaveAttribute('open');
      // At the field, and nowhere else.
      expect(
        within(screen.getByTestId('app-publish-options')).queryByText(
          'Eine der Einstellungen wurde nicht angenommen.',
        ),
      ).toBeNull();
      expect(document.querySelector('.modal-error')).toBeNull();
      expect(get(toasts)).toEqual([]);
      // Corrected, the message was about what stood there before.
      await type('app-publish-middlewares', '{"10-buero": {"compress": {}}}');
      expect(screen.queryByTestId('app-publish-middlewares-refused')).toBeNull();
      expect(field()).not.toHaveAttribute('aria-invalid');
    });

    it('shows a refused setting at the settings when no middlewares were sent', async () => {
      await newPublished({
        'POST /api/v1/admin/apps': () =>
          refusal(422, 'proxy_options_invalid', 'The option strip_prefix is either true or false.'),
      });
      await save('App anlegen');
      const details = screen.getByTestId('app-publish-options');
      await waitFor(() =>
        expect(within(details).getByRole('alert')).toHaveTextContent(
          'Eine der Einstellungen wurde nicht angenommen.',
        ),
      );
      expect(within(details).getByRole('alert')).toHaveTextContent(
        'The option strip_prefix is either true or false.',
      );
      expect(field()).not.toHaveAttribute('aria-invalid');
      expect(screen.queryByTestId('app-publish-middlewares-refused')).toBeNull();
    });

    it('says at the field when the account is no system administrator after all', async () => {
      await newPublished({ 'POST /api/v1/admin/apps': () => errorResponse(403, 'forbidden') });
      await type('app-publish-middlewares', JSON.stringify(office));
      await save('App anlegen');
      await waitFor(() => expect(field()).toHaveAttribute('aria-invalid', 'true'));
      expect(fieldBlock()).toHaveTextContent(
        'Eigene Traefik-Middlewares kann nur ein Systemadministrator setzen oder ändern.',
      );
      expect(document.querySelector('.modal-error')).toBeNull();
    });

    it('leaves a 403 that is about something else to the dialog', async () => {
      await newPublished({ 'POST /api/v1/admin/apps': () => errorResponse(403, 'forbidden') });
      await save('App anlegen');
      await waitFor(() => expect(document.querySelector('.modal-error')).not.toBeNull());
      expect(field()).not.toHaveAttribute('aria-invalid');
    });
  });

  describe('ending a publication', () => {
    it('brings the address field back, empty and required', async () => {
      const { calls } = await editApp(publishedApp());
      await publish();
      expect(screen.queryByTestId('app-publish-target')).toBeNull();
      const address = screen.getByLabelText('Adresse (URL)');
      expect(address).toHaveValue('');
      expect(address).toBeRequired();
      expect(screen.getByTestId('app-publish-ended')).toHaveTextContent(
        'braucht die App wieder eine eigene Adresse',
      );
      await save();
      expect(address).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(de('error.url_required'))).toBeInTheDocument();
      expect(sent(calls, 'PATCH')).toEqual([]);
    });

    it('sends the end of the publication together with the new address', async () => {
      const { calls, onSaved } = await editApp(publishedApp());
      await publish();
      await fireEvent.input(screen.getByLabelText('Adresse (URL)'), {
        target: { value: 'https://wiki.example/' },
      });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([{ publication: null, url: 'https://wiki.example/' }]);
    });

    it('sends the address along even when it is the one the app had while published', async () => {
      const { calls, onSaved } = await editApp(publishedApp());
      await publish();
      await fireEvent.input(screen.getByLabelText('Adresse (URL)'), {
        target: { value: 'https://apps.example.com/wiki/' },
      });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toEqual([
        { publication: null, url: 'https://apps.example.com/wiki/' },
      ]);
    });

    it('ends it as well when the app becomes one with its own code', async () => {
      const { calls, onSaved } = await editApp(publishedApp());
      await choose('app-type', 'custom');
      expect(screen.queryByTestId('app-publish-toggle')).toBeNull();
      await fireEvent.input(screen.getByLabelText('HTML'), { target: { value: '<p>Hallo</p>' } });
      await save();
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(sent(calls, 'PATCH')).toMatchObject([
        { type: 'custom', publication: null, url: null, custom_html: '<p>Hallo</p>' },
      ]);
    });

    it('says nothing about an end for an app that was never published', async () => {
      await newApp();
      await publish();
      await publish();
      expect(screen.queryByTestId('app-publish-ended')).toBeNull();
    });
  });

  describe('when the server refuses', () => {
    async function refused(response: Response) {
      const api = await newApp(info(), { 'POST /api/v1/admin/apps': () => response.clone() });
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      await save('App anlegen');
      await waitFor(() => expect(sent(api.calls, 'POST')).toHaveLength(1));
      await waitFor(() =>
        expect(document.querySelector('form [role="alert"], .msg.error')).not.toBeNull(),
      );
      return api;
    }
    // Nothing of it is a toast, and nothing the general failure line of the dialog.
    const nowhereElse = () => {
      expect(get(toasts)).toEqual([]);
      expect(document.querySelector('.modal-error')).toBeNull();
    };
    const fieldOf = (testid: string) =>
      screen.getByTestId(testid).closest('.ui-field') as HTMLElement;

    it('an internal address that is not released, at the internal address', async () => {
      await refused(refusal(422, 'proxy_target_not_allowed'));
      expect(screen.getByTestId('app-publish-target')).toHaveAttribute('aria-invalid', 'true');
      expect(fieldOf('app-publish-target')).toHaveTextContent(
        'Diese interne Adresse ist für deine Organisation nicht freigegeben. Freigeben kann sie der Systemadministrator.',
      );
      await waitFor(() => expect(screen.getByTestId('app-publish-target')).toHaveFocus());
      expect(screen.getByTestId('app-publish-name')).not.toHaveAttribute('aria-invalid');
      nowhereElse();
    });

    it('an internal address the server cannot use, at the internal address', async () => {
      await refused(refusal(422, 'proxy_target_invalid'));
      expect(screen.getByTestId('app-publish-target')).toHaveAttribute('aria-invalid', 'true');
      expect(fieldOf('app-publish-target')).toHaveTextContent(de('proxy.target.invalid'));
      nowhereElse();
    });

    it('a name that is taken or refused, at the name', async () => {
      await refused(refusal(409, 'publication_name_taken'));
      expect(screen.getByTestId('app-publish-name')).toHaveAttribute('aria-invalid', 'true');
      expect(fieldOf('app-publish-name')).toHaveTextContent(
        'Dieser Name ist schon vergeben – Namen sind über alle Organisationen eindeutig.',
      );
      expect(screen.getByTestId('app-publish-target')).not.toHaveAttribute('aria-invalid');
      nowhereElse();
      cleanup();
      await refused(refusal(422, 'publication_name_invalid'));
      expect(screen.getByTestId('app-publish-name')).toHaveAttribute('aria-invalid', 'true');
      expect(fieldOf('app-publish-name')).toHaveTextContent(de('proxy.name.invalid'));
      nowhereElse();
    });

    it('a kind of address that is not allowed, at the address', async () => {
      const revealed = recordReveals();
      await refused(refusal(422, 'publication_mode_not_allowed'));
      const group = screen.getByTestId('app-publish-mode').closest('fieldset') as HTMLElement;
      expect(within(group).getByRole('alert')).toHaveTextContent(
        'Deine Organisation veröffentlicht Apps nur unter einer Subdomain.',
      );
      // The message stands next to the control that gets the focus: it is brought into view.
      await waitFor(() => expect(revealed.at(-1)).toBe(within(group).getByRole('alert')));
      await waitFor(() =>
        expect(screen.getByTestId('app-publish-mode').contains(document.activeElement)).toBe(true),
      );
      nowhereElse();
      // Choosing another kind of address takes the message back.
      await choose('app-publish-mode', 'subdomain');
      expect(within(group).queryByRole('alert')).toBeNull();
    });

    it('a template that is not known, at the template', async () => {
      await refused(refusal(422, 'proxy_template_unknown'));
      expect(screen.getByTestId('app-publish-template')).toHaveAttribute('aria-invalid', 'true');
      expect(fieldOf('app-publish-template')).toHaveTextContent(
        'Diese Vorlage gibt es nicht (mehr). Wähl eine andere.',
      );
      nowhereElse();
    });

    it('a setting, at the settings, with what the server says about it underneath', async () => {
      await refused(
        refusal(
          422,
          'proxy_options_invalid',
          'A public app has nobody signed in whom the headers could name.',
        ),
      );
      const details = screen.getByTestId('app-publish-options');
      expect(details).toHaveAttribute('open');
      const alert = within(details).getByRole('alert');
      expect(alert).toHaveTextContent('Eine der Einstellungen wurde nicht angenommen.');
      expect(alert.querySelector('.tech')).toHaveTextContent(
        'A public app has nobody signed in whom the headers could name.',
      );
      await waitFor(() => expect(details.querySelector('summary')).toHaveFocus());
      nowhereElse();
    });

    it('that publishing is not possible at all, at the switch', async () => {
      await refused(refusal(409, 'proxy_disabled'));
      const option = screen.getByTestId('app-publish-toggle').closest('.option') as HTMLElement;
      expect(within(option).getByRole('alert')).toHaveTextContent(
        'Veröffentlichen über den Proxy ist auf dieser Installation nicht eingerichtet.',
      );
      await waitFor(() => expect(screen.getByTestId('app-publish-toggle')).toHaveFocus());
      nowhereElse();
      cleanup();
      await refused(refusal(422, 'publication_type'));
      expect(
        within(
          screen.getByTestId('app-publish-toggle').closest('.option') as HTMLElement,
        ).getByRole('alert'),
      ).toHaveTextContent(
        'Veröffentlichen lassen sich nur eingebettete Apps und Apps im neuen Tab.',
      );
      nowhereElse();
    });

    it('a value its schema does not take, at the field it names', async () => {
      await refused(
        errorResponse(422, 'validation', {
          fields: [
            { field: 'publication.name', message: 'String should have at least 2 characters' },
          ],
        }),
      );
      expect(screen.getByTestId('app-publish-name')).toHaveAttribute('aria-invalid', 'true');
      expect(fieldOf('app-publish-name')).toHaveTextContent(de('proxy.name.invalid'));
      nowhereElse();
    });

    it('the missing address of an app whose publication ends, at the address', async () => {
      const app = publishedApp();
      await editApp(app, info(), {
        [`PATCH /api/v1/admin/apps/${app.id}`]: () => refusal(422, 'url_required'),
      });
      await publish();
      await fireEvent.input(screen.getByLabelText('Adresse (URL)'), {
        target: { value: 'https://wiki.example/' },
      });
      await save();
      await waitFor(() =>
        expect(screen.getByLabelText('Adresse (URL)')).toHaveAttribute('aria-invalid', 'true'),
      );
      nowhereElse();
    });

    it('anything else as the failure of the dialog, as before', async () => {
      await newApp(info(), { 'POST /api/v1/admin/apps': () => errorResponse(500, 'internal') });
      await publish();
      await type('app-publish-target', 'http://10.20.0.7:8080');
      await save('App anlegen');
      await waitFor(() => expect(document.querySelector('.modal-error')).not.toBeNull());
      expect(screen.getByTestId('app-publish-target')).not.toHaveAttribute('aria-invalid');
    });
  });
});

describe('TenantProxyModal', () => {
  const tenant: Tenant = {
    ...ACME,
    active: true,
    protected: false,
    proxy_path_allowed: true,
    default_nav_position: null,
    nav_position_locked: false,
    member_count: 3,
    app_count: 1,
    created_at: '',
  };
  const TARGETS = `/api/v1/system/tenants/${ACME.id}/proxy-targets`;
  const released = [
    { id: 'r1', value: '10.20.0.0/16', note: 'Büronetz' },
    { id: 'r2', value: 'nas.intern', note: '' },
  ];

  function open(
    routes: Parameters<typeof stubApi>[0] = {},
    props: { tenant?: Tenant; enabled?: boolean | null } = {},
  ) {
    const onChanged = vi.fn();
    let list = [...released];
    const api = stubApi({
      [`GET ${TARGETS}`]: () => list,
      [`POST ${TARGETS}`]: ({ body }) => {
        const added = { id: `r${list.length + 1}`, ...(body as { value: string; note: string }) };
        list = [...list, added];
        return added;
      },
      [`DELETE ${TARGETS}/r1`]: () => {
        list = list.filter((entry) => entry.id !== 'r1');
        return new Response(null, { status: 204 });
      },
      [`PATCH /api/v1/system/tenants/${ACME.id}`]: ({ body }) => ({
        ...tenant,
        ...(body as object),
      }),
      ...routes,
    });
    render(ConfirmDialog);
    render(TenantProxyModal, {
      tenant: props.tenant ?? tenant,
      enabled: props.enabled === undefined ? true : props.enabled,
      onClose: () => {},
      onChanged,
    });
    return { ...api, onChanged };
  }
  const entries = () =>
    screen.queryAllByTestId('proxy-target').map((entry) => entry.getAttribute('data-value'));
  const changes = (calls: { method: string; body: unknown }[]) =>
    calls.filter((call) => call.method !== 'GET');

  it('lists what is released for the organization, with the notes', async () => {
    open();
    expect(
      await screen.findByRole('dialog', { name: 'Proxy-Freigaben für Acme GmbH' }),
    ).toBeVisible();
    await waitFor(() => expect(entries()).toEqual(['10.20.0.0/16', 'nas.intern']));
    expect(screen.getAllByTestId('proxy-target')[0]).toHaveTextContent('Büronetz');
    expect(screen.getAllByTestId('proxy-target-remove')).toHaveLength(2);
    expect(screen.getAllByTestId('proxy-target-remove')[1]).toHaveAccessibleName(
      'nas.intern nicht mehr freigeben',
    );
  });

  it('says when nothing is released yet', async () => {
    open({ [`GET ${TARGETS}`]: () => [] });
    expect(await screen.findByTestId('proxy-targets-empty')).toHaveTextContent(
      'Noch nichts freigegeben.',
    );
    expect(entries()).toEqual([]);
  });

  it('explains each form a release can have in one line', async () => {
    open();
    const lines = [...(await screen.findByRole('dialog')).querySelectorAll('.forms-list li')].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      '10.20.0.0/16 – ein Netz: jede Adresse darin',
      '10.20.0.7 – eine einzelne Adresse',
      '10.20.0.7:8080 – eine Adresse, und dort nur dieser Port',
      'nas.intern – ein Hostname: genau dieser Name, kein anderer',
    ]);
  });

  it('releases a value with its note, and shows it in the list', async () => {
    const { calls } = open();
    await waitFor(() => expect(entries()).toHaveLength(2));
    await type('proxy-target-value', ' 10.30.0.7:8080 ');
    await type('proxy-target-note', 'Zeiterfassung');
    await fireEvent.click(screen.getByTestId('proxy-target-add'));
    await waitFor(() =>
      expect(entries()).toEqual(['10.20.0.0/16', 'nas.intern', '10.30.0.7:8080']),
    );
    expect(changes(calls)).toMatchObject([
      { method: 'POST', body: { value: '10.30.0.7:8080', note: 'Zeiterfassung' } },
    ]);
    expect(get(toasts).map((toast) => toast.message)).toEqual([
      '10.30.0.7:8080 ist für Acme GmbH freigegeben.',
    ]);
    // Ready for the next one.
    expect(screen.getByTestId('proxy-target-value')).toHaveValue('');
    expect(screen.getByTestId('proxy-target-note')).toHaveValue('');
  });

  it('does not drop a value that was typed but not released when "Fertig" is pressed', async () => {
    const onClose = vi.fn();
    stubApi({ [`GET ${TARGETS}`]: () => released });
    render(TenantProxyModal, { tenant, enabled: true, onClose, onChanged: () => {} });
    await waitFor(() => expect(entries()).toHaveLength(2));
    await type('proxy-target-value', '10.30.0.7');
    await fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('proxy-target-value')).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByText(
        '10.30.0.7 ist noch nicht freigegeben. Gib es mit „Freigeben“ frei oder leer das Feld.',
      ),
    ).toHaveClass('error');
    // Emptied, there is nothing left to do.
    await type('proxy-target-value', '');
    await fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says at the field what can be released, before anything is sent', async () => {
    const { calls } = open();
    await waitFor(() => expect(entries()).toHaveLength(2));
    await fireEvent.click(screen.getByTestId('proxy-target-add'));
    expect(screen.getByTestId('proxy-target-value')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Dieses Feld wird gebraucht.')).toBeInTheDocument();
    await type('proxy-target-value', 'http://10.20.0.7');
    await fireEvent.click(screen.getByTestId('proxy-target-add'));
    expect(screen.getByTestId('proxy-target-value')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Gib ein Netz \(10\.20\.0\.0\/16\), eine Adresse/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('proxy-target-value')).toHaveFocus());
    expect(changes(calls)).toEqual([]);
  });

  it('says at the field what the server refuses: a release that exists, a name of the installation', async () => {
    let answer = refusal(409, 'proxy_target_exists');
    open({ [`POST ${TARGETS}`]: () => answer.clone() });
    await waitFor(() => expect(entries()).toHaveLength(2));
    await type('proxy-target-value', 'nas.intern');
    await fireEvent.click(screen.getByTestId('proxy-target-add'));
    expect(
      await screen.findByText('Diese Adresse ist für die Organisation schon freigegeben.'),
    ).toHaveClass('error');
    expect(screen.getByTestId('proxy-target-value')).toHaveAttribute('aria-invalid', 'true');
    expect(get(toasts)).toEqual([]);

    // The code for a name of the installation itself, whatever its message says.
    answer = refusal(422, 'proxy_target_reserved', 'reserved');
    await type('proxy-target-value', 'keycloak');
    await fireEvent.click(screen.getByTestId('proxy-target-add'));
    expect(
      await screen.findByText(
        'Dieser Name gehört zur Installation selbst und lässt sich nicht freigeben.',
      ),
    ).toHaveClass('error');
    expect(screen.getByTestId('proxy-target-value')).toHaveAttribute('aria-invalid', 'true');
    expect(get(toasts)).toEqual([]);
    // What was typed stays, to be corrected.
    expect(screen.getByTestId('proxy-target-value')).toHaveValue('keycloak');
  });

  it('says what a release looks like when the server does not take a form the check here let through', async () => {
    open({ [`POST ${TARGETS}`]: () => refusal(422, 'proxy_target_invalid') });
    await waitFor(() => expect(entries()).toHaveLength(2));
    await type('proxy-target-value', 'fd00::7/200');
    await fireEvent.click(screen.getByTestId('proxy-target-add'));
    expect(await screen.findByText(/Gib ein Netz \(10\.20\.0\.0\/16\), eine Adresse/)).toHaveClass(
      'error',
    );
    // That it is a name of the installation is said only when it is one.
    expect(screen.queryByText(/gehört zur Installation selbst/)).toBeNull();
    expect(get(toasts)).toEqual([]);
  });

  it('withdraws a release only after asking, and says what that means', async () => {
    const { calls } = open();
    await waitFor(() => expect(entries()).toHaveLength(2));
    await fireEvent.click(screen.getAllByTestId('proxy-target-remove')[0]);
    const question = await screen.findByRole('dialog', { name: 'Freigabe zurückziehen' });
    expect(question).toHaveTextContent('10.20.0.0/16 für Acme GmbH nicht mehr freigeben?');
    expect(question).toHaveTextContent('sind wenige Sekunden später nicht mehr erreichbar');
    await fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Freigabe zurückziehen' })).toBeNull(),
    );
    expect(changes(calls)).toEqual([]);
    expect(entries()).toHaveLength(2);

    screen.getAllByTestId('proxy-target-remove')[0].focus();
    await fireEvent.click(screen.getAllByTestId('proxy-target-remove')[0]);
    await fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Freigabe zurückziehen' })).getByRole(
        'button',
        { name: 'Freigabe zurückziehen' },
      ),
    );
    await waitFor(() => expect(entries()).toEqual(['nas.intern']));
    // The button that had the focus went with its entry: the one that took its place has it.
    await waitFor(() => expect(screen.getByTestId('proxy-target-remove')).toHaveFocus());
    expect(changes(calls)).toMatchObject([{ method: 'DELETE', url: `${TARGETS}/r1` }]);
    expect(get(toasts).map((toast) => toast.message)).toEqual([
      'Die Freigabe 10.20.0.0/16 ist zurückgezogen.',
    ]);
  });

  describe('and path addresses', () => {
    const toggle = () => screen.getByTestId('proxy-path-allowed');

    it('shows whether the organization may use them, with the reason for the choice', async () => {
      open();
      expect(await screen.findByTestId('proxy-path-allowed')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(toggle()).toHaveAccessibleName('Pfad-Adressen erlauben');
      expect(toggle().closest('.option')).toHaveTextContent(
        'Apps mit Pfad-Adresse teilen sich im Browser einen Ursprung – auch mit den Apps anderer Organisationen',
      );
      cleanup();
      open({}, { tenant: { ...tenant, proxy_path_allowed: false } });
      expect(await screen.findByTestId('proxy-path-allowed')).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });

    it('switches them off only after asking, because published apps stop working', async () => {
      const { calls, onChanged } = open();
      await fireEvent.click(await screen.findByTestId('proxy-path-allowed'));
      const question = await screen.findByRole('dialog', { name: 'Pfad-Adressen abschalten' });
      expect(question).toHaveTextContent('Pfad-Adressen für Acme GmbH abschalten?');
      expect(question).toHaveTextContent('bis sie auf eine Subdomain umgestellt werden');
      await fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
      await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
      expect(changes(calls)).toEqual([]);

      await fireEvent.click(toggle());
      await fireEvent.click(
        within(await screen.findByRole('dialog', { name: 'Pfad-Adressen abschalten' })).getByRole(
          'button',
          { name: 'Abschalten' },
        ),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(changes(calls)).toMatchObject([
        { method: 'PATCH', body: { proxy_path_allowed: false } },
      ]);
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
      expect(get(toasts).map((toast) => toast.message)).toEqual([
        'Pfad-Adressen sind für Acme GmbH abgeschaltet.',
      ]);
    });

    it('allows them at once', async () => {
      const { calls, onChanged } = open({}, { tenant: { ...tenant, proxy_path_allowed: false } });
      await fireEvent.click(await screen.findByTestId('proxy-path-allowed'));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('dialog', { name: 'Pfad-Adressen abschalten' })).toBeNull();
      expect(changes(calls)).toMatchObject([
        { method: 'PATCH', body: { proxy_path_allowed: true } },
      ]);
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
      expect(get(toasts).map((toast) => toast.message)).toEqual([
        'Pfad-Adressen sind für Acme GmbH erlaubt.',
      ]);
    });

    it('shows the old state again when the change could not be stored', async () => {
      const { onChanged } = open(
        { [`PATCH /api/v1/system/tenants/${ACME.id}`]: () => errorResponse(500, 'internal') },
        { tenant: { ...tenant, proxy_path_allowed: false } },
      );
      await fireEvent.click(await screen.findByTestId('proxy-path-allowed'));
      await waitFor(() => expect(get(toasts)).toHaveLength(1));
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  it('says that publishing is not set up, instead of offering what would have no effect', async () => {
    const { calls } = open({}, { enabled: false });
    expect(await screen.findByTestId('proxy-disabled')).toHaveTextContent(
      'Veröffentlichen ist nicht eingerichtet',
    );
    expect(screen.getByTestId('proxy-disabled')).toHaveTextContent('APPS_HOST');
    expect(screen.queryByTestId('proxy-target-value')).toBeNull();
    expect(screen.queryByTestId('proxy-path-allowed')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('offers the releases where it is not known whether publishing is set up', async () => {
    open({}, { enabled: null });
    await waitFor(() => expect(entries()).toHaveLength(2));
    expect(screen.queryByTestId('proxy-disabled')).toBeNull();
    expect(screen.getByTestId('proxy-path-allowed')).toBeInTheDocument();
  });
});

describe('ProxyTemplateModal', () => {
  const own = template(
    't-office',
    'Büro-Netz',
    {
      allow_embedding: true,
      custom_middlewares: { '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } } },
    },
    'Nur aus dem Büro erreichbar.',
  );

  function open(editing: ProxyTemplate | null = null, routes: Parameters<typeof stubApi>[0] = {}) {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const api = stubApi({
      'POST /api/v1/system/proxy-templates': ({ body }) => ({
        id: 't-new',
        builtin: false,
        ...(body as object),
      }),
      'PATCH /api/v1/system/proxy-templates/t-office': ({ body }) => ({
        ...own,
        ...(body as object),
      }),
      ...routes,
    });
    render(ProxyTemplateModal, {
      open: true,
      template: editing,
      defaults: DEFAULTS,
      onClose,
      onSaved,
    });
    return { ...api, onSaved, onClose };
  }
  const save = () => fireEvent.click(screen.getByTestId('proxy-template-save'));
  const customField = () =>
    screen.getByTestId('proxy-template-custom').closest('.ui-field') as HTMLElement;

  it('creates a template with what it sets differently from the default, and nothing else', async () => {
    const { calls, onSaved } = open();
    expect(screen.getByRole('dialog', { name: 'Vorlage anlegen' })).toBeVisible();
    await type('proxy-template-name', '  Geräte  im Keller ');
    await type('proxy-template-description', 'Für die Heizung');
    await fireEvent.click(screen.getByTestId('proxy-template-option-verify_upstream_tls'));
    await fireEvent.click(screen.getByTestId('proxy-template-option-pass_host_header'));
    await fireEvent.click(screen.getByTestId('proxy-template-option-pass_host_header'));
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.body)).toEqual([
      {
        name: 'Geräte im Keller',
        description: 'Für die Heizung',
        options: { verify_upstream_tls: false },
      },
    ]);
    expect(onSaved.mock.calls[0][1]).toBe(true);
  });

  it('offers every setting, says where one has an effect only, and what the default is', () => {
    open();
    const ids = [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="proxy-template-option-"]'),
    ].map((el) => el.dataset.testid!.replace('proxy-template-option-', ''));
    expect(ids).toEqual([
      'strip_prefix',
      'allow_embedding',
      'verify_upstream_tls',
      'identity_headers',
      'pass_host_header',
      'rate_limit',
      'request_headers',
      'response_headers',
    ]);
    const option = (key: string) =>
      screen.getByTestId(`proxy-template-option-${key}`).closest('.option') as HTMLElement;
    expect(option('strip_prefix')).toHaveTextContent('Wirkt nur bei Pfad-Adressen.');
    expect(option('verify_upstream_tls')).toHaveTextContent('Wirkt nur bei Zielen mit https://.');
    expect(option('identity_headers')).toHaveTextContent('Wirkt nur bei geschützten Apps.');
    expect(option('allow_embedding')).not.toHaveTextContent('Wirkt nur');
    expect(option('allow_embedding')).toHaveTextContent('Standard: aus');
    expect(option('strip_prefix')).toHaveTextContent('Standard: an');
  });

  it('asks for a name', async () => {
    const { calls } = open();
    await save();
    expect(screen.getByTestId('proxy-template-name')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toEqual([]);
  });

  it('sends own middlewares as the JSON says', async () => {
    const { calls, onSaved } = open();
    await type('proxy-template-name', 'Büro');
    await type(
      'proxy-template-custom',
      '{ "10-buero": { "ipAllowList": { "sourceRange": ["203.0.113.0/24"] } } }',
    );
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls[0].body).toEqual({
      name: 'Büro',
      description: '',
      options: {
        custom_middlewares: { '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } } },
      },
    });
  });

  it('says how own middlewares are applied', () => {
    open();
    expect(screen.getByTestId('proxy-template-custom')).toHaveAccessibleName(
      'Eigene Traefik-Middlewares',
    );
    expect(customField()).toHaveTextContent('je Name genau eine Middleware');
    expect(customField()).toHaveTextContent(
      'Sie wirken nach der Anmeldeprüfung und in der Reihenfolge ihrer Namen',
    );
  });

  it('checks the JSON in the browser: broken or not an object, nothing is sent', async () => {
    const { calls } = open();
    await type('proxy-template-name', 'Büro');
    await type('proxy-template-custom', '{ "10-buero": { "ipAllowList": } }');
    // Not while it is being typed, …
    expect(screen.getByTestId('proxy-template-custom')).not.toHaveAttribute('aria-invalid');
    // … but as soon as the field is left, …
    await fireEvent.focusOut(screen.getByTestId('proxy-template-custom'));
    expect(screen.getByTestId('proxy-template-custom')).toHaveAttribute('aria-invalid', 'true');
    expect(customField()).toHaveTextContent('Das ist kein gültiges JSON:');
    // … and in any case before sending.
    await save();
    expect(calls).toEqual([]);
    await type('proxy-template-custom', '["ipAllowList"]');
    await save();
    expect(customField()).toHaveTextContent('Erwartet wird ein Objekt aus Name und Middleware');
    // A name that cannot be one, and more than one middleware under a name.
    await type('proxy-template-custom', '{"Büro": {"compress": {}}}');
    await save();
    expect(customField()).toHaveTextContent('„Büro“ kann kein Name einer Middleware sein');
    await type('proxy-template-custom', '{"10-buero": {"compress": {}, "headers": {}}}');
    await save();
    expect(customField()).toHaveTextContent('Unter „10-buero“ steht nicht genau eine Middleware.');
    expect(calls).toEqual([]);
  });

  it('shows what the server says about middlewares it does not accept, under the field', async () => {
    const message =
      "10-buero.ipAllowList has no field 'sourceRanges'. Known: ipStrategy, sourceRange.";
    open(null, {
      'POST /api/v1/system/proxy-templates': () => refusal(422, 'proxy_options_invalid', message),
    });
    await type('proxy-template-name', 'Büro');
    await type('proxy-template-custom', '{"10-buero": {"ipAllowList": {"sourceRanges": []}}}');
    const revealed = recordReveals();
    await save();
    expect(await screen.findByTestId('proxy-template-refused')).toHaveTextContent(message);
    // The field comes into view together with what the server said, which stands under it.
    await waitFor(() =>
      expect(revealed.at(-1)).toContainElement(screen.getByTestId('proxy-template-refused')),
    );
    expect(revealed.at(-1)).toContainElement(screen.getByTestId('proxy-template-custom'));
    expect(screen.getByTestId('proxy-template-custom')).toHaveAttribute('aria-invalid', 'true');
    expect(customField()).toHaveTextContent('Diese Middlewares nimmt der Server nicht an.');
    expect(document.querySelector('.modal-error')).toBeNull();
    // Corrected, the message is about what stood there before.
    await type('proxy-template-custom', '{"10-buero": {"ipAllowList": {"sourceRange": []}}}');
    expect(screen.queryByTestId('proxy-template-refused')).toBeNull();
    expect(screen.getByTestId('proxy-template-custom')).not.toHaveAttribute('aria-invalid');
  });

  it('shows a refused setting at the settings when there are no middlewares to blame', async () => {
    open(null, {
      'POST /api/v1/system/proxy-templates': () =>
        refusal(422, 'proxy_options_invalid', 'The request headers are not valid.'),
    });
    await type('proxy-template-name', 'Büro');
    await save();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Eine der Einstellungen wurde nicht angenommen.');
    expect(alert).toHaveTextContent('The request headers are not valid.');
    expect(screen.getByTestId('proxy-template-custom')).not.toHaveAttribute('aria-invalid');
  });

  it('says at the name that it is taken', async () => {
    open(null, { 'POST /api/v1/system/proxy-templates': () => refusal(409, 'name_taken') });
    await type('proxy-template-name', 'Büro');
    await save();
    await waitFor(() =>
      expect(screen.getByTestId('proxy-template-name')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByText('Diesen Namen gibt es schon.')).toHaveClass('error');
  });

  it('shows a template as it is stored', () => {
    open(own);
    expect(screen.getByRole('dialog', { name: 'Vorlage Büro-Netz bearbeiten' })).toBeVisible();
    expect(screen.getByTestId('proxy-template-name')).toHaveValue('Büro-Netz');
    expect(screen.getByTestId('proxy-template-description')).toHaveValue(
      'Nur aus dem Büro erreichbar.',
    );
    expect(screen.getByTestId('proxy-template-option-allow_embedding')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      JSON.parse((screen.getByTestId('proxy-template-custom') as HTMLTextAreaElement).value),
    ).toEqual(own.options.custom_middlewares);
  });

  it('shows a stored limit and stored headers in their fields', async () => {
    const { calls, onClose } = open(
      template('t-office', 'Büro-Netz', {
        rate_limit: { average: 50, burst: 100 },
        request_headers: { 'X-Api-Key': 'abc', Authorization: 'Basic eA==' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('proxy-template-option-rate_limit-average')).toHaveValue('50'),
    );
    expect(screen.getByTestId('proxy-template-option-rate_limit-burst')).toHaveValue('100');
    expect(screen.getByTestId('proxy-template-option-request_headers')).toHaveValue(
      'X-Api-Key: abc\nAuthorization: Basic eA==',
    );
    // Shown as stored, it is no change.
    await save();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([]);
  });

  it('sends only what was changed, and nothing when nothing was', async () => {
    const { calls, onSaved, onClose } = open(own);
    await save();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([]);
    await type('proxy-template-description', 'Nur aus Büro und Lager.');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.body)).toEqual([{ description: 'Nur aus Büro und Lager.' }]);
  });

  it('does not take a stored value that is the default anyway for a change', async () => {
    const { calls, onSaved } = open(
      template('t-office', 'Büro-Netz', { strip_prefix: true, allow_embedding: true }),
    );
    await type('proxy-template-name', 'Büro');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.body)).toEqual([{ name: 'Büro' }]);
  });

  it('stores only what deviates from the default, also for a template that held more', async () => {
    const { calls, onSaved } = open(
      template('t-office', 'Büro-Netz', { strip_prefix: true, allow_embedding: true }),
    );
    await fireEvent.click(screen.getByTestId('proxy-template-option-pass_host_header'));
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.body)).toEqual([
      { options: { allow_embedding: true, pass_host_header: false } },
    ]);
  });

  it('says at the setting what cannot be saved, and sends nothing', async () => {
    const { calls } = open();
    await type('proxy-template-name', 'Büro');
    await fireEvent.click(screen.getByTestId('proxy-template-option-rate_limit'));
    await type('proxy-template-option-rate_limit-burst', '5');
    await save();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Mindestens so viele wie pro Sekunde und höchstens 100 000',
    );
    await waitFor(() =>
      expect(screen.getByTestId('proxy-template-option-rate_limit-burst')).toHaveFocus(),
    );
    expect(calls).toEqual([]);
  });

  it('sends the options as a whole when one of them was changed, the middlewares included', async () => {
    const { calls, onSaved } = open(own);
    await fireEvent.click(screen.getByTestId('proxy-template-option-allow_embedding'));
    await fireEvent.click(screen.getByTestId('proxy-template-option-strip_prefix'));
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.body)).toEqual([
      {
        options: {
          strip_prefix: false,
          custom_middlewares: own.options.custom_middlewares,
        },
      },
    ]);
    expect(onSaved.mock.calls[0][1]).toBe(false);
  });

  it('removes the middlewares when the field is emptied', async () => {
    const { calls, onSaved } = open(own);
    await type('proxy-template-custom', '');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.map((call) => call.body)).toEqual([{ options: { allow_embedding: true } }]);
  });
});
