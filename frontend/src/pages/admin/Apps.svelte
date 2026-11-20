<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  import type { AdminApp } from '$lib/api/types';
  import type { Translate } from '$lib/i18n';

  /** Who sees an app, in a few words: "Alle Mitglieder", "2 Gruppen, 1 Person", "Niemand". */
  export function visibilitySummary(
    app: Pick<AdminApp, 'visible_to_all' | 'group_ids' | 'user_ids'>,
    t: Translate,
  ): string {
    if (app.visible_to_all) return t('apps.audience.all');
    const parts: string[] = [];
    const groups = app.group_ids.length;
    const users = app.user_ids.length;
    if (groups > 0) {
      parts.push(
        t(groups === 1 ? 'apps.visibility.group' : 'apps.visibility.groups', { count: groups }),
      );
    }
    if (users > 0) {
      parts.push(
        t(users === 1 ? 'apps.visibility.user' : 'apps.visibility.users', { count: users }),
      );
    }
    return parts.length > 0 ? parts.join(', ') : t('apps.visibility.nobody');
  }

  /** The list with one entry moved one place up (-1) or down (+1); null if it cannot move. */
  export function moved<T>(list: readonly T[], index: number, delta: -1 | 1): T[] | null {
    const target = index + delta;
    if (index < 0 || index >= list.length || target < 0 || target >= list.length) return null;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Blocks from '@lucide/svelte/icons/blocks';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Trash from '@lucide/svelte/icons/trash';
  import { api } from '$lib/api/client';
  import type { Group } from '$lib/api/types';
  import AppIcon from '$lib/components/app/AppIcon.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { t } from '$lib/i18n';
  import { hasPermission } from '$lib/nav';
  import { permissions } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';
  import { loadApps } from '$lib/stores/workspace';
  import AppModal from '../../modals/AppModal.svelte';

  const canReadGroups = $derived(hasPermission($permissions, 'groups:read'));
  const canReadUsers = $derived(hasPermission($permissions, 'users:read'));

  let apps = $state<AdminApp[] | null>(null);
  let groups = $state<Group[]>([]);
  let failed = $state(false);
  let busy = $state(false);
  let modalOpen = $state(false);
  let editing = $state<AdminApp | null>(null);
  let table = $state<HTMLTableElement | undefined>();

  async function load() {
    try {
      apps = await api.get('/api/v1/admin/apps');
      failed = false;
    } catch (err) {
      failed = true;
      showError(err);
    }
  }

  // The dock shows the same apps: keep it in step with every change made here.
  function refreshDock() {
    loadApps().catch(showError);
  }

  onMount(() => {
    void load();
    if (canReadGroups) {
      api
        .get('/api/v1/admin/groups')
        .then((list) => (groups = list))
        .catch(showError);
    }
  });

  function openCreate() {
    editing = null;
    modalOpen = true;
  }

  function openEdit(app: AdminApp) {
    editing = app;
    modalOpen = true;
  }

  function onSaved(app: AdminApp, created: boolean) {
    modalOpen = false;
    showToast($t(created ? 'apps.created' : 'apps.saved', { name: app.name }));
    void load();
    refreshDock();
  }

  // Moving a row takes the focus away from the button that was pressed (the row is
  // re-inserted elsewhere in the table). Put it back on the same app's button, so the
  // next press moves the same app again; at the end of the list the opposite button of
  // the row takes over. Focus that went somewhere else in the meantime is left alone.
  async function keepFocus(appId: string, delta: -1 | 1) {
    await tick();
    if (!table) return;
    const at = document.activeElement;
    if (at && at !== document.body && !table.contains(at)) return;
    const row = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')].find(
      (candidate) => candidate.dataset.appId === appId,
    );
    const [up, down] = row?.querySelectorAll<HTMLButtonElement>('.row-actions button') ?? [];
    const [wanted, other] = delta === -1 ? [up, down] : [down, up];
    (wanted && !wanted.disabled ? wanted : other)?.focus();
  }

  async function move(index: number, delta: -1 | 1) {
    if (!apps || busy) return;
    const next = moved(apps, index, delta);
    if (!next) return;
    const previous = apps;
    const appId = apps[index].id;
    apps = next; // shown at once, confirmed by the server's answer
    busy = true;
    void keepFocus(appId, delta);
    try {
      apps = await api.put('/api/v1/admin/apps/order', {
        body: { app_ids: next.map((a) => a.id) },
      });
      refreshDock();
    } catch (err) {
      apps = previous;
      showError(err);
      void load();
    } finally {
      busy = false;
      void keepFocus(appId, delta);
    }
  }

  async function recheck(app: AdminApp) {
    try {
      const updated = await api.post('/api/v1/admin/apps/{app_id}/recheck', {
        path: { app_id: app.id },
      });
      showToast(
        $t(`apps.recheck.${updated.embed_status}`, { name: updated.name }),
        updated.embed_status === 'blocked' ? 'info' : 'success',
      );
      await load();
      refreshDock();
    } catch (err) {
      showError(err);
    }
  }

  async function remove(app: AdminApp) {
    const ok = await confirmDialog($t('apps.delete.question', { name: app.name }), {
      title: $t('apps.delete.title'),
      detail: $t(app.type === 'custom' ? 'apps.delete.detailCustom' : 'apps.delete.detail'),
      confirmLabel: $t('apps.delete.confirm'),
    });
    if (!ok) return;
    try {
      await api.delete('/api/v1/admin/apps/{app_id}', { path: { app_id: app.id } });
      showToast($t('apps.deleted', { name: app.name }));
      await load();
      refreshDock();
    } catch (err) {
      showError(err);
    }
  }
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('apps.title')}</h1>
      <p class="page-subtitle">{$t('apps.subtitle')}</p>
    </div>
    <Button iconLeft={Plus} onclick={openCreate}>{$t('apps.create')}</Button>
  </header>

  <div class="table-wrap" aria-busy={busy}>
    <table bind:this={table} class="data-table" data-testid="apps-table">
      <thead>
        <tr>
          <th scope="col" class="order">{$t('apps.col.order')}</th>
          <th scope="col">{$t('field.name')}</th>
          <th scope="col">{$t('field.type')}</th>
          <th scope="col">{$t('apps.col.visibility')}</th>
          <th scope="col">{$t('field.status')}</th>
          <th scope="col">{$t('apps.col.embed')}</th>
          <th scope="col" class="actions">{$t('field.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {#each apps ?? [] as app, index (app.id)}
          <tr data-app-id={app.id}>
            <td class="order">
              <!-- Not disabled while a move is being stored: a disabled button loses the
                   keyboard focus. move() ignores presses during that time. -->
              <span class="row-actions">
                <IconButton
                  icon={ArrowUp}
                  size="sm"
                  label={$t('apps.move.up', { name: app.name })}
                  disabled={index === 0}
                  onclick={() => void move(index, -1)}
                />
                <IconButton
                  icon={ArrowDown}
                  size="sm"
                  label={$t('apps.move.down', { name: app.name })}
                  disabled={index === (apps?.length ?? 0) - 1}
                  onclick={() => void move(index, 1)}
                />
              </span>
            </td>
            <td>
              <span class="app-cell">
                <span class="app-glyph">
                  <AppIcon name={app.icon_name} url={app.icon_url} size={20} />
                </span>
                <span class="app-text">
                  <span class="primary">{app.name}</span>
                  {#if app.url}<span class="secondary">{app.url}</span>{/if}
                </span>
              </span>
            </td>
            <td>{$t(`app.type.${app.type}`)}</td>
            <td>{visibilitySummary(app, $t)}</td>
            <td>
              {#if app.enabled}
                <Pill tone="ok">{$t('status.enabled')}</Pill>
              {:else}
                <Pill tone="muted">{$t('status.disabled')}</Pill>
              {/if}
            </td>
            <td>
              {#if app.type !== 'embedded'}
                <span class="subtle">–</span>
              {:else if app.embed_status === 'ok'}
                <Pill tone="ok" title={app.embed_detail}>{$t('apps.embed.ok')}</Pill>
              {:else if app.embed_status === 'blocked'}
                <Pill tone="crit" title={app.embed_detail}>{$t('apps.embed.blocked')}</Pill>
              {:else}
                <Pill tone="warn" title={app.embed_detail}>{$t('apps.embed.unknown')}</Pill>
              {/if}
            </td>
            <td class="actions">
              <Menu
                label={$t('apps.actions', { name: app.name })}
                triggerClass="row-menu"
                testid="app-actions"
              >
                {#snippet trigger()}<Ellipsis size={18} />{/snippet}
                <MenuItem icon={Pencil} onSelect={() => openEdit(app)}>
                  {$t('action.edit')}
                </MenuItem>
                {#if app.type === 'embedded'}
                  <MenuItem icon={RefreshCw} onSelect={() => void recheck(app)}>
                    {$t('apps.recheck')}
                  </MenuItem>
                {/if}
                <MenuItem icon={Trash} danger onSelect={() => void remove(app)}>
                  {$t('action.delete')}
                </MenuItem>
              </Menu>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if apps && apps.length === 0}
      <EmptyState
        framed={false}
        icon={Blocks}
        title={$t('apps.empty.title')}
        description={$t('apps.empty.text')}
      >
        {#snippet action()}
          <Button variant="secondary" iconLeft={Plus} onclick={openCreate}>
            {$t('apps.create')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if !apps}
      <div class="table-state">
        {#if failed}
          <Button variant="secondary" onclick={() => void load()}>{$t('action.retry')}</Button>
        {:else}
          <Spinner size={20} />
        {/if}
      </div>
    {/if}
  </div>
  <p class="help">{$t('apps.orderHint')}</p>
</section>

<AppModal
  open={modalOpen}
  app={editing}
  {groups}
  {canReadUsers}
  onClose={() => (modalOpen = false)}
  {onSaved}
/>

<style>
  .order {
    width: 1%;
    white-space: nowrap;
  }
  .app-cell {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 200px;
  }
  .app-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-inset);
    color: var(--text-strong);
  }
  .app-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .app-text .secondary {
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
