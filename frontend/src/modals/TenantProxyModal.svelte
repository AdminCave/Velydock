<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import { ApiError, api } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import type { ProxyTarget, Tenant } from '$lib/api/types';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { t } from '$lib/i18n';
  import { releaseProblem } from '$lib/proxy';
  import { showError, showToast } from '$lib/stores/toasts';
  import { restoreFocus } from '$lib/utils/focus';
  import { focusFirstInvalid } from '$lib/utils/forms';

  // What an organization may publish through the proxy: the internal addresses a system
  // administrator released for it, and whether it may use path addresses. Each change is
  // stored at once; there is nothing to save at the end.

  interface Props {
    /** The organization; null keeps the dialog closed. */
    tenant: Tenant | null;
    /** Whether publishing is set up on the installation (null: not known). */
    enabled: boolean | null;
    onClose: () => void;
    /** The organization was changed here (path addresses): the list is out of date. */
    onChanged: () => void;
  }

  let { tenant, enabled, onClose, onChanged }: Props = $props();

  const formId = $props.id();
  let targets = $state<ProxyTarget[] | null>(null);
  let failed = $state(false);
  let value = $state('');
  let note = $state('');
  let error = $state<string | undefined>();
  let adding = $state(false);
  let pathAllowed = $state(true);
  let pathBusy = $state(false);
  let list = $state<HTMLElement | undefined>();

  // What was typed and not released yet would be lost by a stray click (see Modal).
  const dirty = $derived(value.trim() !== '' || note.trim() !== '');

  async function load(id: string) {
    try {
      targets = await api.get('/api/v1/system/tenants/{tenant_id}/proxy-targets', {
        path: { tenant_id: id },
      });
      failed = false;
    } catch (err) {
      failed = true;
      showError(err);
    }
  }

  $effect(() => {
    const current = tenant;
    if (!current) return;
    untrack(() => {
      targets = null;
      failed = false;
      value = '';
      note = '';
      error = undefined;
      adding = false;
      pathAllowed = current.proxy_path_allowed;
      pathBusy = false;
      if (enabled !== false) void load(current.id);
    });
  });

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (!tenant || adding) return;
    const problem = releaseProblem(value);
    error = problem ? $t(problem) : undefined;
    if (problem) {
      void focusFirstInvalid(formId);
      return;
    }
    adding = true;
    try {
      const added = await api.post('/api/v1/system/tenants/{tenant_id}/proxy-targets', {
        path: { tenant_id: tenant.id },
        body: { value: value.trim(), note: note.trim() },
      });
      showToast($t('proxyTargets.added', { value: added.value, name: tenant.name }));
      value = '';
      note = '';
      await load(tenant.id);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'proxy_target_invalid') {
        // A form the check here let through and the server does not take.
        error = $t('proxyTargets.invalid');
      } else if (code === 'proxy_target_reserved' || code === 'proxy_target_exists') {
        // A name of the installation's own services; a release that exists already.
        error = errorMessage(err, $t);
      } else {
        showError(err);
      }
      if (error) void focusFirstInvalid(formId);
    } finally {
      adding = false;
    }
  }

  async function remove(target: ProxyTarget) {
    if (!tenant) return;
    const organization = tenant;
    const ok = await confirmDialog(
      $t('proxyTargets.remove.question', { value: target.value, name: organization.name }),
      {
        title: $t('proxyTargets.remove.title'),
        detail: $t('proxyTargets.remove.detail'),
        confirmLabel: $t('proxyTargets.remove.confirm'),
      },
    );
    if (!ok) return;
    const at = (targets ?? []).findIndex((entry) => entry.id === target.id);
    try {
      await api.delete('/api/v1/system/tenants/{tenant_id}/proxy-targets/{target_id}', {
        path: { tenant_id: organization.id, target_id: target.id },
      });
      showToast($t('proxyTargets.removed', { value: target.value }));
      await load(organization.id);
      // The entry is gone, and with it the button that had the focus: the one that took
      // its place, or the field for the next release.
      await restoreFocus(() => {
        const buttons = [
          ...(list?.querySelectorAll<HTMLElement>('[data-testid="proxy-target-remove"]') ?? []),
        ];
        return [
          buttons[Math.min(at, buttons.length - 1)],
          document.getElementById(formId)?.querySelector<HTMLElement>('input'),
        ];
      });
    } catch (err) {
      showError(err);
    }
  }

  // "Fertig" says that nothing is left to do. A value that was typed and not released is:
  // said at the field, instead of dropping it without a word.
  function done() {
    if (enabled !== false && value.trim()) {
      error = $t('proxyTargets.pending', { value: value.trim() });
      void focusFirstInvalid(formId);
      return;
    }
    onClose();
  }

  async function setPathAllowed(allowed: boolean) {
    if (!tenant) return;
    if (pathBusy) {
      // A second press while the first is being stored: taken back, not sent on top. (The
      // switch is not disabled meanwhile: a disabled control loses the keyboard focus.)
      pathAllowed = !allowed;
      return;
    }
    const organization = tenant;
    if (!allowed) {
      // Published apps of the organization stop working with this: asked first.
      const ok = await confirmDialog(
        $t('proxyTargets.path.off.question', { name: organization.name }),
        {
          title: $t('proxyTargets.path.off.title'),
          detail: $t('proxyTargets.path.off.detail'),
          confirmLabel: $t('proxyTargets.path.off.confirm'),
        },
      );
      if (!ok) {
        pathAllowed = true;
        return;
      }
    }
    pathBusy = true;
    try {
      const saved = await api.patch('/api/v1/system/tenants/{tenant_id}', {
        path: { tenant_id: organization.id },
        body: { proxy_path_allowed: allowed },
      });
      pathAllowed = saved.proxy_path_allowed;
      showToast(
        $t(saved.proxy_path_allowed ? 'proxyTargets.path.on' : 'proxyTargets.path.off', {
          name: organization.name,
        }),
      );
      onChanged();
    } catch (err) {
      pathAllowed = !allowed;
      showError(err);
    } finally {
      pathBusy = false;
    }
  }
