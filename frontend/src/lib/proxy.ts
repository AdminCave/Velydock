// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { components } from '$lib/api/schema';

// Publishing apps through the bundled reverse proxy: what the forms need to know about
// names, addresses and options. The rules are the API's (backend/velydock/services/proxy.py);
// they are mirrored here so that a form can say at once, at the right field, what is wrong.
// The server stays the authority: what it refuses is shown where it belongs as well.
// Pure functions: no DOM, no stores.

type S = components['schemas'];
export type ProxyInfo = S['ProxyInfo'];
export type ProxyTemplate = S['ProxyTemplateOut'];
export type ProxyTarget = S['ProxyTargetOut'];
export type Publication = S['PublicationOut'];
export type PublicationIn = S['PublicationIn'];
export type PublicationMode = S['PublicationMode'];
export type PublicationAccess = S['PublicationAccess'];
export type ProxyOptions = Record<string, unknown>;

export const BUILTIN_PREFIX = 'builtin:';
export const DEFAULT_TEMPLATE = 'builtin:standard';

// ── Options ──────────────────────────────────────────────────────────

/** The options a form offers, in the order of the documentation's table. */
export const OPTION_KEYS = [
  'strip_prefix',
  'allow_embedding',
  'verify_upstream_tls',
  'identity_headers',
  'pass_host_header',
  'rate_limit',
  'request_headers',
  'response_headers',
] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

/**
 * What a publication does unless its template or the publication itself says otherwise
 * (DEFAULTS of the API, which also sends them with GET /admin/proxy; these are used where
 * that answer is not at hand).
 */
export const PROXY_DEFAULTS: Readonly<Record<OptionKey, unknown>> = {
  strip_prefix: true,
  allow_embedding: false,
  verify_upstream_tls: true,
  identity_headers: false,
  pass_host_header: true,
  rate_limit: null,
  request_headers: {},
  response_headers: {},
};

/** Only a system administrator may set these, and the interface offers them in templates only. */
export const CUSTOM_MIDDLEWARES = 'custom_middlewares';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value ?? null;
}

