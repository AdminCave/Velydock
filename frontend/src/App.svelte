<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Mark from '$lib/components/brand/Mark.svelte';
  import Shell from '$lib/components/layout/Shell.svelte';
  import SubNav from '$lib/components/layout/SubNav.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import ConfirmDialog, { cancelConfirm } from '$lib/components/ui/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Toast from '$lib/components/ui/Toast.svelte';
  import { t } from '$lib/i18n';
  import { hasPermission, isAdminArea } from '$lib/nav';
  import { location, loginPath, navigate, startRouter } from '$lib/router';
  import { resolveRoute } from '$lib/routing';
  import {
    loadSession,
    me,
    permissions,
    session,
    sessionExpired,
    startSessionWatch,
  } from '$lib/stores/session';
  import { showError } from '$lib/stores/toasts';
  import { loadApps, resetWorkspace, workspace } from '$lib/stores/workspace';
  import { startThemeSync } from '$lib/theme';
  import NotFound from './pages/NotFound.svelte';
  import { routes } from './routes';

  onMount(() => {
    const stopRouter = startRouter();
    const stopTheme = startThemeSync();
    const stopWatch = startSessionWatch();
    void loadSession();
    return () => {
      stopRouter();
      stopTheme();
      stopWatch();
    };
  });

  const status = $derived($session.status);
  const resolved = $derived(resolveRoute(routes, $location.path, $permissions));
  const activeAppId = $derived(resolved.kind === 'app' ? (resolved.params.id ?? null) : null);

  // Without a session every page but the login page leads to the login page, which
  // remembers where the user wanted to go and, if a session that was in use has just
  // ended, says so.
  $effect(() => {
    if (status !== 'anonymous' || resolved.kind === 'public') return;
    const from = untrack(() => $location);
    const expired = untrack(() => $sessionExpired);
    cancelConfirm();
    navigate(loginPath(from, { expired }), { replace: true });
  });

  $effect(() => {
    if (status === 'ready' && resolved.kind === 'redirect') {
      navigate(resolved.to, { replace: true });
    }
  });

  // The apps belong to the active organization: entering another one (or signing in)
  // loads its apps and drops the frames of the previous one. Primitives on purpose, so a
  // settings change (new `me` object, same organization) leaves open frames alone.
  const tenantId = $derived($me?.active_tenant?.id ?? null);
  const canUseWorkspace = $derived(hasPermission($permissions, 'workspace:use'));
  $effect(() => {
    const load = tenantId !== null && canUseWorkspace;
    untrack(() => {
      resetWorkspace(load ? 'loading' : 'ready');
      if (load) loadApps().catch(showError);
    });
  });

  // Document title: page or app name, then the instance name.
  const pageTitle = $derived.by(() => {
    if (resolved.kind === 'app') {
      return $workspace.apps.find((a) => a.id === activeAppId)?.name ?? '';
    }
    if (resolved.kind === 'page' || resolved.kind === 'public') {
      return resolved.route.title ? $t(resolved.route.title) : '';
    }
    if (resolved.kind === 'not-found' || resolved.kind === 'forbidden') {
      return $t('notFound.title');
    }
    return '';
  });
  $effect(() => {
    const instance = $me?.instance_name ?? 'Velydock';
    document.title = pageTitle ? `${pageTitle} · ${instance}` : instance;
  });
</script>

{#if status === 'loading'}
  <div class="splash" role="status" aria-label={$t('state.loading')}>
    <Mark size={44} />
    <Spinner size={18} />
  </div>
{:else if resolved.kind === 'public'}
  {@const Page = resolved.route.component}
  {#if Page}<Page />{/if}
{:else if status === 'error'}
  <div class="splash">
    <EmptyState
      framed={false}
      title={$t('startup.error.title')}
      description={$t('startup.error.text')}
    >
      {#snippet action()}
        <Button onclick={() => window.location.reload()}>{$t('action.retry')}</Button>
      {/snippet}
    </EmptyState>
  </div>
{:else if status === 'ready' && $me}
  <Shell me={$me} path={$location.path} {activeAppId}>
    {#if resolved.kind === 'page'}
      {@const Page = resolved.route.component}
      <!-- A page shows data of the active organization: when that changes (switched here
           or in another tab, deactivated, membership removed), the page starts over. -->
      {#key tenantId}
        {#if isAdminArea($location.path)}
          <div class="page">
            <SubNav
              path={$location.path}
              permissions={$permissions}
              tenantName={$me.active_tenant?.name}
            />
            {#if Page}<Page />{/if}
          </div>
        {:else if Page}
          <Page />
        {/if}
      {/key}
    {:else if resolved.kind === 'forbidden'}
      <NotFound forbidden />
    {:else if resolved.kind === 'not-found'}
      <NotFound />
    {/if}
  </Shell>
{:else}
  <!-- Anonymous on a protected page: the effect above is on its way to the login page. -->
  <div class="splash"><Mark size={44} /></div>
{/if}

<Toast />
<ConfirmDialog />

<style>
  .splash {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-6);
    height: 100%;
    color: var(--text-strong);
  }
</style>
