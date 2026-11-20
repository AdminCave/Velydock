<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleExclamationPoint from '@lucide/svelte/icons/circle-exclamation-point';
  import Info from '@lucide/svelte/icons/info';
  import TriangleExclamationPoint from '@lucide/svelte/icons/triangle-exclamation-point';

  type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

  interface Props {
    tone?: Tone;
    title?: string;
    /** "alert" announces the text at once, "status" politely; none for static explanations. */
    role?: 'alert' | 'status';
    testid?: string;
    children?: Snippet;
    action?: Snippet;
  }

  let { tone = 'info', title, role, testid, children, action }: Props = $props();

  const icons = {
    info: Info,
    neutral: Info,
    success: CircleCheck,
    warning: TriangleExclamationPoint,
    danger: CircleExclamationPoint,
  };
  const Icon = $derived(icons[tone]);
</script>

<!-- A tinted box with a hairline border; status colours never appear as flat fills. -->
<div class="callout callout-{tone}" {role} data-testid={testid}>
  <span class="icon" aria-hidden="true"><Icon size={18} /></span>
  <div class="body">
    {#if title}<p class="title">{title}</p>{/if}
    {#if children}<div class="text">{@render children()}</div>{/if}
    {#if action}<div class="action">{@render action()}</div>{/if}
  </div>
</div>

<style>
  .callout {
    --tone: var(--text-muted);
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
    font-size: var(--text-sm);
    line-height: var(--lh-normal);
  }
  .callout-info {
    --tone: var(--info);
    border-color: var(--info-border);
    background: var(--info-bg);
  }
  .callout-success {
    --tone: var(--success);
    border-color: var(--success-border);
    background: var(--success-bg);
  }
  .callout-warning {
    --tone: var(--warning);
    border-color: var(--warning-border);
    background: var(--warning-bg);
  }
  .callout-danger {
    --tone: var(--danger);
    border-color: var(--danger-border);
    background: var(--danger-bg);
  }
  .icon {
    display: inline-flex;
    flex: 0 0 auto;
    margin-top: 1px;
    color: var(--tone);
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .title {
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
  }
  .text {
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .action {
    margin-top: var(--space-2);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
