<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { t } from '$lib/i18n';
  import {
    OPTION_KEYS,
    headersToText,
    isRateLimit,
    optionApplies,
    optionValue,
    parseHeaders,
    rateLimitProblem,
    sameOption,
    withOption,
    type OptionContext,
    type OptionKey,
    type ProxyOptions,
  } from '$lib/proxy';

  // The settings of the proxy, as a publication or a template sets them. `own` holds only
  // what deviates from the baseline (the template of a publication, the defaults for a
  // template): each control shows what applies, says what the baseline gives, and a value
  // that is the baseline's again is no deviation any more. So only what was really set
  // differently is sent and stored.

  interface Props {
    /** What deviates from the baseline. */
    own: ProxyOptions;
    /** What applies without `own`: defaults and template. */
    baseline: Record<OptionKey, unknown>;
    /** The publication the settings are for; without it (a template) every option is shown. */
    context?: OptionContext | null;
    /** What the baseline is called next to a control: the template, or the default. */
    source: 'template' | 'default';
    /** `<prefix><key>` is the test hook of each control. */
    testidPrefix: string;
    /** True while something in here cannot be saved (a line that is no header, a limit out of range). */
    invalid?: boolean;
  }

  let {
    own = $bindable(),
    baseline,
    context = null,
    source,
    testidPrefix,
    invalid = $bindable(false),
  }: Props = $props();

  const uid = $props.id();
  const SWITCHES = [
    'strip_prefix',
    'allow_embedding',
    'verify_upstream_tls',
    'identity_headers',
    'pass_host_header',
  ] as const;
  type SwitchKey = (typeof SWITCHES)[number];
  // "Do not verify the certificate" is the documentation's wording: the switch shows the
  // opposite of the option it sets.
  const INVERTED: readonly string[] = ['verify_upstream_tls'];
  const ONLY: Partial<Record<OptionKey, string>> = {
    strip_prefix: 'proxy.option.only.path',
    verify_upstream_tls: 'proxy.option.only.https',
    identity_headers: 'proxy.option.only.protected',
  };

  const shown = $derived(OPTION_KEYS.filter((key) => optionApplies(key, context)));
  const value = (key: OptionKey) => optionValue(own, baseline, key);
  const differs = (key: OptionKey) => key in own && !sameOption(own[key], baseline[key]);

  // What this editor wrote into `own` last. Anything else found there was put in from
  // outside: the form was filled (a dialog opened, another template pruned it).
  let written: ProxyOptions | undefined;

  function set(key: OptionKey, next: unknown) {
    own = withOption(own, baseline, key, next);
    written = own;
  }

  /** What the baseline gives for an option, in words. */
  function given(key: OptionKey): string {
    const base = baseline[key];
    let text: string;
    if (key === 'rate_limit') {
      text = isRateLimit(base)
        ? $t('proxy.value.rate', { average: base.average })
        : $t('proxy.value.off');
    } else if (key === 'request_headers' || key === 'response_headers') {
      const count = base && typeof base === 'object' ? Object.keys(base).length : 0;
      text = count > 0 ? $t('proxy.value.headers', { count }) : $t('proxy.value.none');
    } else {
      const on = INVERTED.includes(key) ? base === false : base === true;
      text = $t(on ? 'proxy.value.on' : 'proxy.value.off');
    }
    return $t(source === 'template' ? 'proxy.options.fromTemplate' : 'proxy.options.fromDefault', {
      value: text,
    });
  }

  // ── Rate limit: a switch and two numbers ───────────────────────────
  const limit = $derived.by(() => {
    const current = value('rate_limit');
    return isRateLimit(current) ? current : null;
  });
  let average = $state('');
  let burst = $state('');
  let rateProblem = $state<string | null>(null);

  function readRate() {
    const next = { average: Number(average), burst: Number(burst) };
    const whole = /^\d+$/.test(average.trim()) && /^\d+$/.test(burst.trim());
    rateProblem = whole
      ? rateLimitProblem(next)
      : /^\d+$/.test(average.trim())
        ? 'proxy.rate.burst'
        : 'proxy.rate.average';
    if (rateProblem === null) set('rate_limit', next);
  }

  function toggleRate(on: boolean) {
    rateProblem = null;
    if (!on) {
      set('rate_limit', null);
      return;
    }
    // What the baseline limits to, if it does; else a start that suits a small application.
    const base = baseline.rate_limit;
    const start = isRateLimit(base) ? base : { average: 20, burst: 40 };
    average = String(start.average);
    burst = String(start.burst);
    set('rate_limit', start);
  }

  // ── Additional headers: one "Name: value" per line ─────────────────
  let headerText = $state<Record<'request_headers' | 'response_headers', string>>({
    request_headers: '',
    response_headers: '',
  });
  let headerProblem = $state<Record<string, { key: string; detail: string } | null>>({});

  function readHeaders(key: 'request_headers' | 'response_headers', text: string) {
    headerText[key] = text;
    const parsed = parseHeaders(text);
    if (parsed.problem) {
      headerProblem[key] = { key: parsed.problem, detail: parsed.detail };
      return;
    }
    headerProblem[key] = null;
    set(key, parsed.headers);
  }

  // The texts of the limit and the headers follow what applies: when the form is filled
  // from outside (a dialog opens with what is stored), and when the baseline changes
  // under a control the form has not touched (another template was chosen). What somebody
  // is typing is never rewritten: a change this editor made itself touches no text.
  let seenBaseline: Record<OptionKey, unknown> | undefined;
  $effect(() => {
    const base = baseline;
    const current = own;
    untrack(() => {
      const filled = current !== written;
      const rebased = base !== seenBaseline;
      written = current;
      seenBaseline = base;
      for (const key of ['request_headers', 'response_headers'] as const) {
        if (filled || (rebased && !(key in current))) {
          headerText[key] = headersToText(optionValue(current, base, key));
          headerProblem[key] = null;
        }
      }
      if (filled || (rebased && !('rate_limit' in current))) {
        const limit = optionValue(current, base, 'rate_limit');
        if (isRateLimit(limit)) {
          average = String(limit.average);
          burst = String(limit.burst);
        }
        rateProblem = null;
      }
    });
  });

  $effect(() => {
    invalid =
      (rateProblem !== null && shown.includes('rate_limit')) ||
      Object.values(headerProblem).some((problem) => problem !== null);
  });
