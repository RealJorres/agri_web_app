import { describe, expect, it } from 'vitest'

import { jsonResponse, mockApi } from '@/test/utils'

import {
  ApiError,
  api,
  authFetch,
  getAccessToken,
  refreshAccessToken,
  setAccessToken,
  unwrap,
} from './client'

describe('authFetch', () => {
  it('sends the in-memory access token as a bearer header', async () => {
    setAccessToken('token-1')
    mockApi({
      'GET /api/v1/farmers': (_url, req) => ({ auth: req.headers.get('Authorization') }),
      'GET /api/v1/auth/me': (_url, req) => ({ auth: req.headers.get('Authorization') }),
      'POST /api/v1/auth/logout': (_url, req) => ({ auth: req.headers.get('Authorization') }),
    })

    const data = await authFetch(new Request('http://localhost/api/v1/farmers'))
    const me = await authFetch(new Request('http://localhost/api/v1/auth/me'))
    const logout = await authFetch(
      new Request('http://localhost/api/v1/auth/logout', { method: 'POST' }),
    )

    expect(await data.json()).toEqual({ auth: 'Bearer token-1' })
    // Regression: auth/me needs the token (a page reload used to log users out).
    expect(await me.json()).toEqual({ auth: 'Bearer token-1' })
    // Cookie endpoints never carry the access token.
    expect(await logout.json()).toEqual({ auth: null })
  })

  it('refreshes once on 401 and retries the original request', async () => {
    setAccessToken('expired')
    let attempts = 0
    const mock = mockApi({
      'GET /api/v1/farmers': (_url, req) => {
        attempts += 1
        return req.headers.get('Authorization') === 'Bearer fresh'
          ? { count: 0, results: [] }
          : jsonResponse(401, { code: 'token_not_valid', message: 'expired', fields: {} })
      },
      'GET /api/v1/auth/csrf': { csrf_token: 'x' },
      'POST /api/v1/auth/refresh': { access: 'fresh' },
    })

    const response = await authFetch(new Request('http://localhost/api/v1/farmers'))

    expect(response.status).toBe(200)
    expect(attempts).toBe(2)
    expect(getAccessToken()).toBe('fresh')
    expect(mock.calls.filter((c) => c.url.pathname.endsWith('/refresh'))).toHaveLength(1)
  })

  it('shares one refresh between concurrent callers (refresh tokens are single-use)', async () => {
    const mock = mockApi({
      'GET /api/v1/auth/csrf': { csrf_token: 'x' },
      'POST /api/v1/auth/refresh': { access: 'fresh' },
    })

    const [a, b] = await Promise.all([refreshAccessToken(), refreshAccessToken()])

    expect([a, b]).toEqual(['fresh', 'fresh'])
    expect(mock.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('clears the session when refresh fails', async () => {
    setAccessToken('old')
    mockApi({
      'GET /api/v1/auth/csrf': { csrf_token: 'x' },
      'POST /api/v1/auth/refresh': jsonResponse(401, {
        code: 'token_invalid',
        message: 'expired',
        fields: {},
      }),
    })

    expect(await refreshAccessToken()).toBeNull()
    expect(getAccessToken()).toBeNull()
  })
})

describe('unwrap', () => {
  it('throws ApiError with the backend error contract', async () => {
    mockApi({
      'GET /api/v1/farmers': jsonResponse(403, {
        code: 'permission_denied',
        message: 'Nope.',
        fields: {},
      }),
    })

    const result = await api.GET('/api/v1/farmers')

    expect(() => unwrap(result)).toThrow(ApiError)
    try {
      unwrap(result)
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: 'permission_denied', message: 'Nope.' })
    }
  })
})
