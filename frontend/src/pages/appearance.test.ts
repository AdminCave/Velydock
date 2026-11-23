// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { ACCENT_PALETTE, accentTokens } from '$lib/accent';
import type { Me, TenantSettings } from '$lib/api/types';
import { setLanguage } from '$lib/i18n';
import { IMAGE_MAX_BYTES } from '$lib/imageFile';
import { me, setMe } from '$lib/stores/session';
import { clearToasts, toasts } from '$lib/stores/toasts';
import {
  OWN_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyAccent,
  setAccentColor,
  setThemePreference,
} from '$lib/theme';
import {
  ACME,
  OWN_SETTINGS,
  PERMISSIONS,
  SETTINGS,
  errorResponse,
  makeMe,
  stubApi,
} from '../test/fixtures';
import AdminTenantSettings from './admin/TenantSettings.svelte';
import Settings from './Settings.svelte';

// Appearance per organization and per user: what the two settings pages offer, what they
// send, and what they show when the organization has fixed something.

const ORANGE = '#c2410c';
const TEAL = '#0f766e';

const settingsOf = (settings: Partial<Me['settings']>, own: Partial<Me['own_settings']> = {}) =>
  makeMe({
    settings: { ...SETTINGS, ...settings },
    own_settings: { ...OWN_SETTINGS, ...own },
  });
const sent = (calls: { method: string; body: unknown }[]) =>
  calls.filter((call) => call.method === 'PATCH').map((call) => call.body);
const notices = () => get(toasts).map((toast) => `${toast.kind}: ${toast.message}`);

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
  setLanguage('de', { persist: false });
  setThemePreference('system', { persist: false });
  setAccentColor(null);
  applyAccent(null, 'dark');
});

