// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { writable } from 'svelte/store';
import { ApiError, TENANT_CHANGED } from '$lib/api/client';
import { errorMessage } from '$lib/api/errors';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
}

const _toasts = writable<ToastMessage[]>([]);
let nextId = 1;

export const toasts = { subscribe: _toasts.subscribe };

export function showToast(message: string, kind: ToastKind = 'success', durationMs?: number): void {
  const id = nextId++;
  // Errors stay longer: they usually need to be read twice.
  const duration = durationMs ?? (kind === 'error' ? 8000 : 4000);
  _toasts.update((list) => [...list, { id, kind, message }]);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
}

/** Error toast with the translated text for the API's error code. */
export function showError(err: unknown): void {
  // A cancelled request is not an error worth reporting.
  if (err instanceof DOMException && err.name === 'AbortError') return;
  // A 401 ends the session; the login page that follows says so (see stores/session.ts).
  if (err instanceof ApiError && err.status === 401) return;
  // A request that was refused, or not even sent, because the page shows another
  // organization than the session. The session store says that, once and in one wording:
  // which organization is active now, and that the request was not carried out (see
  // stores/session.ts). A page of an organization that is gone has nobody to tell anyway.
  if (err instanceof ApiError && err.code === TENANT_CHANGED) return;
  showToast(errorMessage(err), 'error');
}

export function dismissToast(id: number): void {
  _toasts.update((list) => list.filter((toast) => toast.id !== id));
}

export function clearToasts(): void {
  _toasts.set([]);
}
