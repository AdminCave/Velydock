<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { t } from '$lib/i18n';
  import { ADMIN_NAV, SYSTEM_NAV, visibleNav } from '$lib/nav';
  import { NO_OVERFLOW, measureOverflow, scrollByPage, type Overflow } from '$lib/utils/overflow';

  interface Props {
    path: string;
    permissions: readonly string[];
    /** Name of the organization the tenant pages act on. */
    tenantName?: string | null;
  }

  let { path, permissions, tenantName }: Props = $props();

  const admin = $derived(tenantName ? visibleNav(ADMIN_NAV, permissions) : []);
  const system = $derived(visibleNav(SYSTEM_NAV, permissions));

  // On a tablet or phone the entries do not all fit, and the row scrolls sideways without
  // a scrollbar. Two things then keep the user from getting lost: the entry of the page
  // that is open is brought into view, and the end of the row that has more beyond it
  // shows a marker (as the dock does), which also scrolls on a click.
  let scroller = $state<HTMLDivElement | undefined>();
  let overflow = $state<Overflow>(NO_OVERFLOW);

  function measure() {
    if (!scroller) return;
    const next = measureOverflow(scroller, true);
    if (
      next.overflowing !== overflow.overflowing ||
      next.before !== overflow.before ||
      next.after !== overflow.after
    ) {
      overflow = next;
    }
  }

  $effect(() => {
    const el = scroller;
    if (!el) return;
    void path;
    void admin;
    void system;
    void tick().then(() => {
      measure();
      // After the markers have taken their room: the open page's entry, completely.
      void tick().then(() => {
        el.querySelector('[aria-current="page"]')?.scrollIntoView?.({
          block: 'nearest',
          inline: 'nearest',
        });
        measure();
      });
    });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    if (el.parentElement) observer?.observe(el.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  });
</script>

<!-- Secondary navigation of the administration. Active = semibold plus an underline bar. -->
<nav class="subnav" aria-label={$t('nav.admin.label')}>
  <!-- The markers are for the pointer; the keyboard walks the entries with Tab. -->
  {#if overflow.overflowing}
    <span class="more-slot">
      {#if overflow.before}
        <button
          type="button"
          class="more"
          tabindex="-1"
          aria-label={$t('nav.admin.before')}
          title={$t('nav.admin.before')}
          data-testid="subnav-more-before"
          onclick={() => scroller && scrollByPage(scroller, true, -1)}
        >
          <ChevronLeft size={16} />
        </button>
      {/if}
    </span>
  {/if}
  <div class="scroller" bind:this={scroller} onscroll={measure}>
    {#if admin.length > 0}
      <div class="group">
        <span class="caption" title={$t('nav.admin.scope')}>{tenantName}</span>
        <ul>
          {#each admin as entry (entry.path)}
            {@const active = path === entry.path}
            <li>
              <a
                class="tab"
                class:active
                href={entry.path}
                aria-current={active ? 'page' : undefined}
              >
                {$t(entry.label)}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if system.length > 0}
      <div class="group">
        <span class="caption">{$t('nav.system.caption')}</span>
        <ul>
          {#each system as entry (entry.path)}
            {@const active = path === entry.path}
            <li>
              <a
                class="tab"
                class:active
                href={entry.path}
                aria-current={active ? 'page' : undefined}
              >
                {$t(entry.label)}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
  {#if overflow.overflowing}
    <span class="more-slot">
      {#if overflow.after}
        <button
          type="button"
          class="more"
          tabindex="-1"
          aria-label={$t('nav.admin.after')}
          title={$t('nav.admin.after')}
          data-testid="subnav-more-after"
          onclick={() => scroller && scrollByPage(scroller, true, 1)}
        >
          <ChevronRight size={16} />
        </button>
      {/if}
    </span>
  {/if}
</nav>

<style>
  .subnav {
    display: flex;
    align-items: flex-end;
    border-bottom: 1px solid var(--border);
  }
  .scroller {
    display: flex;
    flex: 1 1 auto;
    align-items: flex-end;
    gap: var(--space-8);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .scroller::-webkit-scrollbar {
    display: none;
  }
  /* More entries than fit: room at both ends of the row, and in it a marker towards the
     end that has more beyond it. */
  .more-slot {
    display: flex;
    flex: 0 0 24px;
    height: 40px;
  }
  .more {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .more:hover {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 0 0 auto;
  }
  .caption {
    /* As wide as the entries below it and no wider: a long name of an organization is
       cut with an ellipsis instead of pushing the system pages out of sight. */
    width: 0;
    min-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    white-space: nowrap;
  }
  ul {
    display: flex;
    gap: var(--space-6);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 40px;
    color: var(--text-muted);
    font-size: var(--text-base);
    font-weight: var(--fw-medium);
    text-decoration: none;
    white-space: nowrap;
    transition: color var(--dur-fast) var(--ease-out);
  }
  .tab:hover {
    color: var(--text);
    text-decoration: none;
  }
  .tab.active {
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
  }
  .tab.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    border-radius: var(--radius-pill);
    background: var(--text-strong);
  }
  .tab:focus-visible {
    outline-offset: -2px;
  }
</style>
