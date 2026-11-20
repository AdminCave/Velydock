<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import { fetchAllUsers } from '$lib/api/helpers';
  import type { Group, GroupDetail, User } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import MultiPicker from '$lib/components/ui/MultiPicker.svelte';
  import { t } from '$lib/i18n';
  import { focusFirstInvalid, formChanged } from '$lib/utils/forms';

  interface Props {
    open: boolean;
    /** The group to edit; null creates a new one. */
    group: Group | null;
    /** Whether the member list can be read at all (users:read). */
    canReadUsers: boolean;
    onClose: () => void;
    onSaved: (group: GroupDetail, created: boolean) => void;
  }

  let { open, group, canReadUsers, onClose, onSaved }: Props = $props();

  const formId = $props.id();
  let name = $state('');
  let description = $state('');
  let memberIds = $state<string[]>([]);
  let originalMembers = $state.raw<string[]>([]);
  let users = $state<User[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let failure = $state('');

  // With changes in it the dialog does not close on a stray click or key (see Modal).
  // The members count from what the server reported, which arrives after opening.
  const dirty = $derived(
    formChanged(
      [name, description, [...memberIds].sort()],
      [group?.name ?? '', group?.description ?? '', [...originalMembers].sort()],
    ),
  );

  // A field marked invalid gets the focus, so the message is seen even in a long form.
  $effect(() => {
    if (Object.values(errors).some(Boolean)) void focusFirstInvalid(formId);
  });

  // Opening loads the organization's users for the picker and, when editing, the
  // group's current members.
  $effect(() => {
    if (!open) return;
    const current = group;
    const controller = new AbortController();
    untrack(() => {
      name = current?.name ?? '';
      description = current?.description ?? '';
      memberIds = [];
      originalMembers = [];
      errors = {};
      failure = '';
      saving = false;
      loading = true;
    });
    Promise.all([
      canReadUsers ? fetchAllUsers(controller.signal) : Promise.resolve([]),
      current
        ? api.get('/api/v1/admin/groups/{group_id}', {
            path: { group_id: current.id },
            signal: controller.signal,
          })
        : Promise.resolve(null),
    ])
      .then(([allUsers, detail]) => {
        users = allUsers;
        if (detail) {
          memberIds = [...detail.member_ids];
          originalMembers = [...detail.member_ids];
        }
        loading = false;
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        failure = errorMessage(err, $t);
        loading = false;
      });
    return () => controller.abort();
  });

  // The API refuses a change that adds or removes somebody who outranks the administrator
  // (a user manager and an administrator, anybody and a system administrator). Those
  // accounts are shown as they are and cannot be toggled; `can_edit_membership` says which.
  const options = $derived(
    users.map((u) => ({
      id: u.id,
      label: u.active ? u.display_name : `${u.display_name} (${$t('status.inactive')})`,
      detail: u.username,
      locked: !u.can_edit_membership,
    })),
  );
  const someLocked = $derived(options.some((option) => option.locked));

  function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && [...a].sort().join() === [...b].sort().join();
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || loading) return;
    errors = name.trim() ? {} : { name: $t('validation.required') };
    failure = '';
    if (errors.name) return;
    saving = true;
    try {
      if (group) {
        const saved = await api.patch('/api/v1/admin/groups/{group_id}', {
          path: { group_id: group.id },
          body: {
            name: name.trim(),
            description: description.trim(),
            // Members are only sent when they changed.
            ...(sameIds(memberIds, originalMembers) ? {} : { member_ids: memberIds }),
          },
        });
        onSaved(saved, false);
      } else {
        const saved = await api.post('/api/v1/admin/groups', {
          body: { name: name.trim(), description: description.trim(), member_ids: memberIds },
        });
        onSaved(saved, true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'group_name_taken') {
        errors = { name: $t('error.group_name_taken') };
      } else {
        failure = errorMessage(err, $t);
      }
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  {open}
  title={group ? $t('groups.edit.title', { name: group.name }) : $t('groups.create.title')}
  width="620px"
  error={failure}
  {dirty}
  {onClose}
>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <FormField label={$t('field.name')} required error={errors.name}>
      <Input bind:value={name} maxlength={100} required />
    </FormField>
    <FormField label={$t('field.description')} hint={$t('groups.description.hint')}>
      <Input bind:value={description} multiline rows={2} maxlength={500} />
    </FormField>
    {#if canReadUsers}
      <FormField
        label={$t('groups.members')}
        hint={someLocked
          ? `${$t('groups.members.hint')} ${$t('groups.members.locked')}`
          : $t('groups.members.hint')}
      >
        <MultiPicker
          bind:selected={memberIds}
          {options}
          {loading}
          lockedHint={$t('groups.members.locked')}
          searchPlaceholder={$t('groups.members.search')}
          emptyText={$t('groups.members.empty')}
        />
      </FormField>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving} disabled={loading}>
      {group ? $t('action.save') : $t('groups.create.submit')}
    </Button>
  {/snippet}
</Modal>
