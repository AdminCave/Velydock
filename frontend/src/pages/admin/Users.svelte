<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash';
  import UserCheck from '@lucide/svelte/icons/user-check';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import UserX from '@lucide/svelte/icons/user-x';
  import { api } from '$lib/api/client';
  import {
    ROLES,
    type Group,
    type Role,
    type User,
    type UserCreated,
    type UserPage,
  } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
  import Pagination, { pageCount } from '$lib/components/ui/Pagination.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import SearchField from '$lib/components/ui/SearchField.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Tag from '$lib/components/ui/Tag.svelte';
  import { language, t } from '$lib/i18n';
  import { hasPermission } from '$lib/nav';
  import { me, permissions, refreshMe } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';
  import { loadApps } from '$lib/stores/workspace';
  import { formatDateTime } from '$lib/utils/datetime';
  import TempPasswordModal from '../../modals/TempPasswordModal.svelte';
  import UserCreateModal from '../../modals/UserCreateModal.svelte';
  import UserEditModal from '../../modals/UserEditModal.svelte';

  const PAGE_SIZE = 25;
  const SEARCH_DELAY_MS = 300;

  const canWrite = $derived(hasPermission($permissions, 'users:write'));
  const canAssignRoles = $derived(hasPermission($permissions, 'roles:assign'));
  const canReadGroups = $derived(hasPermission($permissions, 'groups:read'));
  const canEditGroups = $derived(hasPermission($permissions, 'groups:write'));

  let search = $state('');
  let query = $state('');
  let role = $state<Role | 'all'>('all');
  let status = $state<'all' | 'active' | 'inactive'>('all');
  let page = $state(1);

  let data = $state<UserPage | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let groups = $state<Group[]>([]);

  let creating = $state(false);
  let editing = $state<User | null>(null);
  let secret = $state<{ password: string; name: string; username: string } | null>(null);

  // The search runs on the server; typing is debounced so not every key is a request.
  $effect(() => {
    const value = search.trim();
    const timer = setTimeout(() => {
      if (value !== untrack(() => query)) {
        query = value;
        page = 1;
      }
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  });

  // Only the answer to the latest request counts.
  let latest = 0;
  async function load() {
    const mine = ++latest;
    loading = true;
    try {
      const result = await api.get('/api/v1/admin/users', {
        query: {
          search: query,
          role: role === 'all' ? null : role,
          active: status === 'all' ? null : status === 'active',
          page,
          page_size: PAGE_SIZE,
        },
      });
      if (mine !== latest) return;
      data = result;
      failed = false;
      // The last page can vanish when users are removed.
      const pages = pageCount(result.total, PAGE_SIZE);
      if (page > pages) page = pages;
    } catch (err) {
      if (mine !== latest) return;
      failed = true;
      showError(err);
    } finally {
      if (mine === latest) loading = false;
    }
  }

  $effect(() => {
    void query;
    void role;
    void status;
    void page;
    untrack(() => void load());
  });

  onMount(() => {
    if (!canReadGroups) return;
    api
      .get('/api/v1/admin/groups')
      .then((list) => (groups = list))
      .catch(showError);
  });

  const roleFilter = $derived([
    { value: 'all' as const, label: $t('users.filter.allRoles') },
    ...ROLES.map((value) => ({ value, label: $t(`role.${value}`) })),
  ]);
  const statusFilter = $derived([
    { value: 'all' as const, label: $t('users.filter.allStatus') },
    { value: 'active' as const, label: $t('status.active') },
    { value: 'inactive' as const, label: $t('status.inactive') },
  ]);
  const filtered = $derived(query !== '' || role !== 'all' || status !== 'all');

  function isSelf(user: User): boolean {
    return user.id === $me?.user.id;
  }

  /** Managed accounts are deleted, guests only lose access to this organization. */
  function canRemove(user: User): boolean {
    if (isSelf(user)) return false;
    return user.managed ? user.can_edit_identity : user.can_edit_membership;
  }

  // After every write the page is read once more: sorting, paging and totals are the
  // server's business.
  function onCreated(result: UserCreated) {
    creating = false;
    if (result.temporary_password) {
      secret = {
        password: result.temporary_password,
        name: result.user.display_name,
        username: result.user.username,
      };
    } else {
      showToast($t('users.created.emailSent', { name: result.user.display_name }));
    }
    void load();
  }

  function onSaved(user: User) {
    editing = null;
    showToast($t('users.saved', { name: user.display_name }));
    void load();
    // The own row: name and e-mail are shown in the dock and on the profile page, and the
    // own groups decide which apps the dock offers.
    if (isSelf(user)) {
      refreshMe().catch(showError);
      if (hasPermission($permissions, 'workspace:use')) loadApps().catch(showError);
    }
  }

  async function setActive(user: User, active: boolean) {
    if (!active) {
      const ok = await confirmDialog($t('users.deactivate.question', { name: user.display_name }), {
        title: $t('users.deactivate.title'),
        detail: $t('users.deactivate.detail'),
        confirmLabel: $t('users.action.deactivate'),
      });
      if (!ok) return;
    }
    try {
      await api.patch('/api/v1/admin/users/{user_id}', {
        path: { user_id: user.id },
        body: { active },
      });
      showToast(
        $t(active ? 'users.reactivated' : 'users.deactivated', { name: user.display_name }),
      );
      await load();
    } catch (err) {
      showError(err);
    }
  }

  async function resetPassword(user: User) {
    const ok = await confirmDialog($t('users.reset.question', { name: user.display_name }), {
      title: $t('users.reset.title'),
      detail: $t('users.reset.detail'),
      confirmLabel: $t('users.action.resetPassword'),
    });
    if (!ok) return;
    try {
      const result = await api.post('/api/v1/admin/users/{user_id}/reset-password', {
        path: { user_id: user.id },
      });
      secret = {
        password: result.temporary_password,
        name: user.display_name,
        username: user.username,
      };
    } catch (err) {
      showError(err);
    }
  }

  async function endSessions(user: User) {
    const ok = await confirmDialog($t('users.sessions.question', { name: user.display_name }), {
      title: $t('users.sessions.title'),
      detail: $t('users.sessions.detail'),
      confirmLabel: $t('users.action.endSessions'),
      tone: 'neutral',
    });
    if (!ok) return;
    try {
      await api.post('/api/v1/admin/users/{user_id}/end-sessions', { path: { user_id: user.id } });
      showToast($t('users.sessions.done', { name: user.display_name }));
    } catch (err) {
      showError(err);
    }
  }

  async function remove(user: User) {
    // Say plainly which of the two very different things is about to happen.
    const ok = user.managed
      ? await confirmDialog($t('users.delete.question', { name: user.display_name }), {
          title: $t('users.delete.title'),
          detail: $t('users.delete.detail'),
          confirmLabel: $t('users.action.delete'),
        })
      : await confirmDialog($t('users.removeGuest.question', { name: user.display_name }), {
          title: $t('users.removeGuest.title'),
          detail: $t('users.removeGuest.detail'),
          confirmLabel: $t('users.action.removeGuest'),
        });
    if (!ok) return;
    try {
      const result = await api.delete('/api/v1/admin/users/{user_id}', {
        path: { user_id: user.id },
      });
      showToast(
        $t(result.deleted_identity ? 'users.deleted' : 'users.removed', {
          name: user.display_name,
        }),
      );
      await load();
    } catch (err) {
      showError(err);
    }
  }
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('users.title')}</h1>
      <p class="page-subtitle">{$t('users.subtitle')}</p>
    </div>
    {#if canWrite}
      <Button iconLeft={UserPlus} onclick={() => (creating = true)}>{$t('users.create')}</Button>
    {/if}
  </header>

  <div class="toolbar">
    <div class="grow">
      <SearchField
        bind:value={search}
        placeholder={$t('users.search')}
        label={$t('users.search')}
      />
    </div>
    <Select
      bind:value={role}
      options={roleFilter}
      ariaLabel={$t('users.filter.role')}
      testid="users-filter-role"
      onChange={() => (page = 1)}
    />
    <Select
      bind:value={status}
      options={statusFilter}
      ariaLabel={$t('users.filter.status')}
      testid="users-filter-status"
      onChange={() => (page = 1)}
    />
  </div>

  <div class="table-wrap" aria-busy={loading}>
    <table class="data-table" data-testid="users-table">
      <thead>
        <tr>
          <th scope="col">{$t('field.name')}</th>
          <th scope="col">{$t('field.username')}</th>
          <th scope="col">{$t('field.email')}</th>
          <th scope="col">{$t('field.role')}</th>
          <th scope="col">{$t('field.groups')}</th>
          <th scope="col">{$t('field.status')}</th>
          <th scope="col">{$t('field.last_login')}</th>
          {#if canWrite}<th scope="col" class="actions">{$t('field.actions')}</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each data?.items ?? [] as user (user.id)}
          <tr data-user-id={user.id} data-username={user.username}>
            <td>
              <span class="primary">{user.display_name}</span>
              <span class="badges">
                {#if isSelf(user)}<Tag tone="outline" size="sm">{$t('users.badge.you')}</Tag>{/if}
                {#if !user.managed}
                  <Tag tone="outline" size="sm">{$t('users.badge.guest')}</Tag>
                {/if}
                {#if user.is_system_admin}
                  <Tag tone="accent" size="sm">{$t('users.badge.systemAdmin')}</Tag>
                {/if}
              </span>
            </td>
            <td class="meta">{user.username}</td>
            <td>{user.email ?? '–'}</td>
            <td>{user.role ? $t(`role.${user.role}`) : '–'}</td>
            <td>
              <span class="cell-tags">
                {#each user.groups as group (group.id)}
                  <Tag tone="neutral" size="sm" mono={false}>{group.name}</Tag>
                {:else}
                  <span class="subtle">–</span>
                {/each}
              </span>
            </td>
            <td>
              {#if user.active}
                <Pill tone="ok">{$t('status.active')}</Pill>
              {:else}
                <Pill tone="muted">{$t('status.inactive')}</Pill>
              {/if}
            </td>
            <td class="meta">
              {formatDateTime(user.last_login_at, $language) || $t('users.neverSignedIn')}
            </td>
            {#if canWrite}
              <td class="actions">
                <Menu
                  label={$t('users.actions', { name: user.display_name })}
                  triggerClass="row-menu"
                  testid="user-actions"
                >
                  {#snippet trigger()}<Ellipsis size={18} />{/snippet}
                  <MenuItem icon={Pencil} onSelect={() => (editing = user)}>
                    {$t('action.edit')}
                  </MenuItem>
                  <!-- Not for the own account: the API refuses all three there (`self_action`).
                       The own password is changed on the account page, and signing out ends
                       the own session. -->
                  {#if user.can_edit_identity && !isSelf(user)}
                    <MenuItem icon={KeyRound} onSelect={() => void resetPassword(user)}>
                      {$t('users.action.resetPassword')}
                    </MenuItem>
                    <MenuItem icon={LogOut} onSelect={() => void endSessions(user)}>
                      {$t('users.action.endSessions')}
                    </MenuItem>
                    {#if user.active}
                      <MenuItem icon={UserX} onSelect={() => void setActive(user, false)}>
                        {$t('users.action.deactivate')}
                      </MenuItem>
                    {:else}
                      <MenuItem icon={UserCheck} onSelect={() => void setActive(user, true)}>
                        {$t('users.action.reactivate')}
                      </MenuItem>
                    {/if}
                  {/if}
                  {#if canRemove(user)}
                    <MenuSeparator />
                    <MenuItem icon={Trash} danger onSelect={() => void remove(user)}>
                      {user.managed ? $t('users.action.delete') : $t('users.action.removeGuest')}
                    </MenuItem>
                  {/if}
                </Menu>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
    {#if data && data.items.length === 0}
      <EmptyState
        framed={false}
        title={filtered ? $t('users.empty.filtered.title') : $t('users.empty.title')}
        description={filtered ? $t('users.empty.filtered.text') : $t('users.empty.text')}
      />
    {:else if !data}
      <div class="table-state">
        {#if failed}
          <Button variant="secondary" onclick={() => void load()}>{$t('action.retry')}</Button>
        {:else}
          <Spinner size={20} />
        {/if}
      </div>
    {/if}
  </div>

  {#if data}
    <Pagination
      {page}
      pageSize={PAGE_SIZE}
      total={data.total}
      disabled={loading}
      onChange={(next) => (page = next)}
    />
  {/if}
</section>

<UserCreateModal
  open={creating}
  {groups}
  {canAssignRoles}
  onClose={() => (creating = false)}
  {onCreated}
/>
<UserEditModal
  user={editing}
  {groups}
  {canEditGroups}
  isSelf={editing ? isSelf(editing) : false}
  onClose={() => (editing = null)}
  {onSaved}
/>
<TempPasswordModal
  password={secret?.password ?? null}
  name={secret?.name ?? ''}
  username={secret?.username ?? ''}
  onClose={() => (secret = null)}
/>

<style>
  .badges {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-left: var(--space-2);
    vertical-align: middle;
  }
  .badges:empty {
    display: none;
  }
</style>
