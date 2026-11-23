// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// An image the user picks from their device (the icon of an app, the logo of an
// organization). The API takes it as a `data:` URL; types and size are the API's
// (MAX_ICON_BYTES and decode_image() in backend/velydock/services/apps.py). Checked here
// first, so that the message comes at once and says what is wrong, not after an upload.

export const IMAGE_MAX_BYTES = 256 * 1024;
export const IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];
/** For the `accept` attribute of the file input: extensions and types. */
export const IMAGE_ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.svg,image/png,image/jpeg,image/gif,image/webp,image/svg+xml';

/** Why a file cannot be used as an image, or null if it can. */
export function imageFileProblem(file: {
  type: string;
  size: number;
}): 'invalid' | 'too_large' | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'invalid';
  if (file.size === 0 || file.size > IMAGE_MAX_BYTES) return 'too_large';
  return null;
}

/** The file as a `data:` URL. Rejects when the browser cannot read it. */
export function readImageFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The file could not be read.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}
