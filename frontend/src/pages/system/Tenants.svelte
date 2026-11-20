<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import Building from '@lucide/svelte/icons/building';
  import DoorOpen from '@lucide/svelte/icons/door-open';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Power from '@lucide/svelte/icons/power';
  import PowerOff from '@lucide/svelte/icons/power-off';
  import Trash from '@lucide/svelte/icons/trash';
  import { api } from '$lib/api/client';
  import type { Tenant } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Tag from '$lib/components/ui/Tag.svelte';
  import { t } from '$lib/i18n';
  import { navigate } from '$lib/router';
  import { me, refreshMe, switchTenant } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';
  import TenantDeleteModal from '../../modals/TenantDeleteModal.svelte';
  import TenantModal from '../../modals/TenantModal.svelte';

  let tenants = $state<Tenant[] | null>(null);
  let failed = $state(false);
  let modalOpen = $state(false);
  let editing = $state<Tenant | null>(null);
  let deleting = $state<Tenant | null>(null);
  let entering = $state(false);

  async function load() {
    try {
      tenants = await api.get('/api/v1/system/tenants');
      failed = false;
    } catch (err) {
      failed = true;
      showError(err);
    }
  }

  onMount(() => void load());

  // After a write: read the table again, and the signed-in user too, because the
  // organization switcher lists the same organizations (and deleting the organization one
  // is in moves the session to another one).
  async function refresh() {
    await Promise.all([load(), refreshMe().catch(showError)]);
  }

  function openCreate() {
    editing = null;
    modalOpen = true;
  }

  function openRename(tenant: Tenant) {
    editing = tenant;
    modalOpen = true;
  }

  function onSaved(tenant: Tenant, created: boolean) {
    modalOpen = false;
    showToast($t(created ? 'tenants.created' : 'tenants.renamed', { name: tenant.name }));
    void refresh();
  }

  function onDeleted(tenant: Tenant) {
    deleting = null;
    showToast($t('tenants.deleted', { name: tenant.name }));
    void refresh();
  }

  async function enter(tenant: Tenant) {
    if (entering) return;
    entering = true;
    try {
      await switchTenant(tenant.id);
      showToast($t('tenants.entered', { name: tenant.name }), 'info');
      navigate('/');
    } catch (err) {
      showError(err);
    } finally {
      entering = false;
    }
  }

  async function setActive(tenant: Tenant, active: boolean) {
    if (!active) {
      const ok = await confirmDialog($t('tenants.deactivate.question', { name: tenant.name }), {
        title: $t('tenants.deactivate.title'),
        detail: $t('tenants.deactivate.detail'),
        confirmLabel: $t('tenants.action.deactivate'),
      });
      if (!ok) return;
    }
    try {
      await api.patch('/api/v1/system/tenants/{tenant_id}', {
        path: { tenant_id: tenant.id },
        body: { active },
      });
      showToast($t(active ? 'tenants.activated' : 'tenants.deactivated', { name: tenant.name }));
      await refresh();
    } catch (err) {
      showError(err);
    }
  }
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('tenants.title')}</h1>
      <p class="page-subtitle">{$t('tenants.subtitle')}</p>
    </div>
    <Button iconLeft={Plus} onclick={openCreate}>{$t('tenants.create')}</Button>
  </header>

  <div class="table-wrap">
    <table class="data-table" data-testid="tenants-table">
      <thead>
        <tr>
          <th scope="col">{$t('field.name')}</th>
          <th scope="col">{$t('field.slug')}</th>
          <th scope="col">{$t('tenants.col.members')}</th>
          <th scope="col">{$t('tenants.col.apps')}</th>
          <th scope="col">{$t('field.status')}</th>
          <th scope="col" class="actions">{$t('field.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {#each tenants ?? [] as tenant (tenant.id)}
          {@const current = tenant.id === $me?.active_tenant?.id}
          <tr data-tenant-id={tenant.id} data-slug={tenant.slug}>
            <td>
              <span class="primary">{tenant.name}</span>
              {#if current}
                <span class="here"><Tag tone="accent" size="sm">{$t('tenants.current')}</Tag></span>
              {/if}
            </td>
            <td class="meta">{tenant.slug}</td>
            <td class="num">{tenant.member_count}</td>
            <td class="num">{tenant.app_count}</td>
            <td>
              {#if tenant.active}
                <Pill tone="ok">{$t('status.active')}</Pill>
              {:else}
                <Pill tone="muted">{$t('status.inactive')}</Pill>
              {/if}
            </td>
            <td class="actions">
              <span class="row-actions">
                {#if tenant.active && !current}
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={DoorOpen}
                    disabled={entering}
                    onclick={() => void enter(tenant)}
                  >
                    {$t('tenants.action.enter')}
                  </Button>
                {/if}
                <Menu
                  label={$t('tenants.actions', { name: tenant.name })}
                  triggerClass="row-menu"
                  testid="tenant-actions"
                >
                  {#snippet trigger()}<Ellipsis size={18} />{/snippet}
                  <MenuItem icon={Pencil} onSelect={() => openRename(tenant)}>
                    {$t('tenants.action.rename')}
                  </MenuItem>
                  {#if tenant.active}
                    <MenuItem icon={PowerOff} onSelect={() => void setActive(tenant, false)}>
                      {$t('tenants.action.deactivate')}
                    </MenuItem>
                  {:else}
                    <MenuItem icon={Power} onSelect={() => void setActive(tenant, true)}>
                      {$t('tenants.action.activate')}
                    </MenuItem>
                  {/if}
                  <MenuSeparator />
                  <MenuItem icon={Trash} danger onSelect={() => (deleting = tenant)}>
                    {$t('action.delete')}
                  </MenuItem>
                </Menu>
              </span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if tenants && tenants.length === 0}
      <EmptyState
        framed={false}
        icon={Building}
        title={$t('tenants.empty.title')}
        description={$t('tenants.empty.text')}
      />
    {:else if !tenants}
      <div class="table-state">
        {#if failed}
          <Button variant="secondary" onclick={() => void load()}>{$t('action.retry')}</Button>
        {:else}
          <Spinner size={20} />
        {/if}
      </div>
    {/if}
  </div>
</section>

<TenantModal open={modalOpen} tenant={editing} onClose={() => (modalOpen = false)} {onSaved} />
<TenantDeleteModal tenant={deleting} onClose={() => (deleting = null)} {onDeleted} />

<style>
  .here {
    margin-left: var(--space-2);
    vertical-align: middle;
  }
</style>
