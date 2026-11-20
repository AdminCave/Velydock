<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import Compass from '@lucide/svelte/icons/compass';
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    /** The page exists, but the user lacks the permission for it. */
    forbidden?: boolean;
  }

  let { forbidden = false }: Props = $props();
</script>

<div class="page page-narrow" data-testid={forbidden ? 'forbidden-page' : 'not-found-page'}>
  <EmptyState
    icon={forbidden ? LockKeyhole : Compass}
    title={forbidden ? $t('forbidden.title') : $t('notFound.title')}
    description={forbidden ? $t('forbidden.text') : $t('notFound.text')}
  >
    {#snippet action()}
      <a class="back" href="/">{$t('notFound.back')}</a>
    {/snippet}
  </EmptyState>
</div>

<style>
  .back {
    display: inline-flex;
    align-items: center;
    height: 40px;
    padding: 0 var(--space-5);
    border-radius: var(--radius-pill);
    background: var(--fill-solid);
    color: var(--fill-solid-text);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    text-decoration: none;
  }
  .back:hover {
    background: var(--fill-solid-hover);
    text-decoration: none;
  }
</style>