describe('Personal settings: accent colour', () => {
  const picker = () => screen.getByTestId('setting-accent');
  const swatches = () => within(picker()).getAllByTestId('accent-swatch');
  const swatch = (color: string) =>
    swatches().find((button) => button.dataset.color === color) as HTMLElement;
  const own = () => within(picker()).getByTestId('accent-custom');
  /** The card of the accent colour: its hint is worded like those of dock and app bar. */
  const section = () => within(picker().closest('section') as HTMLElement);

  it('offers "Standard", a palette with names, and a colour of one’s own', () => {
    setMe(makeMe());
    render(Settings);
    expect(picker()).toHaveAttribute('role', 'group');
    expect(picker()).toHaveAccessibleName('Akzentfarbe');
    expect(picker().dataset.value).toBe('default');
    expect(swatches().map((button) => button.dataset.color)).toEqual(
      ACCENT_PALETTE.map((entry) => entry.color),
    );
    // Each swatch is a button with the name of its colour, not a bare coloured dot.
    expect(swatches().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Blau',
      'Petrol',
      'Türkis',
      'Grün',
      'Bernstein',
      'Orange',
      'Pink',
      'Violett',
    ]);
    expect(within(picker()).getByTestId('accent-default')).toHaveTextContent('Standard');
    expect(within(picker()).getByTestId('accent-default')).toHaveAttribute('aria-pressed', 'true');
    expect(own()).toHaveValue('');
    expect(within(picker()).getByTestId('accent-picker')).toHaveAttribute('type', 'color');
  });

  it('stores a swatch at once and shows it as the own choice', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () => settingsOf({ accent_color: TEAL }, { accent_color: TEAL }),
    });
    render(Settings);
    await fireEvent.click(swatch(TEAL));
    await waitFor(() => expect(sent(calls)).toEqual([{ accent_color: TEAL }]));
    expect(picker().dataset.value).toBe(TEAL);
    expect(swatch(TEAL)).toHaveAttribute('aria-pressed', 'true');
    expect(swatch(ORANGE)).toHaveAttribute('aria-pressed', 'false');
    expect(within(picker()).getByTestId('accent-default')).toHaveAttribute('aria-pressed', 'false');
    expect(own()).toHaveValue(TEAL);
    // Applied without waiting for the answer, and then as the server says.
    expect(get(me)?.settings.accent_color).toBe(TEAL);
  });

  it('sends nothing when the colour that is chosen already is chosen again', async () => {
    setMe(settingsOf({ accent_color: TEAL }, { accent_color: TEAL }));
    const { calls } = stubApi({});
    render(Settings);
    await fireEvent.click(swatch(TEAL));
    await fireEvent.input(own(), { target: { value: TEAL.toUpperCase() } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });

  it('takes a colour of one’s own as soon as it is one, in either case', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () =>
        settingsOf({ accent_color: ORANGE }, { accent_color: ORANGE }),
    });
    render(Settings);
    for (const partial of ['#', '#C2', '#C2410']) {
      await fireEvent.input(own(), { target: { value: partial } });
    }
    expect(sent(calls)).toEqual([]); // nothing that is no colour is sent
    expect(own()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Eine Farbe sieht so aus: #c2410c/)).toBeVisible();
    await fireEvent.input(own(), { target: { value: '#C2410C' } });
    await waitFor(() => expect(sent(calls)).toEqual([{ accent_color: ORANGE }]));
    expect(picker().dataset.value).toBe(ORANGE);
    expect(own()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(/Eine Farbe sieht so aus/)).toBeNull();
    // A colour that is not in the palette marks no swatch.
    await fireEvent.input(own(), { target: { value: '#123456' } });
    expect(swatches().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(
      true,
    );
  });

  it('takes the colour of the native picker when it is confirmed', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () => settingsOf({ accent_color: TEAL }, { accent_color: TEAL }),
    });
    render(Settings);
    const native = within(picker()).getByTestId('accent-picker');
    await fireEvent.input(native, { target: { value: '#0f766f' } }); // still choosing
    expect(sent(calls)).toEqual([]);
    await fireEvent.change(native, { target: { value: TEAL } });
    await waitFor(() => expect(sent(calls)).toEqual([{ accent_color: TEAL }]));
  });

  it('puts back what stood in the field when it is left with something that is no colour', async () => {
    setMe(settingsOf({ accent_color: TEAL }, { accent_color: TEAL }));
    render(Settings);
    await fireEvent.input(own(), { target: { value: 'grün' } });
    expect(own()).toHaveAttribute('aria-invalid', 'true');
    await fireEvent.blur(own());
    expect(own()).toHaveValue(TEAL);
    expect(own()).not.toHaveAttribute('aria-invalid');
  });

  it('resets to the default with null, and says which colour applies then', async () => {
    setMe(settingsOf({ accent_color: TEAL }, { accent_color: TEAL }));
    const { calls } = stubApi({
      // The organization has a default: that applies once the own choice is gone.
      'PATCH /api/v1/me/settings': () => settingsOf({ accent_color: ORANGE }),
    });
    render(Settings);
    expect(picker().dataset.value).toBe(TEAL);
    expect(section().queryByText(/„Standard“ folgt der Vorgabe deiner Organisation/)).toBeNull();
    await fireEvent.click(within(picker()).getByTestId('accent-default'));
    await waitFor(() => expect(sent(calls)).toEqual([{ accent_color: null }]));
    await waitFor(() => expect(get(me)?.settings.accent_color).toBe(ORANGE));
    expect(picker().dataset.value).toBe('default');
    expect(
      screen.getByText(`„Standard“ folgt der Vorgabe deiner Organisation. Derzeit: ${ORANGE}.`),
    ).toBeVisible();
  });

  it('says that the built-in blue applies when neither the user nor the organization chose', () => {
    setMe(makeMe());
    render(Settings);
    expect(screen.getByText(/Derzeit gibt es keine: Es gilt das eingebaute Blau\./)).toBeVisible();
  });

  it('snaps back when the server refuses the colour', async () => {
    setMe(makeMe());
    stubApi({ 'PATCH /api/v1/me/settings': () => errorResponse(503, 'unavailable') });
    render(Settings);
    await fireEvent.click(swatch(TEAL));
    await waitFor(() => expect(get(toasts)).toHaveLength(1));
    expect(picker().dataset.value).toBe('default');
    expect(get(me)?.settings.accent_color).toBeNull();
  });
});

