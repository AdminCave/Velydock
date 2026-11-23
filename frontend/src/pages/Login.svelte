<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import LogIn from '@lucide/svelte/icons/log-in';
  import { api } from '$lib/api/client';
  import type { PublicInfo } from '$lib/api/types';
  import Mark from '$lib/components/brand/Mark.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Callout from '$lib/components/ui/Callout.svelte';
  import { hasMessage, hasStoredLanguage, isLanguage, language, setLanguage, t } from '$lib/i18n';
  import { location, navigate, safeReturnPath, signInUrl } from '$lib/router';
  import { instanceName } from '$lib/stores/instance';
  import { session } from '$lib/stores/session';
  import { isThemePreference, showPublicTheme } from '$lib/theme';
  import { leaveTo } from '$lib/utils/browser';

  const params = $derived(new URLSearchParams($location.search));
  const errorCode = $derived(params.get('error'));
  const signedOut = $derived(params.get('signed_out') === '1');
  // Set by the app when a session that was in use ended (a request was answered 401).
  const expired = $derived(params.get('expired') === '1');
  const returnTo = $derived(safeReturnPath(params.get('return_to')));

  let info = $state<PublicInfo | null>(null);
  let leaving = $state(false);

  // What the sign-in page may know before anyone is authenticated. A browser that was
  // used before keeps its own language and theme; a fresh one gets the instance defaults.
  onMount(() => {
    api
      .get('/api/v1/public')
      .then((value) => {
        info = value;
        // The browser tab is named after the installation as soon as its name is known.
        instanceName.set(value.instance_name);
        if (!hasStoredLanguage() && isLanguage(value.default_language)) {
          setLanguage(value.default_language, { persist: false });
        }
        // The theme of the installation, unless the user chose one for themselves. What
        // an organization had set for the last session does not count here.
        if (isThemePreference(value.default_theme)) showPublicTheme(value.default_theme);
      })
      .catch(() => {
        /* the page works without it; the name falls back to the product name */
      });
    // Back from the identity provider: a page restored from the back/forward cache still
    // has the button in its "leaving" state, and nobody could sign in with it.
    const onPageShow = () => (leaving = false);
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  });

  // Already signed in: there is nothing to do here.
  $effect(() => {
    if ($session.status === 'ready') navigate(returnTo, { replace: true });
  });

  const errorText = $derived.by(() => {
    if (!errorCode) return '';
    const key = `login.error.${errorCode}`;
    return hasMessage(key) ? $t(key) : $t('login.error.generic');
  });

  // Sign-in happens at the identity provider: a full page navigation, not a fetch.
  function signIn() {
    leaving = true;
    leaveTo(signInUrl(returnTo, $language));
  }
</script>

<main class="login">
  <div class="panel">
    <span class="mark"><Mark size={56} /></span>
    <h1 class="title">{info?.instance_name ?? 'Velydock'}</h1>
    <p class="lead">{$t('login.lead')}</p>

    {#if errorText}
      <Callout tone="danger" role="alert" testid="login-message">{errorText}</Callout>
    {:else if expired}
      <Callout tone="warning" role="status" testid="login-message">
        {$t('login.sessionExpired')}
      </Callout>
    {:else if signedOut}
      <Callout tone="success" role="status" testid="login-message">
        {$t('login.signedOut')}
      </Callout>
    {/if}

    <Button
      size="lg"
      fullWidth
      iconLeft={LogIn}
      loading={leaving}
      data-testid="login-button"
      onclick={signIn}
    >
      {$t('login.submit')}
    </Button>
    <p class="hint">{$t('login.hint')}</p>
  </div>
  <footer class="foot mono">
    Velydock{info?.version ? ` v${info.version}` : ''}
  </footer>
</main>

<style>
  .login {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-12);
    min-height: 100%;
    padding: var(--space-8) var(--space-4);
    overflow-y: auto;
  }
  .panel {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-5);
    width: 100%;
    max-width: 380px;
    text-align: center;
  }
  .mark {
    display: inline-flex;
    align-self: center;
    color: var(--text-strong);
  }
  .title {
    font-size: var(--text-3xl);
    font-weight: var(--fw-semibold);
    letter-spacing: var(--ls-tighter);
    line-height: var(--lh-tight);
    overflow-wrap: anywhere;
  }
  .lead {
    margin-bottom: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-lg);
  }
  .panel :global(.callout) {
    text-align: left;
  }
  .hint {
    color: var(--text-subtle);
    font-size: var(--text-sm);
  }
  .foot {
    color: var(--text-subtle);
    font-size: var(--text-xs);
  }
</style>
