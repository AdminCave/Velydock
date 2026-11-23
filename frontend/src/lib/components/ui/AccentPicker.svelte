<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { ACCENT_PALETTE, normalizeAccent } from '$lib/accent';
  import { t } from '$lib/i18n';

  interface Props {
    /** The chosen colour ("#rrggbb", lower case), or null for none. */
    value: string | null;
    /** Accessible name of the group. */
    label: string;
    /** What "no colour" is called here: "Standard", "Keine Vorgabe". */
    noneLabel: string;
    disabled?: boolean;
    testid?: string;
    onChange?: (value: string | null) => void;
  }

  let {
    value = $bindable(),
    label,
    noneLabel,
    disabled = false,
    testid,
    onChange,
  }: Props = $props();

  const uid = $props.id();

  // What stands in the text field. It follows the chosen colour, except while somebody
  // is typing something that is no colour (yet).
  let typed = $derived(value ?? '');
  const invalid = $derived(typed.trim() !== '' && normalizeAccent(typed) === null);
  // The native picker always shows some colour; without a choice, the built-in blue.
  const picked = $derived(value ?? '#3b82f6');

  function choose(next: string | null) {
    if (next === value) return;
    value = next;
    onChange?.(next);
  }

  // A colour applies as soon as it is one: typing "#c2410c" needs no further key.
  function onTyped(event: Event) {
    typed = (event.currentTarget as HTMLInputElement).value;
    const color = normalizeAccent(typed);
    if (color) choose(color);
  }

  // The native picker reports every move inside it as `input`; the choice counts when it
  // is confirmed (`change`).
  function onPicked(event: Event) {
    const color = normalizeAccent((event.currentTarget as HTMLInputElement).value);
    if (color) choose(color);
  }
</script>

<!-- "No colour", a few swatches, and any colour of one's own: by the native picker or as
     "#rrggbb". The swatches show the colour as it was chosen; how it comes out as text in
     a theme is the business of lib/accent.ts. -->
<div
  class="accent-picker"
  role="group"
  aria-label={label}
  data-testid={testid}
  data-value={value ?? 'default'}
>
  <div class="swatches">
    <button
      type="button"
      class="none"
      class:chosen={value === null}
      aria-pressed={value === null}
      {disabled}
      data-testid="accent-default"
      onclick={() => choose(null)}
    >
      {noneLabel}
    </button>
    {#each ACCENT_PALETTE as entry (entry.color)}
      <button
        type="button"
        class="swatch"
        class:chosen={value === entry.color}
        aria-pressed={value === entry.color}
        aria-label={$t(`accent.color.${entry.name}`)}
        title={$t(`accent.color.${entry.name}`)}
        {disabled}
        data-testid="accent-swatch"
        data-color={entry.color}
        style:--swatch={entry.color}
        onclick={() => choose(entry.color)}
      ></button>
    {/each}
  </div>
  <div class="own">
    <label class="own-label" for="{uid}-hex">{$t('accent.custom')}</label>
    <input
      type="color"
      class="picker"
      value={picked}
      {disabled}
      aria-label={$t('accent.custom.pick')}
      title={$t('accent.custom.pick')}
      data-testid="accent-picker"
      onchange={onPicked}
    />
    <input
      type="text"
      id="{uid}-hex"
      class="hex mono"
      value={typed}
      maxlength="7"
      placeholder="#rrggbb"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      {disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${uid}-msg` : undefined}
      data-testid="accent-custom"
      oninput={onTyped}
      onblur={() => (typed = value ?? '')}
    />
  </div>
  {#if invalid}
    <p class="msg" id="{uid}-msg">{$t('accent.custom.invalid')}</p>
  {/if}
</div>

<style>
  .accent-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }
  .none {
    height: 32px;
    padding: 0 var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
  }
  .none:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .none.chosen {
    border-color: var(--text-strong);
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
  }
  .swatch {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: var(--swatch);
    cursor: pointer;
  }
  /* The chosen one: a ring in the colour of the text, set off from the swatch. */
  .swatch.chosen {
    outline: 2px solid var(--text-strong);
    outline-offset: 2px;
  }
  .swatch:focus-visible,
  .none:focus-visible {
    outline: var(--ring-width) solid var(--ring);
    outline-offset: 2px;
    box-shadow: none;
  }
  .swatch.chosen:focus-visible {
    outline-color: var(--text-strong);
    box-shadow: 0 0 0 calc(2px + var(--ring-width) + 2px) var(--ring);
  }
  .none:disabled,
  .swatch:disabled,
  .picker:disabled,
  .hex:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .own {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }
  .own-label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .picker {
    width: 36px;
    height: 32px;
    padding: 2px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-inset);
    cursor: pointer;
  }
  .hex {
    box-sizing: border-box;
    /* "#rrggbb" and the padding around it. */
    width: calc(7ch + 2 * var(--space-3) + 6px);
    height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: var(--surface-inset);
    color: var(--text);
    font-size: var(--text-sm);
  }
  .hex:focus-visible {
    border-color: var(--accent);
  }
  .hex[aria-invalid='true'] {
    border-color: var(--danger);
  }
  .msg {
    color: var(--danger);
    font-size: var(--text-sm);
  }
</style>
