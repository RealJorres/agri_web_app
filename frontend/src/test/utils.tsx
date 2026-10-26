import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { vi } from 'vitest'

import { ToastProvider } from '@/components/ui/toast'
import type { Schemas } from '@/lib/api/client'
import { AuthContext, type AuthState, type Capability } from '@/lib/auth/context'

export const ALL_CAPS: Capability[] = [
  'view_aggregates',
  'view_records',
  'view_personal_data',
  'edit_records',
  'submit',
  'validate',
  'approve',
  'reopen',
  'manage_rounds',
  'run_imports',
  'merge_farmers',
  'export_personal_data',
  'admin',
]

export function fakeUser(overrides: Partial<Schemas['Me']> = {}): Schemas['Me'] {
  return {
    id: 'u1',
    email: 'tester@example.test',
    first_name: 'Test',
    last_name: 'User',
    full_name: 'Test User',
    is_superuser: false,
    roles: ['mao_validator'],
    capabilities: [
      'view_aggregates',
      'view_records',
      'view_personal_data',
      'edit_records',
      'validate',
    ],
    assignments: [
      {
        id: 'a1',
        role: 'mao_validator',
        role_label: 'MAO validator',
        municipality: { id: 'm1', name: 'Gasan' },
        program: null,
        barangays: [],
      },
    ],
    ...overrides,
  }
}

export function fakeAuth(overrides: Partial<AuthState> = {}): AuthState {
  // An explicit `user: null` means anonymous; only a missing key gets the default user.
  const user = 'user' in overrides ? (overrides.user ?? null) : fakeUser()
  const caps = new Set<string>(user?.capabilities ?? [])
  return {
    status: 'authenticated',
    user,
    login: vi.fn(),
    logout: vi.fn(),
    reload: vi.fn(),
    can: (c: Capability) => caps.has(c),
    ...overrides,
  }
}

interface Options {
  route?: string
  path?: string
  auth?: AuthState
}

export function renderPage(
  ui: ReactElement,
  { route = '/', path = '*', auth = fakeAuth() }: Options = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route path={path} element={children} />
              <Route path="*" element={<p>other page</p>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </ToastProvider>
    </QueryClientProvider>
  )
  return { ...render(ui, { wrapper }), queryClient }
}

type Handler = (url: URL, request: Request) => unknown
export interface MockApi {
  calls: { method: string; url: URL; body: unknown }[]
}

/** Route fetch calls by "METHOD /path" to handlers returning JSON (or a Response). */
export function mockApi(routes: Record<string, Handler | object>): MockApi {
  const state: MockApi = { calls: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const request =
        typeof input === 'string' ? new Request(new URL(input, 'http://localhost'), init) : input
      const url = new URL(request.url, 'http://localhost')
      const text = request.method === 'GET' ? '' : await request.clone().text()
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        // multipart or plain text
      }
      state.calls.push({ method: request.method, url, body })
      const key = `${request.method} ${url.pathname}`
      const handler = routes[key]
      if (handler === undefined) {
        return new Response(
          JSON.stringify({ code: 'not_found', message: `No mock for ${key}`, fields: {} }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      const result = typeof handler === 'function' ? (handler as Handler)(url, request) : handler
      if (result instanceof Response) return result
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  return state
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function page<T>(results: T[]): { count: number; next: null; previous: null; results: T[] } {
  return { count: results.length, next: null, previous: null, results }
}
