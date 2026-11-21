<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, tenantApi } from '$lib/api/client';
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
  import { focusOnNewErrors, formChanged, refusedFields } from '$lib/utils/forms';
  import { isValidEmail, normalizeName, personNameProblem } from '$lib/utils/validate';

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

  // Bound to the organization the page was opened for (see tenantApi()).
  const api = tenantApi();

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
  const focusErrors = focusOnNewErrors(formId);
  $effect(() => focusErrors(errors));

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
  // Nothing in the dialog can be changed by this administrator: it only shows the account.
  const readOnly = $derived(identityLocked && roleLocked && (groupsLocked || groups.length === 0));
  // A role with administrative rights that is higher than the one the person has: the
  // server ends their sessions then, so that the new rights start with a fresh sign-in.
  const promotes = $derived(
    !!user &&
      !roleLocked &&
      role !== 'member' &&
      ROLES.indexOf(role) > ROLES.indexOf(user.role ?? 'member'),
  );

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
      // Compared as the server stores names (one blank between words): a change of
      // blanks alone is none.
      if (normalizeName(firstName) !== current.first_name)
        body.first_name = normalizeName(firstName);
      if (normalizeName(lastName) !== current.last_name) body.last_name = normalizeName(lastName);
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
      const first = personNameProblem(firstName);
      const last = personNameProblem(lastName);
      if (first) found.first_name = $t(first);
      if (last) found.last_name = $t(last);
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
      // What the server refuses about one field is said at that field.
      const refused = refusedFields(err, {
        first_name: () => $t(personNameProblem(firstName) ?? 'validation.invalid'),
        last_name: () => $t(personNameProblem(lastName) ?? 'validation.invalid'),
        email: () => $t('validation.email'),
      });
      if (err instanceof ApiError && err.code === 'email_taken') {
        errors = { email: $t('error.email_taken') };
      } else if (Object.keys(refused).length > 0) {
        errors = refused;
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
        <FormField label={$t('field.first_name')} required bind:error={errors.first_name}>
          <Input bind:value={firstName} maxlength={100} readonly={identityLocked} required />
        </FormField>
        <FormField label={$t('field.last_name')} required bind:error={errors.last_name}>
          <Input bind:value={lastName} maxlength={100} readonly={identityLocked} required />
        </FormField>
      </div>
      <FormField label={$t('field.email')} bind:error={errors.email}>
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
      {#if promotes}
        <Callout tone="warning" role="status" testid="role-signs-out">
          {$t('users.role.signsOut')}
        </Callout>
      {/if}
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
    {#if readOnly}
      <!-- Nothing to save: no button that pretends otherwise. -->
      <Button variant="secondary" onclick={onClose}>{$t('action.close')}</Button>
    {:else}
      <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
      <Button type="submit" form={formId} loading={saving}>{$t('action.save')}</Button>
    {/if}
  {/snippet}
</Modal>
