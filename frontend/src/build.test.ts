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

  // The one deliberate deviation from the design system's tokens: its tertiary text tone
  // (#6e757c dark, #868d94 light) is below 4.5:1 on the surfaces it is used on.
  it('keeps secondary and tertiary text at 4.5:1 or more on every surface, in both themes', () => {
    const [dark, light] = colors.split(':root[data-theme="light"]');
    const read = (block: string, name: string): string => {
      const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1].trim() ?? '';
      const reference = /^var\(--([\w-]+)\)$/.exec(value);
      return reference ? read(dark, reference[1]) : value;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => {
        const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };
    for (const [theme, block] of [
      ['dark', dark],
      ['light', light],
    ]) {
      for (const text of ['text-muted', 'text-subtle']) {
        for (const surface of ['bg', 'bg-subtle', 'surface', 'surface-raised', 'surface-inset']) {
          const [fg, bg] = [read(block, text), read(block, surface)];
          expect(fg, `${theme} ${text}`).toMatch(/^#[0-9a-f]{6}$/);
          expect(bg, `${theme} ${surface}`).toMatch(/^#[0-9a-f]{6}$/);
          expect(
            contrast(fg, bg),
            `${theme}: ${text} ${fg} on ${surface} ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  // Layout is the browser's business and jsdom does none. These rules are what keeps a
  // value without a blank in it (a name, an address, a short name of full length) from
  // breaking a layout; they were measured in a browser, and this pins them.
  describe('long values without a blank', () => {
    /** The declarations of every rule that ends in this selector. */
    const rule = (css: string, selector: string): string => {
      const found: string[] = [];
      for (
        let at = css.indexOf(`${selector} {`);
        at >= 0;
        at = css.indexOf(`${selector} {`, at + 1)
      ) {
        found.push(css.slice(at, css.indexOf('}', at)));
      }
      expect(found.length, `rule for ${selector}`).toBeGreaterThan(0);
      return found.join('\n');
    };

    it('wrap inside a table cell of limited width', () => {
      const cell = rule(globalCss, '.data-table td');
      expect(cell).toMatch(/max-width:\s*\d+ch/);
      expect(cell).toMatch(/overflow-wrap:\s*break-word/);
      // Identifiers are no longer kept on one line; only counts and dates are.
      expect(rule(globalCss, '.data-table .num,\n.data-table .meta')).not.toContain('nowrap');
      expect(rule(globalCss, '.data-table td.meta')).toMatch(/max-width:\s*\d+ch/);
      expect(rule(globalCss, '.data-table td.num')).toMatch(/white-space:\s*nowrap/);
    });

    it('never push the actions of a row out of sight', () => {
      const actions = rule(globalCss, '.data-table .actions');
      expect(actions).toMatch(/position:\s*sticky/);
      expect(actions).toMatch(/right:\s*0/);
      expect(actions).toMatch(/background:\s*var\(--surface\)/); // solid: cells pass under it
      // The menu of a row opens inside that cell and must lie above later rows and the dock.
      expect(rule(globalCss, ".data-table td.actions:has([aria-expanded='true'])")).toMatch(
        /z-index:\s*41/,
      );
    });

    it('wrap in headings, dialogs and toasts', () => {
      expect(
        rule(globalCss, '.page-title,\n.page-subtitle,\n.section-title,\n.section-desc'),
      ).toMatch(/overflow-wrap:\s*anywhere/);
      const modal = read('src/lib/components/ui/Modal.svelte');
      expect(rule(modal, '.modal-title')).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule(modal, '.modal-title')).toMatch(/min-width:\s*0/);
      expect(rule(modal, '.modal-body')).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule(read('src/lib/components/ui/Toast.svelte'), '.msg')).toMatch(
        /overflow-wrap:\s*anywhere/,
      );
    });

    it('are cut with an ellipsis in a tag and in the caption of the navigation', () => {
      const tag = read('src/lib/components/ui/Tag.svelte');
      expect(rule(tag, '.ui-tag')).toMatch(/max-width:\s*100%/);
      expect(rule(tag, '.text,\n  .main')).toMatch(/text-overflow:\s*ellipsis/);
      const caption = rule(read('src/lib/components/layout/SubNav.svelte'), '.caption');
      expect(caption).toMatch(/text-overflow:\s*ellipsis/);
      expect(caption).toMatch(/min-width:\s*100%/);
    });
  });

  it('keeps room for the toasts at the bottom of the page instead of letting them cover it', () => {
    expect(read('src/lib/components/layout/Shell.svelte')).toMatch(
      /\.scroll \{[^}]*margin-bottom:\s*var\(--toast-lane, 0px\)/,
    );
  });

  // Layout again, measured in a browser and pinned here.
  it('puts the app bar below the app by layout, and never distorts the logo of an organization', () => {
    const stage = read('src/lib/components/app/AppStage.svelte');
    expect(stage).toMatch(/\.bar\[data-position='bottom'\] \{[^}]*order:\s*1/);
    for (const file of [
      'src/lib/components/layout/Dock.svelte',
      'src/pages/admin/TenantSettings.svelte',
    ]) {
      const logo = /\n {2}\.logo \{([^}]*)\}/.exec(read(file))?.[1] ?? '';
      expect(logo, file).toMatch(/height:\s*30px/);
      expect(logo, file).toMatch(/width:\s*auto/);
      expect(logo, file).toMatch(/max-width:\s*56px/);
      expect(logo, file).toMatch(/object-fit:\s*contain/);
    }
  });

  it('uses the accent as an accent: no component fills a surface with it but the unused accent button', () => {
    const fills: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(file);
        else if (
          /\.(svelte|css)$/.test(entry.name) &&
          /background(-color)?:\s*var\(--accent(-hover)?\)/.test(read(file))
        ) {
          fills.push(file);
        }
      }
    };
    walk('src');
    expect(fills).toEqual(['src/lib/components/ui/Button.svelte']);
    // And nothing uses that variant.
    const uses: string[] = [];
    const find = (dir: string) => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`;
        if (entry.isDirectory()) find(file);
        else if (entry.name.endsWith('.svelte') && /variant="accent"/.test(read(file)))
          uses.push(file);
      }
    };
    find('src');
    expect(uses).toEqual([]);
  });

  it('draws the product mark with currentColor', () => {
    expect(mark).toContain('fill="currentColor"');
    expect(mark).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(favicon).toContain('<svg');
  });
});
