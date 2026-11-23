// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCENT_PALETTE,
  ACCENT_TOKENS,
  BODY_TEXT,
  SURFACES,
  accentTokens,
  isAccentColor,
  normalizeAccent,
  readableAccent,
  type Scheme,
} from './accent';

const SCHEMES: Scheme[] = ['light', 'dark'];
const colorsCss = readFileSync(
  path.resolve(import.meta.dirname, '../styles/tokens/colors.css'),
  'utf8',
);

// The contrast is computed here once more, from the formula of WCAG 2 and nothing of the
// module under test: what is checked is the colour that comes out, not how it was found.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
/** Hue of a colour in degrees (HSL), NaN for a grey. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta < 0.02) return NaN;
  const raw =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (raw * 60 + 360) % 360;
}
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** The tokens of a theme block of colors.css, with references to the ramps resolved. */
function themeTokens(scheme: Scheme): (name: string) => string {
  const [dark, light] = colorsCss.split(':root[data-theme="light"]');
  const read = (block: string, name: string): string => {
    const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1].trim() ?? '';
    const reference = /^var\(--([\w-]+)\)$/.exec(value);
    return reference ? read(dark, reference[1]) : value;
  };
  return (name) => read(scheme === 'dark' ? dark : light, name) || read(dark, name);
}

