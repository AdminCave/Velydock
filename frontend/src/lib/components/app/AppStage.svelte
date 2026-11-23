<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import Ban from '@lucide/svelte/icons/ban';
  import KeyboardOff from '@lucide/svelte/icons/keyboard-off';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Ghost from '@lucide/svelte/icons/ghost';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Button from '$lib/components/ui/Button.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { startFrameFocusGuard } from '$lib/frameFocus';
  import { openInNewTab, presentation } from '$lib/frames';
  import { t } from '$lib/i18n';
  import { activateFrame, dropFrame, frames, loadApps, workspace } from '$lib/stores/workspace';
  import { showError, showToast } from '$lib/stores/toasts';
  import AppFrame from './AppFrame.svelte';
  import AppIcon from './AppIcon.svelte';

  interface Props {
    /** The app of the current /app/:id route, or null on any other page. */
    appId: string | null;
  }

  let { appId }: Props = $props();

  const apps = $derived($workspace.apps);
  const app = $derived(appId ? (apps.find((a) => a.id === appId) ?? null) : null);
  const mode = $derived(app ? presentation(app) : null);

  // Reload counters per app; bumping one re-creates that app's frame.
  let nonces = $state<Record<string, number>>({});

  // The app on screen, if it was unloaded for taking the keyboard focus (see below). It
  // then stays unloaded until the user asks for it again or comes back to it.
  let closed = $state<string | null>(null);

  // Opening an app marks its frame as the most recently used one (and mounts it).
  $effect(() => {
    if (!app || mode !== 'frame') return;
    const id = app.id;
    untrack(() => {
      if (closed !== id) activateFrame(id);
    });
  });
  $effect(() => {
    const shown = appId;
    untrack(() => {
      if (closed !== null && closed !== shown) closed = null;
    });
  });

  // Kept-alive frames go on running while they are hidden, and a frame can focus itself:
  // the keys typed into Velydock or into the app on screen would then arrive in a hidden
  // app. The guard takes the focus back (lib/frameFocus.ts) and has a frame unloaded that
  // took it while it was not on screen; the user is told which app that was and why.
  const framesAlive = $derived($frames.length > 0);
  $effect(() => {
    if (!framesAlive) return;
    return untrack(() => startFrameFocusGuard({ onUnload: closeForFocus }));
  });

  function closeForFocus(frame: HTMLIFrameElement) {
    const id = frame.dataset.appId;
    if (!id) return;
    const name = apps.find((a) => a.id === id)?.name ?? frame.title;
    if (id === appId) closed = id;
    dropFrame(id);
    // Stays until it is dismissed: somebody typing a password looks at the keyboard.
    showToast($t('app.focusTaken.closed', { name }), 'error', 0);
  }

  function reopen() {
    if (!app) return;
    closed = null;
    activateFrame(app.id);
  }

  function reload() {
    if (!app) return;
    nonces[app.id] = (nonces[app.id] ?? 0) + 1;
  }

  function host(url: string | null | undefined): string {
    if (!url) return '';
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
</script>

<section class="stage" hidden={appId === null} aria-label={app?.name ?? $t('app.view')}>
  {#if appId !== null && app}
    <header class="bar">
      <span class="glyph"><AppIcon name={app.icon_name} url={app.icon_url} size={18} /></span>
      <h1 class="name">{app.name}</h1>
      {#if app.url}<span class="host mono">{host(app.url)}</span>{/if}
      <span class="spacer"></span>
      {#if mode === 'frame'}
        <button type="button" class="tool" data-testid="app-reload" onclick={reload}>
          <RefreshCw size={15} />
          <span class="tool-label">{$t('app.reload')}</span>
        </button>
        {#if app.type === 'embedded' && app.url}
          <button
            type="button"
            class="tool"
            data-testid="app-open-external"
            onclick={() => openInNewTab(app.url ?? '')}
          >
            <ExternalLink size={15} />
            <span class="tool-label">{$t('app.openInNewTab')}</span>
          </button>
        {/if}
      {/if}
    </header>
  {/if}

  <div class="body">
    <!-- Kept-alive frames. The list keeps its order (see frames.ts), so switching apps
         never moves an <iframe> in the DOM, which would reload it. -->
    {#each $frames as frame (frame.appId)}
      {@const framed = apps.find((a) => a.id === frame.appId)}
      {#if framed}
        <AppFrame app={framed} active={frame.appId === appId} nonce={nonces[frame.appId] ?? 0} />
      {/if}
    {/each}

    {#if appId !== null}
      {#if !app}
        <div class="center">
          {#if $workspace.status === 'loading' || $workspace.status === 'idle'}
            <Spinner size={24} />
          {:else if $workspace.status === 'error'}
            <EmptyState
              page
              framed={false}
              title={$t('app.loadFailed.title')}
              description={$t('app.loadFailed.text')}
            >
              {#snippet action()}
                <Button variant="secondary" onclick={() => loadApps().catch(showError)}>
                  {$t('action.retry')}
                </Button>
              {/snippet}
            </EmptyState>
          {:else}
            <!-- No app, so no toolbar with its name: this message is the heading of the page. -->
            <EmptyState
              page
              framed={false}
              icon={Ghost}
              title={$t('app.missing.title')}
              description={$t('app.missing.text')}
            >
              {#snippet action()}
                <a class="home-link" href="/">{$t('app.missing.back')}</a>
              {/snippet}
            </EmptyState>
          {/if}
        </div>
      {:else if closed === app.id}
        <div class="center">
          <EmptyState
            framed={false}
            icon={KeyboardOff}
            title={$t('app.focusTaken.title')}
            description={$t('app.focusTaken.text')}
          >
            {#snippet action()}
              <Button variant="secondary" iconLeft={RefreshCw} onclick={reopen}>
                {$t('app.focusTaken.reopen')}
              </Button>
            {/snippet}
          </EmptyState>
        </div>
      {:else if mode === 'blocked'}
        <div class="center">
          <div class="notice" data-testid="app-blocked-notice" role="status">
            <span class="notice-icon" aria-hidden="true"><Ban size={22} /></span>
            <h2>{$t('app.blocked.title')}</h2>
            <p>{$t('app.blocked.text', { name: app.name })}</p>
            <Button
              iconLeft={ExternalLink}
              data-testid="app-open-external"
              onclick={() => openInNewTab(app.url ?? '')}
            >
              {$t('app.openInNewTab')}
            </Button>
          </div>
        </div>
      {:else if mode === 'external'}
        <div class="center">
          <div class="notice">
            <span class="notice-icon" aria-hidden="true">
              <AppIcon name={app.icon_name} url={app.icon_url} size={22} />
            </span>
            <h2>{$t('app.external.title', { name: app.name })}</h2>
            {#if app.description}<p class="desc">{app.description}</p>{/if}
            <p>{$t('app.external.text')}</p>
            <Button
              iconLeft={ExternalLink}
              data-testid="app-open-external"
              onclick={() => openInNewTab(app.url ?? '')}
            >
              {$t('app.openInNewTab')}
            </Button>
          </div>
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .stage {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 0 0 auto;
    height: 48px;
    padding: 0 var(--space-3) 0 var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .glyph {
    display: inline-flex;
    color: var(--text-muted);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-base);
    font-weight: var(--fw-semibold);
    letter-spacing: var(--ls-snug);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .host {
    min-width: 0;
    overflow: hidden;
    color: var(--text-subtle);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
    height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }
  .tool:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .tool:active {
    transform: scale(0.97);
  }
  .body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .center {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--space-6);
    overflow-y: auto;
  }
  .notice {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    max-width: 460px;
    text-align: center;
  }
  .notice h2 {
    font-size: var(--text-xl);
    letter-spacing: var(--ls-tight);
  }
  .notice p {
    color: var(--text-muted);
  }
  .notice .desc {
    color: var(--text);
  }
  .notice-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 52px;
    height: 52px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-inset);
    color: var(--text-muted);
  }
  .home-link {
    font-weight: var(--fw-medium);
  }
  @media (max-width: 720px) {
    .bar {
      padding-left: var(--space-4);
    }
    .host {
      display: none;
    }
    /* Icon-only tools; the label stays the accessible name. */
    .tool {
      width: 36px;
      padding: 0;
      justify-content: center;
    }
    .tool-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
</style>
