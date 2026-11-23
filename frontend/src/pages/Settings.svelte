<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import type {
    AppBar,
    Language,
    NavPosition,
    SettingsUpdate,
    ThemePreference,
  } from '$lib/api/types';
  import AccentPicker from '$lib/components/ui/AccentPicker.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import { t } from '$lib/i18n';
  import { me, updateSettings } from '$lib/stores/session';
  import { showError } from '$lib/stores/toasts';

  type ThemeChoice = ThemePreference | 'default';
  type NavChoice = NavPosition | 'default';
  type BarChoice = AppBar | 'default';

  let theme = $state<ThemeChoice>('default');
  let accent = $state<string | null>(null);
  let nav = $state<NavChoice>('default');
  let bar = $state<BarChoice>('default');
  let lang = $state<Language>('de');

  // What the organization has fixed for everybody cannot be chosen here: the control is
  // disabled and shows what applies, and a note says so.
  const themeLocked = $derived($me?.settings.theme_locked ?? false);
  const accentLocked = $derived($me?.settings.accent_locked ?? false);
  const locked = $derived($me?.settings.nav_position_locked ?? false);
  const barLocked = $derived($me?.settings.app_bar_locked ?? false);

  // The controls mirror the server's answer; a refused change snaps back. They follow
  // every new answer, so a lock that is set or lifted meanwhile shows without a reload.
  function sync() {
    if (!$me) return;
    lang = $me.settings.language;
    // Locked by the organization: show what is in effect. Otherwise the own choice, and
    // "default" if there is none.
    theme = themeLocked ? $me.settings.theme : ($me.own_settings.theme ?? 'default');
    accent = accentLocked ? $me.settings.accent_color : ($me.own_settings.accent_color ?? null);
    nav = locked ? $me.settings.nav_position : ($me.own_settings.nav_position ?? 'default');
    bar = barLocked ? $me.settings.app_bar : ($me.own_settings.app_bar ?? 'default');
  }
  $effect(sync);

  // Every change applies at once and is stored on the server.
  async function save(patch: SettingsUpdate) {
    try {
      await updateSettings(patch);
    } catch (err) {
      showError(err);
      sync();
    }
  }

  const themeOptions = $derived([
    { value: 'default' as const, label: $t('settings.theme.default') },
    { value: 'system' as const, label: $t('settings.theme.system'), icon: Monitor },
    { value: 'light' as const, label: $t('settings.theme.light'), icon: Sun },
    { value: 'dark' as const, label: $t('settings.theme.dark'), icon: Moon },
  ]);
  const navOptions = $derived([
    { value: 'default' as const, label: $t('settings.nav.default') },
    { value: 'left' as const, label: $t('nav.position.left') },
    { value: 'right' as const, label: $t('nav.position.right') },
    { value: 'top' as const, label: $t('nav.position.top') },
    { value: 'bottom' as const, label: $t('nav.position.bottom') },
  ]);
  const barOptions = $derived([
    { value: 'default' as const, label: $t('settings.appBar.default') },
    { value: 'top' as const, label: $t('appBar.top') },
    { value: 'bottom' as const, label: $t('appBar.bottom') },
    { value: 'hidden' as const, label: $t('appBar.hidden') },
  ]);
  const langOptions = [
    { value: 'de' as const, label: 'Deutsch' },
    { value: 'en' as const, label: 'English' },
  ];
</script>

