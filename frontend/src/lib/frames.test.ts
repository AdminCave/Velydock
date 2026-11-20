// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SANDBOX,
  EMBEDDED_SANDBOX,
  MAX_KEPT_FRAMES,
  frameAttributes,
  presentation,
  pruneFrames,
  touchFrame,
  type KeptFrame,
} from './frames';

function open(ids: string[], cap?: number): KeptFrame[] {
  let frames: KeptFrame[] = [];
  let tick = 0;
  for (const id of ids) frames = touchFrame(frames, id, ++tick, cap);
  return frames;
}

const ids = (frames: KeptFrame[]) => frames.map((f) => f.appId);

describe('kept-alive frames', () => {
  it('keeps at most five frames', () => {
    expect(MAX_KEPT_FRAMES).toBe(5);
    expect(open(['a', 'b', 'c', 'd', 'e'])).toHaveLength(5);
    expect(open(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(5);
  });

  it('drops the least recently used frame', () => {
    expect(ids(open(['a', 'b', 'c', 'd', 'e', 'f']))).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('counts re-opening an app as a use', () => {
    // "a" was opened first but used again last: "b" is now the oldest.
    expect(ids(open(['a', 'b', 'c', 'd', 'e', 'a', 'f']))).toEqual(['a', 'c', 'd', 'e', 'f']);
  });

  it('never reorders the frames that stay (moving an iframe reloads it)', () => {
    const before = open(['a', 'b', 'c']);
    const after = touchFrame(before, 'a', 99);
    expect(ids(after)).toEqual(['a', 'b', 'c']);
    expect(after.find((f) => f.appId === 'a')?.lastUsed).toBe(99);
    // The survivors of an eviction keep their relative order as well.
    expect(ids(open(['a', 'b', 'c', 'd', 'e', 'b', 'f', 'g']))).toEqual(['b', 'd', 'e', 'f', 'g']);
  });

  it('does not mount a frame twice', () => {
    expect(ids(open(['a', 'a', 'a']))).toEqual(['a']);
  });

  it('does not mutate its input', () => {
    const before = open(['a', 'b']);
    const copy = structuredClone(before);
    touchFrame(before, 'c', 10);
    touchFrame(before, 'a', 11);
    expect(before).toEqual(copy);
  });

  it('honours another cap and never drops below one frame', () => {
    expect(ids(open(['a', 'b', 'c'], 2))).toEqual(['b', 'c']);
    expect(ids(open(['a', 'b'], 0))).toEqual(['b']);
  });

  it('prunes frames of apps that are gone', () => {
    expect(ids(pruneFrames(open(['a', 'b', 'c']), new Set(['a', 'c', 'x'])))).toEqual(['a', 'c']);
  });
});

describe('frame attributes', () => {
  it('custom apps: exactly the sandbox flags of the security boundary', () => {
    const attrs = frameAttributes('custom');
    expect(attrs.sandbox).toBe(
      'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox',
    );
    expect(attrs.sandbox).toBe(CUSTOM_SANDBOX);
    expect(attrs.referrerpolicy).toBe('no-referrer');
  });

  it('custom apps never get allow-same-origin, top navigation or an allow list', () => {
    for (const permissions of [[], ['camera'], ['camera', 'microphone', 'fullscreen']]) {
      const attrs = frameAttributes('custom', permissions);
      expect(attrs.sandbox.split(' ')).not.toContain('allow-same-origin');
      expect(attrs.sandbox).not.toMatch(/allow-top-navigation/);
      expect(attrs.allow).toBeUndefined();
    }
  });

  it('embedded apps: the documented sandbox and referrer policy', () => {
    const attrs = frameAttributes('embedded');
    expect(attrs.sandbox).toBe(
      'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox ' +
        'allow-downloads allow-modals allow-top-navigation-by-user-activation',
    );
    expect(attrs.sandbox).toBe(EMBEDDED_SANDBOX);
    expect(attrs.referrerpolicy).toBe('strict-origin-when-cross-origin');
    expect(attrs.allow).toBeUndefined();
  });

  it('embedded apps: allow is built from the granted browser features', () => {
    expect(frameAttributes('embedded', ['camera', 'microphone']).allow).toBe('camera; microphone');
    expect(
      frameAttributes('embedded', [
        'camera',
        'microphone',
        'clipboard-read',
        'clipboard-write',
        'fullscreen',
        'display-capture',
      ]).allow,
    ).toBe('camera; microphone; clipboard-read; clipboard-write; fullscreen; display-capture');
  });

  it('embedded apps: unknown and duplicate features are dropped', () => {
    expect(frameAttributes('embedded', ['camera', 'camera', 'geolocation', '*']).allow).toBe(
      'camera',
    );
    expect(frameAttributes('embedded', ['payment']).allow).toBeUndefined();
  });
});

describe('presentation', () => {
  it('decides how an app is shown', () => {
    expect(presentation({ type: 'embedded', embed_status: 'ok' })).toBe('frame');
    expect(presentation({ type: 'embedded', embed_status: 'unknown' })).toBe('frame');
    expect(presentation({ type: 'embedded', embed_status: 'blocked' })).toBe('blocked');
    expect(presentation({ type: 'custom', embed_status: 'unknown' })).toBe('frame');
    expect(presentation({ type: 'external', embed_status: 'unknown' })).toBe('external');
    // A blocked check result of an earlier type must not hide a custom app.
    expect(presentation({ type: 'custom', embed_status: 'blocked' })).toBe('frame');
  });
});
