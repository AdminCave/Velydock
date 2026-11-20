<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import type { Language, NavPosition, SettingsUpdate, ThemePreference } from '$lib/api/types';
  import Callout from '$lib/components/ui/Callout.svelte';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import { t } from '$lib/i18n';
  import { me, updateSettings } from '$lib/stores/session';
  import { showError } from '$lib/stores/toasts';

  type NavChoice = NavPosition | 'default';

  let theme = $state<ThemePreference>('system');
  let nav = $state<NavChoice>('default');
  let lang = $state<Language>('de');

  const locked = $derived($me?.settings.nav_position_locked ?? false);

  // The controls mirror the server's answer; a refused change snaps back.
  function sync() {
    if (!$me) return;
    theme = $me.settings.theme;
    lang = $me.settings.language;
    // Locked by the organization: show what is in effect. Otherwise the own choice, and
    // "default" if there is none.
    nav = locked ? $me.settings.nav_position : ($me.own_settings.nav_position ?? 'default');
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
        onChange={(value) => save({ theme: value })}
      />
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
