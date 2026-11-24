<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import type { Certificate } from '$lib/api/types';
  import {
    PEM_MAX_BYTES,
    PKCS12_ACCEPT,
    PKCS12_MAX_BYTES,
    errorKey,
    keyIsEncrypted,
    maxKilobytes,
    pemBlocks,
    pemProblem,
    readFileBase64,
    readTextFile,
    uploadFailure,
    type CertificateField,
    type CertificateFormat,
  } from '$lib/certificates';
  import Button from '$lib/components/ui/Button.svelte';
  import FileButton from '$lib/components/ui/FileButton.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import { language, t } from '$lib/i18n';
  import { restoreFocus } from '$lib/utils/focus';
  import { focusOnNewErrors, formChanged } from '$lib/utils/forms';
  import { normalizeName } from '$lib/utils/validate';

  // A certificate with its private key, for a new entry or in the place of a stored one (a
  // renewal): as PEM text, chosen as files or pasted, or as one PKCS#12 file.
  //
  // The private key is sensitive. It lives in the variables of this dialog and nowhere
  // else, and they are emptied when the dialog closes and when the upload succeeded
  // (wipe()). It is never logged and never part of a message: every text shown here is a
  // translation, with nothing in it but names and dates the API reports.

  interface Props {
    open: boolean;
    /** The stored certificate to replace; null adds a new one. */
    certificate: Certificate | null;
    onClose: () => void;
    onSaved: (certificate: Certificate, created: boolean) => void;
  }

  let { open, certificate, onClose, onSaved }: Props = $props();

  const formId = $props.id();
  // The entry the upload goes to: the one the dialog was opened for, or the one the API
  // named because it holds a name of the new certificate already. Null: a new entry.
  let target = $state<{ id: string; name: string } | null>(null);
  let name = $state('');
  let format = $state<CertificateFormat>('pem');
  let certificateText = $state('');
  let keyText = $state('');
  let passphrase = $state('');
  let pkcs12 = $state<{ name: string; size: number; data: string } | null>(null);
  let saving = $state(false);
  // The message of each field (CertificateField), and the code it stands for.
  let errors = $state<Record<string, string | undefined>>({});
  let codes = $state<Record<string, string>>({});
  // `names_taken`: the stored certificate that holds the names, offered instead.
  let other = $state<{ id: string; name: string } | null>(null);
  // Counts how often the dialog was emptied. What was started before (a file still being
  // read, a request under way) belongs to an earlier round and puts nothing back.
  let round = 0;
  // The files that are being read at the moment. Reading takes a moment, and "save" may be
  // pressed within it: it then waits for them instead of sending a form without its files.
  let reading: Promise<unknown> = Promise.resolve();
  let unread = 0;

  function read(job: Promise<void>) {
    unread += 1;
    const done = () => {
      unread -= 1;
    };
    void job.then(done, done);
    reading = Promise.allSettled([reading, job]);
  }

  /** Empty every field. Nothing of what was entered or read from a file stays behind. */
  function wipe() {
    round += 1;
    target = null;
    name = '';
    format = 'pem';
    certificateText = '';
    keyText = '';
    passphrase = '';
    pkcs12 = null;
    saving = false;
    errors = {};
    codes = {};
    other = null;
  }

  // Closed, the dialog holds nothing. Opened, it starts with the entry it is for.
  $effect(() => {
    if (!open) {
      untrack(wipe);
      return;
    }
    const current = certificate;
    untrack(() => {
      target = current ? { id: current.id, name: current.name } : null;
      name = current?.name ?? '';
    });
  });

  // Taken away with its page (a navigation while it is open): the same as closing.
  onDestroy(wipe);

  const dirty = $derived(
    formChanged(
      [normalizeName(name), certificateText, keyText, passphrase, pkcs12?.data ?? ''],
      [target?.name ?? '', '', '', '', ''],
    ),
  );
  // A key that says of itself that it is protected: the passphrase is needed then.
  const encrypted = $derived(format === 'pem' && keyIsEncrypted(`${certificateText}\n${keyText}`));

  const focusErrors = focusOnNewErrors(formId);
  $effect(() => focusErrors(errors));

  /** The hook of a field's message for browser tests, with the code the message stands for. */
  const hook = (field: CertificateField) => ({
    'data-testid': 'certificate-error',
    'data-code': codes[field],
  });

  function problemText(code: string): string {
    return $t(errorKey(code, format), { max: maxKilobytes(format) });
  }

  function refuse(field: CertificateField, code: string) {
    errors = { ...errors, [field]: problemText(code) };
    codes = { ...codes, [field]: code };
  }

  function forgetErrors() {
    errors = {};
    codes = {};
    other = null;
  }

  async function pickPem(field: 'certificate' | 'key', file: File) {
    const mine = round;
    // The field hears of the same event and takes its message back; what is said from
    // here on is about this file.
    await tick();
    if (mine !== round) return;
    if (file.size > PEM_MAX_BYTES) {
      refuse(field, 'too_large');
      return;
    }
    let text: string;
    try {
      text = await readTextFile(file);
    } catch {
      if (mine === round) refuse(field, 'file_unreadable');
      return;
    }
    // Closed meanwhile: nothing of the file is kept.
    if (mine !== round) return;
    if (pemBlocks(text).length === 0) {
      refuse(field, 'not_pem');
      return;
    }
    if (field === 'certificate') certificateText = text;
    else keyText = text;
  }

  async function pickPkcs12(file: File) {
    const mine = round;
    await tick();
    if (mine !== round) return;
    pkcs12 = null;
    if (file.size > PKCS12_MAX_BYTES) {
      refuse('pkcs12', 'too_large');
      return;
    }
    if (file.size === 0) {
      refuse('pkcs12', 'pkcs12_unreadable');
      return;
    }
    let data: string;
    try {
      data = await readFileBase64(file);
    } catch {
      if (mine === round) refuse('pkcs12', 'file_unreadable');
      return;
    }
    if (mine !== round) return;
    pkcs12 = { name: file.name, size: file.size, data };
  }

  /** What can be said before anything is sent: each problem with its field and code. */
  function validate(): { field: CertificateField; code: string; text: string }[] {
    const found: { field: CertificateField; code: string; text: string }[] = [];
    if (!normalizeName(name)) {
      found.push({ field: 'name', code: 'validation', text: $t('validation.required') });
    }
    if (format === 'pem') {
      const problem = pemProblem({ certificate: certificateText, privateKey: keyText, passphrase });
      if (problem) found.push({ ...problem, text: problemText(problem.code) });
    } else if (!pkcs12) {
      found.push({
        field: 'pkcs12',
        code: 'certificate_missing',
        text: problemText('certificate_missing'),
      });
    }
    return found;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    const mine = round;
    saving = true;
    try {
      // A file chosen a moment ago is read to the end first.
      if (unread > 0) await reading;
      if (mine !== round) return;
      const found = validate();
      errors = Object.fromEntries(found.map((problem) => [problem.field, problem.text]));
      codes = Object.fromEntries(found.map((problem) => [problem.field, problem.code]));
      other = null;
      if (found.length > 0) return;
      await send(mine);
    } finally {
      // Emptied meanwhile (closed, or sent): whatever runs then is not this one's to end.
      if (mine === round) saving = false;
    }
  }

  async function send(mine: number) {
    // Only the chosen format is sent, and of it only what was filled in.
    const upload =
      format === 'pem'
        ? {
            ...(certificateText.trim() ? { certificate: certificateText } : {}),
            ...(keyText.trim() ? { private_key: keyText } : {}),
          }
        : { pkcs12: pkcs12?.data ?? '' };
    const body = { ...upload, ...(passphrase ? { passphrase } : {}) };
    const entry = target;
    const sent = format;
    try {
      if (entry) {
        // A renewal keeps the name of the entry unless it was changed here.
        const renamed = normalizeName(name) !== entry.name;
        const saved = await api.put('/api/v1/system/certificates/{certificate_id}', {
          path: { certificate_id: entry.id },
          body: renamed ? { ...body, name: normalizeName(name) } : body,
        });
        wipe();
        onSaved(saved, false);
      } else {
        const saved = await api.post('/api/v1/system/certificates', {
          body: { name: normalizeName(name), ...body },
        });
        wipe();
        onSaved(saved, true);
      }
    } catch (err) {
      // Closed meanwhile: there is no form left to say it in.
      if (mine !== round) return;
      const failure = uploadFailure(err, sent, $language);
      errors = {
        [failure.field]: failure.key ? $t(failure.key, failure.vars) : errorMessage(err, $t),
      };
      codes = { [failure.field]: failure.code };
      other = failure.other ?? null;
    }
  }

  /** What was entered goes to the stored certificate that holds the names already. */
  function replaceOther() {
    if (!other) return;
    target = other;
    name = other.name;
    forgetErrors();
    // The button that had the focus is gone with its message.
    void restoreFocus(() => [document.querySelector<HTMLElement>(`button[form="${formId}"]`)]);
  }
