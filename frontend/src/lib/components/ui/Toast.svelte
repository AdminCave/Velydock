<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { toasts, dismissToast } from '$lib/stores/toasts';
  import { t } from '$lib/i18n';
</script>

<!-- Each toast is its own live region (role="status"); a click dismisses it. -->
<div class="toast-stack">
  {#each $toasts as toast (toast.id)}
    <div class="toast {toast.kind}" role="status" data-testid="toast" data-kind={toast.kind}>
      <span class="dot" aria-hidden="true"></span>
      <span class="msg">{toast.message}</span>
      <button
        type="button"
        class="close"
        aria-label={$t('action.close')}
        onclick={() => dismissToast(toast.id)}
      >
        ×
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-stack {
    /* Bottom left: dialogs and pages keep their buttons at the right. */
    position: fixed;
    left: var(--toast-left, var(--space-4));
    bottom: var(--toast-bottom, var(--space-4));
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    z-index: 9999;
    pointer-events: none;
  }
  .toast {
    --dot: var(--text-muted);
    display: flex;
    align-items: flex-start;
    gap: 12px;
    box-sizing: border-box;
    width: 380px;
    max-width: calc(100vw - 2 * var(--space-4));
    padding: 14px 12px 14px 16px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    box-shadow: var(--shadow-pop);
    color: var(--text-strong);
    font-size: var(--text-base);
    pointer-events: auto;
    animation: toast-in var(--dur-base) var(--ease-out);
  }
  .toast.success {
    --dot: var(--success);
  }
  .toast.error {
    --dot: var(--danger);
  }
  .toast.info {
    --dot: var(--accent);
  }
  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    margin-top: 7px;
    border-radius: var(--radius-pill);
    background: var(--dot);
  }
  .msg {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .close {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-subtle);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