</script>

<Modal
  open={tenant !== null}
  title={tenant ? $t('proxyTargets.title', { name: tenant.name }) : ''}
  width="640px"
  {dirty}
  {onClose}
>
  {#if tenant}
    {#if enabled === false}
      <!-- Nothing can be published on this installation: said in the place of the controls. -->
      <Callout
        tone="warning"
        role="status"
        title={$t('proxy.disabled.title')}
        testid="proxy-disabled"
      >
        {$t('proxy.disabled.text')}
      </Callout>
    {:else}
      <div class="form">
        <p class="help">{$t('proxyTargets.text')}</p>

        <section class="block" aria-labelledby="{formId}-list">
          <h3 class="block-title" id="{formId}-list">{$t('proxyTargets.list')}</h3>
          {#if targets === null}
            <div class="state">
              {#if failed}
                <Button variant="secondary" size="sm" onclick={() => void load(tenant.id)}>
                  {$t('action.retry')}
                </Button>
              {:else}
                <Spinner size={18} />
              {/if}
            </div>
          {:else if targets.length === 0}
            <p class="help" data-testid="proxy-targets-empty">{$t('proxyTargets.empty')}</p>
          {:else}
            <ul class="targets" bind:this={list}>
              {#each targets as target (target.id)}
                <li class="target" data-testid="proxy-target" data-value={target.value}>
                  <span class="target-text">
                    <span class="mono target-value">{target.value}</span>
                    {#if target.note}<span class="target-note">{target.note}</span>{/if}
                  </span>
                  <IconButton
                    icon={X}
                    size="sm"
                    label={$t('proxyTargets.remove', { value: target.value })}
                    data-testid="proxy-target-remove"
                    onclick={() => void remove(target)}
                  />
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <form id={formId} class="add" onsubmit={add} novalidate>
          <FormField label={$t('proxyTargets.value')} required bind:error>
            <Input
              bind:value
              mono
              maxlength={255}
              placeholder="10.20.0.0/16"
              autocapitalize="none"
              spellcheck={false}
              required
              testid="proxy-target-value"
            />
          </FormField>
          <FormField label={$t('proxyTargets.note')} hint={$t('proxyTargets.note.hint')}>
            <Input bind:value={note} maxlength={200} testid="proxy-target-note" />
          </FormField>
          <div class="form-actions">
            <Button
              type="submit"
              variant="secondary"
              iconLeft={Plus}
              loading={adding}
              data-testid="proxy-target-add"
            >
              {$t('proxyTargets.add')}
            </Button>
          </div>
          <div class="forms">
            <p class="help">{$t('proxyTargets.forms')}</p>
            <ul class="help forms-list">
              <li>{$t('proxyTargets.form.network')}</li>
              <li>{$t('proxyTargets.form.address')}</li>
              <li>{$t('proxyTargets.form.port')}</li>
              <li>{$t('proxyTargets.form.host')}</li>
            </ul>
          </div>
        </form>

        <div class="option">
          <Switch
            bind:checked={pathAllowed}
            label={$t('proxyTargets.path.label')}
            testid="proxy-path-allowed"
            onChange={(on) => void setPathAllowed(on)}
          />
          <p class="help">{$t('proxyTargets.path.text')}</p>
        </div>
      </div>
    {/if}
  {/if}
  {#snippet footer()}
    <!-- Every change was stored when it was made: nothing is left to save here. -->
    <Button variant="secondary" onclick={done}>
      {$t(enabled === false ? 'action.close' : 'proxyTargets.done')}
    </Button>
  {/snippet}
</Modal>

<style>
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .block-title {
    margin: 0;
    color: var(--text-strong);
    font-size: var(--text-sm);
    font-weight: var(--fw-semibold);
  }
  .state {
    display: flex;
    align-items: center;
    min-height: 36px;
  }
  .targets {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    list-style: none;
  }
  .target {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  }
  .target + .target {
    border-top: 1px solid var(--border);
  }
  .target-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .target-value {
    color: var(--text-strong);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .target-note {
    color: var(--text-muted);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
  .add {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }
  .forms-list {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-5);
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }
</style>
