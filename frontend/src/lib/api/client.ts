// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { paths } from './schema';

// A small typed fetch wrapper over the generated OpenAPI types. Paths, path parameters,
// query, request body and response body are all checked against schema.d.ts:
//
//   const page = await api.get('/api/v1/admin/users', { query: { search: 'anna' } });
//   await api.post('/api/v1/admin/users/{user_id}/reset-password', { path: { user_id } });

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type Operation<P extends keyof paths, M extends HttpMethod> = NonNullable<paths[P][M]>;

/** All paths that offer the method M. */
export type PathFor<M extends HttpMethod> = {
  [P in keyof paths]: [Operation<P, M>] extends [never] ? never : P;
}[keyof paths];

type PathParams<O> = O extends { parameters: { path: infer T } } ? T : undefined;
type Query<O> = O extends { parameters: { query?: infer T } } ? T : undefined;
type Body<O> = O extends { requestBody: { content: { 'application/json': infer T } } }
  ? T
  : undefined;
type Success<R> = R extends { 200: { content: { 'application/json': infer T } } }
  ? T
  : R extends { 201: { content: { 'application/json': infer T } } }
    ? T
    : void;

export type ResponseOf<P extends keyof paths, M extends HttpMethod> =
  Operation<P, M> extends { responses: infer R } ? Success<R> : never;

type Opt<K extends string, T> = [T] extends [undefined]
  ? { [X in K]?: undefined }
  : { [X in K]: T };

export type RequestOptions<P extends keyof paths, M extends HttpMethod> = Opt<
  'path',
  PathParams<Operation<P, M>>
> &
  Opt<'body', Body<Operation<P, M>>> & {
    query?: Query<Operation<P, M>>;
    signal?: AbortSignal;
    /**
     * A request nobody is waiting for (the session check in the background). A 401 is then
     * only thrown and not reported as the end of the session: the caller decides what an
     * ended session means there.
     */
    background?: boolean;
  };

// Options may be left out entirely when neither path parameters nor a body are required.
type Args<P extends keyof paths, M extends HttpMethod> =
  object extends RequestOptions<P, M> ? [options?: RequestOptions<P, M>] : [RequestOptions<P, M>];

export interface FieldError {
  field: string;
  message: string;
}

/** An error answer of the API: `{ error: { code, message, details } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Per-field messages of a `validation` error (422). */
  get fields(): FieldError[] {
    const raw = this.details.fields;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (f): f is FieldError =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as FieldError).field === 'string' &&
        typeof (f as FieldError).message === 'string',
    );
  }
}

export const CSRF_HEADER = 'X-Velydock-CSRF';

/**
 * Names the organization the page believes it is acting on. The active organization
 * belongs to the session, which all tabs share: switching it in one tab changes what the
 * requests of every other tab act on. With this header the API can tell that a tab is out
 * of date and refuses the request (409 `tenant_changed`) instead of carrying it out in
 * another organization than the one on screen.
 */
export const TENANT_HEADER = 'X-Velydock-Tenant';
export const TENANT_CHANGED = 'tenant_changed';

let activeTenantId: string | null = null;
// Counts the organizations this window has shown one after the other (see tenantApi()).
let tenantEpoch = 0;

/** The organization to name in every request; null leaves the header out. */
export function setActiveTenant(tenantId: string | null | undefined): void {
  const next = tenantId || null;
  if (next === activeTenantId) return;
  activeTenantId = next;
  tenantEpoch += 1;
}

/** The organization a page was mounted for: what tenantApi() binds its requests to. */
interface TenantScope {
  readonly tenantId: string | null;
  readonly epoch: number;
}

// A page that was mounted for another organization than the one on screen now is gone.
// Whatever it still wants to send (a question answered late, the next step after an
// answer) is not sent: it would speak for an organization its user never saw there.
function staleError(): ApiError {
  return new ApiError(
    409,
    TENANT_CHANGED,
    'The page that sent this request was showing another organization.',
    { stale: true },
  );
}

/**
 * A request that was not sent, or whose refusal nobody waits for any more, because the
 * page behind it belongs to an organization that is no longer on screen. There is nothing
 * to report: the session store has said that the organization changed.
 */
export function isStaleRequest(err: unknown): boolean {
  return err instanceof ApiError && err.code === TENANT_CHANGED && err.details.stale === true;
}

let onUnauthorized: (() => void) | null = null;
let onTenantChanged: ((named: string | null) => void) | null = null;

