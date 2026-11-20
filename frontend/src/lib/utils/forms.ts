// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { tick } from 'svelte';

/**
 * After a failed validation: move the focus to the first control marked invalid, which
 * also scrolls it into view. Without this a message further up in a long dialog would go
 * unnoticed.
 */
export async function focusFirstInvalid(formId: string): Promise<void> {
  await tick();
  const control = document
    .getElementById(formId)
    ?.querySelector<HTMLElement>('[aria-invalid="true"]');
  control?.focus();
}
