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
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import { t } from '$lib/i18n';
  import { focusFirstInvalid, formChanged } from '$lib/utils/forms';
  import { SLUG_MAX_LENGTH, slugProblem, suggestSlug } from '$lib/utils/slug';

  interface Props {
    open: boolean;
    /** The organization to rename; null creates a new one. */
    tenant: Tenant | null;
    onClose: () => void;
    onSaved: (tenant: Tenant, created: boolean) => void;
  }

  let { open, tenant, onClose, onSaved }: Props = $props();

  const formId = $props.id();
  let name = $state('');
  let slug = $state('');
  // The short name follows the name until the administrator edits it by hand.
  let slugTouched = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let failure = $state('');

  // With input in it the dialog does not close on a stray click or key (see Modal).
  const dirty = $derived(formChanged([name, slug], [tenant?.name ?? '', tenant?.slug ?? '']));

  // A field marked invalid gets the focus, so the message is seen even in a long form.
  $effect(() => {
    if (Object.values(errors).some(Boolean)) void focusFirstInvalid(formId);
  });

  $effect(() => {
    if (!open) return;
    const current = tenant;
    untrack(() => {
      name = current?.name ?? '';
      slug = current?.slug ?? '';
      slugTouched = false;
      saving = false;
      errors = {};
      failure = '';
    });
  });

  function onNameInput() {
    if (!tenant && !slugTouched) slug = suggestSlug(name);
  }

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (name.trim().length < 2) found.name = $t('tenants.name.tooShort');
    if (!tenant) {
      const problem = slugProblem(slug.trim());
      if (problem === 'format') found.slug = $t('tenants.slug.format');
      if (problem === 'reserved') found.slug = $t('tenants.slug.reserved');
    }
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
      if (tenant) {
        const saved = await api.patch('/api/v1/system/tenants/{tenant_id}', {
          path: { tenant_id: tenant.id },
          body: { name: name.trim() },
        });
        onSaved(saved, false);
      } else {
        const saved = await api.post('/api/v1/system/tenants', {
          body: { name: name.trim(), slug: slug.trim() },
        });
        onSaved(saved, true);
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'tenant_slug_taken') errors = { slug: $t('error.tenant_slug_taken') };
      else if (code === 'tenant_name_taken') errors = { name: $t('error.tenant_name_taken') };
      else failure = errorMessage(err, $t);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  {open}
  title={tenant ? $t('tenants.rename.title', { name: tenant.name }) : $t('tenants.create.title')}
  width="520px"
  error={failure}
  {dirty}
  {onClose}
>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <FormField label={$t('field.name')} required error={errors.name}>
      <Input bind:value={name} maxlength={120} required oninput={onNameInput} />
    </FormField>
    <FormField
      label={$t('field.slug')}
      required={!tenant}
      hint={tenant ? $t('tenants.slug.fixed') : $t('tenants.slug.hint')}
      error={errors.slug}
    >
      <Input
        bind:value={slug}
        mono
        maxlength={SLUG_MAX_LENGTH}
        readonly={!!tenant}
        autocapitalize="none"
        spellcheck={false}
        required={!tenant}
        oninput={() => (slugTouched = true)}
      />
    </FormField>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving}>
      {tenant ? $t('action.save') : $t('tenants.create.submit')}
    </Button>
  {/snippet}
</Modal>