/** Called whenever the API answers 401: the session is gone (expired, ended elsewhere). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * Called whenever the API refuses a request because the active organization changed, with
 * the organization the refused request had named.
 */
export function setTenantChangedHandler(handler: ((named: string | null) => void) | null): void {
  onTenantChanged = handler;
}

/** Replace `{name}` segments and append the query. Exported for tests. */
export function buildUrl(
  template: string,
  path?: Record<string, unknown>,
  query?: Record<string, unknown>,
): string {
  let url = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = path?.[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing path parameter "${name}" for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      // Unset filters are left out; the API treats a missing parameter as "no filter".
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

// What a status means when the answer carries no error envelope: a reverse proxy in
// front of the API answers in its own words (plain "Too Many Requests", an HTML page).
const STATUS_CODES: Record<number, string> = {
  401: 'not_authenticated',
  413: 'too_large',
  429: 'rate_limited',
};

async function toApiError(response: Response): Promise<ApiError> {
  let code = STATUS_CODES[response.status] ?? 'error';
  let message = response.statusText || `HTTP ${response.status}`;
  let details: Record<string, unknown> = {};
  try {
    const payload: unknown = await response.json();
    const error = (payload as { error?: unknown } | null)?.error;
    if (typeof error === 'object' && error !== null) {
      const e = error as { code?: unknown; message?: unknown; details?: unknown };
      if (typeof e.code === 'string') code = e.code;
      if (typeof e.message === 'string') message = e.message;
      if (typeof e.details === 'object' && e.details !== null) {
        details = e.details as Record<string, unknown>;
      }
    }
  } catch {
    /* not JSON (proxy error page, empty body): keep the status-derived values */
  }
  return new ApiError(response.status, code, message, details);
}

interface RawOptions {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
  background?: boolean;
}

/**
 * Send a request. Without `scope` it names the organization on screen at this moment;
 * with one (see tenantApi()) the organization the asking page was mounted for, and it is
 * not sent at all once another organization has taken its place.
 */
export async function request<T>(
  method: HttpMethod,
  template: string,
  options: RawOptions = {},
  scope?: TenantScope,
): Promise<T> {
  if (scope && scope.epoch !== tenantEpoch) throw staleError();
  const tenantId = scope ? scope.tenantId : activeTenantId;
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Every state-changing request carries the CSRF header; the API answers 403 without it.
  if (method !== 'get') headers[CSRF_HEADER] = '1';
  if (tenantId) headers[TENANT_HEADER] = tenantId;
  const init: RequestInit = {
    method: method.toUpperCase(),
    credentials: 'same-origin',
    headers,
    signal: options.signal,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(template, options.path, options.query), init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'The server could not be reached.', {});
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (response.status === 401) {
      if (!options.background) onUnauthorized?.();
    } else if (response.status === 409 && error.code === TENANT_CHANGED) {
      // Refused while the page that asked was being replaced (the user switched the
      // organization with this request under way): the page is gone, and the session
      // store knows the new organization already.
      if (scope && scope.epoch !== tenantEpoch) throw staleError();
      onTenantChanged?.(tenantId);
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function call<M extends HttpMethod>(method: M, scope?: TenantScope) {
  return <P extends PathFor<M>>(path: P, ...args: Args<P, M>): Promise<ResponseOf<P, M>> =>
    request<ResponseOf<P, M>>(method, path, args[0] as RawOptions | undefined, scope);
}

function build(scope?: TenantScope) {
  return {
    get: call('get', scope),
    post: call('post', scope),
    put: call('put', scope),
    patch: call('patch', scope),
    delete: call('delete', scope),
  };
}

export type Api = ReturnType<typeof build>;

/**
 * The API for everything that does not belong to one organization: the session itself,
 * the system administration, the login page. Its requests name the organization that is
 * on screen when they are sent.
 */
export const api: Api = build();

/**
 * The API as a page of the active organization uses it. Call it once while the page (or
 * a dialog of it) is set up and send every request of that page through the result.
 *
 * The result is bound to the organization that is on screen at that moment. A page is
 * destroyed when the organization changes (see `{#key}` in App.svelte), but what it has
 * started lives on: a confirmation that is answered later, the request that follows an
 * answer. Bound like this, none of that can act on the organization that came after: such
 * a request fails with `tenant_changed` without being sent (see isStaleRequest()).
 */
export function tenantApi(): Api {
  return build({ tenantId: activeTenantId, epoch: tenantEpoch });
}
