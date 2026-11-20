<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  // The question itself lives in confirm.ts; these names stay available here because
  // pages import them together with the dialog.
  export { cancelConfirm, confirmDialog, type ConfirmOptions } from './confirm';
</script>

<script lang="ts">
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import { pendingConfirm, settleConfirm } from './confirm';
  import { t } from '$lib/i18n';

  const request = $derived($pendingConfirm);

  function settle(ok: boolean) {
    settleConfirm(ok);
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
