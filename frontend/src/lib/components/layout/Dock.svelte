<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';
  import Building from '@lucide/svelte/icons/building';
  import Check from '@lucide/svelte/icons/check';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Settings from '@lucide/svelte/icons/settings';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import User from '@lucide/svelte/icons/user';
  import type { Me, NavPosition, WorkspaceApp } from '$lib/api/types';
  import AppIcon from '$lib/components/app/AppIcon.svelte';
  import Mark from '$lib/components/brand/Mark.svelte';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
  import { openInNewTab } from '$lib/frames';
  import { t } from '$lib/i18n';
  import { adminHome, dockOrientation, isAdminArea, menuPlacement } from '$lib/nav';
  import { navigate } from '$lib/router';
  import { signOut, switchTenant } from '$lib/stores/session';
  import { showError } from '$lib/stores/toasts';

  interface Props {
    me: Me;
    apps: WorkspaceApp[];
    /** The configured position (settings.nav_position). */
    position: NavPosition;
    /** The edge the dock is actually drawn at (differs on narrow screens). */
    edge: NavPosition;
    /** Narrow viewport: entries shrink to icon over a small label. */
    compact?: boolean;
    path: string;
    activeAppId?: string | null;
  }

  let { me, apps, position, edge, compact = false, path, activeAppId = null }: Props = $props();

  const orientation = $derived(dockOrientation(edge));
  const placement = $derived(menuPlacement(edge));
  const adminPath = $derived(adminHome(me.permissions));
  const inAdmin = $derived(isAdminArea(path));
  const tenantName = $derived(me.active_tenant?.name ?? $t('dock.tenant.none'));

  let list = $state<HTMLElement | undefined>();
  let switching = $state(false);

  // External apps open in a new tab right away; the link still leads to the app view,
  // which offers to open the app again.
  function onAppClick(event: MouseEvent, app: WorkspaceApp) {
    if (app.type !== 'external' || !app.url) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    openInNewTab(app.url);
  }

  // A mouse wheel scrolls a horizontal dock sideways.
  function onWheel(event: WheelEvent) {
    if (orientation !== 'horizontal' || !list) return;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) list.scrollLeft += event.deltaY;
  }

  // Keep the active app in view when the dock scrolls.
  $effect(() => {
    void activeAppId;
    void orientation;
    void tick().then(() => {
      const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
      current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
  });

  async function enterTenant(tenantId: string) {
    if (tenantId === me.active_tenant?.id || switching) return;
    switching = true;
    try {
      await switchTenant(tenantId);
      // The new organization has its own apps and pages; start at its dashboard.
      navigate('/');
    } catch (err) {
      showError(err);
    } finally {
      switching = false;
    }
  }

  function roleLabel(role: string | null | undefined): string {
    return role ? $t(`role.${role}`) : $t('role.none');
  }
</script>

<nav
  class="dock"
  class:compact
  aria-label={$t('dock.label')}
  data-testid="dock"
  data-nav={position}
  data-edge={edge}
  data-orientation={orientation}
>
  <a
    class="home"
    href="/"
    aria-label={$t('dock.home')}
    aria-current={path === '/' ? 'page' : undefined}
    title={$t('dock.home')}
    data-testid="dock-home"
  >
    <Mark size={30} />
    <span class="instance">{me.instance_name}</span>
  </a>

  <span class="divider" aria-hidden="true"></span>
  <ul class="apps" bind:this={list} aria-label={$t('dock.apps')} onwheel={onWheel}>
    {#each apps as app (app.id)}
      {@const active = app.id === activeAppId}
      <li>
        <a
          class="dock-entry"
          class:active
          href="/app/{app.id}"
          title={app.type === 'external' ? `${app.name} – ${$t('app.opensInNewTab')}` : app.name}
          aria-current={active ? 'page' : undefined}
          data-testid="dock-app"
          data-app-id={app.id}
          data-app-type={app.type}
          onclick={(e) => onAppClick(e, app)}
        >
          <span class="glyph"><AppIcon name={app.icon_name} url={app.icon_url} size={22} /></span>
          <span class="label">{app.name}</span>
        </a>
      </li>
    {/each}
  </ul>

  <span class="divider" aria-hidden="true"></span>

  <div class="tools">
    {#if adminPath}
      <a
        class="dock-entry"
        class:active={inAdmin}
        href={adminPath}
        title={$t('dock.admin')}
        aria-current={inAdmin ? 'page' : undefined}
        data-testid="dock-admin"
      >
        <span class="glyph"><SlidersHorizontal size={22} /></span>
        <span class="label">{$t('dock.admin')}</span>
      </a>
    {/if}

    {#if me.memberships.length > 1}
      <Menu
        label={$t('dock.tenant.switch', { name: tenantName })}
        title={$t('dock.tenant.title')}
        testid="tenant-switcher"
        triggerClass="dock-entry dock-tenant"
        {placement}
        disabled={switching}
      >
        {#snippet trigger()}
          <span class="glyph"><Building size={22} /></span>
          <span class="label">{tenantName}</span>
          <span class="chevrons"><ChevronsUpDown size={14} /></span>
        {/snippet}
        <div class="menu-caption" role="presentation">{$t('dock.tenant.caption')}</div>
        {#each me.memberships as membership (membership.tenant.id)}
          {@const current = membership.tenant.id === me.active_tenant?.id}
          <MenuItem
            icon={current ? Check : Building}
            {current}
            meta={roleLabel(membership.role)}
            onSelect={() => enterTenant(membership.tenant.id)}
          >
            {membership.tenant.name}
          </MenuItem>
        {/each}
      </Menu>
    {/if}

    <Menu
      label={$t('dock.user.menu', { name: me.user.display_name })}
      title={me.user.display_name}
      testid="user-menu"
      triggerClass="dock-entry dock-user"
      {placement}
    >
      {#snippet trigger()}
        <Avatar name={me.user.display_name} size={34} />
      {/snippet}
      <div class="menu-user" role="presentation">
        <span class="menu-user-name">{me.user.display_name}</span>
        <span class="menu-user-meta">
          {me.user.username}{me.active_tenant ? ` · ${me.active_tenant.name}` : ''}
        </span>
      </div>
      <MenuSeparator />
      <MenuItem href="/profile" icon={User} current={path === '/profile'}>
        {$t('nav.profile')}
      </MenuItem>
      <MenuItem href="/settings" icon={Settings} current={path === '/settings'}>
        {$t('nav.settings')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={LogOut} onSelect={() => void signOut()}>{$t('nav.signOut')}</MenuItem>
    </Menu>
  </div>
</nav>

<style>
  .dock {
    display: flex;
    align-items: center;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
    z-index: 5;
  }
  .dock[data-edge='left'] {
    border-right: 1px solid var(--border);
  }
  .dock[data-edge='right'] {
    border-left: 1px solid var(--border);
  }
  .dock[data-edge='top'] {
    border-bottom: 1px solid var(--border);
  }
  .dock[data-edge='bottom'] {
    border-top: 1px solid var(--border);
  }

  .home {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    flex: 0 0 auto;
    padding: var(--space-2);
    border-radius: var(--radius-md);
    color: var(--text-strong);
    text-decoration: none;
  }
  .home:hover {
    background: var(--surface-hover);
    text-decoration: none;
  }
  .instance {
    font-size: var(--text-md);
    font-weight: var(--fw-semibold);
    letter-spacing: var(--ls-tight);
    white-space: nowrap;
  }
  .divider {
    flex: 0 0 auto;
    background: var(--border);
  }
  .apps {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .apps li {
    display: flex;
    flex: 0 0 auto;
    min-width: 0;
  }
  .tools {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
  }
  .glyph,
  .chevrons {
    display: inline-flex;
    flex: 0 0 auto;
  }
  .chevrons {
    color: var(--text-subtle);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Entries are shared with the menu triggers, which the Menu component renders: hence
     :global. Active = semibold plus a thin indicator bar at the dock's edge, never a fill. */
  .dock :global(.dock-entry) {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    min-width: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-weight: var(--fw-medium);
    text-decoration: none;
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .dock :global(.dock-entry:hover),
  .dock :global(.dock-entry[aria-expanded='true']) {
    background: var(--surface-hover);
    color: var(--text);
    text-decoration: none;
  }
  .dock :global(.dock-entry:disabled) {
    opacity: 0.5;
    cursor: progress;
  }
  .dock :global(.dock-entry.active) {
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
  }
  .dock :global(.dock-entry.active:hover) {
    background: transparent;
  }
  .dock :global(.dock-entry.active::before) {
    content: '';
    position: absolute;
    border-radius: var(--radius-pill);
    background: var(--text-strong);
  }
  .dock :global(.dock-user) {
    border-radius: var(--radius-pill);
  }

  /* ── Vertical rail (left / right) ─────────────────────────────────── */
  .dock[data-orientation='vertical'] {
    flex-direction: column;
    width: var(--dock-rail);
    height: 100%;
    padding: var(--space-3) 0;
    gap: var(--space-2);
  }
  [data-orientation='vertical'] .instance,
  [data-orientation='vertical'] .chevrons {
    display: none;
  }
  [data-orientation='vertical'] .divider {
    width: 36px;
    height: 1px;
  }
  [data-orientation='vertical'] .apps {
    flex-direction: column;
    align-self: stretch;
    gap: 2px;
    overflow-x: hidden;
    overflow-y: auto;
  }
  [data-orientation='vertical'] .apps li {
    flex-direction: column;
  }
  [data-orientation='vertical'] .tools {
    flex-direction: column;
    align-self: stretch;
    gap: 2px;
  }
  .dock[data-orientation='vertical'] :global(.dock-entry) {
    flex-direction: column;
    gap: 5px;
    width: calc(100% - 2 * var(--space-2));
    min-height: 58px;
    margin: 0 var(--space-2);
    padding: var(--space-2) 2px;
    font-size: 11px;
    line-height: 1.25;
  }
  .dock[data-orientation='vertical'] :global(.dock-entry .label) {
    max-width: 100%;
    text-align: center;
  }
  .dock[data-orientation='vertical'] :global(.dock-entry.active::before) {
    top: 12px;
    bottom: 12px;
    width: 3px;
  }
  .dock[data-edge='left'] :global(.dock-entry.active::before) {
    left: calc(-1 * var(--space-2));
  }
  .dock[data-edge='right'] :global(.dock-entry.active::before) {
    right: calc(-1 * var(--space-2));
  }
  .dock[data-orientation='vertical'] :global(.dock-user) {
    width: 46px;
    min-height: 46px;
    margin: var(--space-1) auto 0;
    padding: 0;
  }

  /* ── Horizontal bar (top / bottom) ────────────────────────────────── */
  .dock[data-orientation='horizontal'] {
    flex-direction: row;
    width: 100%;
    height: var(--dock-bar);
    padding: 0 var(--space-4);
    gap: var(--space-3);
  }
  [data-orientation='horizontal'] .divider {
    width: 1px;
    height: 24px;
  }
  [data-orientation='horizontal'] .apps {
    flex-direction: row;
    align-self: stretch;
    align-items: center;
    gap: var(--space-1);
    overflow-x: auto;
    overflow-y: hidden;
    /* The bar scrolls by wheel, touch and keyboard focus; a scrollbar would crowd it. */
    scrollbar-width: none;
  }
  [data-orientation='horizontal'] .apps::-webkit-scrollbar {
    display: none;
  }
  [data-orientation='horizontal'] .apps li {
    align-self: stretch;
    align-items: center;
  }
  [data-orientation='horizontal'] .tools {
    align-self: stretch;
    gap: var(--space-1);
  }
  .dock[data-orientation='horizontal'] :global(.dock-entry) {
    gap: var(--space-2);
    height: 40px;
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
  }
  .dock[data-orientation='horizontal'] :global(.dock-entry .label) {
    max-width: 168px;
  }
  .dock[data-orientation='horizontal'] :global(.dock-entry.active::before) {
    left: var(--space-3);
    right: var(--space-3);
    height: 3px;
  }
  /* The bar sits on the edge that borders the content. */
  .dock[data-edge='top'] :global(.dock-entry.active::before) {
    bottom: calc((40px - var(--dock-bar)) / 2);
  }
  .dock[data-edge='bottom'] :global(.dock-entry.active::before) {
    top: calc((40px - var(--dock-bar)) / 2);
  }
  .dock[data-orientation='horizontal'] :global(.dock-user) {
    width: 42px;
    padding: 0;
  }

  /* ── Narrow screens: a compact bar, icon over a small label ───────── */
  .dock.compact[data-orientation='horizontal'] {
    padding: 0 var(--space-2);
    gap: var(--space-1);
  }
  .compact .instance,
  .compact .chevrons {
    display: none;
  }
  .compact .home {
    padding: var(--space-1);
  }
  .dock.compact[data-orientation='horizontal'] :global(.dock-entry) {
    flex-direction: column;
    gap: 3px;
    height: 48px;
    min-width: 52px;
    padding: 0 var(--space-1);
    font-size: 10.5px;
    line-height: 1.2;
  }
  .dock.compact[data-orientation='horizontal'] :global(.dock-entry .label) {
    max-width: 68px;
  }
  .dock.compact[data-orientation='horizontal'] :global(.dock-entry.active::before) {
    left: var(--space-2);
    right: var(--space-2);
  }
  .dock.compact[data-edge='top'] :global(.dock-entry.active::before) {
    bottom: calc((48px - var(--dock-bar)) / 2);
  }
  .dock.compact[data-edge='bottom'] :global(.dock-entry.active::before) {
    top: calc((48px - var(--dock-bar)) / 2);
  }
  .dock.compact[data-orientation='horizontal'] :global(.dock-user) {
    min-width: 42px;
    width: 42px;
  }
  /* Administration and organization shrink to their icons, leaving the width to the
     apps; the hidden label stays the accessible name. */
  .compact .tools .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .dock.compact[data-orientation='horizontal'] .tools :global(.dock-entry) {
    min-width: 44px;
  }

  /* Header of the user menu and caption of the organization menu. */
  .dock :global(.menu-user) {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
  }
  .dock :global(.menu-user-name) {
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
  }
  .dock :global(.menu-user-meta) {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
  .dock :global(.menu-caption) {
    padding: var(--space-2) var(--space-3);
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
  }
</style>
