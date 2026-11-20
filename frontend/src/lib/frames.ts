// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { FRAME_PERMISSIONS, type WorkspaceApp } from '$lib/api/types';

// ── Kept-alive frames ────────────────────────────────────────────────
// Frames of apps the user has opened stay mounted (hidden) when switching, so their state
// survives. At most MAX_KEPT_FRAMES are kept; the least recently used one is dropped.
//
// The list keeps its insertion order on purpose: moving an <iframe> in the DOM reloads it,
// so recency is tracked in `lastUsed` and never by reordering.

export const MAX_KEPT_FRAMES = 5;

export interface KeptFrame {
  appId: string;
  /** Monotonic counter value of the last activation; higher is more recent. */
  lastUsed: number;
}

export function touchFrame(
  frames: readonly KeptFrame[],
  appId: string,
  tick: number,
  cap: number = MAX_KEPT_FRAMES,
): KeptFrame[] {
  const next = frames.some((f) => f.appId === appId)
    ? frames.map((f) => (f.appId === appId ? { ...f, lastUsed: tick } : f))
    : [...frames, { appId, lastUsed: tick }];
  while (next.length > Math.max(1, cap)) {
    let oldest = 0;
    for (let i = 1; i < next.length; i++) {
      if (next[i].lastUsed < next[oldest].lastUsed) oldest = i;
    }
    next.splice(oldest, 1);
  }
  return next;
}

/** Drop frames of apps that no longer exist or may no longer be framed. */
export function pruneFrames(
  frames: readonly KeptFrame[],
  framedAppIds: ReadonlySet<string>,
): KeptFrame[] {
  return frames.filter((f) => framedAppIds.has(f.appId));
}

// ── Frame attributes ─────────────────────────────────────────────────

export type FramedAppType = 'embedded' | 'custom';

/** Embedded apps are third-party sites with their own origin and sign-in. */
export const EMBEDDED_SANDBOX =
  'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox ' +
  'allow-downloads allow-modals allow-top-navigation-by-user-activation';

/**
 * Custom apps are code written by an administrator. The frame must never get
 * allow-same-origin: without it the browser runs the code in an opaque origin, with no
 * cookies, no storage and no way to reach Velydock. This is the security boundary.
 * Mirrors SANDBOX_FLAGS in backend/velydock/services/custom_apps.py.
 */
export const CUSTOM_SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox';

export interface FrameAttributes {
  sandbox: string;
  /** Permissions Policy for the frame; undefined means the attribute is not rendered. */
  allow: string | undefined;
  referrerpolicy: 'strict-origin-when-cross-origin' | 'no-referrer';
}

export function frameAttributes(
  type: FramedAppType,
  framePermissions: readonly string[] = [],
): FrameAttributes {
  if (type === 'custom') {
    return { sandbox: CUSTOM_SANDBOX, allow: undefined, referrerpolicy: 'no-referrer' };
  }
  const known = new Set<string>(FRAME_PERMISSIONS);
  const granted = [...new Set(framePermissions)].filter((p) => known.has(p));
  return {
    sandbox: EMBEDDED_SANDBOX,
    allow: granted.length > 0 ? granted.join('; ') : undefined,
    referrerpolicy: 'strict-origin-when-cross-origin',
  };
}

/** How an app is shown in the app view. */
export type AppPresentation = 'frame' | 'blocked' | 'external';

export function presentation(app: Pick<WorkspaceApp, 'type' | 'embed_status'>): AppPresentation {
  if (app.type === 'external') return 'external';
  if (app.type === 'embedded' && app.embed_status === 'blocked') return 'blocked';
  return 'frame';
}

/** Open an address in a new tab without handing the new page a reference to this one. */
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
