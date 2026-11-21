<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import { api, tenantApi } from '$lib/api/client';
  import type { AuditPage } from '$lib/api/types';
  import { auditActionLabel, auditDetail } from '$lib/audit';
  import Button from '$lib/components/ui/Button.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Pagination, { pageCount } from '$lib/components/ui/Pagination.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { language, t } from '$lib/i18n';
  import { pageFromQuery, readListQuery, writeListQuery } from '$lib/listQuery';
  import { location } from '$lib/router';
  import { showError } from '$lib/stores/toasts';
  import { formatDateTime } from '$lib/utils/datetime';

  interface Props {
    /** "tenant": actions inside the active organization; "system": actions above all of them. */
    scope: 'tenant' | 'system';
  }

  let { scope }: Props = $props();

  // The log of the organization is read through the API bound to the organization this
  // page was opened for (see tenantApi()); the system log belongs to none.
  const ofTenant = tenantApi();

  const PAGE_SIZE = 50;

  // The page number lives in the address (see lib/listQuery.ts): a reload and the
  // browser's Back button keep it.
  let page = $state(pageFromQuery(readListQuery()));
  $effect(() => {
    writeListQuery({ page: page === 1 ? null : page });
  });
  $effect(() => {
    const at = pageFromQuery(new URLSearchParams($location.search));
    untrack(() => {
      if (at !== page) page = at;
    });
  });
  let data = $state<AuditPage | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let latest = 0;

  async function load() {
    const mine = ++latest;
    loading = true;
    try {
      const query = { page, page_size: PAGE_SIZE };
      const result =
        scope === 'system'
          ? await api.get('/api/v1/system/audit', { query })
          : await ofTenant.get('/api/v1/admin/audit', { query });
      if (mine !== latest) return;
      data = result;
      failed = false;
      // A page number from the address may lie beyond the end.
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
    void page;
    void scope;
    untrack(() => void load());
  });
</script>

<div class="table-wrap" aria-busy={loading}>
  <table class="data-table" data-testid="audit-table">
    <thead>
      <tr>
        <th scope="col">{$t('audit.col.time')}</th>
        <th scope="col">{$t('audit.col.actor')}</th>
        <th scope="col">{$t('audit.col.action')}</th>
        <th scope="col">{$t('audit.col.target')}</th>
      </tr>
    </thead>
    <tbody>
      {#each data?.items ?? [] as entry (entry.id)}
        {@const detail = auditDetail(entry, $t)}
        <tr data-action={entry.action}>
          <td class="meta num">{formatDateTime(entry.created_at, $language)}</td>
          <td class="meta">{entry.actor_name}</td>
          <td>
            <span class="primary">{auditActionLabel(entry.action, $t)}</span>
            {#if detail}<span class="detail">{detail}</span>{/if}
          </td>
          <td class="target">{entry.target_label || '–'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data && data.items.length === 0}
    <EmptyState
      framed={false}
      icon={ScrollText}
      title={$t('audit.empty.title')}
      description={$t('audit.empty.text')}
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

<style>
  .target {
    min-width: 180px;
    overflow-wrap: anywhere;
  }
  .detail {
    display: block;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
