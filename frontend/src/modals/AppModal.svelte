<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  import type { AdminApp, AppCreate, AppUpdate } from '$lib/api/types';

  export const ICON_MAX_BYTES = 256 * 1024;
  export const ICON_TYPES: readonly string[] = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
  ];

  /** Why an icon file cannot be used (an API error code), or null if it is acceptable. */
  export function iconFileProblem(file: {
    type: string;
    size: number;
  }): 'icon_invalid' | 'icon_too_large' | null {
    if (!ICON_TYPES.includes(file.type)) return 'icon_invalid';
    if (file.size === 0 || file.size > ICON_MAX_BYTES) return 'icon_too_large';
    return null;
  }

  const APP_FIELDS = [
    'name',
    'description',
    'type',
    'url',
    'enabled',
    'visible_to_all',
    'group_ids',
    'user_ids',
    'frame_permissions',
    'custom_html',
    'custom_css',
    'custom_js',
    'custom_allow_network',
  ] as const;

  function sameValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
    }
    return (a ?? null) === (b ?? null);
  }

  /**
   * The fields of an edited app that differ from the stored one. Only these are sent, so
   * the audit log names what was really changed. A new icon always counts as a change.
   */
  export function appChanges(original: AdminApp, next: AppCreate): AppUpdate {
    const patch: Record<string, unknown> = {};
    for (const key of APP_FIELDS) {
      if (!sameValue(original[key], next[key])) patch[key] = next[key];
    }
    if (next.icon) patch.icon = next.icon;
    return patch as AppUpdate;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Upload from '@lucide/svelte/icons/upload';
  import { APP_ICONS, APP_ICON_NAMES, DEFAULT_APP_ICON } from '$lib/appIcons';
  import { embedDetail } from '$lib/embedDetail';
  import { tenantApi } from '$lib/api/client';
  import { errorMessage } from '$lib/api/errors';
  import { fetchAllUsers } from '$lib/api/helpers';
  import {
    FRAME_PERMISSIONS,
    type AppType,
    type EmbedCheck,
    type FramePermission,
    type Group,
    type IconIn,
    type User,
  } from '$lib/api/types';
  import AppIcon from '$lib/components/app/AppIcon.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import MultiPicker from '$lib/components/ui/MultiPicker.svelte';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { t } from '$lib/i18n';
  import { restoreFocus } from '$lib/utils/focus';
  import { focusOnNewErrors, formChanged } from '$lib/utils/forms';
  import { rovingIndex } from '$lib/utils/roving';
  import { isHttpUrl } from '$lib/utils/validate';

  interface Props {
    open: boolean;
    /** The app to edit; null creates a new one. */
    app: AdminApp | null;
    groups: Group[];
    /** Whether single users can be offered for the visibility (users:read). */
    canReadUsers: boolean;
    onClose: () => void;
    onSaved: (app: AdminApp, created: boolean) => void;
  }

  let { open, app, groups, canReadUsers, onClose, onSaved }: Props = $props();

  // Bound to the organization the page was opened for (see tenantApi()).
  const api = tenantApi();

  const formId = $props.id();

  let name = $state('');
  let description = $state('');
  let type = $state<AppType>('embedded');
  let url = $state('');
  let enabled = $state(true);
  let audience = $state<'all' | 'selected'>('all');
  let groupIds = $state<string[]>([]);
  let userIds = $state<string[]>([]);
  let framePermissions = $state<string[]>([]);
  let customHtml = $state('');
  let customCss = $state('');
  let customJs = $state('');
  let allowNetwork = $state(false);

  // Icon: a glyph by name, a freshly chosen file (as data URL), or the stored upload.
  let iconName = $state<string | null>(DEFAULT_APP_ICON);
  let iconUpload = $state<string | null>(null);
  let storedIconUrl = $state<string | null>(null);
  let iconChanged = $state(false);
  let iconError = $state('');

  let users = $state<User[]>([]);
  let usersLoading = $state(false);
  let check = $state<EmbedCheck | null>(null);
  let checkedUrl = $state('');
  let checking = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let failure = $state('');

  // What the form holds, and what it held when the dialog opened: with changes in it the
  // dialog does not close on a stray click or key (see Modal).
  const fields = () => [
    name,
    description,
    type,
    url,
    enabled,
    audience,
    [...groupIds],
    [...userIds],
    [...framePermissions],
    customHtml,
    customCss,
    customJs,
    allowNetwork,
    iconName,
    iconUpload,
  ];
  let pristine = $state.raw<unknown[]>([]);
  const dirty = $derived(formChanged(fields(), pristine));

  // A field marked invalid gets the focus, so the message is seen even in a long form.
  const focusErrors = focusOnNewErrors(formId);
  $effect(() => focusErrors(errors));

  $effect(() => {
    if (!open) return;
    const current = app;
    const controller = new AbortController();
    untrack(() => {
      name = current?.name ?? '';
      description = current?.description ?? '';
      type = current?.type ?? 'embedded';
      url = current?.url ?? '';
      enabled = current?.enabled ?? true;
      audience = current && !current.visible_to_all ? 'selected' : 'all';
      groupIds = [...(current?.group_ids ?? [])];
      userIds = [...(current?.user_ids ?? [])];
      framePermissions = [...(current?.frame_permissions ?? [])];
      customHtml = current?.custom_html ?? '';
      customCss = current?.custom_css ?? '';
      customJs = current?.custom_js ?? '';
      allowNetwork = current?.custom_allow_network ?? false;
      iconName = current ? current.icon_name : DEFAULT_APP_ICON;
      iconUpload = null;
      storedIconUrl = current?.icon_url ?? null;
      iconChanged = false;
      iconError = '';
      check = null;
      checkedUrl = '';
      checking = false;
      saving = false;
      errors = {};
      failure = '';
      users = [];
      usersLoading = canReadUsers;
      iconFocus = null;
      pristine = fields();
    });
    if (canReadUsers) {
      fetchAllUsers(api, controller.signal)
        .then((all) => {
          users = all;
          usersLoading = false;
        })
        .catch(() => {
          // The dialog works without the list; only single users cannot be picked then.
          if (!controller.signal.aborted) usersLoading = false;
        });
    }
    return () => controller.abort();
  });

  const typeOptions = $derived([
    { value: 'embedded' as const, label: $t('app.type.embedded') },
    { value: 'external' as const, label: $t('app.type.external') },
    { value: 'custom' as const, label: $t('app.type.custom') },
  ]);
  const audienceOptions = $derived([
    { value: 'all' as const, label: $t('apps.audience.all') },
    { value: 'selected' as const, label: $t('apps.audience.selected') },
  ]);
  const groupOptions = $derived(groups.map((g) => ({ id: g.id, label: g.name })));
  const userOptions = $derived(
    users.map((u) => ({ id: u.id, label: u.display_name, detail: u.username })),
  );
  const previewUrl = $derived(iconUpload ?? storedIconUrl);

  // The icon grid is a single Tab stop: the chosen icon (or the one last focused, or the
  // first). Arrow keys, Home and End move the focus inside it; Enter or Space choose.
  let iconGrid = $state<HTMLDivElement | undefined>();
  let iconFocus = $state<string | null>(null);
  const iconTabStop = $derived(
    iconFocus ??
      (!previewUrl && iconName && APP_ICON_NAMES.includes(iconName) ? iconName : APP_ICON_NAMES[0]),
  );

  function onIconKeydown(event: KeyboardEvent) {
    if (!iconGrid || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [...iconGrid.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    // The grid wraps with the width of the dialog: count what the first row holds.
    const top = buttons[0].offsetTop;
    const columns = buttons.filter((button) => button.offsetTop === top).length;
    const next = rovingIndex(event.key, at, buttons.length, columns);
    if (next === null) return;
    event.preventDefault();
    buttons[next].focus();
  }

  function pickGlyph(next: string) {
    iconName = next;
    iconUpload = null;
    storedIconUrl = null;
    iconChanged = true;
    iconError = '';
  }

  function onIconFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // the same file can be chosen again after a fix
    if (!file) return;
    const problem = iconFileProblem(file);
    if (problem) {
      iconError = $t(`error.${problem}`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      iconUpload = reader.result;
      storedIconUrl = null;
      iconChanged = true;
      iconError = '';
    };
    reader.onerror = () => (iconError = $t('error.icon_invalid'));
    reader.readAsDataURL(file);
  }

  function togglePermission(permission: FramePermission, on: boolean) {
    framePermissions = on
      ? [...new Set([...framePermissions, permission])]
      : framePermissions.filter((p) => p !== permission);
  }

  async function checkEmbed() {
    const address = url.trim();
    if (!isHttpUrl(address)) {
      errors = { ...errors, url: $t('error.url_invalid') };
      return;
    }
    errors = { ...errors, url: '' };
    checking = true;
    check = null;
    try {
      check = await api.post('/api/v1/admin/apps/check-embed', { body: { url: address } });
      checkedUrl = address;
    } catch (err) {
      errors = { ...errors, url: errorMessage(err, $t) };
    } finally {
      checking = false;
    }
  }

  // A result only describes the address it was made for.
  const checkResult = $derived(check && checkedUrl === url.trim() ? check : null);

  function switchToExternal() {
    type = 'external';
    check = null;
    // The button that was pressed goes with the result of the check. The focus moves to
    // what it changed: the type, which now reads "Neuer Tab".
    void restoreFocus(() => [
      document
        .getElementById(formId)
        ?.querySelector<HTMLElement>('[data-testid="app-type"] input:checked'),
    ]);
  }

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = $t('validation.required');
    if (type !== 'custom') {
      if (!url.trim()) found.url = $t('error.url_required');
      else if (!isHttpUrl(url)) found.url = $t('error.url_invalid');
    } else if (!customHtml.trim()) {
      found.custom_html = $t('error.content_required');
    }
    return found;
  }

  function iconPayload(): IconIn | undefined {
    if (iconUpload) return { data_url: iconUpload };
    if (iconChanged || !app) return { name: iconName ?? DEFAULT_APP_ICON };
    return undefined;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    errors = validate();
    failure = '';
    if (Object.values(errors).some(Boolean)) return;

    // The complete app as the form describes it. What does not belong to the chosen type
    // is empty (the API clears it anyway): the address of custom apps, the code of the
    // others, browser features unless embedded.
    const body: AppCreate = {
      name: name.trim(),
      description: description.trim(),
      type,
      url: type === 'custom' ? null : url.trim(),
      enabled,
      visible_to_all: audience === 'all',
      group_ids: groupIds,
      user_ids: userIds,
      frame_permissions: type === 'embedded' ? (framePermissions as FramePermission[]) : [],
      custom_html: type === 'custom' ? customHtml : '',
      custom_css: type === 'custom' ? customCss : '',
      custom_js: type === 'custom' ? customJs : '',
      custom_allow_network: type === 'custom' && allowNetwork,
    };
    const icon = iconPayload();
    if (icon) body.icon = icon;

    saving = true;
    try {
      if (app) {
        const changes = appChanges(app, body);
        if (Object.keys(changes).length === 0) {
          onClose();
          return;
        }
        const saved = await api.patch('/api/v1/admin/apps/{app_id}', {
          path: { app_id: app.id },
          body: changes,
        });
        onSaved(saved, false);
      } else {
        const saved = await api.post('/api/v1/admin/apps', { body });
        onSaved(saved, true);
      }
    } catch (err) {
      failure = errorMessage(err, $t);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  {open}
  title={app ? $t('apps.edit.title', { name: app.name }) : $t('apps.create.title')}
  width="760px"
  error={failure}
  {dirty}
  {onClose}
>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <FormField label={$t('field.name')} required bind:error={errors.name}>
      <Input bind:value={name} maxlength={80} required />
    </FormField>
    <FormField label={$t('field.description')} hint={$t('apps.description.hint')}>
      <Input bind:value={description} maxlength={500} />
    </FormField>

    <FormField label={$t('field.type')} hint={$t(`apps.type.${type}.text`)}>
      <Segmented bind:value={type} options={typeOptions} testid="app-type" />
    </FormField>

    {#if type !== 'custom'}
      <FormField
        label={$t('field.url')}
        required
        hint={$t(type === 'external' ? 'apps.url.hint.external' : 'apps.url.hint')}
        bind:error={errors.url}
      >
        <div class="url-row">
          <Input
            bind:value={url}
            type="url"
            mono
            maxlength={2000}
            placeholder="https://"
            inputmode="url"
            autocapitalize="none"
            spellcheck={false}
            required
          />
          {#if type === 'embedded'}
            <Button
              variant="secondary"
              loading={checking}
              disabled={!url.trim()}
              onclick={checkEmbed}
            >
              {$t('apps.check.button')}
            </Button>
          {/if}
        </div>
      </FormField>

      {#if type === 'embedded' && checkResult}
        {#if checkResult.status === 'ok'}
          <Callout
            tone="success"
            role="status"
            title={$t('apps.check.ok.title')}
            testid="embed-check"
          >
            {$t('apps.check.ok.text')}
            <span class="tech">{embedDetail(checkResult.detail, $t)}</span>
          </Callout>
        {:else if checkResult.status === 'blocked'}
          <Callout
            tone="warning"
            role="status"
            title={$t('apps.check.blocked.title')}
            testid="embed-check"
          >
            {$t('apps.check.blocked.text')}
            <span class="tech">{embedDetail(checkResult.detail, $t)}</span>
            {#snippet action()}
              <Button variant="secondary" size="sm" onclick={switchToExternal}>
                {$t('apps.check.blocked.switch')}
              </Button>
            {/snippet}
          </Callout>
        {:else}
          <Callout
            tone="neutral"
            role="status"
            title={$t('apps.check.unknown.title')}
            testid="embed-check"
          >
            {$t('apps.check.unknown.text')}
            <span class="tech">{embedDetail(checkResult.detail, $t)}</span>
          </Callout>
        {/if}
      {/if}
    {/if}

    {#if type === 'custom'}
      <Callout tone="info" title={$t('apps.custom.isolated.title')}>
        {$t('apps.custom.isolated.text')}
      </Callout>
      <FormField label="HTML" required bind:error={errors.custom_html}>
        <Input
          bind:value={customHtml}
          multiline
          mono
          rows={8}
          maxlength={300000}
          spellcheck={false}
          autocapitalize="off"
        />
      </FormField>
      <FormField label="CSS">
        <Input
          bind:value={customCss}
          multiline
          mono
          rows={6}
          maxlength={150000}
          spellcheck={false}
          autocapitalize="off"
        />
      </FormField>
      <FormField label="JavaScript">
        <Input
          bind:value={customJs}
          multiline
          mono
          rows={6}
          maxlength={300000}
          spellcheck={false}
          autocapitalize="off"
        />
      </FormField>
      <div class="option">
        <Switch bind:checked={allowNetwork} label={$t('apps.custom.network.label')} />
        <p class="help">{$t('apps.custom.network.text')}</p>
      </div>
    {/if}

    <fieldset class="group">
      <legend>{$t('apps.icon.title')}</legend>
      <div class="icon-head">
        <span class="icon-preview" data-testid="app-icon-preview">
          <AppIcon name={iconName} url={previewUrl} size={26} />
        </span>
        <div class="icon-upload">
          <label class="upload">
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.gif,.webp,.svg,image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              onchange={onIconFile}
            />
            <Upload size={16} />
            <span>{$t('apps.icon.upload')}</span>
          </label>
          <p class="help" class:bad={!!iconError} role={iconError ? 'alert' : undefined}>
            {iconError || $t('apps.icon.uploadHint')}
          </p>
        </div>
      </div>
      <div
        bind:this={iconGrid}
        class="icon-grid"
        role="radiogroup"
        aria-label={$t('apps.icon.pick')}
      >
        {#each APP_ICON_NAMES as glyph (glyph)}
          {@const Glyph = APP_ICONS[glyph]}
          {@const selected = !previewUrl && iconName === glyph}
          <button
            type="button"
            class="icon-option"
            class:selected
            role="radio"
            aria-checked={selected}
            aria-label={$t(`icon.${glyph}`)}
            title={$t(`icon.${glyph}`)}
            data-icon={glyph}
            tabindex={glyph === iconTabStop ? 0 : -1}
            onfocus={() => (iconFocus = glyph)}
            onkeydown={onIconKeydown}
            onclick={() => pickGlyph(glyph)}
          >
            <Glyph size={20} />
          </button>
        {/each}
      </div>
    </fieldset>

    <fieldset class="group">
      <legend>{$t('apps.audience.title')}</legend>
      <Segmented
        bind:value={audience}
        options={audienceOptions}
        label={$t('apps.audience.title')}
        testid="app-audience"
      />
      {#if audience === 'all'}
        <p class="help">{$t('apps.audience.all.text')}</p>
      {:else}
        <p class="help">{$t('apps.audience.selected.text')}</p>
        <FormField label={$t('field.groups')}>
          <MultiPicker
            bind:selected={groupIds}
            options={groupOptions}
            emptyText={$t('apps.audience.noGroups')}
          />
        </FormField>
        {#if canReadUsers}
          <FormField label={$t('apps.audience.users')}>
            <MultiPicker
              bind:selected={userIds}
              options={userOptions}
              loading={usersLoading}
              searchPlaceholder={$t('groups.members.search')}
            />
          </FormField>
        {/if}
      {/if}
    </fieldset>

    {#if type === 'embedded'}
      <fieldset class="group">
        <legend>{$t('apps.permissions.title')}</legend>
        <p class="help">{$t('apps.permissions.text')}</p>
        <div class="checks">
          {#each FRAME_PERMISSIONS as permission (permission)}
            <Checkbox
              checked={framePermissions.includes(permission)}
              label={$t(`apps.permission.${permission}`)}
              onChange={(on) => togglePermission(permission, on)}
            />
          {/each}
        </div>
      </fieldset>
    {/if}

    <div class="option">
      <Switch bind:checked={enabled} label={$t('apps.enabled.label')} />
      <p class="help">{$t('apps.enabled.text')}</p>
    </div>
  </form>
  {#snippet footer()}
    {#if type === 'custom'}
      <span class="foot-note"><ShieldCheck size={14} />{$t('apps.custom.footnote')}</span>
    {/if}
    <Button variant="ghost" onclick={onClose}>{$t('action.cancel')}</Button>
    <Button type="submit" form={formId} loading={saving}>
      {app ? $t('action.save') : $t('apps.create.submit')}
    </Button>
  {/snippet}
</Modal>

<style>
  .url-row {
    display: flex;
    gap: var(--space-2);
  }
  .url-row > :global(:first-child) {
    flex: 1;
    min-width: 0;
  }
  .tech {
    display: block;
    margin-top: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
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
  .option {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }
  .icon-head {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .icon-preview {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 56px;
    height: 56px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
    color: var(--text-strong);
  }
  .icon-upload {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    min-width: 0;
  }
  .upload {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 34px;
    padding: 0 14px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
  }
  .upload:hover {
    background: var(--surface-hover);
  }
  /* The file input covers the label: it takes the click and the keyboard focus itself. */
  .upload input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }
  .upload:has(input:focus-visible) {
    outline: var(--ring-width) solid var(--ring);
    outline-offset: 1px;
  }
  .bad {
    color: var(--danger);
  }
  .icon-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(42px, 1fr));
    gap: var(--space-1);
  }
  .icon-option {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .icon-option:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  /* Chosen: a hairline frame in the text colour, not a fill. */
  .icon-option.selected {
    border-color: var(--text-strong);
    color: var(--text-strong);
  }
  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-3);
  }
  .foot-note {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin-right: auto;
    color: var(--text-subtle);
    font-size: var(--text-xs);
  }
  @media (max-width: 560px) {
    .url-row {
      flex-direction: column;
    }
    .foot-note {
      display: none;
    }
  }
</style>
