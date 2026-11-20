// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { api } from '$lib/api/client';
import type { WorkspaceApp } from '$lib/api/types';
import { pruneFrames, presentation, touchFrame, type KeptFrame } from '$lib/frames';

// The apps the signed-in user sees in the active organization, and the frames kept alive.

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WorkspaceState {
  status: LoadStatus;
  apps: WorkspaceApp[];
}

const _workspace = writable<WorkspaceState>({ status: 'idle', apps: [] });
const _frames = writable<KeptFrame[]>([]);

export const workspace = { subscribe: _workspace.subscribe };
export const frames = { subscribe: _frames.subscribe };

// A load that was started for another organization must not overwrite the current one.
let generation = 0;
let tick = 0;

function framedIds(apps: readonly WorkspaceApp[]): Set<string> {
  return new Set(apps.filter((app) => presentation(app) === 'frame').map((app) => app.id));
}

export async function loadApps(): Promise<void> {
  const mine = ++generation;
  _workspace.update((state) => ({
    ...state,
    status: state.status === 'ready' ? 'ready' : 'loading',
  }));
  try {
    const apps = await api.get('/api/v1/workspace/apps');
    if (mine !== generation) return;
    _workspace.set({ status: 'ready', apps });
    // Apps that were removed, hidden or switched to another type lose their frame.
    _frames.update((list) => pruneFrames(list, framedIds(apps)));
  } catch (err) {
    if (mine !== generation) return;
    // A failed refresh keeps what is on screen; only a failed first load is an error state.
    _workspace.update((state) => ({
      status: state.status === 'ready' ? 'ready' : 'error',
      apps: state.apps,
    }));
    throw err;
  }
}

/** Forget everything of the previous organization, including its open frames. */
export function resetWorkspace(status: LoadStatus = 'idle'): void {
  generation++;
  _workspace.set({ status, apps: [] });
  _frames.set([]);
}

/** Mark an app's frame as the one in use (mounting it if needed, dropping the oldest). */
export function activateFrame(appId: string): void {
  const app = get(_workspace).apps.find((a) => a.id === appId);
  if (!app || presentation(app) !== 'frame') return;
  _frames.update((list) => touchFrame(list, appId, ++tick));
}
