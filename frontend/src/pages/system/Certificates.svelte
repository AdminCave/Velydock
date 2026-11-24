<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Trash from '@lucide/svelte/icons/trash';
  import TriangleAlert from '@lucide/svelte/icons/triangle-exclamation-point';
  import { ApiError, api } from '$lib/api/client';
  import type { Certificate, CertificateHost, CertificatesOverview } from '$lib/api/types';
  import {
    awaited,
    fingerprintPairs,
    hostsOf,
    lagging,
    nameLabel,
    settled,
    shadowed,
  } from '$lib/certificates';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { hasMessage, language, t } from '$lib/i18n';
  import { showError, showToast } from '$lib/stores/toasts';
  import { formatDate, formatDateTime } from '$lib/utils/datetime';
  import { restoreFocus } from '$lib/utils/focus';
  import CertificateModal from '../../modals/CertificateModal.svelte';

  // Own TLS certificates: what a system administrator uploaded, and for every address of
  // this installation what the bundled proxy really answers with. The proxy fetches its
  // configuration every few seconds, so after a change the second table is behind for a
  // moment; the page then asks again by itself until the two agree.
  //
  // "A stored certificate is meant for an address, and the proxy answers with another one"
  // therefore means two things. While the page is asking again after a change, the proxy
  // has not caught up yet. At any other time it will not: it holds a certificate it
  // fetched itself for the name and prefers that one (see shadowed() in lib/certificates.ts).

  const FOLLOW_EVERY_MS = 3000;
  const FOLLOW_ROUNDS = 5;

  let data = $state<CertificatesOverview | null>(null);
  let failed = $state(false);
  let checking = $state(false);
  let modalOpen = $state(false);
  let editing = $state<Certificate | null>(null);
  // The page is asking again by itself after a change: the proxy may still catch up.
  let following = $state(false);
  // Asked as often as the page does by itself, and the proxy has still not loaded what is
  // stored, or still serves what is gone.
  let stalled = $state(false);

  const hostsTitle = $props.id();
  // The newest request for the list: an answer that was overtaken is dropped.
  let latest = 0;
  // The asking again that follows a change. A new change, and leaving the page, end it.
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Fingerprints of what was just removed or replaced: the proxy must stop serving them.
  let gone = $state<string[]>([]);

  async function load(quiet = false): Promise<'ok' | 'failed' | 'overtaken'> {
    const mine = ++latest;
    try {
      const result = await api.get('/api/v1/system/certificates');
      if (mine !== latest) return 'overtaken';
      data = result;
      failed = false;
      return 'ok';
    } catch (err) {
      if (mine !== latest) return 'overtaken';
      failed = true;
      if (!quiet) showError(err);
      return 'failed';
    }
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    run += 1;
    clearTimeout(timer);
  });

  /**
   * After a write: read the list again, then every three seconds, five times at most,
   * until the proxy serves what is stored. `forgotten` are the fingerprints it must not
   * serve any more.
   */
  async function changed(forgotten: string[] = []) {
    const mine = ++run;
    clearTimeout(timer);
    stalled = false;
    gone = forgotten;
    following = true;
    await load();
    if (mine === run) follow(mine, FOLLOW_ROUNDS);
  }

  function follow(mine: number, left: number) {
    if (!data || settled(data, gone) || left === 0) {
      following = false;
      // What is behind for a reason its row names (shadowed) needs no notice above the table.
      stalled = !!data && left === 0 && lagging(data, gone);
      return;
    }
    timer = setTimeout(() => {
      void load(true).then((answer) => {
        if (mine !== run) return;
        // Nobody is told about a failure here; the button asks again and says so.
        if (answer === 'failed') following = false;
        else follow(mine, left - 1);
      });
    }, FOLLOW_EVERY_MS);
  }

  async function check() {
    if (checking) return;
    checking = true;
    stalled = false;
    await load();
    checking = false;
  }

  // Where the installation cannot serve own certificates the API refuses every upload:
  // the dialog is not opened for one, however the click came about.
  function openAdd() {
    if (!data?.available) return;
    editing = null;
    modalOpen = true;
  }

  function openReplace(certificate: Certificate) {
    if (!data?.available) return;
    editing = certificate;
    modalOpen = true;
  }

  function onSaved(saved: Certificate, created: boolean) {
    modalOpen = false;
    showToast($t(created ? 'certificates.added' : 'certificates.replaced', { name: saved.name }));
    // What the entry held until now is on its way out.
    const before = data?.certificates.find((entry) => entry.id === saved.id)?.fingerprint;
    void changed(before && before !== saved.fingerprint ? [before] : []);
  }

  async function remove(certificate: Certificate) {
    if (!data) return;
    const losing = hostsOf(data, certificate.id).map((host) => host.host);
    const ok = await confirmDialog($t('certificates.remove.question', { name: certificate.name }), {
      title: $t('certificates.remove.title'),
      // Which addresses lose it, and what they are served with afterwards.
      detail:
        losing.length > 0
          ? `${$t('certificates.remove.hosts', { hosts: losing.join(', ') })} ${$t(
              data.acme ? 'certificates.remove.then.acme' : 'certificates.remove.then.default',
            )}`
          : $t('certificates.remove.unused'),
      confirmLabel: $t('certificates.remove.confirm'),
      confirmTestid: 'certificate-remove-confirm',
    });
    if (!ok) return;
    const blocks = () => [...document.querySelectorAll<HTMLElement>('[data-testid="certificate"]')];
    const at = blocks().findIndex((block) => block.dataset.id === certificate.id);
    try {
      await api.delete('/api/v1/system/certificates/{certificate_id}', {
        path: { certificate_id: certificate.id },
      });
      showToast($t('certificates.removed', { name: certificate.name }));
      await changed([certificate.fingerprint]);
      // The entry is gone, and with it the button that had the focus.
      await restoreFocus(() => {
        const left = blocks();
        return [
          left[Math.min(at, left.length - 1)]?.querySelector<HTMLElement>('button'),
          document.querySelector<HTMLElement>('[data-testid="certificate-add"]'),
          document.getElementById('main'),
        ];
      });
    } catch (err) {
      showError(err);
      // Removed elsewhere meanwhile: the list as it is now says so.
      if (err instanceof ApiError && err.code === 'not_found') void load(true);
    }
  }

  const stored = $derived(new Map((data?.certificates ?? []).map((entry) => [entry.id, entry])));
  /** The name of a stored certificate, empty for none and for one that is gone. */
  const nameOf = (id: string | null | undefined) => (id ? (stored.get(id)?.name ?? '') : '');

  /** Why this installation cannot serve own certificates, in words an operator can act on. */
  function problemText(problem: string | null): string {
    const key = `certificates.problem.${problem}`;
    return hasMessage(key) ? $t(key) : $t('certificates.problem.unknown', { code: problem });
  }

  /** The mark next to "valid until"; none while the certificate is simply valid. */
  function statusText(status: string): string {
    if (status === 'valid') return '';
    const key = `certificates.status.${status}`;
    // A state this version does not know is shown as its code rather than hidden.
    return hasMessage(key) ? $t(key) : status;
  }

  function warningText(warning: string): string {
    const key = `certificates.warning.${warning}`;
    return hasMessage(key) ? $t(key) : warning;
  }

  function purposeText(host: CertificateHost): string {
    const key = `certificates.purpose.${host.purpose}`;
    return hasMessage(key) ? $t(key, { label: host.label }) : host.purpose;
  }

  const isPast = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < Date.now();
