<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import { ROLES, type Role, type SystemUser, type Tenant } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    /** The account to add somewhere; null keeps the dialog closed. */
    user: SystemUser | null;
    tenants: Tenant[];
    onClose: () => void;
    onAdded: (user: SystemUser, tenant: Tenant) => void;
  }

  let { user, tenants, onClose, onAdded }: Props = $props();

  const formId = $props.id();
  let tenantId = $state('');
  let role = $state<Role>('member');
  let saving = $state(false);
  let failure = $state('');
  let missing = $state(false);

  // With a choice made the dialog does not close on a stray click or key (see Modal).
  const dirty = $derived(tenantId !== '' || role !== 'member');

  $effect(() => {
    if (!user) return;
    untrack(() => {
      tenantId = '';
      role = 'member';
      saving = false;
      failure = '';
      missing = false;
    });
  });

  // Only organizations the account does not belong to yet.
  const available = $derived(
    tenants.filter((tenant) => !user?.memberships.some((m) => m.tenant.id === tenant.id)),
  );
  const tenantOptions = $derived(
    available.map((tenant) => ({ value: tenant.id, label: tenant.name })),
  );
  const roleOptions = $derived(ROLES.map((value) => ({ value, label: $t(`role.${value}`) })));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!user || saving) return;
    const tenant = available.find((candidate) => candidate.id === tenantId);
    missing = !tenant;
    failure = '';
    if (!tenant) return;
    saving = true;
    try {
      const updated = await api.post('/api/v1/system/tenants/{tenant_id}/members', {
        path: { tenant_id: tenant.id },
        body: { user_id: user.id, role },
      });
      onAdded(updated, tenant);
    } catch (err) {
      failure = errorMessage(err, $t);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  open={user !== null}
  title={$t('systemUsers.add.title', { name: user?.display_name ?? '' })}
  width="520px"
  error={failure}
  {dirty}
  {onClose}
>
  {#if user}
    <form id={formId} class="form" onsubmit={submit} novalidate>
      <p class="help">
        {user.home_tenant
          ? $t('systemUsers.add.textGuest', { home: user.home_tenant.name })
          : $t('systemUsers.add.textHome')}
      </p>
      {#if available.length === 0}
        <Callout tone="neutral">{$t('systemUsers.add.none')}</Callout>
      {:else}
        <FormField
          label={$t('systemUsers.add.tenant')}
          required
          error={missing ? $t('validation.required') : undefined}
        >
          <Select
            bind:value={tenantId}
            options={tenantOptions}
            placeholder={$t('systemUsers.add.choose')}
            fullWidth
          />
        </FormField>
        <FormField label={$t('field.role')} hint={$t('users.role.hint')}>
          <Select bind:value={role} options={roleOptions} fullWidth />
        </FormField>
      {/if}
    </form>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving} disabled={available.length === 0}>
      {$t('systemUsers.add.submit')}
    </Button>
  {/snippet}
</Modal>
