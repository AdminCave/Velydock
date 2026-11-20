// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import favicon from '../public/favicon.svg?raw';
import mark from './lib/components/brand/Mark.svelte?raw';

// Style sheets are read from disk: the test runner does not hand out CSS as text.
const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const globalCss = read('src/styles/global.css');
const colors = read('src/styles/tokens/colors.css');
const tokenFiles = readdirSync(path.join(root, 'src/styles/tokens'));

// The backend serves the app with `script-src 'self'`: an inline script would simply not
// run. These checks look at the sources the build is made from.
describe('index.html', () => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');

  it('contains no inline script and no inline event handler', () => {
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.getAttribute('src'), script.outerHTML).toBeTruthy();
      expect(script.textContent?.trim()).toBe('');
    }
    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('applies the theme with a blocking external script before the app loads', () => {
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts[0].getAttribute('src')).toBe('/theme-init.js');
    for (const attr of ['type', 'defer', 'async']) {
      expect(scripts[0].hasAttribute(attr), attr).toBe(false);
    }
    expect(scripts[0].closest('head')).not.toBeNull();
  });

  it('loads nothing from other hosts', () => {
    expect(indexHtml).not.toMatch(/https?:\/\//);
    expect(globalCss).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
    expect(globalCss).not.toContain('fonts.googleapis.com');
  });

  it('starts in German with the product favicon', () => {
    expect(doc.documentElement.lang).toBe('de');
    expect(doc.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/favicon.svg');
    expect(doc.title).toBe('Velydock');
  });
});

describe('design system', () => {
  it('uses the tokens of the AdminCave design system', () => {
    expect(colors).toMatch(/--bg:\s*#17181b/); // soft black, dark by default
    expect(colors).toContain(':root[data-theme="light"]');
    for (const file of ['colors', 'typography', 'spacing', 'radius', 'elevation', 'base']) {
      expect(tokenFiles).toContain(`${file}.css`);
      expect(globalCss).toContain(`./tokens/${file}.css`);
    }
    // The design system's fonts.css loads Geist from a CDN; the fonts are bundled instead.
    expect(tokenFiles).not.toContain('fonts.css');
  });

  it('uses no gradients', () => {
    const components = import.meta.glob('/src/**/*.svelte', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const sheets = Object.fromEntries(
      ['global.css', ...tokenFiles.map((f) => `tokens/${f}`)].map((f) => [
        f,
        read(`src/styles/${f}`),
      ]),
    );
    expect(Object.keys(components).length).toBeGreaterThan(40);
    for (const [file, text] of Object.entries({ ...components, ...sheets })) {
      expect(text, file).not.toMatch(/gradient\(/);
    }
  });

  it('draws the product mark with currentColor', () => {
    expect(mark).toContain('fill="currentColor"');
    expect(mark).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(favicon).toContain('<svg');
  });
});
