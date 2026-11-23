// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  IMAGE_ACCEPT,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  imageFileProblem,
  readImageFile,
} from './imageFile';

describe('an image picked from the device', () => {
  it('must be of a type the API takes', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
      expect(imageFileProblem({ type, size: 1000 }), type).toBeNull();
      expect(IMAGE_ACCEPT.split(','), type).toContain(type);
    }
    for (const type of ['image/bmp', 'image/tiff', 'application/pdf', 'text/html', '']) {
      expect(imageFileProblem({ type, size: 1000 }), type).toBe('invalid');
    }
    expect(IMAGE_TYPES).toHaveLength(5);
  });

  it('must not be empty or larger than 256 KB', () => {
    expect(IMAGE_MAX_BYTES).toBe(256 * 1024);
    expect(imageFileProblem({ type: 'image/png', size: IMAGE_MAX_BYTES })).toBeNull();
    expect(imageFileProblem({ type: 'image/png', size: IMAGE_MAX_BYTES + 1 })).toBe('too_large');
    expect(imageFileProblem({ type: 'image/png', size: 0 })).toBe('too_large');
    // The type is looked at first: a large file of the wrong kind is the wrong kind.
    expect(imageFileProblem({ type: 'application/zip', size: IMAGE_MAX_BYTES * 4 })).toBe(
      'invalid',
    );
  });

  it('is handed to the API as a data URL', async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
      type: 'image/svg+xml',
    });
    const url = await readImageFile(svg);
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(atob(url.split(',')[1])).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
});
