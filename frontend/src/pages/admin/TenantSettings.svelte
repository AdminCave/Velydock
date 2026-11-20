<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api/client';
  import { NAV_POSITIONS, type NavPosition, type TenantSettings } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { t } from '$lib/i18n';
  import { refreshMe } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';

  type Choice = NavPosition | 'system';

  let settings = $state<TenantSettings | null>(null);
  let failed = $state(false);
  let position = $state<Choice>('system');
  let locked = $state(false);
  let saving = $state(false);

  function apply(value: TenantSettings) {
    settings = value;
    position = value.default_nav_position ?? 'system';
    locked = value.nav_position_locked;
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

  const options = $derived([
    { value: 'system' as const, label: $t('nav.position.systemDefault') },
    ...NAV_POSITIONS.map((value) => ({ value, label: $t(`nav.position.${value}`) })),
  ]);
  const changed = $derived(
    settings !== null &&
      (position !== (settings.default_nav_position ?? 'system') ||
        locked !== settings.nav_position_locked),
  );

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!changed || saving) return;
    saving = true;
    try {
      apply(
        await api.patch('/api/v1/admin/tenant', {
          body: {
            default_nav_position: position === 'system' ? null : position,
            nav_position_locked: locked,
          },
        }),
      );
      showToast($t('tenantSettings.saved'));
      // The own dock may move with the new default.
      await refreshMe();
    } catch (err) {
      showError(err);
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
    <form class="card card-pad form settings-form" onsubmit={save}>
      <div>
        <h2 class="section-title">{$t('tenantSettings.nav.title')}</h2>
        <p class="section-desc">{$t('tenantSettings.nav.text')}</p>
      </div>
      <FormField
        label={$t('tenantSettings.nav.position')}
        hint={$t('tenantSettings.nav.positionHint')}
      >
        <Select bind:value={position} {options} testid="tenant-nav-position" />
      </FormField>
      <div class="option">
        <Switch bind:checked={locked} label={$t('tenantSettings.lock.label')} />
        <p class="help">{$t('tenantSettings.lock.text')}</p>
      </div>
      {#if locked}
        <Callout tone="neutral">{$t('tenantSettings.lock.note')}</Callout>
      {/if}
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
    max-width: 720px;
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
</style>
