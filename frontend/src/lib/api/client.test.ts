// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CSRF_HEADER, api, buildUrl, request, setUnauthorizedHandler } from './client';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function apiError(status: number, code: string, details: Record<string, unknown> = {}): Response {
  return json({ error: { code, message: `server says ${code}`, details } }, status);
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function lastCall(): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setUnauthorizedHandler(null);
});

describe('buildUrl', () => {
  it('fills path parameters and encodes them', () => {
    expect(buildUrl('/api/v1/admin/users/{user_id}', { user_id: 'a b/c' })).toBe(
      '/api/v1/admin/users/a%20b%2Fc',
    );
  });

  it('refuses to build an address with a missing path parameter', () => {
    expect(() => buildUrl('/api/v1/admin/users/{user_id}', {})).toThrow(/user_id/);
    expect(() => buildUrl('/api/v1/admin/users/{user_id}', { user_id: '' })).toThrow();
  });

  it('appends the query and leaves unset filters out', () => {
    expect(
      buildUrl('/api/v1/admin/users', undefined, {
        search: 'anna müller',
        role: null,
        active: false,
        group_id: undefined,
        page: 2,
        empty: '',
      }),
    ).toBe('/api/v1/admin/users?search=anna+m%C3%BCller&active=false&page=2');
  });
});

describe('requests', () => {
  it('sends the session cookie on the same origin only', async () => {
    fetchMock.mockResolvedValue(json({ instance_name: 'Velydock' }));
    await api.get('/api/v1/public');
    expect(lastCall().init.credentials).toBe('same-origin');
    expect(lastCall().url).toBe('/api/v1/public');
  });

  it('does not send the CSRF header on GET', async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.get('/api/v1/workspace/apps');
    expect(lastCall().init.method).toBe('GET');
    expect(lastCall().headers[CSRF_HEADER]).toBeUndefined();
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'sends X-Velydock-CSRF: 1 on %s',
    async (method) => {
      fetchMock.mockResolvedValue(json({}));
      await request(method, '/api/v1/anything', { body: { a: 1 } });
      expect(CSRF_HEADER).toBe('X-Velydock-CSRF');
      expect(lastCall().init.method).toBe(method.toUpperCase());
      expect(lastCall().headers[CSRF_HEADER]).toBe('1');
    },
  );

  it('sends the CSRF header on a write without a body too', async () => {
    fetchMock.mockResolvedValue(json({ redirect_url: '/login?signed_out=1' }));
    await api.post('/api/auth/logout');
    expect(lastCall().headers[CSRF_HEADER]).toBe('1');
    expect(lastCall().init.body).toBeUndefined();
    expect(lastCall().headers['Content-Type']).toBeUndefined();
  });

  it('serializes the body as JSON', async () => {
    fetchMock.mockResolvedValue(json({}));
    await api.patch('/api/v1/me/settings', { body: { theme: 'dark', nav_position: null } });
    expect(lastCall().headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      theme: 'dark',
      nav_position: null,
    });
  });

  it('returns the parsed answer', async () => {
    fetchMock.mockResolvedValue(json({ items: [], total: 0, page: 1, page_size: 25 }));
    const page = await api.get('/api/v1/admin/users', { query: { search: 'x', page: 1 } });
    expect(page.total).toBe(0);
    expect(lastCall().url).toBe('/api/v1/admin/users?search=x&page=1');
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      api.delete('/api/v1/admin/groups/{group_id}', { path: { group_id: 'g1' } }),
    ).resolves.toBeUndefined();
    expect(lastCall().url).toBe('/api/v1/admin/groups/g1');
  });
});

describe('errors', () => {
  it('maps the error envelope to an ApiError', async () => {
    fetchMock.mockResolvedValue(apiError(409, 'username_taken'));
    const error = await api
      .post('/api/v1/admin/users', {
        body: {
          username: 'anna',
          first_name: 'A',
          last_name: 'B',
          role: 'member',
          group_ids: [],
          send_email: false,
        },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'username_taken' });
  });

  it('exposes the fields of a validation error', async () => {
    fetchMock.mockResolvedValue(
      apiError(422, 'validation', {
        fields: [{ field: 'username', message: 'too short' }, { broken: true }, 'nonsense'],
      }),
    );
    const error = (await request('post', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('validation');
    expect(error.fields).toEqual([{ field: 'username', message: 'too short' }]);
  });

  it('copes with error answers that are not the API envelope', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const error = (await request('get', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('error');
    expect(error.fields).toEqual([]);
  });

  it('reports an unreachable server as a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await request('get', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 0, code: 'network' });
  });

  it('passes an aborted request on as it is', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const error = await request('get', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
  });
});

describe('401', () => {
  it('calls the unauthorized handler and still rejects', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(apiError(401, 'not_authenticated'));
    const error = (await api.get('/api/v1/me').catch((e: unknown) => e)) as ApiError;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 401, code: 'not_authenticated' });
  });

  it('treats a 401 without envelope as not_authenticated', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    const error = (await request('post', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('not_authenticated');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call the handler for other errors', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(apiError(403, 'forbidden'));
    await api.get('/api/v1/admin/apps').catch(() => {});
    fetchMock.mockResolvedValue(apiError(403, 'csrf'));
    await request('post', '/x').catch(() => {});
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('reads after writes', () => {
  // The API commits a write before it answers, so nothing is held back or repeated.
  it('sends a read that follows a write at once', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json({}));
    await request('post', '/write');
    await request('get', '/read'); // would hang with fake timers if anything waited
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
