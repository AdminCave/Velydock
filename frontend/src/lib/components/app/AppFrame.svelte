<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  /** After this long without the frame's `load` event the page says that nothing has arrived. */
  export const SLOW_AFTER_MS = 10_000;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { get } from 'svelte/store';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { tenantApi } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import type { WorkspaceApp } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { frameAttributes, openInNewTab } from '$lib/frames';
  import { language, t } from '$lib/i18n';
  import { resolvedTheme } from '$lib/theme';

  interface Props {
    /** An embedded or a custom app (external apps never get a frame). */
    app: WorkspaceApp;
    /** Only the active frame is visible; the others stay mounted but hidden. */
    active: boolean;
    /** Changes whenever the user asks to reload the frame. */
    nonce?: number;
  }

  let { app, active, nonce = 0 }: Props = $props();

  // Bound to the organization whose app this is (see tenantApi()).
  const api = tenantApi();

  // Primitives, so a refreshed app list (new objects, same values) does not reload the frame.
  const id = $derived(app.id);
  const type = $derived(app.type === 'custom' ? 'custom' : 'embedded');
  const url = $derived(app.url ?? null);
  const permissions = $derived(app.frame_permissions.join(' '));
  const reload = $derived(nonce);

  // Custom apps: `sandbox` without allow-same-origin and no `allow` attribute, always.
  // The values come from frameAttributes() and nowhere else.
  const attrs = $derived(frameAttributes(type, permissions ? permissions.split(' ') : []));

  let src = $state<string | null>(null);
  let loading = $state(true);
  let failure = $state<unknown>(null);
  let attempt = $state(0);
  // Nothing has loaded for a while. All a page learns about a frame of another site is
  // its `load` event: whether the app is slow, unreachable or refuses to be embedded
  // cannot be told apart from here, and the notice does not pretend it can. Every (re)load
  // gets its own time.
  let slow = $state(false);
  // The user has closed the notice: the app works for them, whatever `load` says (a page
  // with one slow picture has not "loaded" either).
  let dismissed = $state(false);
  $effect(() => {
    void reload;
    void attempt;
    slow = false;
    dismissed = false;
    if (!loading) return;
    const timer = setTimeout(() => (slow = true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  });

  // (Re)load the frame. Embedded apps load their own address. Custom apps are served from
  // the sandbox host under a short-lived signed address, so every (re)load asks for a
  // fresh one.
  $effect(() => {
    void reload;
    void attempt;
    const appId = id;
    const kind = type;
    const address = url;
    let cancelled = false;
    untrack(() => {
      loading = true;
      failure = null;
    });
    if (kind === 'custom') {
      untrack(() => (src = null));
      api
        .post('/api/v1/workspace/apps/{app_id}/launch', {
          path: { app_id: appId },
          body: { theme: get(resolvedTheme), language: get(language) },
        })
        .then((launch) => {
          if (!cancelled) src = launch.url;
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          failure = err;
          loading = false;
        });
    } else {
      untrack(() => (src = address));
    }
    return () => {
      cancelled = true;
    };
  });
</script>

<div class="slot" hidden={!active}>
  {#if src}
    {#key `${reload}:${attempt}`}
      <iframe
        class="frame"
        title={app.name}
        {src}
        sandbox={attrs.sandbox}
        allow={attrs.allow}
        referrerpolicy={attrs.referrerpolicy}
        data-testid="app-frame"
        data-app-id={app.id}
        data-app-type={app.type}
        onload={() => (loading = false)}
      ></iframe>
    {/key}
  {/if}
  {#if failure}
    <div class="message">
      <Callout tone="danger" role="alert" title={$t('app.launchFailed.title')}>
        {errorMessage(failure, $t)}
        {#snippet action()}
          <Button variant="secondary" size="sm" onclick={() => (attempt += 1)}>
            {$t('action.retry')}
          </Button>
        {/snippet}
      </Callout>
    </div>
  {:else if loading && slow && !dismissed}
    <!-- In a corner of the frame, not over all of it: the app may be showing something
         although it has not finished loading. -->
    <div class="slow">
      <Callout tone="neutral" role="status" title={$t('app.slow.title')} testid="app-slow">
        {$t('app.slow.text')}
        {#snippet action()}
          {#if app.type === 'embedded' && app.url}
            <Button
              variant="secondary"
              size="sm"
              iconLeft={ExternalLink}
              onclick={() => openInNewTab(app.url ?? '')}
            >
              {$t('app.openInNewTab')}
            </Button>
          {/if}
          <Button variant="ghost" size="sm" onclick={() => (dismissed = true)}>
            {$t('app.slow.dismiss')}
          </Button>
        {/snippet}
      </Callout>
    </div>
  {:else if loading}
    <div class="loading"><Spinner size={22} /></div>
  {/if}
</div>

<style>
  .slot {
    position: absolute;
    inset: 0;
    display: flex;
  }
  .frame {
    flex: 1;
    width: 100%;
    height: 100%;
    border: 0;
    /* Pages without their own background would otherwise show the dark shell through. */
    background: #fff;
    color-scheme: normal;
  }
  .slow {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    max-width: min(380px, calc(100% - 2 * var(--space-4)));
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    box-shadow: var(--shadow-pop);
  }
  .loading {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    display: inline-flex;
    padding: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: var(--surface-raised);
    color: var(--text-muted);
    pointer-events: none;
  }
  .message {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--space-6);
    background: var(--bg);
  }
  .message > :global(*) {
    max-width: 520px;
  }
</style>
