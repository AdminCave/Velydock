// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The accent colour of an organization or a user. One colour ("#rrggbb") is chosen; the
// design needs a handful of tokens from it, and it needs them readable: the accent is the
// colour of links, tags and active states, which are text. Whatever is chosen (the yellow
// of a logo, white, black), the colour that is shown keeps its hue and its saturation as
// far as possible and gets as much lighter or darker as it takes to reach a contrast of
// 4.5:1 on every surface of the theme. Pure functions: no DOM, no stores.

export type Scheme = 'light' | 'dark';

/** The tokens of styles/tokens/colors.css that are built from the blue ramp. */
export const ACCENT_TOKENS = [
  '--accent',
  '--accent-hover',
  '--accent-muted',
  '--accent-border',
  '--link',
  '--info',
  '--info-bg',
  '--info-border',
  '--ring',
] as const;
export type AccentToken = (typeof ACCENT_TOKENS)[number];
export type AccentTokens = Record<AccentToken, string>;

/**
 * The surfaces text can stand on, per theme, as styles/tokens/colors.css defines them
 * (accent.test.ts keeps the two in step). `text` is the body text, for previews.
 */
export const SURFACES: Record<Scheme, Record<string, string>> = {
  dark: {
    bg: '#17181b',
    'bg-subtle': '#1b1c20',
    surface: '#1e2024',
    'surface-raised': '#26282d',
    'surface-inset': '#131417',
  },
  light: {
    bg: '#ffffff',
    'bg-subtle': '#f4f5f6',
    surface: '#ffffff',
    'surface-raised': '#ffffff',
    'surface-inset': '#f4f5f6',
  },
};
export const BODY_TEXT: Record<Scheme, string> = { dark: '#ededee', light: '#16181c' };

/** How strongly the tinted tokens show the accent: the alpha values of colors.css. */
const ALPHA: Record<
  Scheme,
  Record<'muted' | 'border' | 'infoBg' | 'infoBorder' | 'ring', number>
> = {
  dark: { muted: 0.14, border: 0.32, infoBg: 0.12, infoBorder: 0.3, ring: 0.55 },
  light: { muted: 0.1, border: 0.26, infoBg: 0.1, infoBorder: 0.26, ring: 0.45 },
};

/** WCAG AA for text. */
export const MIN_CONTRAST = 4.5;
/** How much lighter (dark theme) or darker (light theme) the hover tone is, in OKLCH lightness. */
const HOVER_STEP = 0.06;

/**
 * The colours offered as swatches. Mid tones that need little correction in either theme;
 * `name` is the key of the colour's name (`accent.color.<name>`).
 */
export const ACCENT_PALETTE: readonly { color: string; name: string }[] = [
  { color: '#2563eb', name: 'blue' },
  { color: '#0e7490', name: 'cyan' },
  { color: '#0f766e', name: 'teal' },
  { color: '#15803d', name: 'green' },
  { color: '#b45309', name: 'amber' },
  { color: '#c2410c', name: 'orange' },
  { color: '#be185d', name: 'pink' },
  { color: '#7c3aed', name: 'violet' },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function isAccentColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** A colour as the API stores it (lower case), or null for anything that is none. */
export function normalizeAccent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX.test(trimmed) ? trimmed.toLowerCase() : null;
}

// ── Colour arithmetic ────────────────────────────────────────────────

type Rgb = [number, number, number];

function channels(hex: string): Rgb {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as Rgb;
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Relative luminance of a colour (WCAG 2). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio of two colours (WCAG 2), 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** The lowest contrast of a colour, as text, on the surfaces of a theme. */
export function contrastOnSurfaces(hex: string, scheme: Scheme): number {
  return Math.min(...Object.values(SURFACES[scheme]).map((surface) => contrastRatio(hex, surface)));
}

// OKLCH (Björn Ottosson's OKLab in polar form): lightness can be changed in it without the
// hue drifting, which HSL does not manage for blues and yellows.
interface Oklch {
  l: number;
  c: number;
  h: number;
}

function toOklch(hex: string): Oklch {
  const [r, g, b] = channels(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: lightness, c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

function linearRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);

function hexOf(linear: Rgb): string {
  return `#${linear
    .map((c) =>
      Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The colour of that lightness and hue with as much of the chroma as sRGB can show. */
function fromOklch(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  // A grey stays a grey: without this the three channels can come out one step apart.
  if (color.c < 1e-4) return hexOf([l ** 3, l ** 3, l ** 3]);
  let rgb = linearRgb({ ...color, l });
  if (!inGamut(rgb)) {
    let low = 0;
    let high = color.c;
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      if (inGamut(linearRgb({ l, c: mid, h: color.h }))) low = mid;
      else high = mid;
    }
    rgb = linearRgb({ l, c: low, h: color.h });
  }
  return hexOf(rgb);
}

/**
 * The chosen colour as it can be used for text in a theme: itself if it is readable on
 * every surface, else the nearest lighter (dark theme) or darker (light theme) colour of
 * the same hue that is.
 */
export function readableAccent(color: string, scheme: Scheme): string {
  const chosen = color.toLowerCase();
  const passes = (hex: string) => contrastOnSurfaces(hex, scheme) >= MIN_CONTRAST;
  if (passes(chosen)) return chosen;
  const from = toOklch(chosen);
  // Towards white on dark surfaces, towards black on light ones: that end always passes.
  let failing = from.l;
  let passing = scheme === 'dark' ? 1 : 0;
  for (let i = 0; i < 24; i++) {
    const mid = (failing + passing) / 2;
    if (passes(fromOklch({ ...from, l: mid }))) passing = mid;
    else failing = mid;
  }
  return fromOklch({ ...from, l: passing });
}

/** The tone for a link under the pointer: a step further away from the background. */
function hoverAccent(accent: string, scheme: Scheme): string {
  const from = toOklch(accent);
  const away = scheme === 'dark' ? HOVER_STEP : -HOVER_STEP;
  const further = fromOklch({ ...from, l: from.l + away });
  if (further !== accent) return further;
  // White on dark, black on light: there is nothing further away. A step back, if that
  // is still readable; otherwise the tone stays.
  const back = fromOklch({ ...from, l: from.l - away });
  return contrastOnSurfaces(back, scheme) >= MIN_CONTRAST ? back : accent;
}

function tint(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex).map((c) => Math.round(c * 255));
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Every accent token of the design for one chosen colour in one theme. */
export function accentTokens(color: string, scheme: Scheme): AccentTokens {
  const accent = readableAccent(color, scheme);
  const alpha = ALPHA[scheme];
  return {
    '--accent': accent,
    '--accent-hover': hoverAccent(accent, scheme),
    '--accent-muted': tint(accent, alpha.muted),
    '--accent-border': tint(accent, alpha.border),
    '--link': accent,
    '--info': accent,
    '--info-bg': tint(accent, alpha.infoBg),
    '--info-border': tint(accent, alpha.infoBorder),
    '--ring': tint(accent, alpha.ring),
  };
}