describe('Personal settings: design', () => {
  const control = () => screen.getByTestId('setting-theme');
  const option = (name: string) => within(control()).getByRole('radio', { name });
  const hint = () =>
    within(control().closest('section') as HTMLElement).queryByText(/„Standard“ folgt/);

  it('offers "Standard" before System, Hell and Dunkel, whose values are what they were', () => {
    setMe(makeMe());
    render(Settings);
    expect(control()).toHaveAttribute('role', 'radiogroup');
    expect(
      within(control())
        .getAllByRole('radio')
        .map(
          (radio) =>
            `${(radio as HTMLInputElement).value}=${radio.closest('label')?.textContent?.trim()}`,
        ),
    ).toEqual(['default=Standard', 'system=System', 'light=Hell', 'dark=Dunkel']);
    // The browser tests choose a theme by the value of its input.
    for (const value of ['system', 'light', 'dark']) {
      expect(control().querySelector(`label:has(input[value="${value}"])`), value).not.toBeNull();
    }
  });

  it('shows "Standard" for somebody who chose nothing, and says which design that is now', () => {
    // No own choice; the organization (or the installation) uses the light design.
    setMe(settingsOf({ theme: 'light' }));
    render(Settings);
    expect(control().dataset.value).toBe('default');
    expect(option('Standard')).toBeChecked();
    expect(option('Hell')).not.toBeChecked(); // what applies is said, not marked as a choice
    expect(hint()).toHaveTextContent(
      '„Standard“ folgt der Vorgabe deiner Organisation. Derzeit: Hell.',
    );
  });

  it('shows the own choice, and no word about "Standard" then', () => {
    setMe(settingsOf({ theme: 'dark' }, { theme: 'dark' }));
    render(Settings);
    expect(control().dataset.value).toBe('dark');
    expect(option('Dunkel')).toBeChecked();
    expect(hint()).toBeNull();
  });

  it('stores a chosen design as before', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () => settingsOf({ theme: 'light' }, { theme: 'light' }),
    });
    render(Settings);
    await fireEvent.click(option('Hell'));
    await waitFor(() => expect(sent(calls)).toEqual([{ theme: 'light' }]));
    expect(control().dataset.value).toBe('light');
    expect(get(me)?.settings.theme).toBe('light');
    expect(hint()).toBeNull();
  });

  it('goes back to the default with null, and shows what the server says applies then', async () => {
    setMe(settingsOf({ theme: 'dark' }, { theme: 'dark' }));
    const { calls } = stubApi({
      // The own choice is gone: the design of the organization applies.
      'PATCH /api/v1/me/settings': () => settingsOf({ theme: 'light' }),
    });
    render(Settings);
    await fireEvent.click(option('Standard'));
    await waitFor(() => expect(sent(calls)).toEqual([{ theme: null }]));
    await waitFor(() => expect(get(me)?.settings.theme).toBe('light'));
    expect(control().dataset.value).toBe('default');
    expect(get(me)?.own_settings.theme).toBeNull();
    expect(hint()).toHaveTextContent('Derzeit: Hell.');
  });

  it('does not guess what applies after going back: the design stays until the server has answered', async () => {
    setMe(settingsOf({ theme: 'dark' }, { theme: 'dark' }));
    let release: (value: unknown) => void = () => {};
    stubApi({
      'PATCH /api/v1/me/settings': () => new Promise((resolve) => (release = resolve)),
    });
    render(Settings);
    await fireEvent.click(option('Standard'));
    expect(control().dataset.value).toBe('default');
    expect(get(me)?.settings.theme).toBe('dark'); // not "system", not anything made up
    release(settingsOf({ theme: 'system' }));
    await waitFor(() => expect(get(me)?.settings.theme).toBe('system'));
    expect(hint()).toHaveTextContent('Derzeit: System.');
  });

  it('snaps back to the own choice when the server refuses to forget it', async () => {
    setMe(settingsOf({ theme: 'dark' }, { theme: 'dark' }));
    stubApi({ 'PATCH /api/v1/me/settings': () => errorResponse(503, 'unavailable') });
    render(Settings);
    await fireEvent.click(option('Standard'));
    await waitFor(() => expect(get(toasts)).toHaveLength(1));
    expect(control().dataset.value).toBe('dark');
    expect(get(me)?.own_settings.theme).toBe('dark');
  });

  it('treats "Standard" as no own choice where nobody is signed in: the login page does not keep the old one', async () => {
    setMe(settingsOf({ theme: 'dark' }, { theme: 'dark' }));
    expect(localStorage.getItem(OWN_THEME_STORAGE_KEY)).toBe('dark');
    stubApi({ 'PATCH /api/v1/me/settings': () => settingsOf({ theme: 'light' }) });
    render(Settings);
    await fireEvent.click(option('Standard'));
    await waitFor(() => expect(get(me)?.settings.theme).toBe('light'));
    // What applies is remembered for the next page of the signed-in user …
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    // … but it is no choice of the user: the login page falls back to the installation.
    expect(localStorage.getItem(OWN_THEME_STORAGE_KEY)).toBeNull();
  });
});

