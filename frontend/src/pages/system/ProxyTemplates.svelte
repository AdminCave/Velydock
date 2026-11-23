<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash from '@lucide/svelte/icons/trash';
  import { ApiError, api } from '$lib/api/client';
  import type { ProxyTemplate } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { t } from '$lib/i18n';
  import type { ProxyOptions } from '$lib/proxy';
  import { optionSummary, templateText } from '$lib/proxyText';
  import { showError, showToast } from '$lib/stores/toasts';
  import { restoreFocus } from '$lib/utils/focus';
  import ProxyTemplateModal from '../../modals/ProxyTemplateModal.svelte';

  // Proxy templates: sets of proxy settings organizations choose from when they publish an
  // app. The built-in ones come with the installation and are shown as they are; a system
  // administrator adds their own, which may also hold Traefik middlewares.

  let templates = $state<ProxyTemplate[] | null>(null);
  let failed = $state(false);
  let modalOpen = $state(false);
  let editing = $state<ProxyTemplate | null>(null);
  // Whether apps can be published on this installation at all, and its defaults (null: not
  // known; the page works all the same).
  let publishing = $state<boolean | null>(null);
  let defaults = $state<ProxyOptions | null>(null);
  // A template that could not be deleted because published apps use it: said on the page,
  // where it stays to be read, with the rule and the publications the server names.
  let inUse = $state<{ name: string; apps: string } | null>(null);

  async function load() {
    try {
      templates = await api.get('/api/v1/system/proxy-templates');
      failed = false;
    } catch (err) {
      failed = true;
      showError(err);
    }
  }

  onMount(() => {
    void load();
    // What the installation says about publishing, for the pages that are about no
    // organization: whether it is set up, and its defaults.
    api
      .get('/api/v1/system/proxy')
      .then((info) => {
        publishing = info.enabled;
        defaults = info.enabled ? (info.defaults ?? null) : null;
      })
      .catch(() => {
        /* not known then: the defaults this version knows are used */
      });
  });

  function openCreate() {
    inUse = null;
    editing = null;
    modalOpen = true;
  }

  function openEdit(template: ProxyTemplate) {
    inUse = null;
    editing = template;
    modalOpen = true;
  }

  /**
   * The publications that use a template, as the refusal lists them
   * (`details.publications`): at most five, so five may stand for more.
   */
  function usedBy(err: ApiError): string {
    const listed = Array.isArray(err.details.publications) ? err.details.publications : [];
    const names = listed.filter((name): name is string => typeof name === 'string');
    return names.length >= 5 ? `${names.join(', ')}, …` : names.join(', ');
  }

  function onSaved(template: ProxyTemplate, created: boolean) {
    modalOpen = false;
    showToast(
      $t(created ? 'proxyTemplates.created' : 'proxyTemplates.saved', { name: template.name }),
    );
    void load();
  }

  async function remove(template: ProxyTemplate) {
    const ok = await confirmDialog($t('proxyTemplates.delete.question', { name: template.name }), {
      title: $t('proxyTemplates.delete.title'),
      detail: $t('proxyTemplates.delete.detail'),
      confirmLabel: $t('proxyTemplates.delete.confirm'),
    });
    if (!ok) return;
    inUse = null;
    const rows = () => [
      ...document.querySelectorAll<HTMLElement>('[data-testid="proxy-template"]'),
    ];
    const at = rows().findIndex((row) => row.dataset.id === template.id);
    try {
      await api.delete('/api/v1/system/proxy-templates/{template_id}', {
        path: { template_id: template.id },
      });
      showToast($t('proxyTemplates.deleted', { name: template.name }));
      await load();
      // The row is gone, and with it the button that had the focus.
      await restoreFocus(() => {
        const left = rows();
        return [
          left[Math.min(at, left.length - 1)]?.querySelector<HTMLElement>('button'),
          document.querySelector<HTMLElement>('[data-testid="proxy-template-new"]'),
        ];
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'template_in_use') {
        inUse = { name: template.name, apps: usedBy(err) };
      } else {
        showError(err);
      }
    }
  }
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('proxyTemplates.title')}</h1>
      <p class="page-subtitle">{$t('proxyTemplates.subtitle')}</p>
    </div>
    <Button iconLeft={Plus} data-testid="proxy-template-new" onclick={openCreate}>
      {$t('proxyTemplates.new')}
    </Button>
  </header>

  {#if publishing === false}
    <Callout
      tone="warning"
      role="status"
      title={$t('proxy.disabled.title')}
      testid="proxy-disabled"
    >
      {$t('proxy.disabled.text')}
    </Callout>
  {/if}

  {#if inUse}
    <Callout
      tone="warning"
      role="alert"
      title={$t('proxyTemplates.inUse.title', { name: inUse.name })}
      testid="proxy-template-in-use"
    >
      {$t('error.template_in_use')}
      {#if inUse.apps}{$t('proxyTemplates.usedBy', { apps: inUse.apps })}{/if}
    </Callout>
  {/if}

  <div class="table-wrap">
    <table class="data-table" data-testid="proxy-templates-table">
      <thead>
        <tr>
          <th scope="col">{$t('field.name')}</th>
          <th scope="col">{$t('proxyTemplates.col.kind')}</th>
          <th scope="col">{$t('proxyTemplates.col.settings')}</th>
          <th scope="col" class="actions">{$t('field.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {#each templates ?? [] as template (template.id)}
          {@const summary = optionSummary(template.options ?? {}, $t)}
          {@const name = templateText(template, 'name', $t)}
          {@const text = templateText(template, 'text', $t)}
          <tr data-testid="proxy-template" data-id={template.id} data-builtin={template.builtin}>
            <td>
              <span class="primary">{name}</span>
              {#if text}<span class="description">{text}</span>{/if}
            </td>
            <td>
              {#if template.builtin}
                <Pill tone="muted">{$t('proxyTemplates.builtin')}</Pill>
              {:else}
                <Pill tone="accent">{$t('proxyTemplates.own')}</Pill>
              {/if}
            </td>
            <td>
              {#if summary.length > 0}
                <ul class="summary">
                  {#each summary as part (part)}<li>{part}</li>{/each}
                </ul>
              {:else}
                <span class="subtle">{$t('proxyTemplates.nothing')}</span>
              {/if}
            </td>
            <td class="actions">
              {#if !template.builtin}
                <span class="row-actions">
                  <IconButton
                    icon={Pencil}
                    size="sm"
                    label={$t('proxyTemplates.actions.edit', { name: template.name })}
                    data-testid="proxy-template-edit"
                    onclick={() => openEdit(template)}
                  />
                  <IconButton
                    icon={Trash}
                    size="sm"
                    label={$t('proxyTemplates.actions.delete', { name: template.name })}
                    data-testid="proxy-template-delete"
                    onclick={() => void remove(template)}
                  />
                </span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if !templates}
      <div class="table-state">
        {#if failed}
          <Button variant="secondary" onclick={() => void load()}>{$t('action.retry')}</Button>
        {:else}
          <Spinner size={20} />
        {/if}
      </div>
    {/if}
  </div>
  <p class="help">{$t('proxyTemplates.effect')}</p>
</section>

<ProxyTemplateModal
  open={modalOpen}
  template={editing}
  {defaults}
  onClose={() => (modalOpen = false)}
  {onSaved}
/>

<style>
  .description {
    display: block;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    list-style: none;
  }
</style>
