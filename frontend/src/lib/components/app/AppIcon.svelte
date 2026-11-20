<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import { appIcon } from '$lib/appIcons';

  interface Props {
    /** Kebab-case Lucide name chosen by the administrator. */
    name?: string | null;
    /** Address of an uploaded icon; takes precedence over the name. */
    url?: string | null;
    size?: number;
  }

  let { name, url, size = 20 }: Props = $props();

  // An uploaded image that fails to load (deleted, wrong type) falls back to the glyph.
  let broken = $state(false);
  $effect(() => {
    void url;
    broken = false;
  });

  const Glyph = $derived(appIcon(name));
</script>

{#if url && !broken}
  <img
    class="app-icon"
    src={url}
    alt=""
    width={size}
    height={size}
    loading="lazy"
    decoding="async"
    onerror={() => (broken = true)}
  />
{:else}
  <span class="app-icon glyph" aria-hidden="true"><Glyph {size} /></span>
{/if}

<style>
  .app-icon {
    display: inline-flex;
    flex: 0 0 auto;
  }
  img.app-icon {
    object-fit: contain;
    border-radius: 4px;
  }
</style>
