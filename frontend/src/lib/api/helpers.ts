// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { api } from './client';
import type { User } from './types';

const PAGE_SIZE = 200; // the API's maximum

/**
 * All users of the active organization, for the member pickers. The API has no unpaged
 * list, so the pages are read one after the other.
 */
export async function fetchAllUsers(signal?: AbortSignal): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; ; page++) {
    const result = await api.get('/api/v1/admin/users', {
      query: { page, page_size: PAGE_SIZE },
      signal,
    });
    users.push(...result.items);
    if (result.items.length === 0 || users.length >= result.total) break;
  }
  return users;
}
