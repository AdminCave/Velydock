<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  interface Props {
    size?: number;
    /** Accessible name; without it the mark is decorative. */
    title?: string;
  }

  let { size = 32, title }: Props = $props();
</script>

<!-- The Velydock mark: a rounded square with a dock bar and three app dots, the middle one
     lifted like an app that is being opened. The shapes are knocked out (fill-rule
     evenodd), so the page shows through and the mark works on either theme with
     currentColor. -->
<svg
  class="mark"
  width={size}
  height={size}
  viewBox="0 0 100 100"
  fill="currentColor"
  role={title ? 'img' : undefined}
  aria-label={title}
  aria-hidden={title ? undefined : 'true'}
>
  <path
    fill-rule="evenodd"
    clip-rule="evenodd"
    d="M28 0h44c15.464 0 28 12.536 28 28v44c0 15.464-12.536 28-28 28H28C12.536 100 0 87.464 0 72V28C0 12.536 12.536 0 28 0ZM27 66a6 6 0 0 0 0 12h46a6 6 0 0 0 0-12H27Zm-5-18a8 8 0 1 0 16 0a8 8 0 1 0-16 0Zm20-12a8 8 0 1 0 16 0a8 8 0 1 0-16 0Zm20 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0Z"
  />
</svg>

<style>
  .mark {
    display: block;
    flex: 0 0 auto;
  }
</style>
