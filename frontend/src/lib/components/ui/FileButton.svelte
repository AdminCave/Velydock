<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import Upload from '@lucide/svelte/icons/upload';
  import { getField } from './field';

  interface Props {
    /** The visible text, which is also the name of the control. */
    label: string;
    accept?: string;
    disabled?: boolean;
    /** The file is what the FormField around it is about: its label, message and invalid
     *  state then belong to this control. Leave it off next to another control of the field. */
    control?: boolean;
    testid?: string;
    onPick: (file: File) => void;
  }

  let { label, accept, disabled = false, control = false, testid, onPick }: Props = $props();

  const field = getField();
  const bound = $derived(control ? field : undefined);

  function changed(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // The input keeps nothing: the same file can be chosen again, and what was chosen
    // lives where the page put it and nowhere else.
    input.value = '';
    if (file) onPick(file);
  }
</script>

<!-- The file input covers the label and is invisible: the label is what is seen, the
     input what is used (and what the keyboard focuses). -->
<label class="file-button" class:disabled class:invalid={bound?.invalid}>
  <input
    type="file"
    id={bound?.id}
    {accept}
    {disabled}
    aria-invalid={bound?.invalid || undefined}
    aria-describedby={bound?.describedBy}
    data-testid={testid}
    onchange={changed}
  />
  <Upload size={16} />
  <span>{label}</span>
</label>

<style>
  .file-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: var(--space-2);
    height: 40px;
    padding: 0 var(--space-5);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
  }
  .file-button:hover:not(.disabled) {
    background: var(--surface-hover);
  }
  .invalid {
    border-color: var(--danger-border);
  }
  .disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: inherit;
  }
  .file-button:has(input:focus-visible) {
    outline: var(--ring-width) solid var(--ring);
    outline-offset: 1px;
  }
</style>