{#if $me}
  <div class="page page-narrow">
    <header class="page-header">
      <div>
        <h1 class="page-title">{$t('settings.title')}</h1>
        <p class="page-subtitle">{$t('settings.subtitle')}</p>
      </div>
    </header>

    <section class="card card-pad section" aria-labelledby="settings-theme">
      <div>
        <h2 class="section-title" id="settings-theme">{$t('settings.theme.title')}</h2>
        <p class="section-desc">{$t('settings.theme.text')}</p>
      </div>
      <Segmented
        bind:value={theme}
        options={themeOptions}
        label={$t('settings.theme.title')}
        testid="setting-theme"
        disabled={themeLocked}
        onChange={(value) => save({ theme: value === 'default' ? null : value })}
      />
      {#if themeLocked}
        <Callout tone="neutral" testid="setting-theme-locked">
          {$t('settings.theme.locked', { theme: $t(`settings.theme.${$me.settings.theme}`) })}
        </Callout>
      {:else if theme === 'default'}
        <p class="help">
          {$t('settings.theme.defaultHint', {
            theme: $t(`settings.theme.${$me.settings.theme}`),
          })}
        </p>
      {/if}
    </section>

    <section class="card card-pad section" aria-labelledby="settings-accent">
      <div>
        <h2 class="section-title" id="settings-accent">{$t('settings.accent.title')}</h2>
        <p class="section-desc">{$t('settings.accent.text')}</p>
      </div>
      <AccentPicker
        bind:value={accent}
        label={$t('settings.accent.title')}
        noneLabel={$t('settings.accent.default')}
        testid="setting-accent"
        disabled={accentLocked}
        onChange={(value) => save({ accent_color: value })}
      />
      {#if accentLocked}
        <Callout tone="neutral" testid="setting-accent-locked">
          {$me.settings.accent_color
            ? $t('settings.accent.locked', { color: $me.settings.accent_color })
            : $t('settings.accent.lockedBuiltin')}
        </Callout>
      {:else if accent === null}
        <p class="help">
          {$me.settings.accent_color
            ? $t('settings.accent.defaultHint.organization', { color: $me.settings.accent_color })
            : $t('settings.accent.defaultHint.builtin')}
        </p>
      {/if}
    </section>

    <section class="card card-pad section" aria-labelledby="settings-nav">
      <div>
        <h2 class="section-title" id="settings-nav">{$t('settings.nav.title')}</h2>
        <p class="section-desc">{$t('settings.nav.text')}</p>
      </div>
      <Segmented
        bind:value={nav}
        options={navOptions}
        label={$t('settings.nav.title')}
        testid="setting-nav-position"
        disabled={locked}
        onChange={(value) => save({ nav_position: value === 'default' ? null : value })}
      />
      {#if locked}
        <Callout tone="neutral" testid="setting-nav-locked">
          {$t('settings.nav.locked', {
            position: $t(`nav.position.${$me.settings.nav_position}`),
          })}
        </Callout>
      {:else if nav === 'default'}
        <p class="help">
          {$t('settings.nav.defaultHint', {
            position: $t(`nav.position.${$me.settings.nav_position}`),
          })}
        </p>
      {/if}
    </section>

    <section class="card card-pad section" aria-labelledby="settings-app-bar">
      <div>
        <h2 class="section-title" id="settings-app-bar">{$t('settings.appBar.title')}</h2>
        <p class="section-desc">{$t('settings.appBar.text')}</p>
      </div>
      <Segmented
        bind:value={bar}
        options={barOptions}
        label={$t('settings.appBar.title')}
        testid="setting-app-bar"
        disabled={barLocked}
        onChange={(value) => save({ app_bar: value === 'default' ? null : value })}
      />
      {#if barLocked}
        <Callout tone="neutral" testid="setting-app-bar-locked">
          {$t('settings.appBar.locked', { position: $t(`appBar.${$me.settings.app_bar}`) })}
        </Callout>
      {:else if bar === 'default'}
        <p class="help">
          {$t('settings.appBar.defaultHint', { position: $t(`appBar.${$me.settings.app_bar}`) })}
        </p>
      {/if}
    </section>

    <section class="card card-pad section" aria-labelledby="settings-language">
      <div>
        <h2 class="section-title" id="settings-language">{$t('settings.language.title')}</h2>
        <p class="section-desc">{$t('settings.language.text')}</p>
      </div>
      <Segmented
        bind:value={lang}
        options={langOptions}
        label={$t('settings.language.title')}
        testid="setting-language"
        onChange={(value) => save({ language: value })}
      />
    </section>
  </div>
{/if}
