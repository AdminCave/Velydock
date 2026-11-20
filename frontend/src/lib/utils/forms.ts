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

/**
 * Whether a form holds something else than it started with. Both lists name the same
 * fields in the same order; arrays inside them are compared by content, order included.
 * Dialogs use this to tell whether closing them would throw input away.
 */
export function formChanged(now: readonly unknown[], pristine: readonly unknown[]): boolean {
  if (now.length !== pristine.length) return true;
  return now.some((value, i) => {
    const before = pristine[i];
    if (Array.isArray(value) && Array.isArray(before)) {
      return value.length !== before.length || value.some((item, j) => item !== before[j]);
    }
    return value !== before;
  });
}
