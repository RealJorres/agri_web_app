import createClient from 'openapi-fetch'

import type { components, paths } from './schema'

export type Schemas = components['schemas']

/** The backend's error contract: every non-2xx JSON body is {code, message, fields}. */
export interface ApiErrorBody {
  code: string
  message: string
  fields: Record<string, string[]>
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly fields: Record<string, string[]>

  constructor(status: number, body: Partial<ApiErrorBody> | undefined) {
    super(body?.message ?? `Request failed (${String(status)})`)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.code ?? 'error'
    this.fields = body?.fields ?? {}
  }
}

// --- Access token: memory only (never localStorage), per brief §9 -----------------------------

let accessToken: string | null = null
type Listener = (token: string | null) => void
const listeners = new Set<Listener>()

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  accessToken = token
  listeners.forEach((fn) => {
    fn(token)
  })
}

export function onAccessTokenChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// --- CSRF (double submit; the refresh cookie lives on /api/v1/auth/ only) ---------------------

export function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

const AUTH_PREFIX = '/api/v1/auth/'
const COOKIE_ENDPOINTS = ['csrf', 'login', 'refresh', 'logout']

export async function ensureCsrf(): Promise<void> {
  if (!readCookie('csrftoken')) {
    await fetch(`${AUTH_PREFIX}csrf`, { credentials: 'same-origin' })
  }
}

// --- Refresh: one at a time per tab AND across tabs (Web Locks), because refresh tokens are
// single-use and a second concurrent refresh would look like token theft to the server. -------

let inFlight: Promise<string | null> | null = null

async function doRefresh(): Promise<string | null> {
  await ensureCsrf()
  const response = await fetch(`${AUTH_PREFIX}refresh`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRFToken': readCookie('csrftoken') ?? '' },
  })
  if (!response.ok) {
    setAccessToken(null)
    return null
  }
  const body = (await response.json()) as { access: string }
  setAccessToken(body.access)
  return body.access
}

export function refreshAccessToken(): Promise<string | null> {
  if (!inFlight) {
    const run = (): Promise<string | null> => doRefresh()
    const locked: Promise<string | null> =
      typeof navigator !== 'undefined' && 'locks' in navigator
        ? navigator.locks.request('agri-dms-refresh', run).then((token) => token)
        : run()
    inFlight = locked.finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** fetch wrapper: bearer token, CSRF for auth endpoints, one silent retry after a 401. */
export async function authFetch(input: Request): Promise<Response> {
  // Cookie endpoints (csrf/login/refresh/logout) use the refresh cookie + CSRF header; every other
  // endpoint, including auth/me, needs the bearer token.
  const path = new URL(input.url, window.location.origin).pathname
  const isAuth = COOKIE_ENDPOINTS.some((name) => path === `${AUTH_PREFIX}${name}`)
  const prepare = (req: Request, token: string | null): Request => {
    const headers = new Headers(req.headers)
    if (token && !isAuth) headers.set('Authorization', `Bearer ${token}`)
    if (isAuth) headers.set('X-CSRFToken', readCookie('csrftoken') ?? '')
    return new Request(req, { headers, credentials: 'same-origin' })
  }
  const retry = input.clone()
  const response = await fetch(prepare(input, accessToken))
  if (response.status !== 401 || isAuth) return response
  const token = await refreshAccessToken()
  return token ? fetch(prepare(retry, token)) : response
}

// Absolute base so Request() also works outside the browser (tests); same origin in production.
export const api = createClient<paths>({ baseUrl: globalThis.location.origin, fetch: authFetch })

/** Unwrap an openapi-fetch result, throwing ApiError for error responses. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    throw new ApiError(result.response.status, result.error as Partial<ApiErrorBody>)
  }
  return result.data as T
}

/** Binary downloads (exports, templates, error reports) go through the same auth handling. */
export async function download(url: string, filename: string): Promise<void> {
  const response = await authFetch(new Request(url))
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as Partial<ApiErrorBody> | undefined
    throw new ApiError(response.status, body)
  }
  const blob = await response.blob()
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.click()
  URL.revokeObjectURL(href)
}
