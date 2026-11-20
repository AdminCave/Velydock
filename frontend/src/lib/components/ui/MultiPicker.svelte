<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  export interface PickerOption {
    id: string;
    label: string;
    /** Secondary text such as a username, set in mono. */
    detail?: string;
    /** The entry stays as it is, chosen or not: it is shown but cannot be toggled. */
    locked?: boolean;
  }

  /** Options whose label or detail contains the query (case-insensitive). */
  export function filterOptions(options: readonly PickerOption[], query: string): PickerOption[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...options];
    return options.filter(
      (o) => o.label.toLowerCase().includes(needle) || !!o.detail?.toLowerCase().includes(needle),
    );
  }
</script>

<script lang="ts">
  import { t } from '$lib/i18n';
  import { getField } from './field';
  import SearchField from './SearchField.svelte';
  import Spinner from './Spinner.svelte';
  import Tag from './Tag.svelte';

  interface Props {
    options: PickerOption[];
    selected: string[];
    /** Accessible name when the picker is not inside a FormField with a label. */
    label?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    /** Why locked entries cannot be changed; shown as their tooltip. */
    lockedHint?: string;
    loading?: boolean;
    disabled?: boolean;
    onChange?: (selected: string[]) => void;
  }

  let {
    options,
    selected = $bindable(),
    label,
    searchPlaceholder,
    emptyText,
    lockedHint,
    loading = false,
    disabled = false,
    onChange,
  }: Props = $props();

  const field = getField();
  field?.markGroup();

  let query = $state('');

  const chosen = $derived(new Set(selected));
  const visible = $derived(filterOptions(options, query));
  const byId = $derived(new Map(options.map((o) => [o.id, o])));
  // Ids that are selected but (no longer) offered are kept, not silently dropped.
  const chips = $derived(selected.map((id) => byId.get(id)).filter((o) => o !== undefined));

  function set(next: string[]) {
    selected = next;
    onChange?.(next);
  }

  function toggle(id: string, on: boolean) {
    if (byId.get(id)?.locked) return;
    if (on && !chosen.has(id)) set([...selected, id]);
    if (!on && chosen.has(id)) set(selected.filter((x) => x !== id));
  }
</script>

<!-- A searchable list of native checkboxes: every option is reachable by keyboard and
     named by its label. -->
<div
  class="picker"
  class:disabled
  role="group"
  aria-label={field?.labelId ? undefined : label}
  aria-labelledby={field?.labelId}
  aria-describedby={field?.describedBy}
>
  {#if chips.length > 0}
    <div class="chips">
      {#each chips as chip (chip.id)}
        <Tag
          tone="neutral"
          mono={false}
          onRemove={disabled || chip.locked ? undefined : () => toggle(chip.id, false)}
          removeLabel={$t('picker.remove', { name: chip.label })}
        >
          {chip.label}
        </Tag>
      {/each}
    </div>
  {/if}
  {#if options.length > 6}
    <SearchField
      bind:value={query}
      size="sm"
      placeholder={searchPlaceholder ?? $t('ui.search')}
      label={searchPlaceholder ?? $t('ui.search')}
    />
  {/if}
  <div class="list">
    {#if loading}
      <div class="state"><Spinner size={16} /></div>
    {:else}
      {#each visible as option (option.id)}
        <label
          class="row"
          class:locked={option.locked}
          title={option.locked ? lockedHint : undefined}
        >
          <input
            type="checkbox"
            checked={chosen.has(option.id)}
            disabled={disabled || option.locked}
            onchange={(e) => toggle(option.id, e.currentTarget.checked)}
          />
          <span class="name">{option.label}</span>
          {#if option.detail}<span class="detail">{option.detail}</span>{/if}
        </label>
      {:else}
        <p class="state">
          {options.length === 0 ? (emptyText ?? $t('picker.empty')) : $t('picker.noMatch')}
        </p>
      {/each}
    {/if}
  </div>
  <div class="foot">
    <span>{$t('picker.count', { count: selected.length, total: options.length })}</span>
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .disabled {
    opacity: 0.6;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .list {
    max-height: 208px;
    overflow-y: auto;
    padding: var(--space-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-field);
    background: var(--surface-inset);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 36px;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .disabled .row,
  .row.locked {
    cursor: not-allowed;
  }
  .row.locked {
    opacity: 0.6;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row:has(input:focus-visible) {
    box-shadow: inset 0 0 0 2px var(--ring);
  }
  input {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--text-strong);
    cursor: inherit;
  }
  input:focus-visible {
    outline: none;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    display: flex;
    justify-content: center;
    margin: 0;
    padding: var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }
  .foot {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
