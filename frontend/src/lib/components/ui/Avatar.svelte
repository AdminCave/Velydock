<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts" module>
  /** Up to two initials of a name: "Anna Admin" → "AA", "root" → "R". */
  export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    const first = parts[0][0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
    return (first + last).toUpperCase();
  }
</script>

<script lang="ts">
  interface Props {
    name: string;
    size?: number;
  }

  let { name, size = 32 }: Props = $props();
</script>

<span
  class="avatar"
  aria-hidden="true"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.38)}px"
>
  {initials(name)}
</span>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: var(--surface-raised);
    color: var(--text-strong);
    font-weight: var(--fw-semibold);
    letter-spacing: 0.02em;
    line-height: 1;
    user-select: none;
  }
</style>