</script>

<div class="options">
  {#each shown as key (key)}
    <!-- `data-field`: the control and what is said about it come into view together when
         the form sends the focus here (see focusFirstInvalid()). -->
    <div class="option" data-field>
      {#if (SWITCHES as readonly string[]).includes(key)}
        {@const current = value(key) === true}
        <Switch
          checked={INVERTED.includes(key) ? !current : current}
          label={$t(`proxy.option.${key}`)}
          testid="{testidPrefix}{key}"
          onChange={(on) => set(key as SwitchKey, INVERTED.includes(key) ? !on : on)}
        />
      {:else if key === 'rate_limit'}
        <Switch
          checked={limit !== null}
          label={$t('proxy.option.rate_limit')}
          testid="{testidPrefix}rate_limit"
          onChange={toggleRate}
        />
      {:else}
        <label class="option-label" for="{uid}-{key}">{$t(`proxy.option.${key}`)}</label>
      {/if}
      <p class="help">
        {$t(`proxy.option.${key}.text`)}
        {#if !context && ONLY[key]}{$t(ONLY[key] ?? '')}{/if}
        <span class="given" class:changed={differs(key)}>
          {differs(key) ? `${given(key)} · ${$t('proxy.options.overridden')}` : given(key)}
        </span>
      </p>
      {#if key === 'rate_limit' && limit !== null}
        <div class="rate">
          <label class="rate-field">
            <span>{$t('proxy.rate.average.label')}</span>
            <Input
              bind:value={average}
              inputmode="numeric"
              maxlength={5}
              fullWidth={false}
              invalid={rateProblem === 'proxy.rate.average'}
              testid="{testidPrefix}rate_limit-average"
              oninput={readRate}
            />
          </label>
          <label class="rate-field">
            <span>{$t('proxy.rate.burst.label')}</span>
            <Input
              bind:value={burst}
              inputmode="numeric"
              maxlength={6}
              fullWidth={false}
              invalid={rateProblem === 'proxy.rate.burst'}
              testid="{testidPrefix}rate_limit-burst"
              oninput={readRate}
            />
          </label>
        </div>
        {#if rateProblem}<p class="problem" role="alert">{$t(rateProblem)}</p>{/if}
      {:else if key === 'request_headers' || key === 'response_headers'}
        {@const problem = headerProblem[key]}
        <Input
          id="{uid}-{key}"
          value={headerText[key]}
          multiline
          mono
          rows={3}
          spellcheck={false}
          autocapitalize="off"
          placeholder="Name: Wert"
          invalid={!!problem}
          testid="{testidPrefix}{key}"
          oninput={(event) => readHeaders(key, (event.currentTarget as HTMLTextAreaElement).value)}
        />
        {#if problem}
          <p class="problem" role="alert">{$t(problem.key, { detail: problem.detail })}</p>
        {/if}
      {/if}
    </div>
  {/each}
</div>

<style>
  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .option-label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  /* What the baseline gives, on a line of its own; marked when the form deviates. */
  .given {
    display: block;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .given.changed {
    color: var(--text);
  }
  .rate {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
  .rate-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    color: var(--text);
    font-size: var(--text-sm);
  }
  .rate-field :global(.input) {
    width: 9rem;
  }
  .problem {
    color: var(--danger);
    font-size: var(--text-sm);
  }
</style>
