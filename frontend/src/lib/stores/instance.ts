// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { writable } from 'svelte/store';

/**
 * The name of the installation as the login page learns it (GET /api/v1/public), for the
 * title of the browser tab before anybody is signed in. Afterwards `me.instance_name`
 * says it.
 */
export const instanceName = writable<string | null>(null);
