<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Blocks from '@lucide/svelte/icons/blocks';
  import LogOut from '@lucide/svelte/icons/log-out';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Unplug from '@lucide/svelte/icons/unplug';
  import type { WorkspaceApp } from '$lib/api/types';
  import AppIcon from '$lib/components/app/AppIcon.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { openInNewTab } from '$lib/frames';
  import { t } from '$lib/i18n';
  import { hasPermission } from '$lib/nav';
  import { me, permissions, refreshMe, signOut } from '$lib/stores/session';
  import { showError } from '$lib/stores/toasts';
  import { loadApps, workspace } from '$lib/stores/workspace';
  import { dayPart } from '$lib/utils/datetime';

  const firstName = $derived($me?.user.first_name || $me?.user.display_name || '');
  const greeting = $derived($t(`dashboard.greeting.${dayPart()}`, { name: firstName }));
  const canManageApps = $derived(hasPermission($permissions, 'apps:manage'));
  const isSystemAdmin = $derived(hasPermission($permissions, 'system:admin'));

  let checking = $state(false);

  async function checkAgain() {
    checking = true;
    try {
      await refreshMe();
    } catch (err) {
      showError(err);
    } finally {
      checking = false;
    }
  }

  // External apps open in a new tab right away; the link still leads to the app view.
  function onTileClick(event: MouseEvent, app: WorkspaceApp) {
    if (app.type !== 'external' || !app.url) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    openInNewTab(app.url);
  }
</script>

{#if $me && !$me.active_tenant}
  <div class="page page-narrow" data-testid="no-tenant-page">
    <!-- No organization at all, or only deactivated ones: two different things to ask for. -->
    <EmptyState
      page
      icon={Unplug}
      title={$me.inactive_memberships > 1
        ? $t('noTenant.inactive.titleMany')
        : $me.inactive_memberships === 1
          ? $t('noTenant.inactive.title')
          : $t('noTenant.title')}
      description={$me.inactive_memberships > 0
        ? $t('noTenant.inactive.text')
        : $t('noTenant.text')}
    >
      {#snippet action()}
        <div class="no-tenant-actions">
          <Button variant="secondary" iconLeft={RefreshCw} loading={checking} onclick={checkAgain}>
            {$t('noTenant.retry')}
          </Button>
          <Button iconLeft={LogOut} onclick={() => void signOut()}>{$t('nav.signOut')}</Button>
        </div>
      {/snippet}
    </EmptyState>
    <p class="account mono">
      {$t('noTenant.account', { username: $me.user.username })}
    </p>
    {#if isSystemAdmin}
      <p class="sysadmin">
        {$t('noTenant.systemAdmin')}
        <a href="/system/tenants">{$t('nav.system.tenants')}</a>
      </p>
    {/if}
  </div>
{:else if $me}
  <div class="page">
    <header class="hero">
      <p class="eyebrow">{$me.active_tenant?.name}</p>
      <h1 class="greeting">{greeting}</h1>
      <p class="lead">{$t('dashboard.lead')}</p>
    </header>

    {#if $workspace.status === 'loading' || $workspace.status === 'idle'}
      <div class="state"><Spinner size={22} /></div>
    {:else if $workspace.status === 'error'}
      <EmptyState title={$t('app.loadFailed.title')} description={$t('app.loadFailed.text')}>
        {#snippet action()}
          <Button variant="secondary" onclick={() => loadApps().catch(showError)}>
            {$t('action.retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if $workspace.apps.length === 0}
      <EmptyState
        icon={Blocks}
        title={$t('dashboard.empty.title')}
        description={canManageApps ? $t('dashboard.empty.textAdmin') : $t('dashboard.empty.text')}
      >
        {#snippet action()}
          {#if canManageApps}
            <a class="cta" href="/admin/apps">{$t('dashboard.empty.cta')}</a>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <ul class="tiles" aria-label={$t('dashboard.apps')}>
        {#each $workspace.apps as app (app.id)}
          <li>
            <a
              class="tile"
              href="/app/{app.id}"
              data-testid="app-tile"
              data-app-id={app.id}
              data-app-type={app.type}
              onclick={(e) => onTileClick(e, app)}
            >
              <span class="tile-icon">
                <AppIcon name={app.icon_name} url={app.icon_url} size={24} />
              </span>
              <span class="tile-text">
                <span class="tile-name">{app.name}</span>
                {#if app.description}<span class="tile-desc">{app.description}</span>{/if}
              </span>
              {#if app.type === 'external'}
                <span class="tile-ext" title={$t('app.opensInNewTab')}>
                  <ArrowUpRight size={16} />
                  <span class="visually-hidden">{$t('app.opensInNewTab')}</span>
                </span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .hero {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-6) 0 var(--space-4);
  }
  .greeting {
    font-size: var(--text-3xl);
    font-weight: var(--fw-semibold);
    letter-spacing: var(--ls-tighter);
    line-height: var(--lh-tight);
    overflow-wrap: anywhere;
  }
  .lead {
    color: var(--text-muted);
    font-size: var(--text-lg);
  }
  .state {
    display: flex;
    justify-content: center;
    padding: var(--space-16);
    color: var(--text-muted);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tiles li {
    display: flex;
    min-width: 0;
  }
  .tile {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    flex: 1;
    min-width: 0;
    min-height: 104px;
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    transition:
      transform var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .tile:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-md);
    text-decoration: none;
    transform: translateY(-2px);
  }
  .tile-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 48px;
    height: 48px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
    color: var(--text-strong);
  }
  .tile-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
  }
  .tile-name {
    color: var(--text-strong);
    font-size: var(--text-md);
    font-weight: var(--fw-semibold);
    letter-spacing: var(--ls-snug);
    overflow-wrap: anywhere;
  }
  .tile-desc {
    display: -webkit-box;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--text-sm);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .tile-ext {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-subtle);
  }
  .cta {
    font-weight: var(--fw-medium);
  }
  .no-tenant-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-3);
  }
  .account,
  .sysadmin {
    color: var(--text-subtle);
    font-size: var(--text-sm);
    text-align: center;
  }
  @media (max-width: 720px) {
    .hero {
      padding-top: var(--space-2);
    }
    .greeting {
      font-size: var(--text-2xl);
    }
    .lead {
      font-size: var(--text-md);
    }
  }
</style>
