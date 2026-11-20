// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

// The backend sends the Content-Security-Policy as a response header (script-src 'self',
// see backend/velydock/security/http.py), so nothing is injected here. What this build has
// to guarantee is that index.html carries no inline script: the theme bootstrap is the
// file public/theme-init.js, and Vite emits the bundle as external module files.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, './src/lib'),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, './dist'),
    emptyOutDir: true,
    // The server image serves the build publicly: no production sourcemaps.
    sourcemap: false,
    target: 'es2022',
    // Never inline assets as data: URLs; fonts and images stay hashed files under assets/.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      // Development backend: `python -m tests.support.devserver --public-url http://localhost:5173`
      '/api': 'http://localhost:8765',
    },
  },
});
