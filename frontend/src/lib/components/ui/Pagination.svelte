<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  /** Number of pages for a total; at least one, so "page 1 of 1" also covers an empty list. */
  export function pageCount(total: number, pageSize: number): number {
    return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  }
</script>

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { t } from '$lib/i18n';
  import IconButton from './IconButton.svelte';

  interface Props {
    page: number;
    pageSize: number;
    total: number;
    disabled?: boolean;
    onChange: (page: number) => void;
  }

  let { page, pageSize, total, disabled = false, onChange }: Props = $props();

  const pages = $derived(pageCount(total, pageSize));
  const from = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
  const to = $derived(Math.min(total, page * pageSize));
</script>

<nav class="pagination" aria-label={$t('pagination.label')}>
  <span class="range mono">{$t('pagination.range', { from, to, total })}</span>
  <span class="controls">
    <IconButton
      icon={ChevronLeft}
      label={$t('pagination.previous')}
      variant="secondary"
      size="sm"
      disabled={disabled || page <= 1}
      onclick={() => onChange(page - 1)}
    />
    <span class="mono current">{$t('pagination.page', { page, pages })}</span>
    <IconButton
      icon={ChevronRight}
      label={$t('pagination.next')}
      variant="secondary"
      size="sm"
      disabled={disabled || page >= pages}
      onclick={() => onChange(page + 1)}
    />
  </span>
</nav>

<style>
  .pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .controls {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }
  .current {
    min-width: 9ch;
    text-align: center;
  }
</style>
