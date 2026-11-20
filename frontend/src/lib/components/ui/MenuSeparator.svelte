<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  interface Props {
    /** Optional caption for the group that follows. */
    label?: string;
  }

  let { label }: Props = $props();
</script>

<div class="sep" role="separator"></div>
{#if label}<div class="caption" role="presentation">{label}</div>{/if}

<style>
  .sep {
    height: 1px;
    margin: var(--space-2) calc(-1 * var(--space-2));
    background: var(--border);
  }
  .caption {
    padding: var(--space-1) var(--space-3) var(--space-2);
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
  }
</style>
