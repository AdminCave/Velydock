<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import type { ProxyTemplate } from '$lib/api/types';
  import MiddlewaresField from '$lib/components/proxy/MiddlewaresField.svelte';
  import ProxyOptionsEditor from '$lib/components/proxy/ProxyOptionsEditor.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import { t } from '$lib/i18n';
  import {
    CUSTOM_MIDDLEWARES,
    OPTION_KEYS,
    middlewaresToText,
    optionBaseline,
    parseMiddlewares,
    pruneOptions,
    sameOption,
    type ProxyOptions,
  } from '$lib/proxy';
  import { focusFirstInvalid, focusOnNewErrors, formChanged } from '$lib/utils/forms';
  import { normalizeName } from '$lib/utils/validate';

  // A template of a system administrator's own: a name, what it is for, the settings it
  // gives (what deviates from the defaults), and Traefik middlewares in Traefik's own
  // words. The API checks those against what Traefik knows; its answer is shown under the
  // field as it comes, because it names the field and what would be possible.

  interface Props {
    open: boolean;
    /** The template to edit; null creates a new one. */
    template: ProxyTemplate | null;
    /** The defaults of the installation, where they are known (GET /admin/proxy). */
    defaults: ProxyOptions | null;
    onClose: () => void;
    onSaved: (template: ProxyTemplate, created: boolean) => void;
  }

  let { open, template, defaults, onClose, onSaved }: Props = $props();

  const formId = $props.id();
  let name = $state('');
  let description = $state('');
  let own = $state<ProxyOptions>({});
  let custom = $state('');
  let optionsInvalid = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  // What the server said about the settings, as it came.
  let refusedDetail = $state('');
  let failure = $state('');

  const baseline = $derived(optionBaseline(defaults));
  // The JSON is read while it is typed: a slip shows at once, not after saving.
  const middlewares = $derived(parseMiddlewares(custom));

  const fields = () => [name, description, JSON.stringify(own), custom];
  let pristine = $state.raw<unknown[]>([]);
  // The options as the dialog would send them unchanged: they are sent only when they
  // differ from this, however the stored ones are written.
  let pristineOptions = $state.raw<ProxyOptions>({});
  const dirty = $derived(formChanged(fields(), pristine));

  const focusErrors = focusOnNewErrors(formId);
  $effect(() => focusErrors(errors));

  $effect(() => {
    if (!open) return;
    const current = template;
    untrack(() => {
      const stored = current?.options ?? {};
      name = current?.name ?? '';
      description = current?.description ?? '';
      // What the template sets, without what is the default anyway.
      own = pruneOptions(
        Object.fromEntries(
          Object.entries(stored).filter(([key]) =>
            (OPTION_KEYS as readonly string[]).includes(key),
          ),
        ),
        optionBaseline(defaults),
      );
      custom = middlewaresToText(stored[CUSTOM_MIDDLEWARES]);
      optionsInvalid = false;
      saving = false;
      errors = {};
      refusedDetail = '';
      failure = '';
      pristine = fields();
      pristineOptions = optionsPayload();
    });
  });

  /** The options as the API stores them: the deviations, and the middlewares if there are any. */
  function optionsPayload(): ProxyOptions {
    const options: ProxyOptions = { ...own };
    const parsed = parseMiddlewares(custom);
    if (parsed.problem === null && Object.keys(parsed.value).length > 0) {
      options[CUSTOM_MIDDLEWARES] = parsed.value;
    }
    return options;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    const found: Record<string, string> = {};
    if (!normalizeName(name)) found.name = $t('validation.required');
    if (middlewares.problem) {
      found.custom = $t(middlewares.problem, { detail: middlewares.detail });
    }
    errors = found;
    refusedDetail = '';
    failure = '';
    if (Object.keys(found).length > 0) return;
    if (optionsInvalid) {
      // A setting that cannot be saved as it stands says so itself, where it stands.
      void focusFirstInvalid(formId);
      return;
    }

    const options = optionsPayload();
    saving = true;
    try {
      if (template) {
        // Only what was changed here.
        const body: { name?: string; description?: string; options?: ProxyOptions } = {};
        if (normalizeName(name) !== template.name) body.name = normalizeName(name);
        if (description.trim() !== template.description) body.description = description.trim();
        if (!sameOption(options, pristineOptions)) body.options = options;
        if (Object.keys(body).length === 0) {
          onClose();
          return;
        }
        const saved = await api.patch('/api/v1/system/proxy-templates/{template_id}', {
          path: { template_id: template.id },
          body,
        });
        onSaved(saved, false);
      } else {
        const saved = await api.post('/api/v1/system/proxy-templates', {
          body: { name: normalizeName(name), description: description.trim(), options },
        });
        onSaved(saved, true);
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'name_taken') {
        errors = { name: errorMessage(err, $t) };
      } else if (code === 'proxy_options_invalid' && err instanceof ApiError) {
        // Under the middlewares when there are any (that is where a system administrator
        // writes freely), else at the settings.
        refusedDetail = err.message;
        errors =
          CUSTOM_MIDDLEWARES in options
            ? { custom: $t('proxy.custom.refused') }
            : { options: $t('proxy.options.refused') };
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
  title={template
    ? $t('proxyTemplates.edit.title', { name: template.name })
    : $t('proxyTemplates.create.title')}
  width="720px"
  error={failure}
  {dirty}
  {onClose}
>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <FormField label={$t('field.name')} required bind:error={errors.name}>
      <Input bind:value={name} maxlength={80} required testid="proxy-template-name" />
    </FormField>
    <FormField label={$t('field.description')} hint={$t('proxyTemplates.description.hint')}>
      <Input bind:value={description} maxlength={300} testid="proxy-template-description" />
    </FormField>

    <fieldset class="group">
      <legend>{$t('proxyTemplates.options.title')}</legend>
      <p class="help">{$t('proxyTemplates.options.text')}</p>
      {#if errors.options}
        <p class="problem" role="alert">
          {errors.options}
          {#if refusedDetail}<span class="tech">{refusedDetail}</span>{/if}
        </p>
      {/if}
      <ProxyOptionsEditor
        bind:own
        {baseline}
        source="default"
        testidPrefix="proxy-template-option-"
        bind:invalid={optionsInvalid}
      />
    </fieldset>

    <div class="group">
      <MiddlewaresField
        bind:value={custom}
        bind:error={errors.custom}
        detail={refusedDetail}
        hint={$t('proxyTemplates.custom.hint')}
        testid="proxy-template-custom"
        detailTestid="proxy-template-refused"
      />
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving} data-testid="proxy-template-save">
      {template ? $t('action.save') : $t('proxyTemplates.create.submit')}
    </Button>
  {/snippet}
</Modal>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
    margin: 0;
    padding: var(--space-5) 0 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  legend {
    float: left;
    width: 100%;
    padding: 0;
    color: var(--text-strong);
    font-size: var(--text-sm);
    font-weight: var(--fw-semibold);
  }
  .problem {
    color: var(--danger);
    font-size: var(--text-sm);
  }
  .tech {
    display: block;
    margin: 0;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
</style>
