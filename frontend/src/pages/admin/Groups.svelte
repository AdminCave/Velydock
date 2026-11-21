<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash from '@lucide/svelte/icons/trash';
  import Users from '@lucide/svelte/icons/users';
  import { tenantApi } from '$lib/api/client';
  import type { Group, GroupDetail } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { t } from '$lib/i18n';
  import { hasPermission } from '$lib/nav';
  import { permissions } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';
  import { restoreFocus, rowIndex, rowMenuAt } from '$lib/utils/focus';
  import GroupModal from '../../modals/GroupModal.svelte';

  // Bound to the organization this page was opened for (see tenantApi()).
  const api = tenantApi();

  const canWrite = $derived(hasPermission($permissions, 'groups:write'));
  const canReadUsers = $derived(hasPermission($permissions, 'users:read'));

  let groups = $state<Group[] | null>(null);
  let failed = $state(false);
  let modalOpen = $state(false);
  let editing = $state<Group | null>(null);

  async function load() {
    try {
      groups = await api.get('/api/v1/admin/groups');
      failed = false;
    } catch (err) {
      failed = true;
      showError(err);
    }
  }

  onMount(() => void load());

  function openCreate() {
    editing = null;
    modalOpen = true;
  }

  function openEdit(group: Group) {
    editing = group;
    modalOpen = true;
  }

  function onSaved(group: GroupDetail, created: boolean) {
    modalOpen = false;
    showToast($t(created ? 'groups.created' : 'groups.saved', { name: group.name }));
    void load();
  }

  async function remove(group: Group) {
    const ok = await confirmDialog($t('groups.delete.question', { name: group.name }), {
      title: $t('groups.delete.title'),
      detail: $t('groups.delete.detail', { members: group.member_count, apps: group.app_count }),
      confirmLabel: $t('groups.delete.confirm'),
    });
    if (!ok) return;
    const table = document.querySelector('[data-testid="groups-table"]');
    const at = rowIndex(table, 'data-group-id', group.id);
    try {
      await api.delete('/api/v1/admin/groups/{group_id}', { path: { group_id: group.id } });
      showToast($t('groups.deleted', { name: group.name }));
      await load();
      // The row is gone, and with it the button that had the focus.
      await restoreFocus(() => [rowMenuAt(table, at), document.getElementById('main')]);
    } catch (err) {
      showError(err);
    }
  }
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('groups.title')}</h1>
      <p class="page-subtitle">{$t('groups.subtitle')}</p>
    </div>
    {#if canWrite}
      <Button iconLeft={Plus} onclick={openCreate}>{$t('groups.create')}</Button>
    {/if}
  </header>

  <div class="table-wrap">
    <table class="data-table" data-testid="groups-table">
      <thead>
        <tr>
          <th scope="col">{$t('field.name')}</th>
          <th scope="col">{$t('field.description')}</th>
          <th scope="col">{$t('groups.col.members')}</th>
          <th scope="col">{$t('groups.col.apps')}</th>
          {#if canWrite}<th scope="col" class="actions">{$t('field.actions')}</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each groups ?? [] as group (group.id)}
          <tr data-group-id={group.id}>
            <td class="primary">{group.name}</td>
            <td class="muted">{group.description || '–'}</td>
            <td class="num">{group.member_count}</td>
            <td class="num">{group.app_count}</td>
            {#if canWrite}
              <td class="actions">
                <Menu
                  label={$t('groups.actions', { name: group.name })}
                  triggerClass="row-menu"
                  testid="group-actions"
                >
                  {#snippet trigger()}<Ellipsis size={18} />{/snippet}
                  <MenuItem icon={Pencil} onSelect={() => openEdit(group)}>
                    {$t('action.edit')}
                  </MenuItem>
                  <MenuItem icon={Trash} danger onSelect={() => void remove(group)}>
                    {$t('action.delete')}
                  </MenuItem>
                </Menu>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
    {#if groups && groups.length === 0}
      <EmptyState
        framed={false}
        icon={Users}
        title={$t('groups.empty.title')}
        description={$t('groups.empty.text')}
      >
        {#snippet action()}
          {#if canWrite}
            <Button variant="secondary" iconLeft={Plus} onclick={openCreate}>
              {$t('groups.create')}
            </Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else if !groups}
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

<GroupModal
  open={modalOpen}
  group={editing}
  {canReadUsers}
  onClose={() => (modalOpen = false)}
  {onSaved}
/>
