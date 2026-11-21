// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { common } from './messages/common';
import { errors } from './messages/errors';
import { icons } from './messages/icons';
import { shell } from './messages/shell';
import { workspace } from './messages/workspace';
import { account } from './messages/account';
import { admin } from './messages/admin';
import { system } from './messages/system';

export type Language = 'de' | 'en';

/** One entry per key: [German, English]. Both languages live side by side so none drifts. */
export type Messages = Record<string, readonly [de: string, en: string]>;
export type Translations = Record<Language, Record<string, string>>;

const sources: Messages[] = [common, errors, shell, workspace, account, admin, system, icons];

function build(index: 0 | 1): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, pair] of Object.entries(source)) out[key] = pair[index];
  }
  return out;
}

/** Keys defined in more than one message file (a later file would silently win). */
export function duplicateKeys(): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const source of sources) {
    for (const key of Object.keys(source)) {
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
  }
  return dupes;
}

export const translations: Translations = { de: build(0), en: build(1) };
