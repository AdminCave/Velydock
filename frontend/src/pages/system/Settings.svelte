<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api/client';
  import { errorMessage, fieldErrors } from '$lib/api/errors';
  import {
    LANGUAGES,
    NAV_POSITIONS,
    THEMES,
    type Language,
    type NavPosition,
    type SmtpSettings,
    type SystemSettings,
    type SystemSettingsUpdate,
    type ThemePreference,
  } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { t } from '$lib/i18n';
  import { refreshMe } from '$lib/stores/session';
  import { showError, showToast } from '$lib/stores/toasts';
  import { focusFirstInvalid, refusedFields } from '$lib/utils/forms';
  import { instanceNameProblem, isValidEmail, normalizeName } from '$lib/utils/validate';

  type Encryption = SmtpSettings['encryption'];

  let settings = $state<SystemSettings | null>(null);
  let failed = $state(false);

  // General
  let instanceName = $state('');
  let navPosition = $state<NavPosition>('left');
  let theme = $state<ThemePreference>('system');
  let lang = $state<Language>('de');
  let require2fa = $state(false);
  let savingGeneral = $state(false);
  let generalErrors = $state<Record<string, string>>({});

  // SMTP
  let host = $state('');
  let port = $state('587');
  let encryption = $state<Encryption>('starttls');
  let fromAddress = $state('');
  let fromName = $state('');
  let smtpUser = $state('');
  let smtpPassword = $state('');
  let savingSmtp = $state(false);
  let smtpErrors = $state<Record<string, string>>({});
  let smtpFailure = $state('');
  const smtpFormId = $props.id();
  const generalFormId = `${smtpFormId}-general`;

  function apply(value: SystemSettings) {
    settings = value;
    instanceName = value.instance_name;
    navPosition = value.default_nav_position;
    theme = value.default_theme;
    lang = value.default_language;
    require2fa = value.require_admin_2fa;
    host = value.smtp.host ?? '';
    port = String(value.smtp.port ?? 587);
    encryption = value.smtp.encryption ?? 'starttls';
    fromAddress = value.smtp.from_address ?? '';
    fromName = value.smtp.from_name ?? '';
    smtpUser = value.smtp.username ?? '';
    // The stored password is never sent to the browser; the field only takes a new one.
    smtpPassword = '';
  }

  async function load() {
    try {
      apply(await api.get('/api/v1/system/settings'));
      failed = false;
    } catch (err) {
      failed = true;
      showError(err);
    }
  }

  onMount(() => void load());

  const navOptions = $derived(
    NAV_POSITIONS.map((value) => ({ value, label: $t(`nav.position.${value}`) })),
  );
  const themeOptions = $derived(
    THEMES.map((value) => ({ value, label: $t(`settings.theme.${value}`) })),
  );
  const langOptions = LANGUAGES.map((value) => ({
    value,
    label: value === 'de' ? 'Deutsch' : 'English',
  }));
  const encryptionOptions = $derived([
    { value: 'starttls' as const, label: 'STARTTLS' },
    { value: 'ssl' as const, label: 'SSL/TLS' },
    { value: 'none' as const, label: $t('systemSettings.smtp.encryption.none') },
  ]);

  async function saveGeneral(event: SubmitEvent) {
    event.preventDefault();
    if (savingGeneral || !settings) return;
    // The rule for the name is the server's (see instanceNameProblem()); said here first,
    // at the field, with the reason.
    const problem = instanceNameProblem(instanceName);
    generalErrors = problem ? { instance_name: $t(problem) } : {};
    if (problem) {
      void focusFirstInvalid(generalFormId);
      return;
    }
    // Only what was changed is sent (and ends up in the audit log); SMTP has its own button.
    // The name is compared as the server stores it: one blank between words.
    const body: SystemSettingsUpdate = {};
    if (normalizeName(instanceName) !== settings.instance_name) {
      body.instance_name = normalizeName(instanceName);
    }
    if (navPosition !== settings.default_nav_position) body.default_nav_position = navPosition;
    if (theme !== settings.default_theme) body.default_theme = theme;
    if (lang !== settings.default_language) body.default_language = lang;
    if (require2fa !== settings.require_admin_2fa) body.require_admin_2fa = require2fa;
    if (Object.keys(body).length === 0) {
      showToast($t('systemSettings.unchanged'), 'info');
      return;
    }
    savingGeneral = true;
    try {
      const saved = await api.patch('/api/v1/system/settings', { body });
      const smtpDraft = { host, port, encryption, fromAddress, fromName, smtpUser, smtpPassword };
      apply(saved);
      // Unsaved SMTP input survives saving the general section.
      ({ host, port, encryption, fromAddress, fromName, smtpUser, smtpPassword } = smtpDraft);
      showToast($t('systemSettings.saved'));
      // Instance name and defaults are part of what every page shows.
      await refreshMe();
    } catch (err) {
      // The server has the last word on the name; what it refuses is said at the field.
      const refused = refusedFields(err, {
        instance_name: () =>
          $t(instanceNameProblem(instanceName) ?? 'systemSettings.instanceName.markup'),
      });
      if (Object.keys(refused).length > 0) {
        generalErrors = refused;
        void focusFirstInvalid(generalFormId);
      } else {
        showError(err);
      }
    } finally {
      savingGeneral = false;
    }
  }

  async function saveSmtp(event: SubmitEvent) {
    event.preventDefault();
    if (savingSmtp) return;
    const found: Record<string, string> = {};
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      found.port = $t('systemSettings.smtp.port.invalid');
    }
    if (fromAddress.trim() && !isValidEmail(fromAddress))
      found.from_address = $t('validation.email');
    smtpErrors = found;
    smtpFailure = '';
    if (Object.keys(found).length > 0) return;
    // The same as what is stored, and no new password: nothing to save.
    const stored = settings?.smtp;
    if (
      stored &&
      smtpPassword === '' &&
      host.trim() === (stored.host ?? '') &&
      portNumber === (stored.port ?? 587) &&
      encryption === (stored.encryption ?? 'starttls') &&
      fromAddress.trim() === (stored.from_address ?? '') &&
      fromName.trim() === (stored.from_name ?? '') &&
      smtpUser.trim() === (stored.username ?? '')
    ) {
      showToast($t('systemSettings.unchanged'), 'info');
      return;
    }
    savingSmtp = true;
    try {
      const saved = await api.patch('/api/v1/system/settings', {
        body: {
          smtp: {
            host: host.trim(),
            port: portNumber,
            encryption,
            from_address: fromAddress.trim(),
            from_name: fromName.trim(),
            username: smtpUser.trim(),
            // Empty keeps the stored password.
            password: smtpPassword,
          },
        },
      });
      const generalDraft = { instanceName, navPosition, theme, lang, require2fa };
      apply(saved);
      ({ instanceName, navPosition, theme, lang, require2fa } = generalDraft);
      showToast($t('systemSettings.smtp.saved'));
    } catch (err) {
      // The stored password only goes with the connection it was saved for: when that
      // was changed and the field left empty, the server asks for it again. Said at the
      // field it is about, which also gets the focus.
      if ('smtp.password' in fieldErrors(err)) {
        smtpErrors = { password: errorMessage(err, $t) };
        void focusFirstInvalid(smtpFormId);
      } else {
        smtpFailure = errorMessage(err, $t);
      }
    } finally {
      savingSmtp = false;
    }
  }
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('systemSettings.title')}</h1>
      <p class="page-subtitle">{$t('systemSettings.subtitle')}</p>
    </div>
  </header>

  {#if settings}
    <form id={generalFormId} class="card card-pad form block" onsubmit={saveGeneral} novalidate>
      <div>
        <h2 class="section-title">{$t('systemSettings.general.title')}</h2>
        <p class="section-desc">{$t('systemSettings.general.text')}</p>
      </div>
      <FormField
        label={$t('systemSettings.instanceName')}
        required
        hint={$t('systemSettings.instanceName.hint')}
        bind:error={generalErrors.instance_name}
      >
        <Input bind:value={instanceName} maxlength={60} required />
      </FormField>
      <div class="form-row three">
        <FormField label={$t('systemSettings.defaultNav')}>
          <Select bind:value={navPosition} options={navOptions} fullWidth />
        </FormField>
        <FormField label={$t('systemSettings.defaultTheme')}>
          <Select bind:value={theme} options={themeOptions} fullWidth />
        </FormField>
        <FormField label={$t('systemSettings.defaultLanguage')}>
          <Select bind:value={lang} options={langOptions} fullWidth />
        </FormField>
      </div>
      <p class="help">{$t('systemSettings.defaults.hint')}</p>

      <div class="divider"></div>
      <div>
        <h2 class="section-title">{$t('systemSettings.security.title')}</h2>
      </div>
      <div class="option">
        <Switch bind:checked={require2fa} label={$t('systemSettings.require2fa.label')} />
        <p class="help">{$t('systemSettings.require2fa.text')}</p>
      </div>

      <div class="form-actions">
        <Button type="submit" loading={savingGeneral}>{$t('action.save')}</Button>
      </div>
    </form>

    <form id={smtpFormId} class="card card-pad form block" onsubmit={saveSmtp} novalidate>
      <div class="smtp-head">
        <div>
          <h2 class="section-title">{$t('systemSettings.smtp.title')}</h2>
          <p class="section-desc">{$t('systemSettings.smtp.text')}</p>
        </div>
        <span data-testid="smtp-status" data-configured={settings.smtp_configured}>
          {#if settings.smtp_configured}
            <Pill tone="ok">{$t('systemSettings.smtp.configured')}</Pill>
          {:else}
            <Pill tone="muted">{$t('systemSettings.smtp.notConfigured')}</Pill>
          {/if}
        </span>
      </div>
      {#if smtpFailure}<Callout tone="danger" role="alert">{smtpFailure}</Callout>{/if}
      <div class="form-row host-row">
        <FormField label={$t('systemSettings.smtp.host')}>
          <Input
            bind:value={host}
            mono
            maxlength={255}
            placeholder="smtp.example.org"
            autocapitalize="none"
            spellcheck={false}
          />
        </FormField>
        <FormField label={$t('systemSettings.smtp.port')} bind:error={smtpErrors.port}>
          <Input bind:value={port} mono inputmode="numeric" />
        </FormField>
        <FormField label={$t('systemSettings.smtp.encryption')}>
          <Select bind:value={encryption} options={encryptionOptions} fullWidth />
        </FormField>
      </div>
      <div class="form-row">
        <FormField
          label={$t('systemSettings.smtp.fromAddress')}
          bind:error={smtpErrors.from_address}
        >
          <Input
            bind:value={fromAddress}
            type="email"
            maxlength={254}
            placeholder="velydock@example.org"
          />
        </FormField>
        <FormField label={$t('systemSettings.smtp.fromName')}>
          <Input bind:value={fromName} maxlength={100} />
        </FormField>
      </div>
      <div class="form-row">
        <FormField label={$t('systemSettings.smtp.username')}>
          <Input
            bind:value={smtpUser}
            maxlength={255}
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
          />
        </FormField>
        <FormField
          label={$t('systemSettings.smtp.password')}
          hint={$t('systemSettings.smtp.password.hint')}
          bind:error={smtpErrors.password}
        >
          <Input
            bind:value={smtpPassword}
            type="password"
            maxlength={500}
            autocomplete="new-password"
            placeholder={settings.smtp_configured ? '••••••••' : ''}
          />
        </FormField>
      </div>
      <div class="form-actions">
        <Button type="submit" loading={savingSmtp}>{$t('systemSettings.smtp.save')}</Button>
      </div>
    </form>
  {:else}
    <div class="table-state">
      {#if failed}
        <Button variant="secondary" onclick={() => void load()}>{$t('action.retry')}</Button>
      {:else}
        <Spinner size={20} />
      {/if}
    </div>
  {/if}
</section>

<style>
  .block {
    max-width: 820px;
  }
  .three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .host-row {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
  }
  .divider {
    height: 1px;
    background: var(--border);
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .smtp-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }
  @media (max-width: 720px) {
    .three,
    .host-row {
      grid-template-columns: 1fr;
    }
  }
</style>
