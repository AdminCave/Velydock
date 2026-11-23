<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { t } from '$lib/i18n';
  import { parseMiddlewares } from '$lib/proxy';

  // "Eigene Traefik-Middlewares": Traefik middlewares in Traefik's own words, as JSON. A
  // system administrator's field, in a template and on a single published app. The JSON,
  // the names and "one middleware per name" are checked here while it is written; which
  // middlewares and fields exist is the server's knowledge, and what it says is shown
  // under the field as it came, because it names the place.

  interface Props {
    /** The JSON text. */
    value: string;
    /** The form's own message: what it found on saving, or that the server refused. Taken
     *  back when the field is edited. */
    error?: string;
    /** What the server said, shown under the field while `error` stands. */
    detail?: string;
    hint: string;
    /** Test hook of the text area; the server's message gets `<testid>-refused`. */
    testid: string;
    /** Test hook of the server's message, where it has a name of its own. */
    detailTestid?: string;
  }

  let {
    value = $bindable(),
    error = $bindable(),
    detail = '',
    hint,
    testid,
    detailTestid = `${testid}-refused`,
  }: Props = $props();

  // Whether the field was left once: a slip is said then, not at every key while typing.
  let left = $state(false);
  const parsed = $derived(parseMiddlewares(value));
  const slip = $derived(
    left && parsed.problem ? $t(parsed.problem, { detail: parsed.detail }) : undefined,
  );
</script>

<!-- `data-field`: the field and the server's message under it come into view together
     when the form sends the focus here (see focusFirstInvalid()). -->
<div class="middlewares" data-field onfocusout={() => (left = true)}>
  <FormField
    label={$t('proxyTemplates.custom.label')}
    {hint}
    error={error || slip}
    onedit={() => (error = '')}
  >
    <Input
      bind:value
      multiline
      mono
      rows={8}
      maxlength={8000}
      spellcheck={false}
      autocapitalize="off"
      placeholder={'{\n  "10-buero": { "ipAllowList": { "sourceRange": ["203.0.113.0/24"] } }\n}'}
      {testid}
    />
  </FormField>
  {#if error && detail}
    <!-- The server's own words: they name the middleware and the field. -->
    <p class="tech" data-testid={detailTestid}>{detail}</p>
  {/if}
</div>

<style>
  .middlewares {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .tech {
    margin: 0;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
</style>
