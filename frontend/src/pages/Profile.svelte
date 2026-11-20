<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import LogOut from '@lucide/svelte/icons/log-out';
  import { fieldErrors } from '$lib/api/errors';
  import Button from '$lib/components/ui/Button.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { t } from '$lib/i18n';
  import { me, signOut, updateProfile } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';

  let firstName = $state('');
  let lastName = $state('');
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});

  // Start from what the server knows; after saving, the store carries the new values.
  // Primitives on purpose: a refreshed `me` with the same names must not reset the form
  // while someone is typing.
  const storedFirst = $derived($me?.user.first_name ?? '');
  const storedLast = $derived($me?.user.last_name ?? '');
  $effect(() => {
    firstName = storedFirst;
    lastName = storedLast;
  });

  const changed = $derived(firstName.trim() !== storedFirst || lastName.trim() !== storedLast);
  const valid = $derived(firstName.trim().length > 0 && lastName.trim().length > 0);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!valid || !changed || saving) return;
    saving = true;
    errors = {};
    try {
      await updateProfile(firstName.trim(), lastName.trim());
      showToast($t('profile.saved'));
    } catch (err) {
      errors = fieldErrors(err);
      showError(err);
    } finally {
      saving = false;
    }
  }

  function roleLabel(role: string | null | undefined): string {
    return role ? $t(`role.${role}`) : $t('role.none');
  }
</script>

{#if $me}
  <div class="page page-narrow">
    <header class="page-header">
      <div>
        <h1 class="page-title">{$t('profile.title')}</h1>
        <p class="page-subtitle">{$t('profile.subtitle')}</p>
      </div>
    </header>

    <section class="card card-pad section" aria-labelledby="profile-name">
      <div>
        <h2 class="section-title" id="profile-name">{$t('profile.personal.title')}</h2>
        <p class="section-desc">{$t('profile.personal.text')}</p>
      </div>
      <form class="form" onsubmit={save} novalidate>
        <div class="form-row">
          <FormField
            label={$t('field.first_name')}
            required
            error={errors.first_name ? $t('validation.required') : undefined}
          >
            <Input bind:value={firstName} maxlength={100} autocomplete="given-name" required />
          </FormField>
          <FormField
            label={$t('field.last_name')}
            required
            error={errors.last_name ? $t('validation.required') : undefined}
          >
            <Input bind:value={lastName} maxlength={100} autocomplete="family-name" required />
          </FormField>
        </div>
        <div class="form-row">
          <FormField label={$t('field.username')}>
            <Input value={$me.user.username} readonly mono />
          </FormField>
          <FormField label={$t('field.email')} hint={$t('profile.email.hint')}>
            <Input value={$me.user.email ?? ''} readonly placeholder={$t('profile.email.none')} />
          </FormField>
        </div>
        <div class="form-actions">
          <Button type="submit" loading={saving} disabled={!changed || !valid}>
            {$t('action.save')}
          </Button>
        </div>
      </form>
    </section>

    <section class="card card-pad section" aria-labelledby="profile-org">
      <div>
        <h2 class="section-title" id="profile-org">{$t('profile.org.title')}</h2>
        <p class="section-desc">{$t('profile.org.text')}</p>
      </div>
      {#if $me.active_tenant}
        <dl class="facts">
          <div>
            <dt>{$t('profile.org.name')}</dt>
            <dd>{$me.active_tenant.name}</dd>
          </div>
          <div>
            <dt>{$t('profile.org.role')}</dt>
            <dd>{roleLabel($me.role)}</dd>
          </div>
          {#if $me.user.is_system_admin}
            <div>
              <dt>{$t('profile.org.system')}</dt>
              <dd>{$t('role.system_admin')}</dd>
            </div>
          {/if}
        </dl>
      {:else}
        <p class="help">{$t('profile.org.none')}</p>
      {/if}
    </section>

    <section class="card card-pad section" aria-labelledby="profile-security">
      <div>
        <h2 class="section-title" id="profile-security">{$t('profile.security.title')}</h2>
        <p class="section-desc">{$t('profile.security.text')}</p>
      </div>
      <div class="form-actions">
        <a
          class="outline-link"
          href={$me.account_url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="account-link"
        >
          <ExternalLink size={16} />
          {$t('profile.security.link')}
        </a>
      </div>
    </section>

    <section class="card card-pad section" aria-labelledby="profile-signout">
      <div>
        <h2 class="section-title" id="profile-signout">{$t('profile.signOut.title')}</h2>
        <p class="section-desc">{$t('profile.signOut.text')}</p>
      </div>
      <div class="form-actions">
        <Button variant="secondary" iconLeft={LogOut} onclick={() => void signOut()}>
          {$t('nav.signOut')}
        </Button>
      </div>
    </section>
  </div>
{/if}

<style>
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-5);
    margin: 0;
  }
  dt {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
  }
  dd {
    margin: var(--space-1) 0 0;
    color: var(--text-strong);
    font-weight: var(--fw-medium);
    overflow-wrap: anywhere;
  }
  .outline-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 40px;
    padding: 0 18px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    text-decoration: none;
  }
  .outline-link:hover {
    background: var(--surface-hover);
    text-decoration: none;
  }
</style>
