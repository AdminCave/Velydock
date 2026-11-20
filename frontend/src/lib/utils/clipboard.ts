// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { tNow } from '$lib/i18n';
import { showToast } from '$lib/stores/toasts';

function legacyCopy(text: string): boolean {
  // Fallback for pages served without a secure context, where navigator.clipboard is missing.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function write(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* refused (permissions, lost focus): try the fallback */
  }
  return legacyCopy(text);
}

/** Copy text and say how it went. Never throws; true if the text was copied. */
export async function copyToClipboard(text: string, okKey = 'toast.copied'): Promise<boolean> {
  const ok = await write(text);
  showToast(tNow(ok ? okKey : 'toast.copyFailed'), ok ? 'success' : 'error');
  return ok;
}
