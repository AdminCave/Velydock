// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CSRF_HEADER,
  TENANT_HEADER,
  api,
  buildUrl,
  isStaleRequest,
  request,
  setActiveTenant,
  setTenantChangedHandler,
  setUnauthorizedHandler,
  tenantApi,
} from './client';

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
  setTenantChangedHandler(null);
  setActiveTenant(null);
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

  it('names what a reverse proxy means when it answers without the envelope', async () => {
    // nginx and friends: a plain text or HTML body, no JSON.
    fetchMock.mockResolvedValue(new Response('Too Many Requests', { status: 429 }));
    let error = (await request('get', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 429, code: 'rate_limited' });
    fetchMock.mockResolvedValue(new Response('<html>413</html>', { status: 413 }));
    error = (await request('post', '/x', { body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 413, code: 'too_large' });
  });

  it('prefers the code of the envelope over the one derived from the status', async () => {
    fetchMock.mockResolvedValue(apiError(429, 'rate_limited'));
    let error = (await request('get', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('rate_limited');
    fetchMock.mockResolvedValue(apiError(409, 'try_again'));
    error = (await request('post', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 409, code: 'try_again' });
    fetchMock.mockResolvedValue(apiError(413, 'something_else'));
    error = (await request('post', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('something_else');
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

describe('active organization', () => {
  it('names the organization the page shows in every request, reads and writes', async () => {
    expect(TENANT_HEADER).toBe('X-Velydock-Tenant');
    setActiveTenant('t-acme');
    fetchMock.mockImplementation(async () => json({}));
    await api.get('/api/v1/admin/groups');
    expect(lastCall().headers[TENANT_HEADER]).toBe('t-acme');
    await request('post', '/api/v1/admin/users', { body: {} });
    expect(lastCall().headers[TENANT_HEADER]).toBe('t-acme');
    expect(lastCall().headers[CSRF_HEADER]).toBe('1');
  });

  it('leaves the header out while no organization is known', async () => {
    fetchMock.mockImplementation(async () => json({}));
    await api.get('/api/v1/me');
    expect(TENANT_HEADER in lastCall().headers).toBe(false);
    setActiveTenant('t-acme');
    setActiveTenant(null);
    await api.get('/api/v1/me');
    expect(TENANT_HEADER in lastCall().headers).toBe(false);
    setActiveTenant('');
    await api.get('/api/v1/me');
    expect(TENANT_HEADER in lastCall().headers).toBe(false);
  });

  it('reports 409 tenant_changed to its handler and still rejects', async () => {
    const changed = vi.fn();
    const unauthorized = vi.fn();
    setTenantChangedHandler(changed);
    setUnauthorizedHandler(unauthorized);
    fetchMock.mockResolvedValue(apiError(409, 'tenant_changed'));
    const error = (await api.get('/api/v1/admin/groups').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 409, code: 'tenant_changed' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('does not take other conflicts for a changed organization', async () => {
    const changed = vi.fn();
    setTenantChangedHandler(changed);
    fetchMock.mockResolvedValue(apiError(409, 'username_taken'));
    await request('post', '/x').catch(() => {});
    fetchMock.mockResolvedValue(apiError(403, 'tenant_changed'));
    await request('post', '/x').catch(() => {});
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('the API of a page that belongs to one organization (tenantApi)', () => {
  it('names the organization the page was opened for', async () => {
    setActiveTenant('t-acme');
    const page = tenantApi();
    fetchMock.mockImplementation(async () => json({}));
    await page.get('/api/v1/admin/groups');
    expect(lastCall().headers[TENANT_HEADER]).toBe('t-acme');
    await page.post('/api/v1/admin/groups', { body: { name: 'IT', description: '' } });
    expect(lastCall().headers[TENANT_HEADER]).toBe('t-acme');
    expect(lastCall().headers[CSRF_HEADER]).toBe('1');
  });

  it('sends nothing once another organization is on screen, whatever the page still wants', async () => {
    const changed = vi.fn();
    setTenantChangedHandler(changed);
    setActiveTenant('t-acme');
    const page = tenantApi();
    fetchMock.mockImplementation(async () => json({}));
    setActiveTenant('t-main'); // the organization changed: the page is gone
    const error = (await page
      .delete('/api/v1/admin/users/{user_id}', { path: { user_id: 'u-mia' } })
      .catch((e: unknown) => e)) as ApiError;
    // Not sent, not even with the old organization in the header …
    expect(fetchMock).not.toHaveBeenCalled();
    // … and it fails like a request the API refused for that reason, without the handler:
    // the session store knows the new organization already.
    expect(error).toMatchObject({ status: 409, code: 'tenant_changed' });
    expect(isStaleRequest(error)).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    // The plain api, and a page opened now, speak for the organization on screen.
    await api.get('/api/v1/me');
    expect(lastCall().headers[TENANT_HEADER]).toBe('t-main');
    await tenantApi().get('/api/v1/admin/groups');
    expect(lastCall().headers[TENANT_HEADER]).toBe('t-main');
  });

  it('stays silent for good: coming back to the first organization does not revive the old page', async () => {
    setActiveTenant('t-acme');
    const page = tenantApi();
    setActiveTenant('t-main');
    setActiveTenant('t-acme');
    fetchMock.mockImplementation(async () => json({}));
    const error = await page.get('/api/v1/admin/groups').catch((e: unknown) => e);
    expect(isStaleRequest(error)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is not disturbed by anything that leaves the organization as it is', async () => {
    setActiveTenant('t-acme');
    const page = tenantApi();
    setActiveTenant('t-acme'); // e.g. a settings change: a new user object, same organization
    fetchMock.mockImplementation(async () => json({}));
    await page.get('/api/v1/admin/groups');
    expect(lastCall().headers[TENANT_HEADER]).toBe('t-acme');
  });

  it('reports nothing for a refusal that arrives when the page is gone already', async () => {
    const changed = vi.fn();
    setTenantChangedHandler(changed);
    setActiveTenant('t-acme');
    const page = tenantApi();
    let answer: (response: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    const pending = page.get('/api/v1/admin/groups').catch((e: unknown) => e);
    setActiveTenant('t-main'); // the user switched with this request under way
    answer(apiError(409, 'tenant_changed'));
    expect(isStaleRequest(await pending)).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it('reports a refusal for a page that is still there, like any other request', async () => {
    const changed = vi.fn();
    setTenantChangedHandler(changed);
    setActiveTenant('t-acme');
    fetchMock.mockResolvedValue(apiError(409, 'tenant_changed'));
    const error = await tenantApi()
      .get('/api/v1/admin/groups')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: 'tenant_changed' });
    expect(isStaleRequest(error)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('a request in the background', () => {
  it('throws a 401 without reporting the end of the session', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    fetchMock.mockImplementation(async () => apiError(401, 'not_authenticated'));
    await expect(api.get('/api/v1/me', { background: true })).rejects.toMatchObject({
      status: 401,
      code: 'not_authenticated',
    });
    expect(unauthorized).not.toHaveBeenCalled();
    await api.get('/api/v1/me').catch(() => {});
    expect(unauthorized).toHaveBeenCalledTimes(1);
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
