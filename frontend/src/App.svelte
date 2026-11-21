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
    endedSessionToLogin,
    loadSession,
    me,
    permissions,
    session,
    sessionEnded,
    sessionExpired,
    startSessionWatch,
  } from '$lib/stores/session';
  import { instanceName } from '$lib/stores/instance';
  import { showError } from '$lib/stores/toasts';
  import { loadApps, resetWorkspace, workspace } from '$lib/stores/workspace';
  import { startThemeSync } from '$lib/theme';
  import { restoreFocus } from '$lib/utils/focus';
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

  // The element that had the keyboard focus can go with the page that is left (the menu of
  // a row that led elsewhere, such as entering an organization). The focus then lies on
  // `<body>`, and the next Tab would start at the very top: it goes to the new page instead.
  // A link in the dock or the navigation stays where it is and keeps the focus.
  let pathSeen: string | null = null;
  $effect(() => {
    const path = $location.path;
    untrack(() => {
      if (pathSeen !== null && path !== pathSeen) {
        void restoreFocus(() => [document.getElementById('main')]);
      }
      pathSeen = path;
    });
  });

  // A page that was kept after its session ended (see `sessionEnded`) is there for the
  // apps in their frames, and moving between those is fine. Going anywhere else in
  // Velydock leads to the login page, as it would have at once without the frames.
  let keptAt: string | null = null;
  $effect(() => {
    const here = $location.path + $location.search;
    const inApp = resolved.kind === 'app';
    if (!$sessionEnded) {
      keptAt = null;
      return;
    }
    untrack(() => {
      if (keptAt !== null && here !== keptAt && !inApp) endedSessionToLogin();
      else keptAt = here;
    });
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

  // A question that is open (confirm dialog) was asked about the organization that was on
  // screen then. When another one takes its place the question is withdrawn: answered
  // "yes" later, it would not mean what its text says any more.
  $effect(() => {
    void tenantId;
    untrack(() => cancelConfirm());
  });

  // Only pages of the active organization start over when it changes (switched here or
  // in another tab, deactivated, membership removed). The system administration and the
  // user's own pages do not depend on it and keep what is on them, unsaved input included.
  const pageKey = $derived(
    resolved.kind === 'page' && resolved.route.tenantScoped ? tenantId : null,
  );

  // Document title: what is on screen (page, app, or what went wrong), then the name of
  // the installation.
  const pageTitle = $derived.by(() => {
    if (status === 'error' && resolved.kind !== 'public') return $t('startup.error.title');
    if (resolved.kind === 'app') {
      const app = $workspace.apps.find((a) => a.id === activeAppId);
      if (app) return app.name;
      // Not among the user's apps (and the list is there): the page says so, the tab too.
      return $workspace.status === 'ready' ? $t('app.missing.title') : '';
    }
    if (resolved.kind === 'page' || resolved.kind === 'public') {
      return resolved.route.title ? $t(resolved.route.title) : '';
    }
    if (resolved.kind === 'forbidden') return $t('forbidden.title');
    if (resolved.kind === 'not-found') return $t('notFound.title');
    return '';
  });
  $effect(() => {
    const instance = $me?.instance_name ?? $instanceName ?? 'Velydock';
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
      page
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
      {#key pageKey}
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
