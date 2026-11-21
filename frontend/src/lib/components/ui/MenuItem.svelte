<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  interface Props {
    /** A link entry; without it the entry is a button that runs onSelect. */
    href?: string;
    /** Open the link in a new tab (for addresses outside of Velydock). */
    external?: boolean;
    icon?: Component<{ size?: number }>;
    danger?: boolean;
    disabled?: boolean;
    /** Marks the entry that is in effect, e.g. the active organization or page. */
    current?: boolean;
    /** Secondary text at the right edge, set in mono. */
    meta?: string;
    testid?: string;
    onSelect?: () => void;
    children: Snippet;
  }

  let {
    href,
    external = false,
    icon: Icon,
    danger = false,
    disabled = false,
    current = false,
    meta,
    testid,
    onSelect,
    children,
  }: Props = $props();
</script>

{#snippet content()}
  {#if Icon}<span class="icon" aria-hidden="true"><Icon size={16} /></span>{/if}
  <span class="text">{@render children()}</span>
  {#if meta}<span class="meta">{meta}</span>{/if}
{/snippet}

{#if href && !disabled}
  <a
    class="item"
    class:danger
    class:current
    role="menuitem"
    tabindex="-1"
    {href}
    target={external ? '_blank' : undefined}
    rel={external ? 'noopener noreferrer' : undefined}
    aria-current={current ? 'true' : undefined}
    data-testid={testid}
    onclick={() => onSelect?.()}
  >
    {@render content()}
  </a>
{:else}
  <button
    type="button"
    class="item"
    class:danger
    class:current
    role="menuitem"
    tabindex="-1"
    {disabled}
    aria-current={current ? 'true' : undefined}
    data-testid={testid}
    onclick={() => onSelect?.()}
  >
    {@render content()}
  </button>
{/if}

<style>
  .item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    min-height: 38px;
    padding: var(--space-2) var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }
  .item:hover:not(:disabled),
  .item:focus-visible {
    background: var(--surface-hover);
    color: var(--text-strong);
    text-decoration: none;
  }
  .item:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--ring);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  /* On the highlighted entry the subtle tone would fall below 4.5:1. */
  .item:hover .meta,
  .item:focus-visible .meta {
    color: var(--text-muted);
  }
  /* In effect: weight, not a filled background. */
  .current {
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
  }
  .danger,
  .danger .icon {
    color: var(--danger);
  }
  .danger:hover:not(:disabled),
  .danger:focus-visible {
    background: var(--danger-bg);
    color: var(--danger);
  }
</style>
