<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  import { writable, get } from 'svelte/store';

  export interface ConfirmOptions {
    title?: string;
    /** Plain-language consequences, shown below the question. */
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** "danger" for anything that deletes or locks out; "neutral" otherwise. */
    tone?: 'danger' | 'neutral';
  }

  interface ConfirmRequest extends ConfirmOptions {
    message: string;
    resolve: (ok: boolean) => void;
  }

  const _pending = writable<ConfirmRequest | null>(null);

  /** Ask a yes/no question in a dialog. Resolves false when dismissed. */
  export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
    // Resolve a still-open question as cancelled before replacing it; its awaiter would
    // otherwise hang forever.
    const previous = get(_pending);
    if (previous) previous.resolve(false);
    return new Promise((resolve) => {
      _pending.set({ ...options, message, resolve });
    });
  }

  /** Cancel an open question, e.g. when the session ends. */
  export function cancelConfirm(): void {
    const current = get(_pending);
    if (current) current.resolve(false);
    _pending.set(null);
  }
</script>

<script lang="ts">
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import { t } from '$lib/i18n';

  const request = $derived($_pending);

  function settle(ok: boolean) {
    request?.resolve(ok);
    _pending.set(null);
  }
</script>

<Modal
  open={request !== null}
  title={request?.title ?? $t('confirm.title')}
  width="440px"
  onClose={() => settle(false)}
>
  <p class="question">{request?.message ?? ''}</p>
  {#if request?.detail}<p class="detail">{request.detail}</p>{/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => settle(false)}>
      {request?.cancelLabel ?? $t('action.cancel')}
    </Button>
    <Button
      variant={request?.tone === 'neutral' ? 'primary' : 'danger'}
      onclick={() => settle(true)}
    >
      {request?.confirmLabel ?? $t('action.confirm')}
    </Button>
  {/snippet}
</Modal>

<style>
  .question {
    margin: 0;
    color: var(--text-strong);
  }
  .detail {
    margin: calc(-1 * var(--space-3)) 0 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
