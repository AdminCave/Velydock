<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import { ROLES, type Group, type Role, type User, type UserUpdate } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import MultiPicker from '$lib/components/ui/MultiPicker.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { t } from '$lib/i18n';
  import { focusFirstInvalid, formChanged } from '$lib/utils/forms';
  import { isValidEmail } from '$lib/utils/validate';

  interface Props {
    /** The user to edit; null keeps the dialog closed. */
    user: User | null;
    groups: Group[];
    /** Whether the administrator may change group assignments at all (groups:write). */
    canEditGroups: boolean;
    /** The administrator is editing their own account. */
    isSelf: boolean;
    onClose: () => void;
    onSaved: (user: User) => void;
  }

  let { user, groups, canEditGroups, isSelf, onClose, onSaved }: Props = $props();

  const formId = $props.id();
  let firstName = $state('');
  let lastName = $state('');
  let email = $state('');
  let role = $state<Role>('member');
  let groupIds = $state<string[]>([]);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let failure = $state('');

  // With changes in it the dialog does not close on a stray click or key (see Modal).
  const fields = () => [firstName, lastName, email, role, [...groupIds]];
  let pristine = $state.raw<unknown[]>([]);
  const dirty = $derived(formChanged(fields(), pristine));

  // A field marked invalid gets the focus, so the message is seen even in a long form.
  $effect(() => {
    if (Object.values(errors).some(Boolean)) void focusFirstInvalid(formId);
  });

  $effect(() => {
    const current = user;
    if (!current) return;
    untrack(() => {
      firstName = current.first_name;
      lastName = current.last_name;
      email = current.email ?? '';
      role = current.role ?? 'member';
      groupIds = current.groups.map((g) => g.id);
      saving = false;
      errors = {};
      failure = '';
      pristine = fields();
    });
  });

  // What this administrator may change is decided by the API per user.
  const identityLocked = $derived(!user?.can_edit_identity);
  const roleLocked = $derived(!user?.can_assign_role);
  const groupsLocked = $derived(!user?.can_edit_membership || !canEditGroups);

  const roleOptions = $derived(ROLES.map((value) => ({ value, label: $t(`role.${value}`) })));
  const groupOptions = $derived(groups.map((g) => ({ id: g.id, label: g.name })));

  function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && [...a].sort().join() === [...b].sort().join();
  }

  // Only what actually changed is sent: the API rejects a request that touches a part
  // this administrator may not change, even if the value stays the same.
  function patch(current: User): UserUpdate {
    const body: UserUpdate = {};
    if (!identityLocked) {
      if (firstName.trim() !== current.first_name) body.first_name = firstName.trim();
      if (lastName.trim() !== current.last_name) body.last_name = lastName.trim();
      if (email.trim().toLowerCase() !== (current.email ?? '')) body.email = email.trim() || null;
    }
    if (!roleLocked && role !== current.role) body.role = role;
    if (
      !groupsLocked &&
      !sameIds(
        groupIds,
        current.groups.map((g) => g.id),
      )
    ) {
      body.group_ids = groupIds;
    }
    return body;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!user || saving) return;
    const found: Record<string, string> = {};
    if (!identityLocked) {
      if (!firstName.trim()) found.first_name = $t('validation.required');
      if (!lastName.trim()) found.last_name = $t('validation.required');
      if (email.trim() && !isValidEmail(email)) found.email = $t('validation.email');
    }
    errors = found;
    failure = '';
    if (Object.keys(found).length > 0) return;

    const body = patch(user);
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    saving = true;
    try {
      onSaved(
        await api.patch('/api/v1/admin/users/{user_id}', { path: { user_id: user.id }, body }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_taken') {
        errors = { email: $t('error.email_taken') };
      } else {
        failure = errorMessage(err, $t);
      }
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  open={user !== null}
  title={$t('users.edit.title', { name: user?.display_name ?? '' })}
  width="620px"
  error={failure}
  {dirty}
  {onClose}
>
  {#if user}
    <form id={formId} class="form" onsubmit={submit} novalidate>
      {#if identityLocked}
        <Callout tone="neutral" testid="identity-locked">
          {user.managed ? $t('users.edit.lockedRank') : $t('users.edit.lockedGuest')}
        </Callout>
      {/if}
      <FormField label={$t('field.username')} hint={$t('users.edit.usernameFixed')}>
        <Input value={user.username} readonly mono />
      </FormField>
      <div class="form-row">
        <FormField label={$t('field.first_name')} required error={errors.first_name}>
          <Input bind:value={firstName} maxlength={100} readonly={identityLocked} required />
        </FormField>
        <FormField label={$t('field.last_name')} required error={errors.last_name}>
          <Input bind:value={lastName} maxlength={100} readonly={identityLocked} required />
        </FormField>
      </div>
      <FormField label={$t('field.email')} error={errors.email}>
        <Input bind:value={email} type="email" maxlength={254} readonly={identityLocked} />
      </FormField>
      <FormField
        label={$t('field.role')}
        hint={roleLocked
          ? isSelf
            ? $t('users.role.self')
            : $t('users.role.locked')
          : $t('users.role.hint')}
      >
        <Select bind:value={role} options={roleOptions} fullWidth disabled={roleLocked} />
      </FormField>
      {#if groups.length > 0}
        <FormField
          label={$t('field.groups')}
          hint={groupsLocked ? $t('users.groups.locked') : $t('users.groups.hint')}
        >
          <MultiPicker bind:selected={groupIds} options={groupOptions} disabled={groupsLocked} />
        </FormField>
      {/if}
    </form>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving}>{$t('action.save')}</Button>
  {/snippet}
</Modal>