describe('Personal settings: app bar', () => {
  const control = () => screen.getByTestId('setting-app-bar');
  const option = (name: string) => within(control()).getByRole('radio', { name });

  it('offers Standard, oben, unten and ausgeblendet, and says what "Standard" means now', () => {
    setMe(makeMe());
    render(Settings);
    expect(control()).toHaveAttribute('role', 'radiogroup');
    expect(control().dataset.value).toBe('default');
    expect(
      within(control())
        .getAllByRole('radio')
        .map(
          (radio) =>
            `${(radio as HTMLInputElement).value}=${radio.closest('label')?.textContent?.trim()}`,
        ),
    ).toEqual(['default=Standard', 'top=Oben', 'bottom=Unten', 'hidden=Ausgeblendet']);
    expect(
      screen.getByText('„Standard“ folgt der Vorgabe deiner Organisation. Derzeit: Oben.'),
    ).toBeVisible();
  });

  it('stores a choice at once and shows it as the own one', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () => settingsOf({ app_bar: 'hidden' }, { app_bar: 'hidden' }),
    });
    render(Settings);
    await fireEvent.click(option('Ausgeblendet'));
    await waitFor(() => expect(sent(calls)).toEqual([{ app_bar: 'hidden' }]));
    expect(control().dataset.value).toBe('hidden');
    expect(get(me)?.settings.app_bar).toBe('hidden');
    expect(
      screen.queryByText(/„Standard“ folgt der Vorgabe deiner Organisation\. Derzeit: Oben/),
    ).toBeNull();
  });

  it('resets with null when "Standard" is chosen, and shows what applies then', async () => {
    setMe(settingsOf({ app_bar: 'hidden' }, { app_bar: 'hidden' }));
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () => settingsOf({ app_bar: 'bottom' }),
    });
    render(Settings);
    expect(control().dataset.value).toBe('hidden');
    await fireEvent.click(option('Standard'));
    await waitFor(() => expect(sent(calls)).toEqual([{ app_bar: null }]));
    await waitFor(() =>
      expect(
        screen.getByText('„Standard“ folgt der Vorgabe deiner Organisation. Derzeit: Unten.'),
      ).toBeVisible(),
    );
    expect(control().dataset.value).toBe('default');
  });
});

