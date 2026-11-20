<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import { t } from '$lib/i18n';
  import { copyToClipboard } from '$lib/utils/clipboard';

  interface Props {
    /** The one-time password to show; null keeps the dialog closed. */
    password: string | null;
    /** Display name of the user it belongs to. */
    name: string;
    username: string;
    onClose: () => void;
  }

  let { password, name, username, onClose }: Props = $props();
</script>

<!-- The API returns a one-time password exactly once; it is shown here and nowhere else,
     and it is gone as soon as this dialog closes. Hence not dismissible: neither Escape nor
     a click beside the dialog closes it, only its button does. -->
<Modal
  open={password !== null}
  title={$t('tempPassword.title', { name })}
  width="480px"
  dismissible={false}
  {onClose}
>
  <Callout tone="warning" title={$t('tempPassword.once.title')}>
    {$t('tempPassword.once.text')}
  </Callout>
  <div class="reveal">
    <div class="pair">
      <span class="caption">{$t('field.username')}</span>
      <code class="value">{username}</code>
    </div>
    <div class="pair">
      <span class="caption">{$t('tempPassword.label')}</span>
      <code class="value secret" data-testid="temp-password">{password ?? ''}</code>
    </div>
    <Button
      variant="secondary"
      iconLeft={Copy}
      onclick={() => void copyToClipboard(password ?? '', 'tempPassword.copied')}
    >
      {$t('tempPassword.copy')}
    </Button>
  </div>
  <p class="help">{$t('tempPassword.hint')}</p>
  {#snippet footer()}
    <Button onclick={onClose}>{$t('tempPassword.done')}</Button>
  {/snippet}
</Modal>

<style>
  .reveal {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-5);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
  }
  .pair {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    max-width: 100%;
  }
  .caption {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
  }
  .value {
    color: var(--text-strong);
    font-size: var(--text-base);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .secret {
    font-size: var(--text-lg);
    font-weight: var(--fw-medium);
    letter-spacing: 0.04em;
  }
</style>
