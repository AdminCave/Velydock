// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**', 'src/lib/api/schema.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    rules: {
      // error, not warn: a warning nobody reads is no gate. The _ prefix only excuses
      // unused arguments, not variables.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-undef': 'off',
      'svelte/valid-compile': 'warn',
      'svelte/no-at-html-tags': 'error',
      // Navigation goes through the History API router in src/lib/router.ts, which
      // intercepts plain same-origin links; there is no SvelteKit resolve() here.
      'svelte/no-navigation-without-resolve': 'off',
    },
  },
  {
    // Pages of the active organization (routes with `tenantScoped`), their dialogs and
    // the app frames. They are destroyed when the organization changes, but what they
    // started lives on; their requests therefore go through tenantApi(), which binds them
    // to the organization they were opened for. The plain `api` names whatever
    // organization is on screen when a request is sent.
    files: [
      'src/pages/admin/**/*.svelte',
      'src/modals/AppModal.svelte',
      'src/modals/GroupModal.svelte',
      'src/modals/UserCreateModal.svelte',
      'src/modals/UserEditModal.svelte',
      'src/lib/components/app/AppFrame.svelte',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '$lib/api/client',
              importNames: ['api', 'request'],
              message: 'A page of the active organization sends its requests through tenantApi().',
            },
          ],
        },
      ],
    },
  },
];
