<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import BuildingComplexPlus from '@lucide/svelte/icons/building-complex-plus';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldOff from '@lucide/svelte/icons/shield-off';
  import { api } from '$lib/api/client';
  import type { SystemUser, SystemUserPage, Tenant } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import Pagination, { pageCount } from '$lib/components/ui/Pagination.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import SearchField from '$lib/components/ui/SearchField.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Tag from '$lib/components/ui/Tag.svelte';
  import { language, t } from '$lib/i18n';
  import { me, refreshMe } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';
  import { formatDateTime } from '$lib/utils/datetime';
  import AddMemberModal from '../../modals/AddMemberModal.svelte';

  const PAGE_SIZE = 25;
  const SEARCH_DELAY_MS = 300;

  let search = $state('');
  let query = $state('');
  let page = $state(1);
  let data = $state<SystemUserPage | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let tenants = $state<Tenant[]>([]);
  let adding = $state<SystemUser | null>(null);

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

  let latest = 0;
  async function load() {
    const mine = ++latest;
    loading = true;
    try {
      const result = await api.get('/api/v1/system/users', {
        query: { search: query, page, page_size: PAGE_SIZE },
      });
      if (mine !== latest) return;
      data = result;
      failed = false;
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
    void page;
    untrack(() => void load());
  });

  onMount(() => {
    api
      .get('/api/v1/system/tenants')
      .then((list) => (tenants = list))
      .catch(showError);
  });

  function isSelf(user: SystemUser): boolean {
    return user.id === $me?.user.id;
  }

  function onAdded(user: SystemUser, tenant: Tenant) {
    adding = null;
    showToast($t('systemUsers.added', { name: user.display_name, tenant: tenant.name }));
    void load();
    // Adding yourself changes your own list of organizations.
    if (isSelf(user)) refreshMe().catch(showError);
  }

  async function setSystemAdmin(user: SystemUser, grant: boolean) {
    const ok = await confirmDialog(
      $t(grant ? 'systemUsers.grant.question' : 'systemUsers.revoke.question', {
        name: user.display_name,
      }),
      {
        title: $t(grant ? 'systemUsers.grant.title' : 'systemUsers.revoke.title'),
        detail: $t(grant ? 'systemUsers.grant.detail' : 'systemUsers.revoke.detail'),
        confirmLabel: $t(grant ? 'systemUsers.action.grant' : 'systemUsers.action.revoke'),
      },
    );
    if (!ok) return;
    try {
      await api.patch('/api/v1/system/users/{user_id}', {
        path: { user_id: user.id },
        body: { is_system_admin: grant },
      });
      showToast(
        $t(grant ? 'systemUsers.granted' : 'systemUsers.revoked', { name: user.display_name }),
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
      <h1 class="page-title">{$t('systemUsers.title')}</h1>
      <p class="page-subtitle">{$t('systemUsers.subtitle')}</p>
    </div>
  </header>

  <div class="toolbar">
    <div class="grow">
      <SearchField
        bind:value={search}
        placeholder={$t('users.search')}
        label={$t('users.search')}
      />
    </div>
  </div>

  <div class="table-wrap" aria-busy={loading}>
    <table class="data-table" data-testid="system-users-table">
      <thead>
        <tr>
          <th scope="col">{$t('field.name')}</th>
          <th scope="col">{$t('field.username')}</th>
          <th scope="col">{$t('field.email')}</th>
          <th scope="col">{$t('systemUsers.col.tenants')}</th>
          <th scope="col">{$t('field.status')}</th>
          <th scope="col">{$t('field.last_login')}</th>
          <th scope="col" class="actions">{$t('field.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {#each data?.items ?? [] as user (user.id)}
          <tr data-user-id={user.id} data-username={user.username}>
            <td>
              <span class="primary">{user.display_name}</span>
              {#if user.is_system_admin}
                <span class="badge">
                  <Tag tone="accent" size="sm">{$t('users.badge.systemAdmin')}</Tag>
                </span>
              {/if}
            </td>
            <td class="meta">{user.username}</td>
            <td>{user.email ?? '–'}</td>
            <td>
              <span class="cell-tags">
                {#each user.memberships as membership (membership.tenant.id)}
                  <Tag
                    tone={membership.tenant.id === user.home_tenant?.id ? 'neutral' : 'outline'}
                    size="sm"
                    mono={false}
                  >
                    {membership.tenant.name}
                    · {membership.role ? $t(`role.${membership.role}`) : '–'}{membership.tenant
                      .id === user.home_tenant?.id
                      ? ''
                      : ` · ${$t('users.badge.guest')}`}
                  </Tag>
                {:else}
                  <span class="subtle">{$t('systemUsers.noTenant')}</span>
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
            <td class="actions">
              <Menu
                label={$t('users.actions', { name: user.display_name })}
                triggerClass="row-menu"
                testid="system-user-actions"
              >
                {#snippet trigger()}<Ellipsis size={18} />{/snippet}
                <MenuItem icon={BuildingComplexPlus} onSelect={() => (adding = user)}>
                  {$t('systemUsers.action.add')}
                </MenuItem>
                {#if user.is_system_admin}
                  <MenuItem
                    icon={ShieldOff}
                    danger
                    disabled={isSelf(user)}
                    onSelect={() => void setSystemAdmin(user, false)}
                  >
                    {$t('systemUsers.action.revoke')}
                  </MenuItem>
                {:else}
                  <MenuItem icon={ShieldCheck} onSelect={() => void setSystemAdmin(user, true)}>
                    {$t('systemUsers.action.grant')}
                  </MenuItem>
                {/if}
              </Menu>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if data && data.items.length === 0}
      <EmptyState
        framed={false}
        title={$t('users.empty.filtered.title')}
        description={$t('users.empty.filtered.text')}
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

<AddMemberModal user={adding} {tenants} onClose={() => (adding = null)} {onAdded} />

<style>
  .badge {
    margin-left: var(--space-2);
    vertical-align: middle;
  }
</style>
