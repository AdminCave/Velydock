<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import type { Tenant } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    /** The organization to delete; null keeps the dialog closed. */
    tenant: Tenant | null;
    onClose: () => void;
    onDeleted: (tenant: Tenant) => void;
  }

  let { tenant, onClose, onDeleted }: Props = $props();

  const formId = $props.id();
  let typed = $state('');
  let deleting = $state(false);
  let failure = $state('');
  let mismatch = $state(false);

  $effect(() => {
    if (!tenant) return;
    untrack(() => {
      typed = '';
      deleting = false;
      failure = '';
      mismatch = false;
    });
  });

  // Deleting needs the short name typed out, exactly.
  const matches = $derived(tenant !== null && typed.trim() === tenant.slug);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!tenant || deleting) return;
    mismatch = !matches;
    failure = '';
    if (!matches) return;
    deleting = true;
    try {
      await api.post('/api/v1/system/tenants/{tenant_id}/delete', {
        path: { tenant_id: tenant.id },
        body: { confirm_slug: typed.trim() },
      });
      onDeleted(tenant);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'confirmation_mismatch') mismatch = true;
      else failure = errorMessage(err, $t);
    } finally {
      deleting = false;
    }
  }
</script>

<Modal
  open={tenant !== null}
  title={$t('tenants.delete.title', { name: tenant?.name ?? '' })}
  width="520px"
  error={failure}
  {onClose}
>
  {#if tenant}
    <form id={formId} class="form" onsubmit={submit} novalidate>
      <Callout tone="danger" title={$t('tenants.delete.warning.title')}>
        {$t('tenants.delete.warning.text', {
          members: tenant.member_count,
          apps: tenant.app_count,
        })}
      </Callout>
      <FormField
        label={$t('tenants.delete.confirmLabel', { slug: tenant.slug })}
        error={mismatch ? $t('error.confirmation_mismatch') : undefined}
      >
        <Input
          bind:value={typed}
          mono
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          placeholder={tenant.slug}
        />
      </FormField>
    </form>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button variant="danger" type="submit" form={formId} loading={deleting} disabled={!matches}>
      {$t('tenants.delete.confirm')}
    </Button>
  {/snippet}
</Modal>
