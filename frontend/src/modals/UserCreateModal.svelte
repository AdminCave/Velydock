<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import { ROLES, type Group, type Role, type UserCreated } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import MultiPicker from '$lib/components/ui/MultiPicker.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { t } from '$lib/i18n';
  import { focusFirstInvalid } from '$lib/utils/forms';
  import { isValidEmail, isValidUsername } from '$lib/utils/validate';

  interface Props {
    open: boolean;
    /** Groups of the organization; empty hides the group selection. */
    groups: Group[];
    /** Whether the administrator may give out other roles than "member" (roles:assign). */
    canAssignRoles: boolean;
    onClose: () => void;
    onCreated: (result: UserCreated) => void;
  }

  let { open, groups, canAssignRoles, onClose, onCreated }: Props = $props();

  const formId = $props.id();
  let username = $state('');
  let firstName = $state('');
  let lastName = $state('');
  let email = $state('');
  let role = $state<Role>('member');
  let groupIds = $state<string[]>([]);
  let sendEmail = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let failure = $state('');

  // A field marked invalid gets the focus, so the message is seen even in a long form.
  $effect(() => {
    if (Object.values(errors).some(Boolean)) void focusFirstInvalid(formId);
  });

  // Every opening starts with an empty form.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      username = firstName = lastName = email = '';
      role = 'member';
      groupIds = [];
      sendEmail = false;
      saving = false;
      errors = {};
      failure = '';
    });
  });

  const roleOptions = $derived(
    (canAssignRoles ? ROLES : ROLES.slice(0, 1)).map((value) => ({
      value,
      label: $t(`role.${value}`),
    })),
  );
  const groupOptions = $derived(groups.map((g) => ({ id: g.id, label: g.name })));

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!username.trim()) found.username = $t('validation.required');
    else if (!isValidUsername(username)) found.username = $t('validation.username');
    if (!firstName.trim()) found.first_name = $t('validation.required');
    if (!lastName.trim()) found.last_name = $t('validation.required');
    if (email.trim() && !isValidEmail(email)) found.email = $t('validation.email');
    if (sendEmail && !email.trim()) found.email = $t('error.email_required');
    return found;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    errors = validate();
    failure = '';
    if (Object.keys(errors).length > 0) return;
    saving = true;
    try {
      const result = await api.post('/api/v1/admin/users', {
        body: {
          username: username.trim().toLowerCase(),
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim() || null,
          role,
          group_ids: groupIds,
          send_email: sendEmail,
        },
      });
      onCreated(result);
    } catch (err) {
      // Problems that belong to one field are shown at that field.
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'username_taken') errors = { username: $t('error.username_taken') };
      else if (code === 'email_taken') errors = { email: $t('error.email_taken') };
      else if (code === 'email_required') errors = { email: $t('error.email_required') };
      else failure = errorMessage(err, $t);
    } finally {
      saving = false;
    }
  }
</script>

<Modal {open} title={$t('users.create.title')} width="620px" error={failure} {onClose}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <FormField
      label={$t('field.username')}
      required
      hint={$t('users.username.hint')}
      error={errors.username}
    >
      <Input
        bind:value={username}
        mono
        maxlength={64}
        autocomplete="off"
        autocapitalize="none"
        spellcheck={false}
        required
      />
    </FormField>
    <div class="form-row">
      <FormField label={$t('field.first_name')} required error={errors.first_name}>
        <Input bind:value={firstName} maxlength={100} autocomplete="off" required />
      </FormField>
      <FormField label={$t('field.last_name')} required error={errors.last_name}>
        <Input bind:value={lastName} maxlength={100} autocomplete="off" required />
      </FormField>
    </div>
    <FormField label={$t('field.email')} hint={$t('users.email.hint')} error={errors.email}>
      <Input bind:value={email} type="email" maxlength={254} autocomplete="off" />
    </FormField>
    <FormField
      label={$t('field.role')}
      hint={canAssignRoles ? $t('users.role.hint') : $t('users.role.memberOnly')}
    >
      <Select bind:value={role} options={roleOptions} fullWidth disabled={!canAssignRoles} />
    </FormField>
    {#if groups.length > 0}
      <FormField label={$t('field.groups')} hint={$t('users.groups.hint')}>
        <MultiPicker bind:selected={groupIds} options={groupOptions} />
      </FormField>
    {/if}
    <Checkbox
      bind:checked={sendEmail}
      label={$t('users.sendEmail.label')}
      description={$t('users.sendEmail.text')}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving}>{$t('users.create.submit')}</Button>
  {/snippet}
</Modal>