describe('Personal settings: what the organization has fixed', () => {
  const radios = (testid: string) =>
    within(screen.getByTestId(testid)).getAllByRole('radio') as HTMLInputElement[];

  it('shows nothing of the kind while nothing is fixed', () => {
    setMe(makeMe());
    render(Settings);
    for (const id of ['theme', 'accent', 'app-bar', 'nav']) {
      expect(screen.queryByTestId(`setting-${id}-locked`), id).toBeNull();
    }
    expect(radios('setting-theme').every((radio) => !radio.disabled)).toBe(true);
    expect(radios('setting-app-bar').every((radio) => !radio.disabled)).toBe(true);
    expect(
      screen.getAllByTestId('accent-swatch').every((b) => !(b as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it('disables the design and says what it is fixed to', () => {
    // The own choice is "dark"; the organization fixed "light".
    setMe(settingsOf({ theme: 'light', theme_locked: true }, { theme: 'dark' }));
    render(Settings);
    expect(radios('setting-theme').every((radio) => radio.disabled)).toBe(true);
    expect(screen.getByTestId('setting-theme').dataset.value).toBe('light'); // what applies
    // The note says it; there is no hint about "Standard" beside it.
    expect(
      within(screen.getByTestId('setting-theme').closest('section') as HTMLElement).queryByText(
        /„Standard“ folgt/,
      ),
    ).toBeNull();
    expect(screen.getByTestId('setting-theme-locked')).toHaveTextContent(
      'Deine Organisation hat das Design für alle festgelegt: Hell. Deshalb kannst du es hier nicht ändern.',
    );
    // The other settings are untouched by that.
    expect(radios('setting-app-bar').every((radio) => !radio.disabled)).toBe(true);
    expect(screen.queryByTestId('setting-accent-locked')).toBeNull();
  });

  it('disables the accent colour and says what it is fixed to', () => {
    setMe(settingsOf({ accent_color: ORANGE, accent_locked: true }, { accent_color: TEAL }));
    render(Settings);
    const picker = screen.getByTestId('setting-accent');
    for (const testid of ['accent-swatch', 'accent-default', 'accent-custom', 'accent-picker']) {
      for (const control of within(picker).getAllByTestId(testid)) {
        expect(control, testid).toBeDisabled();
      }
    }
    expect(picker.dataset.value).toBe(ORANGE); // what applies, not the own (suspended) choice
    expect(screen.getByTestId('setting-accent-locked')).toHaveTextContent(
      `Deine Organisation hat die Akzentfarbe für alle festgelegt: ${ORANGE}.`,
    );
    // The note takes the place of the hint about "Standard".
    expect(
      within(picker.closest('section') as HTMLElement).queryByText(/„Standard“ folgt der Vorgabe/),
    ).toBeNull();
  });

  it('shows what is fixed for somebody who chose nothing as well, not "Standard"', () => {
    setMe(settingsOf({ theme: 'light', theme_locked: true }));
    render(Settings);
    expect(screen.getByTestId('setting-theme').dataset.value).toBe('light');
    expect(radios('setting-theme')[0]).toBeDisabled(); // the browser tests look at the first
  });

  it('says that the built-in colour is fixed when the organization fixed "none"', () => {
    setMe(settingsOf({ accent_color: null, accent_locked: true }, { accent_color: TEAL }));
    render(Settings);
    expect(screen.getByTestId('setting-accent').dataset.value).toBe('default');
    expect(screen.getByTestId('setting-accent-locked')).toHaveTextContent(
      'Deine Organisation hat die Akzentfarbe für alle festgelegt: das eingebaute Blau.',
    );
  });

  it('disables the app bar and says what it is fixed to', () => {
    setMe(settingsOf({ app_bar: 'bottom', app_bar_locked: true }, { app_bar: 'hidden' }));
    render(Settings);
    expect(radios('setting-app-bar').every((radio) => radio.disabled)).toBe(true);
    expect(screen.getByTestId('setting-app-bar').dataset.value).toBe('bottom');
    expect(screen.getByTestId('setting-app-bar-locked')).toHaveTextContent(
      'Deine Organisation hat die App-Leiste für alle festgelegt: Unten. Deshalb kannst du sie hier nicht ändern.',
    );
  });

  it('follows the next answer about the user: a lock that is lifted gives the own choice back', async () => {
    setMe(
      settingsOf(
        {
          theme: 'light',
          theme_locked: true,
          accent_color: ORANGE,
          accent_locked: true,
          app_bar: 'bottom',
          app_bar_locked: true,
        },
        { theme: 'dark', accent_color: TEAL, app_bar: 'hidden' },
      ),
    );
    render(Settings);
    expect(screen.getByTestId('setting-theme-locked')).toBeVisible();
    expect(screen.getByTestId('setting-accent-locked')).toBeVisible();
    expect(screen.getByTestId('setting-app-bar-locked')).toBeVisible();
    // The administrator lifts the locks; the page learns of it with the next /me.
    setMe(
      settingsOf(
        { theme: 'dark', accent_color: TEAL, app_bar: 'hidden' },
        { theme: 'dark', accent_color: TEAL, app_bar: 'hidden' },
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('setting-theme-locked')).toBeNull());
    expect(screen.queryByTestId('setting-accent-locked')).toBeNull();
    expect(screen.queryByTestId('setting-app-bar-locked')).toBeNull();
    expect(screen.getByTestId('setting-theme').dataset.value).toBe('dark');
    expect(screen.getByTestId('setting-accent').dataset.value).toBe(TEAL);
    expect(screen.getByTestId('setting-app-bar').dataset.value).toBe('hidden');
    expect(radios('setting-theme').every((radio) => !radio.disabled)).toBe(true);
    expect(screen.getAllByTestId('accent-swatch')[0]).toBeEnabled();
  });
});

describe('Administration: settings of the organization', () => {
  const stored: TenantSettings = {
    ...ACME,
    default_theme: null,
    theme_locked: false,
    accent_color: null,
    accent_locked: false,
    default_nav_position: 'top',
    nav_position_locked: false,
    default_app_bar: null,
    app_bar_locked: false,
    logo_url: null,
  };
  const admin = makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin });
  const PNG = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'logo.png', {
    type: 'image/png',
  });
  const save = () => screen.getByRole('button', { name: 'Speichern' });

  /** The page against a server that stores what it is sent. */
  async function open(start: TenantSettings = stored, routes: Parameters<typeof stubApi>[0] = {}) {
    setMe(admin);
    let now = start;
    const api = stubApi({
      'GET /api/v1/admin/tenant': () => now,
      'PATCH /api/v1/admin/tenant': ({ body }) => {
        const { logo, ...rest } = body as Record<string, unknown>;
        now = { ...now, ...rest } as TenantSettings;
        if (logo !== undefined) now = { ...now, logo_url: logo ? '/api/v1/tenant/logo?v=2' : null };
        return now;
      },
      'GET /api/v1/me': () => admin,
      ...routes,
    });
    render(AdminTenantSettings);
    await screen.findByTestId('tenant-theme');
    return api;
  }
  const choose = (testid: string, value: string) =>
    fireEvent.change(screen.getByTestId(testid), { target: { value } });
  const lock = (testid: string) => screen.getByTestId(testid);

  it('shows what is stored, each setting with its own switch', async () => {
    await open({
      ...stored,
      default_theme: 'light',
      theme_locked: true,
      accent_color: ORANGE,
      accent_locked: true,
      default_app_bar: 'hidden',
      app_bar_locked: true,
      nav_position_locked: true,
    });
    expect(document.body).toHaveTextContent('Vorgaben für alle in Acme GmbH.');
    expect(screen.getByTestId('tenant-theme')).toHaveValue('light');
    expect(screen.getByTestId('tenant-accent').dataset.value).toBe(ORANGE);
    expect(screen.getByTestId('tenant-nav')).toHaveValue('top');
    expect(screen.getByTestId('tenant-app-bar')).toHaveValue('hidden');
    for (const [testid, name] of [
      ['tenant-theme-lock', 'Design für alle festlegen'],
      ['tenant-accent-lock', 'Akzentfarbe für alle festlegen'],
      ['tenant-nav-lock', 'Position für alle festlegen'],
      ['tenant-app-bar-lock', 'App-Leiste für alle festlegen'],
    ]) {
      expect(lock(testid), testid).toHaveAttribute('role', 'switch');
      expect(lock(testid), testid).toHaveAccessibleName(name);
      expect(lock(testid), testid).toHaveAttribute('aria-checked', 'true');
    }
    // What a lock means is said next to it.
    expect(screen.getByText(/Mitglieder können dann kein eigenes Design wählen\./)).toBeVisible();
    expect(
      screen.getByText(/Mitglieder können dann keine eigene Akzentfarbe wählen\./),
    ).toBeVisible();
    expect(
      screen.getByText(/Mitglieder können die App-Leiste dann nicht selbst einstellen\./),
    ).toBeVisible();
    // One button for the page, and nothing to save yet.
    expect(screen.getAllByRole('button', { name: 'Speichern' })).toHaveLength(1);
    expect(save()).toBeDisabled();
  });

  it('offers "keine Vorgabe" for design, accent colour and app bar', async () => {
    await open();
    const texts = (testid: string) =>
      [...(screen.getByTestId(testid) as HTMLSelectElement).options].map(
        (option) => `${option.value}=${option.textContent?.trim()}`,
      );
    expect(texts('tenant-theme')).toEqual([
      'none=Keine Vorgabe',
      'system=System',
      'light=Hell',
      'dark=Dunkel',
    ]);
    expect(texts('tenant-app-bar')).toEqual([
      'none=Keine Vorgabe',
      'top=Oben',
      'bottom=Unten',
      'hidden=Ausgeblendet',
    ]);
    expect(texts('tenant-nav')[0]).toBe('system=Systemstandard');
    expect(screen.getByTestId('tenant-theme')).toHaveValue('none');
    expect(screen.getByTestId('tenant-app-bar')).toHaveValue('none');
    expect(
      within(screen.getByTestId('tenant-accent')).getByTestId('accent-default'),
    ).toHaveTextContent('Keine Vorgabe');
  });

  it('sends only what was changed, in one request for the one button', async () => {
    const { calls } = await open();
    await choose('tenant-theme', 'dark');
    await fireEvent.click(lock('tenant-theme-lock'));
    await fireEvent.input(
      within(screen.getByTestId('tenant-accent')).getByTestId('accent-custom'),
      { target: { value: ORANGE } },
    );
    await choose('tenant-app-bar', 'bottom');
    await fireEvent.click(lock('tenant-app-bar-lock'));
    await fireEvent.click(save());
    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    // Neither the dock position nor its lock nor the logo: they were not touched here.
    expect(sent(calls)[0]).toEqual({
      default_theme: 'dark',
      theme_locked: true,
      accent_color: ORANGE,
      default_app_bar: 'bottom',
      app_bar_locked: true,
    });
    await waitFor(() => expect(notices()).toEqual(['success: Einstellungen gespeichert.']));
  });

  it.each([
    ['tenant-theme-lock', { theme_locked: true }],
    ['tenant-accent-lock', { accent_locked: true }],
    ['tenant-nav-lock', { nav_position_locked: true }],
    ['tenant-app-bar-lock', { app_bar_locked: true }],
  ])('fixes one setting with %s and nothing else', async (testid, body) => {
    const { calls } = await open();
    await fireEvent.click(lock(testid));
    await fireEvent.click(save());
    await waitFor(() => expect(sent(calls)).toEqual([body]));
  });

  it('removes a default with null', async () => {
    const { calls } = await open({
      ...stored,
      default_theme: 'light',
      accent_color: ORANGE,
      default_app_bar: 'hidden',
    });
    await choose('tenant-theme', 'none');
    await fireEvent.click(
      within(screen.getByTestId('tenant-accent')).getByTestId('accent-default'),
    );
    await choose('tenant-nav', 'system');
    await choose('tenant-app-bar', 'none');
    await fireEvent.click(save());
    await waitFor(() =>
      expect(sent(calls)).toEqual([
        {
          default_theme: null,
          accent_color: null,
          default_nav_position: null,
          default_app_bar: null,
        },
      ]),
    );
  });

  it('has nothing to save, and says nothing, when a change is taken back', async () => {
    const { calls } = await open();
    await choose('tenant-theme', 'dark');
    expect(save()).toBeEnabled();
    await choose('tenant-theme', 'none');
    await fireEvent.click(lock('tenant-accent-lock'));
    await fireEvent.click(lock('tenant-accent-lock'));
    expect(save()).toBeDisabled();
    await fireEvent.submit(save().closest('form') as HTMLFormElement);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls)).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it('shows the administrator the result at once: the user is read again after saving', async () => {
    const after = { ...admin, settings: { ...admin.settings, accent_color: ORANGE } };
    const { calls } = await open(stored, { 'GET /api/v1/me': () => after });
    await fireEvent.click(
      within(screen.getByTestId('tenant-accent'))
        .getAllByTestId('accent-swatch')
        .find((button) => button.dataset.color === ORANGE) as HTMLElement,
    );
    await fireEvent.click(save());
    await waitFor(() => expect(get(me)?.settings.accent_color).toBe(ORANGE));
    expect(calls.filter((call) => call.url === '/api/v1/me')).toHaveLength(1);
  });

  describe('accent colour', () => {
    const preview = () => screen.queryByTestId('tenant-accent-preview');

    it('previews how the colour comes out in the light and in the dark design', async () => {
      await open();
      expect(preview()).toBeNull(); // no default: nothing to preview
      expect(screen.getByText(/Ohne Vorgabe bleibt es beim eingebauten Blau/)).toBeVisible();
      await fireEvent.input(
        within(screen.getByTestId('tenant-accent')).getByTestId('accent-custom'),
        { target: { value: '#facc15' } },
      );
      const tiles = [...(preview() as HTMLElement).querySelectorAll<HTMLElement>('[data-scheme]')];
      expect(tiles.map((tile) => tile.dataset.scheme)).toEqual(['light', 'dark']);
      // The tones the page itself would get, not the yellow as it was typed.
      expect(tiles.map((tile) => tile.dataset.accent)).toEqual([
        accentTokens('#facc15', 'light')['--accent'],
        accentTokens('#facc15', 'dark')['--accent'],
      ]);
      expect(tiles[0].dataset.accent).not.toBe('#facc15');
      expect(tiles[0]).toHaveTextContent('Hell');
      expect(tiles[1]).toHaveTextContent('Dunkel');
      expect(screen.queryByText(/Ohne Vorgabe bleibt es beim eingebauten Blau/)).toBeNull();
    });
  });

  describe('logo', () => {
    const input = () => screen.getByTestId('tenant-logo-input') as HTMLInputElement;
    const pick = (file: File) => fireEvent.change(input(), { target: { files: [file] } });
    const images = () =>
      [...(screen.getByTestId('tenant-logo-preview').querySelectorAll('img') ?? [])].map(
        (image) => image.getAttribute('src') ?? '',
      );

    it('says that there is none, and takes the image types of the API', async () => {
      await open();
      expect(screen.queryByTestId('tenant-logo-preview')).toBeNull();
      expect(screen.queryByTestId('tenant-logo-remove')).toBeNull();
      expect(screen.getByText('Kein Logo: Im Dock steht das Velydock-Zeichen.')).toBeVisible();
      expect(input()).toHaveAttribute('type', 'file');
      for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
        expect(input().accept).toContain(type);
      }
    });

    it('previews a chosen image on light and on dark, and sends it with the save', async () => {
      const { calls } = await open();
      await pick(PNG);
      // Shown before anything is saved, twice: once per theme.
      await waitFor(() => expect(screen.getByTestId('tenant-logo-preview')).toBeVisible());
      expect(images()).toHaveLength(2);
      const chosen = images()[0];
      expect(chosen).toMatch(/^data:image\/png;base64,/);
      expect(images()[1]).toBe(chosen);
      expect(sent(calls)).toEqual([]);
      expect(save()).toBeEnabled();
      await fireEvent.click(save());
      await waitFor(() => expect(sent(calls)).toHaveLength(1));
      expect(sent(calls)[0]).toEqual({ logo: { data_url: chosen } });
      // Stored: the preview shows what the server serves now, and there is nothing to save.
      await waitFor(() => expect(images()).toEqual(Array(2).fill('/api/v1/tenant/logo?v=2')));
      expect(await screen.findByRole('button', { name: 'Speichern' })).toBeDisabled();
    });

    it('refuses a file that is too large before anything is sent, and says why', async () => {
      const { calls } = await open();
      await pick(
        new File([new Uint8Array(IMAGE_MAX_BYTES + 1)], 'gross.png', { type: 'image/png' }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Das Logo darf höchstens 256 KB groß sein.',
      );
      expect(screen.queryByTestId('tenant-logo-preview')).toBeNull();
      expect(save()).toBeDisabled();
      expect(sent(calls)).toEqual([]);
      // A file that fits takes the message away.
      await pick(PNG);
      await waitFor(() => expect(screen.getByTestId('tenant-logo-preview')).toBeVisible());
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('refuses a file that is no image of a known type', async () => {
      await open();
      await pick(new File(['%PDF-1.7'], 'logo.pdf', { type: 'application/pdf' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Das Logo muss ein PNG-, JPEG-, GIF-, WebP- oder SVG-Bild sein.',
      );
      expect(screen.queryByTestId('tenant-logo-preview')).toBeNull();
    });

    it('shows the stored logo and removes it with null', async () => {
      const { calls } = await open({ ...stored, logo_url: '/api/v1/tenant/logo?v=1' });
      expect(images()).toEqual(Array(2).fill('/api/v1/tenant/logo?v=1'));
      await fireEvent.click(screen.getByTestId('tenant-logo-remove'));
      expect(screen.queryByTestId('tenant-logo-preview')).toBeNull();
      await fireEvent.click(save());
      await waitFor(() => expect(sent(calls)).toEqual([{ logo: null }]));
    });

    it('sends nothing about the logo when one that was only chosen is removed again', async () => {
      const { calls } = await open();
      await pick(PNG);
      await waitFor(() => expect(screen.getByTestId('tenant-logo-preview')).toBeVisible());
      await fireEvent.click(screen.getByTestId('tenant-logo-remove'));
      expect(save()).toBeDisabled(); // there was none, there is none
      await fireEvent.click(lock('tenant-nav-lock'));
      await fireEvent.click(save());
      await waitFor(() => expect(sent(calls)).toEqual([{ nav_position_locked: true }]));
    });

    it.each([
      ['logo_too_large', 'Das Logo darf höchstens 256 KB groß sein.'],
      ['logo_invalid', 'Das Logo muss ein PNG-, JPEG-, GIF-, WebP- oder SVG-Bild sein.'],
    ])('says at the logo what the server refuses about it (%s)', async (code, text) => {
      await open(stored, { 'PATCH /api/v1/admin/tenant': () => errorResponse(422, code) });
      await pick(PNG);
      await waitFor(() => expect(screen.getByTestId('tenant-logo-preview')).toBeVisible());
      await fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(notices()).toEqual([]); // said once, where the image is
      expect(screen.getByTestId('tenant-logo-preview')).toBeVisible(); // the choice is kept
    });
  });
});