</script>

<section class="section" data-testid="certificates-page">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('certificates.title')}</h1>
      <p class="page-subtitle">
        {$t('certificates.subtitle')}
        {#if data}
          {$t(data.acme ? 'certificates.fallback.acme' : 'certificates.fallback.default')}
        {/if}
      </p>
    </div>
    <Button
      iconLeft={Plus}
      data-testid="certificate-add"
      disabled={!data?.available}
      onclick={openAdd}
    >
      {$t('certificates.add')}
    </Button>
  </header>

  {#if data && !data.available}
    <div data-testid="certificates-unavailable" data-problem={data.problem ?? ''}>
      <Callout tone="warning" role="status" title={$t('certificates.unavailable.title')}>
        {problemText(data.problem)}
        {$t('certificates.unavailable.effect')}
      </Callout>
    </div>
  {/if}

  <div class="table-wrap">
    <table class="data-table" data-testid="certificates-table">
      <thead>
        <tr>
          <th scope="col">{$t('field.name')}</th>
          <th scope="col">{$t('certificates.col.names')}</th>
          <th scope="col">{$t('certificates.issuer')}</th>
          <th scope="col">{$t('certificates.until')}</th>
          <th scope="col">{$t('certificates.col.key')}</th>
          <th scope="col" class="actions">{$t('field.actions')}</th>
        </tr>
      </thead>
      <!-- One block per certificate: its row, and under it what does not fit a column. -->
      {#each data?.certificates ?? [] as certificate (certificate.id)}
        {@const status = statusText(certificate.status)}
        <tbody
          class="certificate"
          data-testid="certificate"
          data-id={certificate.id}
          data-name={certificate.name}
          data-status={certificate.status}
        >
          <tr class="main">
            <td><span class="primary">{certificate.name}</span></td>
            <td>
              <ul class="names" data-testid="certificate-names">
                {#each certificate.names as name (name)}<li>{name}</li>{/each}
              </ul>
            </td>
            <td title={certificate.issuer}>{nameLabel(certificate.issuer)}</td>
            <td>
              <span class="until">{formatDate(certificate.not_after, $language)}</span>
              {#if status}
                <Pill tone={certificate.status === 'expired' ? 'crit' : 'warn'}>{status}</Pill>
              {/if}
            </td>
            <td class="meta">{certificate.key_type}</td>
            <td class="actions">
              <span class="row-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={RefreshCw}
                  aria-label={$t('certificates.actions.replace', { name: certificate.name })}
                  title={$t('certificates.actions.replace', { name: certificate.name })}
                  data-testid="certificate-replace"
                  disabled={!data?.available}
                  onclick={() => openReplace(certificate)}
                >
                  {$t('certificates.action.replace')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft={Trash}
                  aria-label={$t('certificates.actions.remove', { name: certificate.name })}
                  title={$t('certificates.actions.remove', { name: certificate.name })}
                  data-testid="certificate-remove"
                  onclick={() => void remove(certificate)}
                >
                  {$t('certificates.action.remove')}
                </Button>
              </span>
            </td>
          </tr>
          <tr class="more">
            <td colspan="6">
              {#each certificate.warnings as warning (warning)}
                <p class="flag" data-testid="certificate-warning" data-warning={warning}>
                  <TriangleAlert size={14} />
                  {warningText(warning)}
                </p>
              {/each}
              <details data-testid="certificate-details">
                <summary>
                  {$t('certificates.details')}<span class="visually-hidden">
                    : {certificate.name}
                  </span>
                </summary>
                <dl>
                  <dt>{$t('certificates.detail.subject')}</dt>
                  <dd>{certificate.subject}</dd>
                  <dt>{$t('certificates.issuer')}</dt>
                  <dd>{certificate.issuer}</dd>
                  <dt>{$t('certificates.detail.chain')}</dt>
                  <dd>
                    <ol class="chain">
                      {#each certificate.chain as link, at (at)}<li>{link}</li>{/each}
                    </ol>
                  </dd>
                  <dt>{$t('certificates.detail.serial')}</dt>
                  <dd class="mono">{certificate.serial}</dd>
                  <dt>{$t('certificates.detail.fingerprint')}</dt>
                  <!-- Its text is the fingerprint as the API gives it; the pairs are only
                       set apart for the eye. -->
                  <dd class="mono fingerprint" data-testid="certificate-fingerprint">
                    {#each fingerprintPairs(certificate.fingerprint) as pair, at (at)}<span>
                        {pair}
                      </span>{/each}
                  </dd>
                  <dt>{$t('certificates.detail.notBefore')}</dt>
                  <dd>{formatDateTime(certificate.not_before, $language)}</dd>
                  <dt>{$t('certificates.until')}</dt>
                  <dd>{formatDateTime(certificate.not_after, $language)}</dd>
                  <dt>{$t('certificates.detail.created')}</dt>
                  <dd>{formatDateTime(certificate.created_at, $language)}</dd>
                  <dt>{$t('certificates.detail.updated')}</dt>
                  <dd>{formatDateTime(certificate.updated_at, $language)}</dd>
                </dl>
              </details>
            </td>
          </tr>
        </tbody>
      {/each}
    </table>
    {#if data && data.certificates.length === 0}
      <EmptyState
        framed={false}
        icon={ShieldCheck}
        title={$t('certificates.empty.title')}
        description={$t('certificates.empty.text')}
      >
        {#snippet action()}
          <Button
            variant="secondary"
            iconLeft={Plus}
            data-testid="certificate-add-empty"
            disabled={!data?.available}
            onclick={openAdd}
          >
            {$t('certificates.add')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if !data}
      <div class="table-state">
        {#if failed}
          <Button variant="secondary" onclick={() => void load()}>{$t('action.retry')}</Button>
        {:else}
          <Spinner size={20} />
        {/if}
      </div>
    {/if}
  </div>

  {#if data}
    <section class="section hosts" aria-labelledby={hostsTitle}>
      <header class="hosts-header">
        <div>
          <h2 class="section-title" id={hostsTitle}>{$t('certificates.hosts.title')}</h2>
          <p class="section-desc">{$t('certificates.hosts.text')}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={RefreshCw}
          loading={checking}
          data-testid="certificate-hosts-refresh"
          onclick={() => void check()}
        >
          {$t('certificates.hosts.refresh')}
        </Button>
      </header>

      {#if data.hosts.some((host) => host.served.source === 'unreachable')}
        <Callout
          tone="warning"
          role="status"
          title={$t('certificates.hosts.unreachable.title')}
          testid="certificate-hosts-unreachable"
        >
          {$t('certificates.hosts.unreachable.text')}
        </Callout>
      {/if}
      {#if stalled}
        <Callout tone="warning" role="status" testid="certificate-hosts-stalled">
          {$t('certificates.hosts.stalled')}
        </Callout>
      {/if}

      <div class="table-wrap" aria-busy={checking}>
        <table class="data-table" data-testid="certificate-hosts">
          <thead>
            <tr>
              <th scope="col">{$t('certificates.hosts.col.host')}</th>
              <th scope="col">{$t('certificates.hosts.col.purpose')}</th>
              <th scope="col">{$t('certificates.hosts.col.served')}</th>
              <th scope="col">{$t('certificates.until')}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.hosts as host, at (at)}
              {@const served = host.served}
              {@const servedName =
                served.source === 'uploaded' ? nameOf(served.certificate_id) : ''}
              {@const expected = nameOf(host.certificate_id)}
              <tr
                data-testid="certificate-host"
                data-host={host.host}
                data-source={served.source}
                data-certificate={servedName}
              >
                <td><span class="primary">{host.host}</span></td>
                <td>{purposeText(host)}</td>
                <td class="served">
                  {#if served.source === 'uploaded'}
                    <span class="primary">{servedName || nameLabel(served.subject)}</span>
                    <span class="note">{$t('certificates.served.own')}</span>
                  {:else if served.source === 'other'}
                    <span title={served.issuer}>
                      {served.issuer
                        ? $t('certificates.served.other', { issuer: nameLabel(served.issuer) })
                        : $t('certificates.served.otherUnnamed')}
                    </span>
                  {:else if served.source === 'default'}
                    <span class="flag">
                      <TriangleAlert size={14} />
                      {$t('certificates.served.default')}
                    </span>
                  {:else if served.source === 'unreachable'}
                    <span class="muted">{$t('certificates.served.unreachable')}</span>
                  {:else if served.source === 'unknown'}
                    <span class="muted">{$t('certificates.served.unknown')}</span>
                  {:else}
                    <!-- An answer this version does not know, shown as it came. -->
                    <span class="muted">{served.source}</span>
                  {/if}
                  {#if (served.source === 'uploaded' || served.source === 'other') && !served.valid_for_host}
                    <span class="flag" data-testid="certificate-host-mismatch">
                      <TriangleAlert size={14} />
                      {$t('certificates.served.mismatch')}
                    </span>
                  {/if}
                  {#if awaited(host)}
                    <!-- Stored for this name, and the proxy answers with something else. -->
                    {#if !following && shadowed(host, gone)}
                      <!-- Not a matter of seconds: the proxy prefers one it fetched itself. -->
                      <span class="flag" data-testid="certificate-host-shadowed">
                        <TriangleAlert size={14} />
                        {$t('certificates.served.shadowed', { name: expected })}
                      </span>
                    {:else}
                      <span class="note" data-testid="certificate-host-pending">
                        {$t('certificates.served.pending', { name: expected })}
                      </span>
                    {/if}
                  {:else if expected && served.source !== 'uploaded'}
                    <span class="note" data-testid="certificate-host-expected">
                      {$t('certificates.served.expected', { name: expected })}
                    </span>
                  {/if}
                </td>
                <td>
                  <span class="until">{formatDate(served.not_after, $language) || '–'}</span>
                  {#if isPast(served.not_after)}
                    <Pill tone="crit">{$t('certificates.status.expired')}</Pill>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if data.hosts.some((host) => host.served.source === 'unknown')}
        <p class="help">{$t('certificates.hosts.unknown')}</p>
      {/if}
    </section>
  {/if}
</section>

<CertificateModal
  open={modalOpen}
  certificate={editing}
  onClose={() => (modalOpen = false)}
  {onSaved}
/>

<style>
  /* A certificate is two rows that belong together: no line between them, one between
     certificates. */
  .certificate .main td {
    border-bottom: 0;
    vertical-align: top;
  }
  .certificate + .certificate .main td {
    border-top: 1px solid var(--border);
  }
  .certificate .more td {
    max-width: none;
    padding-top: 0;
  }
  .certificate:hover td {
    background: var(--surface-hover);
  }
  .certificate:hover td.actions {
    background: var(--surface);
    box-shadow: inset 0 0 0 100vmax var(--surface-hover);
  }
  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    list-style: none;
  }
  .until {
    margin-right: var(--space-2);
    white-space: nowrap;
  }
  .flag {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
    margin: 0;
    color: var(--text);
    font-size: var(--text-xs);
    line-height: var(--lh-normal);
  }
  /* The warning tone is for the sign; a sentence in it would be hard to read on white. */
  .flag :global(svg) {
    flex: 0 0 auto;
    margin-top: 2px;
    color: var(--warning);
  }
  .more .flag {
    margin-bottom: var(--space-2);
  }
  /* Room for a sentence about what is served, where one is needed: also in a table that
     has become wider than its place and scrolls sideways. */
  .served {
    min-width: 28ch;
    max-width: 44ch;
  }
  /* The actions stick to the edge of a table that scrolls sideways. Two buttons with words
     would cover half of a phone's width there: the signs alone remain, the buttons keep
     their names. */
  @media (max-width: 720px) {
    .row-actions :global(.ui-btn .label) {
      display: none;
    }
  }
  .note {
    display: block;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  /* Closed, the element is as wide as its line: a click on it opens it. */
  details:not([open]) {
    width: fit-content;
  }
  summary {
    width: fit-content;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--fw-medium);
    cursor: pointer;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-4);
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-xs);
  }
  dt {
    color: var(--text-subtle);
  }
  dd {
    margin: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .chain {
    margin: 0;
    padding-left: var(--space-4);
  }
  .fingerprint span + span {
    margin-left: 0.35em;
  }
  .hosts {
    margin-top: var(--space-5);
  }
  .hosts-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
