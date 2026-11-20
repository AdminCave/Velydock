<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { t } from '$lib/i18n';
  import { ADMIN_NAV, SYSTEM_NAV, visibleNav } from '$lib/nav';

  interface Props {
    path: string;
    permissions: readonly string[];
    /** Name of the organization the tenant pages act on. */
    tenantName?: string | null;
  }

  let { path, permissions, tenantName }: Props = $props();

  const admin = $derived(tenantName ? visibleNav(ADMIN_NAV, permissions) : []);
  const system = $derived(visibleNav(SYSTEM_NAV, permissions));
</script>

<!-- Secondary navigation of the administration. Active = semibold plus an underline bar. -->
<nav class="subnav" aria-label={$t('nav.admin.label')}>
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
</nav>

<style>
  .subnav {
    display: flex;
    align-items: flex-end;
    gap: var(--space-8);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .subnav::-webkit-scrollbar {
    display: none;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 0 0 auto;
  }
  .caption {
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