/** Whether two values of an option are the same setting (objects by content, not identity). */
export function sameOption(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * What applies before a form's own settings: the defaults, then what the template sets.
 * Without a template (a form for a template itself) that is the defaults.
 */
export function optionBaseline(
  defaults: ProxyOptions | null | undefined,
  template?: Pick<ProxyTemplate, 'options'> | null,
): Record<OptionKey, unknown> {
  const merged: ProxyOptions = {
    ...PROXY_DEFAULTS,
    ...(defaults ?? {}),
    ...(template?.options ?? {}),
  };
  return Object.fromEntries(OPTION_KEYS.map((key) => [key, merged[key]])) as Record<
    OptionKey,
    unknown
  >;
}

/**
 * Set one option in what a form deviates in. Only a deviation is kept: a value that is
 * what the baseline gives anyway is taken out again, so that only what was really set
 * differently is sent and stored.
 */
export function withOption(
  own: ProxyOptions,
  baseline: Record<string, unknown>,
  key: OptionKey,
  value: unknown,
): ProxyOptions {
  const next = { ...own };
  if (sameOption(value, baseline[key])) delete next[key];
  else next[key] = value;
  return next;
}

/** Drop what no longer deviates, for instance after another template was chosen. */
export function pruneOptions(own: ProxyOptions, baseline: Record<string, unknown>): ProxyOptions {
  return Object.fromEntries(
    Object.entries(own).filter(
      ([key, value]) => !(key in baseline) || !sameOption(value, baseline[key]),
    ),
  );
}

/** The value of an option as it applies: what the form set, else what the baseline gives. */
export function optionValue(
  own: ProxyOptions,
  baseline: Record<string, unknown>,
  key: OptionKey,
): unknown {
  return key in own ? own[key] : baseline[key];
}

export interface OptionContext {
  mode: PublicationMode;
  /** The internal address as it stands in the form. */
  target: string;
  access: PublicationAccess;
}

/**
 * Whether an option has any effect for a publication: removing the name from the path
 * only by path, the certificate check only for https:// targets, sign-in by header only
 * when protected. Without a context (a template) every option applies.
 */
export function optionApplies(key: OptionKey, context?: OptionContext | null): boolean {
  if (!context) return true;
  if (key === 'strip_prefix') return context.mode === 'path';
  if (key === 'verify_upstream_tls') return /^https:\/\//i.test(context.target.trim());
  if (key === 'identity_headers') return context.access === 'protected';
  return true;
}

/** What a publication sends as its options: the deviations that apply, and nothing else. */
export function optionsToSend(own: ProxyOptions, context: OptionContext): ProxyOptions {
  // optionApplies() has a rule for three options and lets everything else pass, also what
  // the form does not know (own middlewares a system administrator set).
  return Object.fromEntries(
    Object.entries(own).filter(([key]) => optionApplies(key as OptionKey, context)),
  );
}

// ── Rate limit ───────────────────────────────────────────────────────

export interface RateLimit {
  average: number;
  burst: number;
}

export function isRateLimit(value: unknown): value is RateLimit {
  if (!value || typeof value !== 'object') return false;
  const { average, burst } = value as Record<string, unknown>;
  return Number.isInteger(average) && Number.isInteger(burst);
}

/** Why a rate limit is refused (the key of the message), or null: 1–10 000, burst at least that. */
export function rateLimitProblem(limit: RateLimit): string | null {
  const { average, burst } = limit;
  if (!Number.isInteger(average) || average < 1 || average > 10_000) return 'proxy.rate.average';
  if (!Number.isInteger(burst) || burst < average || burst > 100_000) return 'proxy.rate.burst';
  return null;
}

// ── Additional headers ───────────────────────────────────────────────

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Headers that describe the connection or that the proxy and Velydock set themselves.
const FIXED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-real-ip',
]);
export const MAX_HEADERS = 20;

/** Headers as the form shows them: one "Name: value" per line. */
export function headersToText(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return '';
  return Object.entries(headers as Record<string, unknown>)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join('\n');
}

export type HeadersResult =
  | { headers: Record<string, string>; problem: null }
  | { headers: null; problem: string; detail: string };

/**
 * Read "Name: value" lines. `problem` is the key of the message for the first line that
 * cannot be a header the proxy may set, `detail` what that message is about (the line or
 * the name).
 */
export function parseHeaders(text: string): HeadersResult {
  const headers: Record<string, string> = {};
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const line of lines) {
    const at = line.indexOf(':');
    const name = at < 0 ? '' : line.slice(0, at).trim();
    const value = at < 0 ? '' : line.slice(at + 1).trim();
    if (!HEADER_NAME.test(name))
      return { headers: null, problem: 'proxy.headers.line', detail: line };
    const lowered = name.toLowerCase();
    if (
      FIXED_HEADERS.has(lowered) ||
      lowered.startsWith('x-forwarded-') ||
      lowered.startsWith('x-velydock-')
    ) {
      return { headers: null, problem: 'proxy.headers.fixed', detail: name };
    }
    if (lowered === 'set-cookie' || lowered === 'set-cookie2') {
      return { headers: null, problem: 'proxy.headers.cookie', detail: name };
    }
    // A control character (a tab, say) cannot be part of a value.
    // eslint-disable-next-line no-control-regex -- exactly these are meant
    if (/[\x00-\x1f\x7f]/.test(value)) {
      return { headers: null, problem: 'proxy.headers.line', detail: line };
    }
    if (value.length > 1000) return { headers: null, problem: 'proxy.headers.long', detail: name };
    headers[name] = value;
  }
  if (Object.keys(headers).length > MAX_HEADERS) {
    return { headers: null, problem: 'proxy.headers.many', detail: String(MAX_HEADERS) };
  }
  return { headers, problem: null };
}

