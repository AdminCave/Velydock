<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  import type { AdminApp, AppCreate, AppUpdate } from '$lib/api/types';

  import { IMAGE_ACCEPT, IMAGE_MAX_BYTES, imageFileProblem, readImageFile } from '$lib/imageFile';

  export const ICON_MAX_BYTES = IMAGE_MAX_BYTES;

  /** Why an icon file cannot be used (an API error code), or null if it is acceptable. */
  export function iconFileProblem(file: {
    type: string;
    size: number;
  }): 'icon_invalid' | 'icon_too_large' | null {
    const problem = imageFileProblem(file);
    return problem ? `icon_${problem}` : null;
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
   * The address of a published app is the proxy's: it is neither compared nor sent. (The
   * publication itself is added by the form, which knows whether it was touched.)
   */
  export function appChanges(original: AdminApp, next: AppCreate): AppUpdate {
    const patch: Record<string, unknown> = {};
    for (const key of APP_FIELDS) {
      if (key === 'url' && next.publication) continue;
      if (!sameValue(original[key], next[key])) patch[key] = next[key];
    }
    if (next.icon) patch.icon = next.icon;
    return patch as AppUpdate;
  }
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Upload from '@lucide/svelte/icons/upload';
  import { APP_ICONS, APP_ICON_NAMES, DEFAULT_APP_ICON } from '$lib/appIcons';
  import { embedDetail } from '$lib/embedDetail';
  import { ApiError, tenantApi } from '$lib/api/client';
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
  import MiddlewaresField from '$lib/components/proxy/MiddlewaresField.svelte';
  import ProxyOptionsEditor from '$lib/components/proxy/ProxyOptionsEditor.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import FormField from '$lib/components/ui/FormField.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import MultiPicker from '$lib/components/ui/MultiPicker.svelte';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { t } from '$lib/i18n';
  import {
    CUSTOM_MIDDLEWARES,
    DEFAULT_TEMPLATE,
    NAME_MAX_LENGTH,
    OPTION_KEYS,
    middlewaresToText,
    normalizePublicationName,
    optionBaseline,
    optionsToSend,
    parseMiddlewares,
    pruneOptions,
    publicAddress,
    publicationNameProblem,
    samePublication,
    sameOption,
    splitOptions,
    suggestPublicationName,
    targetProblem,
    type ProxyInfo,
    type ProxyOptions,
    type PublicationAccess,
    type PublicationIn,
    type PublicationMode,
  } from '$lib/proxy';
  import { templateText } from '$lib/proxyText';
  import { restoreFocus } from '$lib/utils/focus';
  import {
    focusFirstInvalid,
    focusOnNewErrors,
    formChanged,
    refusedFields,
    reveal,
  } from '$lib/utils/forms';
  import { rovingIndex } from '$lib/utils/roving';
  import { isHttpUrl } from '$lib/utils/validate';

  interface Props {
    open: boolean;
    /** The app to edit; null creates a new one. */
    app: AdminApp | null;
    groups: Group[];
    /** Whether single users can be offered for the visibility (users:read). */
    canReadUsers: boolean;
    /** A system administrator may give a single published app Traefik middlewares of its
     *  own; everybody else sees that there are some and can neither change nor drop them. */
    systemAdmin: boolean;
    onClose: () => void;
    onSaved: (app: AdminApp, created: boolean) => void;
  }

  let { open, app, groups, canReadUsers, systemAdmin, onClose, onSaved }: Props = $props();

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

  // Publishing through the bundled proxy (embedded apps and apps in a new tab): what the
  // installation offers the organization, and what the form holds about it. `pubOptions`
  // is only what deviates from the chosen template.
  let proxy = $state<ProxyInfo | null>(null);
  let proxyLoading = $state(false);
  let published = $state(false);
  let pubTarget = $state('');
  let pubMode = $state<PublicationMode>('path');
  let pubName = $state('');
  // The name in the address follows the app's name until it is edited by hand.
  let pubNameTouched = $state(false);
  let pubAccess = $state<PublicationAccess>('protected');
  let pubTemplate = $state(DEFAULT_TEMPLATE);
  let pubOptions = $state<ProxyOptions>({});
  // Own middlewares of this one app, as JSON: a system administrator's field. They are no
  // part of `pubOptions`; what is stored of them is `storedCustom`.
  let pubCustom = $state('');
  // Whether the request that was refused carried them (the refusal is then about them).
  let sentCustom = false;
  let optionsInvalid = $state(false);
  let optionsOpen = $state(false);
  let optionsDetail = $state('');

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
    published,
    pubTarget,
    pubMode,
    pubName,
    pubAccess,
    pubTemplate,
    JSON.stringify(pubOptions),
    pubCustom,
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
      const stored = current?.publication ?? null;
      name = current?.name ?? '';
      description = current?.description ?? '';
      type = current?.type ?? 'embedded';
      // The address of a published app is the public one, which goes with the publication:
      // should it be ended, the field comes back empty and asks for the app's own address.
      url = stored ? '' : (current?.url ?? '');
      published = stored !== null;
      pubTarget = stored?.target_url ?? '';
      pubMode = stored?.mode ?? 'path';
      pubName = stored?.name ?? '';
      pubNameTouched = false;
      pubAccess = stored?.access ?? 'protected';
      pubTemplate = stored?.template ?? DEFAULT_TEMPLATE;
      const options = splitOptions(stored?.options);
      pubOptions = options.own;
      pubCustom = middlewaresToText(options.custom);
      sentCustom = false;
      optionsInvalid = false;
      // Open where something deviates from the template, or where a system administrator
      // finds middlewares to look after.
      optionsOpen =
        Object.keys(options.own).length > 0 ||
        (systemAdmin && Object.keys(options.custom).length > 0);
      optionsDetail = '';
      proxy = null;
      proxyLoading = true;
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
    // What can be published, and from where. Without an answer the dialog works as it
    // always did; only publishing is not offered then.
    api
      .get('/api/v1/admin/proxy', { signal: controller.signal })
      .then((info) => {
        proxy = info;
        proxyLoading = false;
      })
      .catch(() => {
        if (!controller.signal.aborted) proxyLoading = false;
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

  // ── Publishing ─────────────────────────────────────────────────────
  const canPublish = $derived(proxy?.enabled === true);
  // Offered where the installation has it set up; an app that is published already shows
  // the section in any case, so that the publication can be seen and ended.
  const publishShown = $derived(type !== 'custom' && (canPublish || published));
  /** Whether the app is published as the form stands (a custom app never is). */
  const isPublished = $derived(published && type !== 'custom');
  const targets = $derived(proxy?.targets ?? []);
  const pathAllowed = $derived(proxy?.path_allowed !== false);
  const proxyTemplates = $derived(proxy?.templates ?? []);
  const template = $derived(proxyTemplates.find((entry) => entry.id === pubTemplate) ?? null);
  const baseline = $derived(optionBaseline(proxy?.defaults, template));
  const pubContext = $derived({ mode: pubMode, target: pubTarget, access: pubAccess });
  // Nothing was released for the organization, and nothing is published yet: there is
  // no address a publication could be saved with.
  const nothingReleased = $derived(canPublish && targets.length === 0 && !app?.publication);
  const publicPreview = $derived.by(() => {
    const built = publicAddress(proxy, pubMode, pubName);
    if (built) return built;
    // Before the installation has said what its addresses look like: what is stored.
    const stored = app?.publication;
    return stored && stored.mode === pubMode && stored.name === normalizePublicationName(pubName)
      ? stored.public_url
      : '';
  });
  // What a system administrator stored for this one app; an organization's administrator
  // is told that it is there, by its names.
  const storedCustom = $derived(splitOptions(app?.publication?.options).custom);
  const storedCustomNames = $derived(Object.keys(storedCustom).sort().join(', '));
  const optionsChanged = $derived(
    OPTION_KEYS.filter((key) => key in pubOptions && !sameOption(pubOptions[key], baseline[key]))
      .length,
  );

  const modeOptions = $derived([
    // Without path addresses for the organization there is the sub-domain only.
    ...(pathAllowed ? [{ value: 'path' as const, label: $t('proxy.mode.path') }] : []),
    { value: 'subdomain' as const, label: $t('proxy.mode.subdomain') },
  ]);
  const accessOptions = $derived([
    { value: 'protected' as const, label: $t('proxy.access.protected') },
    { value: 'public' as const, label: $t('proxy.access.public') },
  ]);
  // Built-in templates are named by this interface, by their id; own ones as the system
  // administrator named them.
  const templateOptions = $derived([
    ...proxyTemplates.map((entry) => ({
      value: entry.id,
      label: templateText(entry, 'name', $t),
    })),
    // A template that is not among those offered stays the choice until another one is
    // made: one that was deleted since is shown as that; before the installation has
    // said what it offers, the place is held without a name.
    ...(template
      ? []
      : [{ value: pubTemplate, label: proxy ? $t('proxy.template.missing') : '…' }]),
  ]);
  const templateHint = $derived(
    template
      ? templateText(template, 'text', $t) || $t('proxy.template.hint')
      : $t('proxy.template.hint'),
  );

  // A path address that is stored although the organization may no longer use them: the
  // proxy does not serve it, and the form does not offer it again.
  const pathRefused = $derived(!pathAllowed && pubMode === 'path');

  function onPublishToggle(on: boolean) {
    errors = { ...errors, publication: '' };
    if (!on || app?.publication) return;
    // A new publication: by sub-domain where path addresses are not allowed, and with a
    // name taken from the app's, which can be changed.
    if (!pathAllowed) pubMode = 'subdomain';
    if (!pubNameTouched) pubName = suggestPublicationName(name);
  }

  function onNameInput() {
    if (isPublished && !app?.publication && !pubNameTouched) {
      pubName = suggestPublicationName(name);
    }
  }

  // Where the focus goes for a refusal that is not about a text field (those are focused
  // as every invalid field is): to the control the message stands at.
  const REFUSAL_FOCUS: Record<string, string> = {
    publication: '[data-testid="app-publish-toggle"]',
    pub_mode: '[data-testid="app-publish-mode"] input',
    pub_options: '[data-testid="app-publish-options"] summary',
  };
  async function focusRefusal(refused: Record<string, string>) {
    const selector = Object.keys(refused)
      .map((field) => REFUSAL_FOCUS[field])
      .find(Boolean);
    if (!selector) return;
    await tick();
    const form = document.getElementById(formId);
    form?.querySelector<HTMLElement>(selector)?.focus();
    // The message stands next to the control, not in it: it is brought into view as well.
    reveal(form?.querySelector('[role="alert"]'));
  }

  // Another template gives other values: what the form set stays, unless it is what the
  // new template gives anyway.
  function onTemplateChange(id: string) {
    const next = proxyTemplates.find((entry) => entry.id === id) ?? null;
    pubOptions = pruneOptions(pubOptions, optionBaseline(proxy?.defaults, next));
  }

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
    readImageFile(file)
      .then((dataUrl) => {
        iconUpload = dataUrl;
        storedIconUrl = null;
        iconChanged = true;
        iconError = '';
      })
      .catch(() => (iconError = $t('error.icon_invalid')));
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
    if (isPublished) {
      // The address is the public one; what is needed instead is where it leads and
      // what it is called.
      const target = targetProblem(pubTarget);
      const called = publicationNameProblem(pubName);
      if (target) found.pub_target = $t(target);
      if (called) found.pub_name = $t(called);
      const custom = systemAdmin ? parseMiddlewares(pubCustom) : null;
      if (custom?.problem) found.pub_custom = $t(custom.problem, { detail: custom.detail });
    } else if (type !== 'custom') {
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

  /** The publication as the form describes it, or null when the app is not published. */
  function publicationPayload(): PublicationIn | null {
    if (!isPublished) return null;
    // Only the deviations that have an effect for this address, access and target.
    const options = optionsToSend(pubOptions, pubContext);
    // Own middlewares are a system administrator's to send: what the field holds is what
    // the app has from then on, and an empty field takes them away. From everybody else
    // the key does not come at all; the server keeps what is stored.
    const custom = systemAdmin ? parseMiddlewares(pubCustom).value : null;
    if (custom && Object.keys(custom).length > 0) options[CUSTOM_MIDDLEWARES] = custom;
    return {
      name: normalizePublicationName(pubName),
      mode: pubMode,
      target_url: pubTarget.trim(),
      access: pubAccess,
      template: pubTemplate,
      options,
    };
  }

  // What the server refuses about a publication is said at the field it is about.
  function refusal(err: unknown): Record<string, string> | null {
    if (!(err instanceof ApiError)) return null;
    optionsDetail = '';
    switch (err.code) {
      case 'proxy_target_not_allowed':
        return { pub_target: $t('error.proxy_target_not_allowed') };
      case 'proxy_target_invalid':
        return { pub_target: $t(targetProblem(pubTarget) ?? 'proxy.target.invalid') };
      case 'publication_name_invalid':
        return { pub_name: $t(publicationNameProblem(pubName) ?? 'proxy.name.invalid') };
      case 'publication_name_taken':
        return { pub_name: $t('error.publication_name_taken') };
      case 'publication_mode_not_allowed':
        return { pub_mode: $t('error.publication_mode_not_allowed') };
      case 'proxy_template_unknown':
        return { pub_template: $t('error.proxy_template_unknown') };
      case 'proxy_options_invalid':
        // The server's message names the setting; it goes under the sentence as it came.
        // With own middlewares in the request it is about those: the settings themselves
        // were checked here before they were sent.
        optionsDetail = err.message;
        optionsOpen = true;
        return sentCustom
          ? { pub_custom: $t('proxy.custom.refused') }
          : { pub_options: $t('proxy.options.refused') };
      case 'publication_type':
      case 'proxy_disabled':
        return { publication: errorMessage(err, $t) };
      case 'url_required':
        return { url: $t('error.url_required') };
      case 'validation': {
        // A value the server's schema refuses (a name of one character, say).
        const refused = refusedFields(err, {
          'publication.name': () => $t('proxy.name.invalid'),
          'publication.target_url': () => $t('proxy.target.invalid'),
          'publication.template': () => $t('error.proxy_template_unknown'),
        });
        const at: Record<string, string> = {
          'publication.name': 'pub_name',
          'publication.target_url': 'pub_target',
          'publication.template': 'pub_template',
        };
        const shown = Object.entries(refused).map(([field, text]) => [at[field], text]);
        return shown.length > 0 ? Object.fromEntries(shown) : null;
      }
      case 'forbidden':
        // Own middlewares from somebody who is no system administrator (any more).
        if (sentCustom) {
          optionsOpen = true;
          return { pub_custom: $t('proxy.custom.forbidden') };
        }
        return null;
      default:
        return null;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || (isPublished && nothingReleased)) return;
    errors = validate();
    failure = '';
    optionsDetail = '';
    // The field of the middlewares is among the settings: opened, so that it can be seen.
    if (errors.pub_custom) optionsOpen = true;
    if (Object.values(errors).some(Boolean)) return;
    if (isPublished && optionsInvalid) {
      // A setting that cannot be saved as it stands says so itself, where it stands: the
      // settings are opened and the focus goes there.
      optionsOpen = true;
      void focusFirstInvalid(formId);
      return;
    }
    const publication = publicationPayload();

    // The complete app as the form describes it. What does not belong to the chosen type
    // is empty (the API clears it anyway): the address of custom apps, the code of the
    // others, browser features unless embedded.
    const body: AppCreate = {
      name: name.trim(),
      description: description.trim(),
      type,
      // A published app has no address of its own: the server sets the public one.
      url: type === 'custom' || publication ? null : url.trim(),
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
    if (publication) body.publication = publication;

    sentCustom = !!publication?.options && CUSTOM_MIDDLEWARES in publication.options;
    saving = true;
    try {
      if (app) {
        const changes = appChanges(app, body);
        const stored = app.publication ?? null;
        if (publication) {
          // Sent as a whole, and only when something about it was changed here. Own
          // middlewares count for those who can change them.
          const kept = splitOptions(stored?.options);
          const untouched =
            stored !== null &&
            samePublication(
              { ...stored, options: kept.own },
              { ...publication, options: pubOptions },
            ) &&
            (!systemAdmin ||
              sameOption(publication.options?.[CUSTOM_MIDDLEWARES] ?? {}, kept.custom));
          if (!untouched) changes.publication = publication;
        } else if (stored) {
          // The publication ends; the address the app has from now on comes along.
          changes.publication = null;
          changes.url = body.url;
        }
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
      const refused = refusal(err);
      if (refused) {
        errors = refused;
        void focusRefusal(refused);
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
  title={app ? $t('apps.edit.title', { name: app.name }) : $t('apps.create.title')}
  width="760px"
  error={failure}
  {dirty}
  {onClose}
>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <FormField label={$t('field.name')} required bind:error={errors.name}>
      <Input bind:value={name} maxlength={80} required oninput={onNameInput} />
    </FormField>
    <FormField label={$t('field.description')} hint={$t('apps.description.hint')}>
      <Input bind:value={description} maxlength={500} />
    </FormField>

    <FormField label={$t('field.type')} hint={$t(`apps.type.${type}.text`)}>
      <Segmented bind:value={type} options={typeOptions} testid="app-type" />
    </FormField>

    {#if publishShown}
      <div class="option">
        <Switch
          bind:checked={published}
          label={$t('proxy.publish.label')}
          testid="app-publish-toggle"
          onChange={onPublishToggle}
        />
        <p class="help">{$t('proxy.publish.text')}</p>
        {#if errors.publication}
          <p class="problem" role="alert">{errors.publication}</p>
        {/if}
      </div>
    {/if}

    {#if isPublished}
      {#if proxy && !proxy.enabled}
        <Callout tone="warning" role="status" testid="app-publish-unavailable">
          {$t('proxy.publish.unavailable')}
        </Callout>
      {/if}
      {#if nothingReleased}
        <!-- Nothing to publish from: said in the place of the released addresses, and the
             dialog offers no save while it is so. -->
        <div data-testid="app-publish-targets">
          <Callout tone="warning" role="status" title={$t('proxy.target.none.title')}>
            {$t('proxy.target.none.text')}
          </Callout>
        </div>
      {:else}
        <FormField
          label={$t('proxy.target.label')}
          required
          hint={$t('proxy.target.hint')}
          bind:error={errors.pub_target}
        >
          <Input
            bind:value={pubTarget}
            mono
            maxlength={500}
            placeholder="http://10.20.0.7:8080"
            inputmode="url"
            autocapitalize="none"
            spellcheck={false}
            required
            testid="app-publish-target"
          />
        </FormField>
        <div class="released" data-testid="app-publish-targets">
          {#if targets.length > 0}
            <p class="help">{$t('proxy.target.released')}:</p>
            <ul class="released-list">
              {#each targets as value (value)}
                <li class="mono">{value}</li>
              {/each}
            </ul>
            <p class="help">{$t('proxy.target.releasedHint')}</p>
          {:else if proxyLoading}
            <Spinner size={16} />
          {:else if canPublish}
            <Callout tone="warning" role="status" title={$t('proxy.target.none.title')}>
              {$t('proxy.target.none.text')}
            </Callout>
          {/if}
        </div>

        <fieldset class="group">
          <legend>{$t('proxy.address.label')}</legend>
          <Segmented
            bind:value={pubMode}
            options={modeOptions}
            label={$t('proxy.address.label')}
            testid="app-publish-mode"
            onChange={() => (errors = { ...errors, pub_mode: '' })}
          />
          {#if pathRefused}
            <p class="problem" data-testid="app-publish-mode-refused">
              {$t('proxy.mode.pathOff')}
            </p>
          {:else}
            <p class="help">
              {#if !pathAllowed}{$t('proxy.mode.subdomainOnly')}{/if}
              {$t(`proxy.mode.${pubMode}.text`)}
            </p>
          {/if}
          {#if errors.pub_mode}<p class="problem" role="alert">{errors.pub_mode}</p>{/if}
          <FormField
            label={$t('proxy.name.label')}
            required
            hint={$t('proxy.name.hint')}
            bind:error={errors.pub_name}
          >
            <Input
              bind:value={pubName}
              mono
              maxlength={NAME_MAX_LENGTH}
              autocapitalize="none"
              spellcheck={false}
              required
              testid="app-publish-name"
              oninput={() => (pubNameTouched = true)}
            />
          </FormField>
          <p class="preview">
            <span class="preview-label">{$t('proxy.preview.label')}</span>
            <output class="mono" data-testid="app-publish-preview">
              {publicPreview || $t('proxy.preview.empty')}
            </output>
          </p>
        </fieldset>

        <fieldset class="group">
          <legend>{$t('proxy.access.label')}</legend>
          <Segmented
            bind:value={pubAccess}
            options={accessOptions}
            label={$t('proxy.access.label')}
            testid="app-publish-access"
          />
          {#if pubAccess === 'public'}
            <Callout
              tone="warning"
              role="status"
              title={$t('proxy.access.public.title')}
              testid="app-publish-public"
            >
              {$t('proxy.access.public.text')}
            </Callout>
          {:else}
            <p class="help">{$t('proxy.access.protected.text')}</p>
          {/if}
        </fieldset>

        <!-- No fieldset: the field's own label names the choice, and the settings under it
             have their own heading. -->
        <div class="group">
          <FormField
            label={$t('proxy.template.label')}
            hint={templateHint}
            bind:error={errors.pub_template}
          >
            <Select
              bind:value={pubTemplate}
              options={templateOptions}
              fullWidth
              testid="app-publish-template"
              onChange={onTemplateChange}
            />
          </FormField>
          {#if proxy && !template}
            <p class="problem">{$t('proxy.template.missingText')}</p>
          {/if}
          {#if !systemAdmin && storedCustomNames}
            <!-- Somebody who cannot change them is told that they are there, and which. -->
            <Callout tone="neutral" testid="app-publish-custom">
              {$t('proxy.custom.kept', { names: storedCustomNames })}
            </Callout>
          {/if}
          <details class="adjust" bind:open={optionsOpen} data-testid="app-publish-options">
            <summary>
              {$t('proxy.options.title')}
              {#if optionsChanged > 0}
                <span class="adjust-count">
                  {$t('proxy.options.changed', { count: optionsChanged })}
                </span>
              {/if}
            </summary>
            <div class="adjust-body">
              <p class="help">{$t('proxy.options.text')}</p>
              {#if errors.pub_options}
                <p class="problem" role="alert">
                  {errors.pub_options}
                  {#if optionsDetail}<span class="tech">{optionsDetail}</span>{/if}
                </p>
              {/if}
              <ProxyOptionsEditor
                bind:own={pubOptions}
                {baseline}
                context={pubContext}
                source="template"
                testidPrefix="app-publish-option-"
                bind:invalid={optionsInvalid}
              />
              {#if systemAdmin}
                <div class="own-middlewares">
                  <MiddlewaresField
                    bind:value={pubCustom}
                    bind:error={errors.pub_custom}
                    detail={optionsDetail}
                    hint={$t('proxy.custom.appHint')}
                    testid="app-publish-middlewares"
                  />
                </div>
              {/if}
            </div>
          </details>
        </div>
      {/if}
    {/if}

    {#if type !== 'custom' && !isPublished}
      {#if app?.publication}
        <p class="help" data-testid="app-publish-ended">{$t('proxy.publish.ended')}</p>
      {/if}
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
            <input type="file" accept={IMAGE_ACCEPT} onchange={onIconFile} />
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
    <!-- No save for a publication that has nothing to publish from (said in the form). -->
    <Button type="submit" form={formId} loading={saving} disabled={isPublished && nothingReleased}>
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
  .problem {
    color: var(--danger);
    font-size: var(--text-sm);
  }
  .released {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .released-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .released-list li {
    padding: 2px var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-inset);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
  }
  .preview-label {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .preview output {
    color: var(--text-strong);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .adjust summary {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
  }
  .adjust-count {
    margin-left: var(--space-2);
    color: var(--text-muted);
    font-weight: 400;
  }
  .adjust-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-4);
  }
  .own-middlewares {
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
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
