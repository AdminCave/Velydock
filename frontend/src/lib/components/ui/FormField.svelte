<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { language, t } from '$lib/i18n';
  import { setField } from './field';

  interface Props {
    label?: string;
    // Id of the control; generated when the page does not need to know it.
    id?: string;
    required?: boolean;
    hint?: string;
    // Replaces the hint and marks the control invalid. It is taken back as soon as the
    // user edits the field: the message was about what stood there before. Pass it with
    // `bind:error`, or say with `onedit` how the page forgets it.
    error?: string;
    onedit?: () => void;
    // Attributes of the message while it is an error: a hook for tests, the code behind it.
    errorAttrs?: Record<string, string | undefined>;
    children: Snippet;
  }

  const uid = $props.id();
  let {
    label,
    id = `${uid}-control`,
    required = false,
    hint,
    error = $bindable(),
    onedit,
    errorAttrs,
    children,
  }: Props = $props();

  // `input` and `change` of whatever control the field holds bubble up to here.
  function edited() {
    if (!error) return;
    if (onedit) onedit();
    else error = undefined;
  }

  const labelId = `${uid}-label`;
  const msgId = `${uid}-msg`;
  const limitId = `${uid}-limit`;
  let group = $state(false);
  // The browser stops typing at `maxlength` without a word and cuts what is pasted. Once
  // the control is full the field says so, so that nobody saves a cut text unawares.
  let limit = $state<number | null>(null);

  setField({
    get id() {
      return id;
    },
    get labelId() {
      return label ? labelId : undefined;
    },
    get describedBy() {
      const ids = [error || hint ? msgId : null, limit !== null ? limitId : null];
      return ids.filter(Boolean).join(' ') || undefined;
    },
    get invalid() {
      return !!error;
    },
    markGroup() {
      group = true;
    },
    atLimit(max) {
      limit = max;
    },
  });
</script>

<div class="ui-field" oninput={edited} onchange={edited}>
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
    <span class="msg error" id={msgId} {...errorAttrs}>{error}</span>
  {:else if hint}
    <span class="msg" id={msgId}>{hint}</span>
  {/if}
  {#if limit !== null}
    <span class="msg limit" id={limitId} role="status" data-testid="field-limit">
      {$t('validation.maxLength', { max: new Intl.NumberFormat($language).format(limit) })}
    </span>
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
  .limit {
    color: var(--text-muted);
  }
</style>