</script>

{#snippet replaceInstead(field: CertificateField)}
  {#if other && errors[field]}
    <Button
      variant="secondary"
      size="sm"
      data-testid="certificate-replace-other"
      onclick={replaceOther}
    >
      {$t('certificates.replaceOther', { name: other.name })}
    </Button>
  {/if}
{/snippet}

<Modal
  {open}
  title={target ? $t('certificates.replace.title', { name: target.name }) : $t('certificates.add')}
  width="640px"
  error={errors.form ?? ''}
  errorAttrs={hook('form')}
  {dirty}
  {onClose}
>
  <form id={formId} class="form" onsubmit={submit} novalidate autocomplete="off">
    {#if target}<p class="help">{$t('certificates.replace.text')}</p>{/if}
    <FormField
      label={$t('field.name')}
      required
      hint={$t('certificates.name.hint')}
      bind:error={errors.name}
      errorAttrs={hook('name')}
    >
      <Input
        bind:value={name}
        maxlength={80}
        required
        autocomplete="off"
        testid="certificate-name"
      />
    </FormField>
    <FormField label={$t('certificates.format.label')}>
      <Segmented
        bind:value={format}
        options={[
          { value: 'pem', label: $t('certificates.format.pem') },
          { value: 'pkcs12', label: $t('certificates.format.pkcs12') },
        ]}
        testid="certificate-format"
        onChange={forgetErrors}
      />
    </FormField>

    {#if format === 'pem'}
      <div class="source">
        <FormField
          label={$t('certificates.certificate.label')}
          required
          hint={$t('certificates.certificate.hint')}
          bind:error={errors.certificate}
          errorAttrs={hook('certificate')}
        >
          <FileButton
            label={$t('certificates.certificate.file')}
            testid="certificate-file"
            onPick={(file) => read(pickPem('certificate', file))}
          />
          <Input
            bind:value={certificateText}
            multiline
            mono
            rows={6}
            placeholder="-----BEGIN CERTIFICATE-----"
            spellcheck={false}
            autocomplete="off"
            autocapitalize="off"
            testid="certificate-text"
          />
        </FormField>
        {@render replaceInstead('certificate')}
      </div>
      <FormField
        label={$t('certificates.key.label')}
        hint={$t('certificates.key.hint')}
        bind:error={errors.key}
        errorAttrs={hook('key')}
      >
        <FileButton
          label={$t('certificates.key.file')}
          testid="certificate-key-file"
          onPick={(file) => read(pickPem('key', file))}
        />
        <Input
          bind:value={keyText}
          multiline
          mono
          rows={4}
          placeholder="-----BEGIN PRIVATE KEY-----"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          testid="certificate-key-text"
        />
      </FormField>
    {:else}
      <div class="source">
        <FormField
          label={$t('certificates.pkcs12.label')}
          required
          hint={$t('certificates.pkcs12.hint')}
          bind:error={errors.pkcs12}
          errorAttrs={hook('pkcs12')}
        >
          <FileButton
            control
            label={$t('certificates.pkcs12.file')}
            accept={PKCS12_ACCEPT}
            testid="certificate-pkcs12-file"
            onPick={(file) => read(pickPkcs12(file))}
          />
          {#if pkcs12}
            <span class="chosen" data-testid="certificate-pkcs12-chosen">
              {$t('certificates.pkcs12.chosen', {
                name: pkcs12.name,
                size: Math.max(1, Math.round(pkcs12.size / 1024)),
              })}
            </span>
          {/if}
        </FormField>
        {@render replaceInstead('pkcs12')}
      </div>
    {/if}

    <FormField
      label={$t('certificates.passphrase.label')}
      required={encrypted}
      hint={format === 'pkcs12'
        ? $t('certificates.passphrase.hint.pkcs12')
        : encrypted
          ? $t('certificates.passphrase.hint.needed')
          : $t('certificates.passphrase.hint.pem')}
      bind:error={errors.passphrase}
      errorAttrs={hook('passphrase')}
    >
      <Input
        bind:value={passphrase}
        type="password"
        maxlength={1024}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        testid="certificate-passphrase"
      />
    </FormField>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving} data-testid="certificate-save">
      {target ? $t('certificates.action.replace') : $t('certificates.add')}
    </Button>
  {/snippet}
</Modal>

<style>
  .source {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    min-width: 0;
  }
  /* The field takes the whole width; the offer under it is as wide as its text. */
  .source > :global(.ui-field) {
    align-self: stretch;
  }
  .chosen {
    color: var(--text);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
</style>
