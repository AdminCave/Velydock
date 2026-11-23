<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import Trash from '@lucide/svelte/icons/trash';
  import Upload from '@lucide/svelte/icons/upload';
  import { BODY_TEXT, SURFACES, accentTokens, type Scheme } from '$lib/accent';
  import { ApiError, tenantApi } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import {
    NAV_POSITIONS,
    type AppBar,
    type NavPosition,
    type TenantSettings,
    type TenantSettingsUpdate,
    type ThemePreference,
  } from '$lib/api/types';
  import AccentPicker from '$lib/components/ui/AccentPicker.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { t } from '$lib/i18n';
  import { IMAGE_ACCEPT, imageFileProblem, readImageFile } from '$lib/imageFile';
  import { refreshMe } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';

  // What an organization sets for its members: a logo, and for each of design, accent
  // colour, dock position and app bar a default and whether it is fixed. A default applies
  // to everybody who chose nothing themselves; fixed, it applies to everybody.
  type ThemeChoice = ThemePreference | 'none';
  type NavChoice = NavPosition | 'system';
  type BarChoice = AppBar | 'none';
  const SCHEMES: Scheme[] = ['light', 'dark'];

  // Bound to the organization this page was opened for (see tenantApi()).
  const api = tenantApi();

  let settings = $state<TenantSettings | null>(null);
  let failed = $state(false);
  let saving = $state(false);

  let theme = $state<ThemeChoice>('none');
  let themeLocked = $state(false);
  let accent = $state<string | null>(null);
  let accentLocked = $state(false);
  let position = $state<NavChoice>('system');
  let locked = $state(false);
  let bar = $state<BarChoice>('none');
  let barLocked = $state(false);
  // The logo: a new image (as a data URL) that is sent with the next save, or the wish
  // to remove the stored one.
  let logoUpload = $state<string | null>(null);
  let logoRemoved = $state(false);
  let logoError = $state('');

  function apply(value: TenantSettings) {
    settings = value;
    theme = value.default_theme ?? 'none';
    themeLocked = value.theme_locked;
    accent = value.accent_color;
    accentLocked = value.accent_locked;
    position = value.default_nav_position ?? 'system';
    locked = value.nav_position_locked;
    bar = value.default_app_bar ?? 'none';
    barLocked = value.app_bar_locked;
    logoUpload = null;
    logoRemoved = false;
    logoError = '';
  }

  async function load() {
    try {
      apply(await api.get('/api/v1/admin/tenant'));
      failed = false;
    } catch (err) {
      failed = true;
      showError(err);
    }
  }

  onMount(() => void load());

  const themeOptions = $derived([
    { value: 'none' as const, label: $t('tenantSettings.noDefault') },
    { value: 'system' as const, label: $t('settings.theme.system') },
    { value: 'light' as const, label: $t('settings.theme.light') },
    { value: 'dark' as const, label: $t('settings.theme.dark') },
  ]);
  const options = $derived([
    { value: 'system' as const, label: $t('nav.position.systemDefault') },
    ...NAV_POSITIONS.map((value) => ({ value, label: $t(`nav.position.${value}`) })),
  ]);
  const barOptions = $derived([
    { value: 'none' as const, label: $t('tenantSettings.noDefault') },
    { value: 'top' as const, label: $t('appBar.top') },
    { value: 'bottom' as const, label: $t('appBar.bottom') },
    { value: 'hidden' as const, label: $t('appBar.hidden') },
  ]);

  /**
   * What differs from what is stored, as the API takes it. Only that is sent: somebody
   * else may have changed another setting since this page was loaded.
   */
  function changes(): TenantSettingsUpdate {
    const stored = settings;
    const body: TenantSettingsUpdate = {};
    if (!stored) return body;
    if (theme !== (stored.default_theme ?? 'none')) {
      body.default_theme = theme === 'none' ? null : theme;
    }
    if (themeLocked !== stored.theme_locked) body.theme_locked = themeLocked;
    if (accent !== stored.accent_color) body.accent_color = accent;
    if (accentLocked !== stored.accent_locked) body.accent_locked = accentLocked;
    if (position !== (stored.default_nav_position ?? 'system')) {
      body.default_nav_position = position === 'system' ? null : position;
    }
    if (locked !== stored.nav_position_locked) body.nav_position_locked = locked;
    if (bar !== (stored.default_app_bar ?? 'none')) {
      body.default_app_bar = bar === 'none' ? null : bar;
    }
    if (barLocked !== stored.app_bar_locked) body.app_bar_locked = barLocked;
    if (logoUpload) body.logo = { data_url: logoUpload };
    else if (logoRemoved && stored.logo_url) body.logo = null;
    return body;
  }
  const changed = $derived(Object.keys(changes()).length > 0);

  // The logo as this page shows it: the new one, none, or the stored one.
  const logo = $derived(logoUpload ?? (logoRemoved ? null : (settings?.logo_url ?? null)));

  async function onLogoFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // the same file can be chosen again after a fix
    if (!file) return;
    // Checked before anything is sent, so the message comes at once.
    const problem = imageFileProblem(file);
    if (problem) {
      logoError = $t(`error.logo_${problem}`);
      return;
    }
    try {
      logoUpload = await readImageFile(file);
      logoRemoved = false;
      logoError = '';
    } catch {
      logoError = $t('error.logo_invalid');
    }
  }

  function removeLogo() {
    logoUpload = null;
    logoRemoved = true;
    logoError = '';
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const body = changes();
    if (Object.keys(body).length === 0 || saving) return;
    saving = true;
    try {
      apply(await api.patch('/api/v1/admin/tenant', { body }));
      showToast($t('tenantSettings.saved'));
      // What was set here applies to the administrator as well: the dock, its logo, the
      // accent colour and the app bar follow at once.
      await refreshMe();
    } catch (err) {
      // What the server refuses about the image is said where the image is.
      if (
        err instanceof ApiError &&
        (err.code === 'logo_invalid' || err.code === 'logo_too_large')
      ) {
        logoError = errorMessage(err, $t);
      } else {
        showError(err);
      }
    } finally {
      saving = false;
    }
  }
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('tenantSettings.title')}</h1>
      <p class="page-subtitle">
        {$t('tenantSettings.subtitle', { name: settings?.name ?? '' })}
      </p>
    </div>
  </header>

  {#if settings}
    <form class="settings-form" onsubmit={save}>
      <section class="card card-pad form" aria-labelledby="tenant-settings-logo">
        <div>
          <h2 class="section-title" id="tenant-settings-logo">{$t('tenantSettings.logo.title')}</h2>
          <p class="section-desc">{$t('tenantSettings.logo.text')}</p>
        </div>
        {#if logo}
          <!-- As it will stand in the dock, on the page background of either theme. -->
          <div class="previews" data-testid="tenant-logo-preview">
            {#each SCHEMES as scheme (scheme)}
              <figure class="tile" style:background={SURFACES[scheme].bg}>
                <img class="logo" src={logo} alt={$t('tenantSettings.logo.alt')} />
                <figcaption style:color={BODY_TEXT[scheme]}>
                  {$t(`settings.theme.${scheme}`)}
                </figcaption>
              </figure>
            {/each}
          </div>
        {:else}
          <p class="help">{$t('tenantSettings.logo.none')}</p>
        {/if}
        <div class="form-actions">
          <label class="upload">
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              data-testid="tenant-logo-input"
              onchange={onLogoFile}
            />
            <Upload size={16} />
            <span>{$t(logo ? 'tenantSettings.logo.replace' : 'tenantSettings.logo.choose')}</span>
          </label>
          {#if logo}
            <Button
              variant="ghost"
              iconLeft={Trash}
              data-testid="tenant-logo-remove"
              onclick={removeLogo}
            >
              {$t('tenantSettings.logo.remove')}
            </Button>
          {/if}
        </div>
        <p class="help" class:bad={!!logoError} role={logoError ? 'alert' : undefined}>
          {logoError || $t('tenantSettings.logo.hint')}
        </p>
      </section>

      <section class="card card-pad form" aria-labelledby="tenant-settings-theme">
        <div>
          <h2 class="section-title" id="tenant-settings-theme">
            {$t('tenantSettings.theme.title')}
          </h2>
          <p class="section-desc">{$t('tenantSettings.theme.text')}</p>
        </div>
        <FormField
          label={$t('tenantSettings.theme.default')}
          hint={$t('tenantSettings.theme.hint')}
        >
          <Select bind:value={theme} options={themeOptions} testid="tenant-theme" />
        </FormField>
        <div class="option">
          <Switch
            bind:checked={themeLocked}
            label={$t('tenantSettings.theme.lock')}
            testid="tenant-theme-lock"
          />
          <p class="help">{$t('tenantSettings.theme.lockText')}</p>
        </div>
      </section>

      <section class="card card-pad form" aria-labelledby="tenant-settings-accent">
        <div>
          <h2 class="section-title" id="tenant-settings-accent">
            {$t('tenantSettings.accent.title')}
          </h2>
          <p class="section-desc">{$t('tenantSettings.accent.text')}</p>
        </div>
        <AccentPicker
          bind:value={accent}
          label={$t('tenantSettings.accent.title')}
          noneLabel={$t('tenantSettings.noDefault')}
          testid="tenant-accent"
        />
        {#if accent}
          <!-- How the colour comes out: as it is where that is readable, lighter or darker
               where it is not. The same tones lib/accent.ts gives the page itself. -->
          <div class="previews" data-testid="tenant-accent-preview">
            {#each SCHEMES as scheme (scheme)}
              {@const tokens = accentTokens(accent, scheme)}
              <div
                class="tile sample"
                style:background={SURFACES[scheme].bg}
                style:color={BODY_TEXT[scheme]}
                data-scheme={scheme}
                data-accent={tokens['--accent']}
              >
                <span class="sample-theme">{$t(`settings.theme.${scheme}`)}</span>
                <span class="sample-link" style:color={tokens['--accent']}>
                  {$t('tenantSettings.accent.sampleLink')}
                </span>
                <span
                  class="sample-tag"
                  style:color={tokens['--accent']}
                  style:background={tokens['--accent-muted']}
                  style:border-color={tokens['--accent-border']}
                >
                  {$t('tenantSettings.accent.sampleTag')}
                </span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="help">{$t('tenantSettings.accent.none')}</p>
        {/if}
        <div class="option">
          <Switch
            bind:checked={accentLocked}
            label={$t('tenantSettings.accent.lock')}
            testid="tenant-accent-lock"
          />
          <p class="help">{$t('tenantSettings.accent.lockText')}</p>
        </div>
      </section>

      <section class="card card-pad form" aria-labelledby="tenant-settings-nav">
        <div>
          <h2 class="section-title" id="tenant-settings-nav">{$t('tenantSettings.nav.title')}</h2>
          <p class="section-desc">{$t('tenantSettings.nav.text')}</p>
        </div>
        <FormField
          label={$t('tenantSettings.nav.position')}
          hint={$t('tenantSettings.nav.positionHint')}
        >
          <Select bind:value={position} {options} testid="tenant-nav" />
        </FormField>
        <div class="option">
          <Switch
            bind:checked={locked}
            label={$t('tenantSettings.lock.label')}
            testid="tenant-nav-lock"
          />
          <p class="help">{$t('tenantSettings.lock.text')}</p>
        </div>
        {#if locked}
          <Callout tone="neutral">{$t('tenantSettings.lock.note')}</Callout>
        {/if}
      </section>

      <section class="card card-pad form" aria-labelledby="tenant-settings-app-bar">
        <div>
          <h2 class="section-title" id="tenant-settings-app-bar">
            {$t('tenantSettings.appBar.title')}
          </h2>
          <p class="section-desc">{$t('tenantSettings.appBar.text')}</p>
        </div>
        <FormField
          label={$t('tenantSettings.appBar.default')}
          hint={$t('tenantSettings.appBar.hint')}
        >
          <Select bind:value={bar} options={barOptions} testid="tenant-app-bar" />
        </FormField>
        <div class="option">
          <Switch
            bind:checked={barLocked}
            label={$t('tenantSettings.appBar.lock')}
            testid="tenant-app-bar-lock"
          />
          <p class="help">{$t('tenantSettings.appBar.lockText')}</p>
        </div>
      </section>

      <div class="form-actions">
        <Button type="submit" loading={saving} disabled={!changed}>{$t('action.save')}</Button>
      </div>
    </form>
  {:else}
    <div class="table-state">
      {#if failed}
        <Button variant="secondary" onclick={() => void load()}>{$t('action.retry')}</Button>
      {:else}
        <Spinner size={20} />
      {/if}
    </div>
  {/if}
</section>

<style>
  .settings-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 720px;
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .previews {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  /* A piece of the page in one theme, whatever theme the page itself is in: the colours
     are those of that theme (lib/accent.ts), not the tokens of this page. */
  .tile {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    box-sizing: border-box;
    min-width: 0;
    margin: 0;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  /* As in the dock: as high as the product mark, never distorted. */
  .logo {
    display: block;
    width: auto;
    height: 30px;
    max-width: 56px;
    object-fit: contain;
  }
  .sample-theme {
    font-weight: var(--fw-medium);
  }
  .sample-link {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .sample-tag {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 var(--space-2);
    border: 1px solid;
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .upload {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 40px;
    padding: 0 var(--space-5);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
  }
  .upload:hover {
    background: var(--surface-hover);
  }
  /* The file input covers the label and is invisible: the label is what is seen, the
     input what is used (and what the keyboard focuses). */
  .upload input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }
  .upload:has(input:focus-visible) {
    outline: var(--ring-width) solid var(--ring);
    outline-offset: 1px;
  }
  .bad {
    color: var(--danger);
  }
</style>