// ── Names and addresses ──────────────────────────────────────────────

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Not available as the name of a publication (RESERVED_NAMES of the API). */
export const RESERVED_NAMES: readonly string[] = [
  'admin',
  'api',
  'apps',
  'assets',
  'auth',
  'dock',
  'favicon',
  'health',
  'internal',
  'login',
  'logout',
  'realms',
  'resources',
  'robots',
  'sandbox',
  'static',
  'status',
  'velydock',
  'www',
];
export const NAME_MAX_LENGTH = 40;

/** A name as the API takes it: trimmed, in lower case. */
export function normalizePublicationName(value: string): string {
  return value.trim().toLowerCase();
}

/** Why a name cannot be the name of a publication (the key of the message), or null. */
export function publicationNameProblem(value: string): string | null {
  const name = normalizePublicationName(value);
  if (!name) return 'validation.required';
  if (name.length < 2 || !NAME.test(name) || name.startsWith('xn--')) return 'proxy.name.invalid';
  if (RESERVED_NAMES.includes(name)) return 'proxy.name.reserved';
  return null;
}

/** A name for the address from the name of the app: "Wiki für alle" → "wiki-fuer-alle". */
export function suggestPublicationName(appName: string): string {
  const replaced = appName
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX_LENGTH)
    .replace(/-+$/g, '');
  return publicationNameProblem(replaced) === null ? replaced : '';
}

/**
 * Why an internal address cannot be one (the key of the message), or null. An address is
 * http:// or https://, a host and optionally a port: no path (the proxy sends the path of
 * each request there), no user name, no password.
 */
export function targetProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return 'validation.required';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'proxy.target.invalid';
  }
  // Written out as http:// or https:// (a URL parser also takes "http:host"), with a host
  // and without a user name or password.
  if (!/^https?:\/\//i.test(text) || !url.hostname || url.username || url.password) {
    return 'proxy.target.invalid';
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    return 'proxy.target.path';
  }
  return null;
}

/** Two internal addresses that mean the same: without regard to case and a closing slash. */
export function sameTarget(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * The public address a publication gets: `https://apps.example.com/name/` by path,
 * `https://name.apps.example.com/` by sub-domain. Empty while the installation has not
 * said what its apps host is, or without a name.
 */
export function publicAddress(
  info: Pick<ProxyInfo, 'path_base' | 'subdomain_scheme' | 'subdomain_suffix'> | null | undefined,
  mode: PublicationMode,
  name: string,
): string {
  const clean = normalizePublicationName(name);
  if (!info || !clean) return '';
  if (mode === 'subdomain') {
    if (!info.subdomain_scheme || !info.subdomain_suffix) return '';
    return `${info.subdomain_scheme}://${clean}${info.subdomain_suffix}/`;
  }
  return info.path_base ? `${info.path_base}${clean}/` : '';
}

/** Whether what the form holds is the publication that is stored. */
export function samePublication(stored: Publication, next: PublicationIn): boolean {
  return (
    stored.name === next.name &&
    stored.mode === next.mode &&
    stored.access === next.access &&
    stored.template === next.template &&
    sameTarget(stored.target_url, next.target_url) &&
    sameOption(stored.options ?? {}, next.options ?? {})
  );
}

// ── What a system administrator releases ─────────────────────────────

const HOST =
  /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

/**
 * Whether a value can be released for an organization: a network (10.20.0.0/16), an
 * address (10.20.0.7) or a host name (nas.intern), optionally with a port
 * (10.20.0.7:8080, [fd00::7]:8080). Mirrors parse_rule() of the API as far as the form of
 * the value goes; whether a name belongs to the installation itself only the server knows.
 */
export function releaseProblem(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/\.$/, '');
  if (!text) return 'validation.required';
  let host = text;
  let port: string | null = null;
  if (text.startsWith('[')) {
    const closed = text.indexOf(']');
    if (closed < 0) return 'proxyTargets.invalid';
    host = text.slice(1, closed);
    const rest = text.slice(closed + 1);
    if (rest && !rest.startsWith(':')) return 'proxyTargets.invalid';
    port = rest ? rest.slice(1) : null;
  } else if (text.split(':').length === 2) {
    [host, port] = text.split(':');
  }
  if (port !== null && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    return 'proxyTargets.invalid';
  }
  const v4 = IPV4.exec(host);
  if (v4) {
    const octets = v4.slice(1, 5).every((octet) => Number(octet) <= 255);
    const prefix = v4[5] === undefined || Number(v4[5]) <= 32;
    return octets && prefix ? null : 'proxyTargets.invalid';
  }
  if (host.includes(':')) {
    // An IPv6 address or network; what exactly is valid there is left to the server.
    return /^[0-9a-f:.]+(\/\d{1,3})?$/.test(host) && host.split(':').length > 2
      ? null
      : 'proxyTargets.invalid';
  }
  // A host name, and not something that only looks like an address ("10.20").
  if (!HOST.test(host) || /^[\d.]+$/.test(host)) return 'proxyTargets.invalid';
  return null;
}

