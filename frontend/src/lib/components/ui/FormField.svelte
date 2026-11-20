<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setField } from './field';

  interface Props {
    label?: string;
    // Id of the control; generated when the page does not need to know it.
    id?: string;
    required?: boolean;
    hint?: string;
    // Replaces the hint and marks the control invalid.
    error?: string;
    children: Snippet;
  }

  const uid = $props.id();
  let { label, id = `${uid}-control`, required = false, hint, error, children }: Props = $props();

  const labelId = `${uid}-label`;
  const msgId = `${uid}-msg`;
  let group = $state(false);

  setField({
    get id() {
      return id;
    },
    get labelId() {
      return label ? labelId : undefined;
    },
    get describedBy() {
      return error || hint ? msgId : undefined;
    },
    get invalid() {
      return !!error;
    },
    markGroup() {
      group = true;
    },
  });
</script>

<div class="ui-field">
  {#if label}
    <!-- The asterisk sits next to the label, not inside it: the label's text, and with it
         the accessible name of the control, is exactly the label. -->
    <span class="label-row">
      <label class="label" id={labelId} for={group ? undefined : id}>{label}</label>
      {#if required}<span class="req" aria-hidden="true">*</span>{/if}
    </span>
  {/if}
  {@render children()}
  {#if error}
    <span class="msg error" id={msgId}>{error}</span>
  {:else if hint}
    <span class="msg" id={msgId}>{hint}</span>
  {/if}
</div>

<style>
  .ui-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }
  .label-row {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
  }
  .label {
    color: var(--text);
    font-weight: 500;
  }
  .req {
    color: var(--accent);
  }
  .msg {
    color: var(--text-subtle);
    font-size: var(--text-sm);
  }
  .error {
    color: var(--danger);
  }
</style>
