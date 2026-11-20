<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Me } from '$lib/api/types';
  import AppStage from '$lib/components/app/AppStage.svelte';
  import { t } from '$lib/i18n';
  import { dockEdge } from '$lib/nav';
  import { narrowViewport } from '$lib/stores/media';
  import { workspace } from '$lib/stores/workspace';
  import Dock from './Dock.svelte';

  interface Props {
    me: Me;
    path: string;
    /** Id of the app shown in the app view, or null on any other page. */
    activeAppId: string | null;
    children: Snippet;
  }

  let { me, path, activeAppId, children }: Props = $props();

  const position = $derived(me.settings.nav_position);
  const edge = $derived(dockEdge(position, $narrowViewport));

  // Toasts keep clear of the dock (see Toast.svelte).
  $effect(() => {
    document.body.dataset.dockEdge = edge;
    return () => {
      delete document.body.dataset.dockEdge;
    };
  });
</script>

<div class="shell" data-edge={edge}>
  <a class="skip" href="#main">{$t('shell.skip')}</a>
  <Dock
    {me}
    apps={$workspace.apps}
    {position}
    {edge}
    compact={$narrowViewport}
    {path}
    {activeAppId}
  />
  <main id="main" class="content" tabindex="-1">
    <!-- The stage stays mounted on every page so opened app frames keep their state. -->
    <AppStage appId={activeAppId} />
    {#if activeAppId === null}
      <div class="scroll">
        {@render children()}
      </div>
    {/if}
  </main>
</div>

<style>
  .shell {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  .shell[data-edge='left'] {
    grid-template: 'dock content' minmax(0, 1fr) / auto minmax(0, 1fr);
  }
  .shell[data-edge='right'] {
    grid-template: 'content dock' minmax(0, 1fr) / minmax(0, 1fr) auto;
  }
  .shell[data-edge='top'] {
    grid-template:
      'dock' auto
      'content' minmax(0, 1fr) / minmax(0, 1fr);
  }
  .shell[data-edge='bottom'] {
    grid-template:
      'content' minmax(0, 1fr)
      'dock' auto / minmax(0, 1fr);
  }
  .shell > :global(.dock) {
    grid-area: dock;
  }
  .content {
    grid-area: content;
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .content:focus {
    outline: none;
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .skip {
    position: fixed;
    top: var(--space-2);
    left: var(--space-2);
    z-index: 100;
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: var(--surface-raised);
    color: var(--text-strong);
    transform: translateY(-200%);
  }
  .skip:focus {
    transform: none;
  }
</style>