// ── Templates ────────────────────────────────────────────────────────

/** The key of a built-in template ("standard" of "builtin:standard"), or null for an own one. */
export function builtinKey(id: string): string | null {
  return id.startsWith(BUILTIN_PREFIX) ? id.slice(BUILTIN_PREFIX.length) : null;
}

// ── Own middlewares (a system administrator's: in templates and on single apps) ──

/**
 * The options of a publication or a template in two parts: what the settings of the form
 * are about, and the own middlewares, which have a field (or a notice) of their own.
 */
export function splitOptions(options: ProxyOptions | null | undefined): {
  own: ProxyOptions;
  custom: Record<string, unknown>;
} {
  const { [CUSTOM_MIDDLEWARES]: custom, ...own } = options ?? {};
  const held = custom && typeof custom === 'object' && !Array.isArray(custom);
  return { own, custom: held ? (custom as Record<string, unknown>) : {} };
}

export type MiddlewaresResult =
  | { value: Record<string, unknown>; problem: null }
  | {
      value: null;
      problem:
        | 'proxy.custom.syntax'
        | 'proxy.custom.shape'
        | 'proxy.custom.name'
        | 'proxy.custom.one'
        | 'proxy.custom.many';
      detail: string;
    };

const MIDDLEWARE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const MAX_MIDDLEWARES = 10;

/**
 * Read the JSON text of a template's own middlewares. Checked here are the syntax and the
 * outer shape, as _check_custom() of the API has it: an object of at most ten names, each
 * of lower-case letters, digits and hyphens, each holding exactly one middleware. Which
 * middlewares and fields exist is the API's knowledge, and its answer is shown under the
 * field.
 */
export function parseMiddlewares(text: string): MiddlewaresResult {
  if (text.trim() === '') return { value: {}, problem: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      value: null,
      problem: 'proxy.custom.syntax',
      detail: err instanceof Error ? err.message : '',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, problem: 'proxy.custom.shape', detail: '' };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_MIDDLEWARES) {
    return { value: null, problem: 'proxy.custom.many', detail: String(MAX_MIDDLEWARES) };
  }
  for (const [name, definition] of entries) {
    if (!MIDDLEWARE_NAME.test(name)) {
      return { value: null, problem: 'proxy.custom.name', detail: name };
    }
    const one =
      !!definition &&
      typeof definition === 'object' &&
      !Array.isArray(definition) &&
      Object.keys(definition).length === 1;
    if (!one) return { value: null, problem: 'proxy.custom.one', detail: name };
  }
  return { value: parsed as Record<string, unknown>, problem: null };
}

export function middlewaresToText(value: unknown): string {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}

// ── What is wrong with a publication ─────────────────────────────────

/** Why the proxy does not serve a publication (`publication.problem` of the API). */
export const PUBLICATION_PROBLEMS = [
  'target_not_allowed',
  'template_missing',
  'mode_not_allowed',
  'proxy_disabled',
] as const;
