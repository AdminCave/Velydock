<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { getField } from './field';

  type Size = 'sm' | 'md' | 'lg';

  interface Props {
    value?: string;
    type?: string;
    size?: Size;
    placeholder?: string;
    iconLeft?: Component<{ size?: number }>;
    // Trailing adornment such as a unit or a key hint.
    suffix?: Snippet;
    multiline?: boolean;
    rows?: number;
    disabled?: boolean;
    readonly?: boolean;
    required?: boolean;
    invalid?: boolean;
    fullWidth?: boolean;
    // Geist Mono for code, ids and other technical values.
    mono?: boolean;
    id?: string;
    name?: string;
    maxlength?: number;
    min?: number;
    max?: number;
    spellcheck?: boolean;
    inputmode?: HTMLInputAttributes['inputmode'];
    autocomplete?: HTMLInputElement['autocomplete'];
    autocapitalize?: 'off' | 'none' | 'sentences' | 'words' | 'characters';
    ariaLabel?: string;
    oninput?: (e: Event) => void;
    onkeydown?: (e: KeyboardEvent) => void;
  }

  let {
    value = $bindable(''),
    type = 'text',
    size = 'md',
    placeholder,
    iconLeft: IconLeft,
    suffix,
    multiline = false,
    rows = 4,
    disabled = false,
    readonly = false,
    required = false,
    invalid = false,
    fullWidth = true,
    mono = false,
    id,
    name,
    maxlength,
    min,
    max,
    spellcheck,
    inputmode,
    autocomplete,
    autocapitalize,
    ariaLabel,
    oninput,
    onkeydown,
  }: Props = $props();

  const field = getField();
  const bad = $derived(invalid || !!field?.invalid);
</script>

<div
  class="input input-{size}"
  class:multiline
  class:invalid={bad}
  class:disabled
  class:readonly
  class:mono
  class:full={fullWidth}
>
  {#if IconLeft}<span class="icon"><IconLeft size={16} /></span>{/if}
  {#if multiline}
    <textarea
      bind:value
      id={id ?? field?.id}
      {name}
      {rows}
      {placeholder}
      {disabled}
      {readonly}
      {required}
      {maxlength}
      {spellcheck}
      {autocapitalize}
      aria-label={ariaLabel}
      aria-invalid={bad || undefined}
      aria-describedby={field?.describedBy}
      {oninput}
      {onkeydown}></textarea>
  {:else}
    <input
      bind:value
      {type}
      id={id ?? field?.id}
      {name}
      {placeholder}
      {disabled}
      {readonly}
      {required}
      {maxlength}
      {min}
      {max}
      {spellcheck}
      {inputmode}
      {autocomplete}
      {autocapitalize}
      aria-label={ariaLabel}
      aria-invalid={bad || undefined}
      aria-describedby={field?.describedBy}
      {oninput}
      {onkeydown}
    />
  {/if}
  {#if suffix}<span class="suffix">{@render suffix()}</span>{/if}
</div>

<style>
  .input {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: var(--surface-inset);
    transition:
      border-color var(--dur-fast) var(--ease-standard),
      box-shadow var(--dur-fast) var(--ease-standard);
  }
  .full {
    display: flex;
    width: 100%;
  }
  /* The ring sits on the pill, not on the bare field inside it. */
  .input:focus-within {
    border-color: var(--accent);
    box-shadow: var(--ring-shadow);
  }
  .invalid,
  .invalid:focus-within {
    border-color: var(--danger-border);
    box-shadow: none;
  }
  .disabled {
    opacity: 0.5;
  }
  /* Read-only values are shown, not edited: no well, a quieter border. */
  .readonly {
    border-color: var(--border);
    background: transparent;
  }
  .readonly input,
  .readonly textarea {
    color: var(--text-muted);
  }
  .mono input,
  .mono textarea {
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  .input-sm {
    min-height: 34px;
    padding: 0 12px;
    font-size: var(--text-sm);
  }
  .input-md {
    min-height: 42px;
    padding: 0 14px;
    font-size: var(--text-base);
  }
  .input-lg {
    min-height: 50px;
    padding: 0 16px;
    font-size: var(--text-lg);
  }
  .multiline {
    align-items: flex-start;
    padding: 11px 14px;
    border-radius: var(--radius-field);
  }
  input,
  textarea {
    flex: 1;
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text-strong);
    font: inherit;
  }
  textarea {
    resize: vertical;
  }
  input::placeholder,
  textarea::placeholder {
    color: var(--text-subtle);
  }
  .icon,
  .suffix {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-subtle);
  }
</style>