describe('the surfaces the accent is measured against', () => {
  it.each(SCHEMES)('are those of the %s theme in colors.css', (scheme) => {
    const token = themeTokens(scheme);
    for (const [name, value] of Object.entries(SURFACES[scheme])) {
      expect(token(name), `${scheme} --${name}`).toBe(value);
    }
    expect(token('text')).toBe(BODY_TEXT[scheme]);
  });

  it('cover every token of colors.css that is built from the blue ramp', () => {
    // Whatever names the blue ramp or its rgb() values in a theme block must be overridden,
    // or a part of the interface stays blue beside an orange accent.
    const blue = /var\(--blue-\d+\)|rgba\((79,157,255|37,99,235),/;
    const fromBlue = [...colorsCss.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
      .filter(([, name, value]) => !name.startsWith('--blue-') && blue.test(value))
      .map(([, name]) => name);
    expect([...new Set(fromBlue)].sort()).toEqual([...ACCENT_TOKENS].sort());
  });
});

describe('the accent that is shown', () => {
  // What an administrator may well take from a logo, and the extremes.
  const awkward = ['#facc15', '#ffffff', '#000000', '#808080', '#0a0a0a', '#ffff00', '#00ff00'];
  const sweep = Array.from({ length: 36 }, (_, i) => {
    // Every tenth hue at full saturation and three lightnesses (HSL → hex).
    const h = i * 10;
    return [0.2, 0.5, 0.85].map((l) => {
      const a = Math.min(l, 1 - l);
      const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
          .toString(16)
          .padStart(2, '0');
      };
      return `#${f(0)}${f(8)}${f(4)}`;
    });
  }).flat();

  it.each(SCHEMES)(
    'is readable as text on the page, on cards and on menus of the %s theme, whatever was chosen',
    (scheme) => {
      for (const chosen of [...awkward, ...ACCENT_PALETTE.map((entry) => entry.color), ...sweep]) {
        const tokens = accentTokens(chosen, scheme);
        for (const token of ['--accent', '--accent-hover', '--link', '--info'] as const) {
          expect(tokens[token], `${chosen} ${token}`).toMatch(/^#[0-9a-f]{6}$/);
          for (const [surface, background] of Object.entries(SURFACES[scheme])) {
            expect(
              contrast(tokens[token], background),
              `${scheme}: ${token} ${tokens[token]} (chosen ${chosen}) on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    },
  );

  it('is the chosen colour itself where that is readable', () => {
    expect(accentTokens('#c2410c', 'light')['--accent']).toBe('#c2410c');
    expect(accentTokens('#FACC15', 'dark')['--accent']).toBe('#facc15');
    for (const { color } of ACCENT_PALETTE) {
      // The swatches are chosen so that the light theme shows them as they are.
      expect(accentTokens(color, 'light')['--accent'], color).toBe(color);
    }
  });

  it('keeps the hue of the chosen colour when it has to become lighter or darker', () => {
    for (const chosen of ['#facc15', '#c2410c', '#0f766e', '#7c3aed', '#be185d', '#2563eb']) {
      for (const scheme of SCHEMES) {
        const shown = readableAccent(chosen, scheme);
        expect(
          hueDistance(hue(shown), hue(chosen)),
          `${chosen} → ${shown} (${scheme})`,
        ).toBeLessThan(12);
      }
    }
    // Yellow on white is the hard one: it comes out dark, and still a yellow, not a grey.
    const yellow = readableAccent('#facc15', 'light');
    expect(yellow).not.toBe('#facc15');
    expect(luminance(yellow)).toBeLessThan(luminance('#facc15'));
    expect(Number.isNaN(hue(yellow))).toBe(false);
  });

  it('gives up saturation, not hue, where the lighter or darker colour cannot be shown', () => {
    // The hue as the eye sees it (OKLab, computed here anew). Lightening a saturated blue
    // or darkening a yellow leaves what a screen can show; cutting the channels off there
    // would turn the colour towards another one.
    const okHue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => {
        const c = parseInt(hex.slice(at, at + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
      const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
    };
    for (const [chosen, scheme] of [
      ['#facc15', 'light'],
      ['#ffff00', 'light'],
      ['#0000ff', 'dark'],
      ['#2563eb', 'dark'],
      ['#1d4ed8', 'dark'],
    ] as const) {
      const tokens = accentTokens(chosen, scheme);
      for (const shown of [tokens['--accent'], tokens['--accent-hover']]) {
        expect(
          hueDistance(okHue(shown), okHue(chosen)),
          `${chosen} → ${shown} (${scheme})`,
        ).toBeLessThan(2);
      }
    }
  });

  it('moves no further than it has to', () => {
    // One step back towards the chosen colour would not be readable any more.
    for (const [chosen, scheme] of [
      ['#facc15', 'light'],
      ['#c2410c', 'dark'],
      ['#0f766e', 'dark'],
    ] as const) {
      const shown = readableAccent(chosen, scheme);
      const worst = Math.min(...Object.values(SURFACES[scheme]).map((s) => contrast(shown, s)));
      expect(worst, `${chosen} (${scheme}) → ${shown}`).toBeLessThan(4.65);
    }
  });

  it('turns a grey into a grey, and the extremes into something that can be read', () => {
    for (const scheme of SCHEMES) {
      for (const chosen of ['#ffffff', '#000000', '#808080']) {
        const shown = readableAccent(chosen, scheme);
        expect(new Set([shown.slice(1, 3), shown.slice(3, 5), shown.slice(5, 7)]).size).toBe(1);
      }
    }
    expect(readableAccent('#ffffff', 'dark')).toBe('#ffffff');
    expect(readableAccent('#000000', 'light')).toBe('#000000');
    expect(readableAccent('#ffffff', 'light')).not.toBe('#ffffff');
    expect(readableAccent('#000000', 'dark')).not.toBe('#000000');
  });

  it('has a hover tone that differs from it and lies further away from the background', () => {
    for (const { color } of ACCENT_PALETTE) {
      const light = accentTokens(color, 'light');
      const dark = accentTokens(color, 'dark');
      expect(luminance(light['--accent-hover'])).toBeLessThan(luminance(light['--accent']));
      expect(luminance(dark['--accent-hover'])).toBeGreaterThan(luminance(dark['--accent']));
    }
    // Nothing is further away than white on dark or black on light: a step back then.
    expect(accentTokens('#ffffff', 'dark')['--accent-hover']).not.toBe('#ffffff');
    expect(accentTokens('#000000', 'light')['--accent-hover']).not.toBe('#000000');
  });

  it('derives every accent token of the design, the tinted ones with the strength of the theme', () => {
    const dark = accentTokens('#c2410c', 'dark');
    const light = accentTokens('#c2410c', 'light');
    expect(Object.keys(dark).sort()).toEqual([...ACCENT_TOKENS].sort());
    expect(light).toEqual({
      '--accent': '#c2410c',
      '--accent-hover': light['--accent-hover'],
      '--accent-muted': 'rgba(194,65,12,0.1)',
      '--accent-border': 'rgba(194,65,12,0.26)',
      '--link': '#c2410c',
      '--info': '#c2410c',
      '--info-bg': 'rgba(194,65,12,0.1)',
      '--info-border': 'rgba(194,65,12,0.26)',
      '--ring': 'rgba(194,65,12,0.45)',
    });
    const rgb = [1, 3, 5].map((at) => parseInt(dark['--accent'].slice(at, at + 2), 16)).join(',');
    expect(dark['--accent-muted']).toBe(`rgba(${rgb},0.14)`);
    expect(dark['--accent-border']).toBe(`rgba(${rgb},0.32)`);
    expect(dark['--info-bg']).toBe(`rgba(${rgb},0.12)`);
    expect(dark['--info-border']).toBe(`rgba(${rgb},0.3)`);
    expect(dark['--ring']).toBe(`rgba(${rgb},0.55)`);
  });

  it('uses the strengths colors.css uses for the built-in blue', () => {
    for (const scheme of SCHEMES) {
      const token = themeTokens(scheme);
      const alpha = (value: string) => /,\s*([\d.]+)\)$/.exec(value)?.[1];
      const derived = accentTokens('#2563eb', scheme);
      for (const name of [
        '--accent-muted',
        '--accent-border',
        '--info-bg',
        '--info-border',
        '--ring',
      ] as const) {
        expect(Number(alpha(derived[name])), `${scheme} ${name}`).toBe(
          Number(alpha(token(name.slice(2)))),
        );
      }
    }
  });
});

describe('what counts as an accent colour', () => {
  it('is "#rrggbb" in either case, and nothing else', () => {
    for (const ok of ['#c2410c', '#C2410C', '#000000', '#ffffff']) {
      expect(isAccentColor(ok), ok).toBe(true);
    }
    for (const bad of ['', '#fff', 'c2410c', '#c2410', '#c2410cc', '#gggggg', 'red', null, 7]) {
      expect(isAccentColor(bad), String(bad)).toBe(false);
    }
  });

  it('is handled in lower case, as the API stores it', () => {
    expect(normalizeAccent(' #C2410C ')).toBe('#c2410c');
    expect(normalizeAccent('#c2410')).toBeNull();
    expect(normalizeAccent(null)).toBeNull();
  });

  it('offers about eight swatches with a name each, all of them valid and different', () => {
    expect(ACCENT_PALETTE.length).toBeGreaterThanOrEqual(7);
    expect(ACCENT_PALETTE.length).toBeLessThanOrEqual(9);
    expect(new Set(ACCENT_PALETTE.map((entry) => entry.color)).size).toBe(ACCENT_PALETTE.length);
    expect(new Set(ACCENT_PALETTE.map((entry) => entry.name)).size).toBe(ACCENT_PALETTE.length);
    for (const { color } of ACCENT_PALETTE) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
