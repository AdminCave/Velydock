// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { tick } from 'svelte';
import { fieldErrors } from '$lib/api/errors';

/**
 * Bring something into view inside whatever scrolls it (a dialog's body), moving as little
 * as possible. Focusing a control scrolls to it as well, but how far is the browser's
 * choice: Safari stops as soon as the first line of a tall field shows at the edge, with
 * the message under it still out of sight.
 */
export function reveal(element: Element | null | undefined): void {
  // Not every environment has it (jsdom).
  element?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * After a failed validation: move the focus to the first control marked invalid and bring
 * its field into view, the control together with the message under it: what is marked
 * `data-field` around it (where more than the field belongs together), else its
 * `FormField`. Without this a message further up or down in a long dialog would go
 * unnoticed.
 */
export async function focusFirstInvalid(formId: string): Promise<void> {
  await tick();
  const control = document
    .getElementById(formId)
    ?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!control) return;
  control.focus();
  reveal(control.closest('[data-field]') ?? control.closest('.ui-field') ?? control);
}

/**
 * For an effect over a form's field errors: when messages were set (a failed validation,
 * an answer of the server), the first invalid control gets the focus. Not when one was
 * taken back because the user is editing that field: the focus must stay where they type.
 */
export function focusOnNewErrors(
  formId: string,
): (errors: Record<string, string | undefined>) => void {
  let shown = 0;
  return (errors) => {
    const count = Object.values(errors).filter(Boolean).length;
    if (count > 0 && count >= shown) void focusFirstInvalid(formId);
    shown = count;
  };
}

/**
 * Whether a form holds something else than it started with. Both lists name the same
 * fields in the same order. A list inside them is a selection (the chosen groups, the
 * members): it counts as changed when it holds other entries, not when the same entries
 * were picked in another order. Dialogs use this to tell whether closing them would
 * throw input away.
 */
export function formChanged(now: readonly unknown[], pristine: readonly unknown[]): boolean {
  if (now.length !== pristine.length) return true;
  return now.some((value, i) => {
    const before = pristine[i];
    if (Array.isArray(value) && Array.isArray(before)) return !sameSelection(value, before);
    return value !== before;
  });
}

function sameSelection(a: readonly unknown[], b: readonly unknown[]): boolean {
  const before = new Set(b);
  const now = new Set(a);
  return now.size === before.size && [...now].every((item) => before.has(item));
}

/**
 * The fields of a form that the server refused (422 `validation` with `details.fields`),
 * each with the form's own message for it. The server names the field; its message is
 * English and meant for developers. `messages` gives, per field the form has, the text
 * to show there. Fields the form does not have are left out: the caller reports the
 * failure as a whole if nothing remains.
 */
export function refusedFields(
  err: unknown,
  messages: Record<string, () => string>,
): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const field of Object.keys(fieldErrors(err))) {
    if (field in messages) shown[field] = messages[field]();
  }
  return shown;
}
