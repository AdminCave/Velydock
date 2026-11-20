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

let onUnauthorized: (() => void) | null = null;

/** Called whenever the API answers 401: the session is gone (expired, ended elsewhere). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
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

async function toApiError(response: Response): Promise<ApiError> {
  let code = response.status === 401 ? 'not_authenticated' : 'error';
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
}

export async function request<T>(
  method: HttpMethod,
  template: string,
  options: RawOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Every state-changing request carries the CSRF header; the API answers 403 without it.
  if (method !== 'get') headers[CSRF_HEADER] = '1';
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
    if (response.status === 401) onUnauthorized?.();
    throw error;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function call<M extends HttpMethod>(method: M) {
  return <P extends PathFor<M>>(path: P, ...args: Args<P, M>): Promise<ResponseOf<P, M>> =>
    request<ResponseOf<P, M>>(method, path, args[0] as RawOptions | undefined);
}

export const api = {
  get: call('get'),
  post: call('post'),
  put: call('put'),
  patch: call('patch'),
  delete: call('delete'),
};
