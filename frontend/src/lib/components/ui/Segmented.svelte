<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" generics="T extends string">
  import type { Component } from 'svelte';
  import { getField } from './field';

  interface Option {
    value: T;
    label: string;
    icon?: Component<{ size?: number }>;
  }

  interface Props {
    value: T;
    options: Option[];
    /** Accessible name of the group when it has no visible FormField label. */
    label?: string;
    disabled?: boolean;
    testid?: string;
    onChange?: (value: T) => void;
  }

  let { value = $bindable(), options, label, disabled = false, testid, onChange }: Props = $props();

  const uid = $props.id();
  const field = getField();
  field?.markGroup();

  function select(next: T) {
    if (next === value) return;
    value = next;
    onChange?.(next);
  }
</script>

<!-- Native radios under the drawn segments: arrow keys, Space and form semantics are the
     platform's. The chosen segment is marked by weight and an indicator bar, not by a fill. -->
<div
  class="segmented"
  class:disabled
  role="radiogroup"
  aria-label={field?.labelId ? undefined : label}
  aria-labelledby={field?.labelId}
  aria-describedby={field?.describedBy}
  data-testid={testid}
  data-value={value}
>
  {#each options as option (option.value)}
    <label class="segment" class:checked={option.value === value}>
      <input
        type="radio"
        name="{uid}-segmented"
        value={option.value}
        checked={option.value === value}
        {disabled}
        onchange={() => select(option.value)}
      />
      {#if option.icon}<option.icon size={16} />{/if}
      <span class="text">{option.label}</span>
    </label>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    /* As wide as its options, also inside a stretching flex column. */
    width: fit-content;
    max-width: 100%;
    padding: var(--space-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    background: var(--surface-inset);
  }
  .disabled {
    opacity: 0.55;
  }
  .segment {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: 0 var(--space-4);
    border-radius: var(--radius-pill);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    white-space: nowrap;
    cursor: pointer;
    transition:
      color var(--dur-fast) var(--ease-standard),
      background var(--dur-fast) var(--ease-standard);
  }
  .disabled .segment {
    cursor: not-allowed;
  }
  .segment:hover {
    color: var(--text);
  }
  .segmented:not(.disabled) .segment:not(.checked):hover {
    background: var(--surface-hover);
  }
  /* The radio covers its segment, so a click or tap always lands on the input itself. */
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .checked {
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
  }
  .checked::after {
    content: '';
    position: absolute;
    left: var(--space-4);
    right: var(--space-4);
    bottom: 3px;
    height: 2px;
    border-radius: var(--radius-pill);
    background: var(--text-strong);
  }
  .segment:has(input:focus-visible) {
    outline: var(--ring-width) solid var(--ring);
    outline-offset: 1px;
  }
</style>
