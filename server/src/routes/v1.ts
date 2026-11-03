import * as auth from '../controllers/auth.controller.js'
import { enforceCsrf, issueCsrfToken } from '../middleware/csrf.js'
import type { Throttles } from '../middleware/throttle.js'
import type { RouteDefinition } from './registry.js'

export interface RouteConfig {
  production: boolean
  csrfTrustedOrigins: readonly string[]
  throttles: Throttles
}

const PUBLIC = { kind: 'public' } as const
const SIGNED_IN = { kind: 'authenticated' } as const

export function v1Routes(config: RouteConfig): RouteDefinition[] {
  const { throttles } = config
  const csrf = enforceCsrf(config.csrfTrustedOrigins)
  return [
    {
      method: 'get',
      path: '/auth/csrf',
      access: PUBLIC,
      handlers: [throttles.auth, issueCsrfToken({ production: config.production })],
    },
    {
      method: 'post',
      path: '/auth/login',
      access: PUBLIC,
      handlers: [throttles.login, csrf, auth.login],
    },
    {
      method: 'post',
      path: '/auth/refresh',
      access: PUBLIC,
      handlers: [throttles.auth, csrf, auth.refresh],
    },
    {
      method: 'post',
      path: '/auth/logout',
      access: PUBLIC,
      handlers: [throttles.auth, csrf, auth.logout],
    },
    { method: 'get', path: '/auth/me', access: SIGNED_IN, handlers: [auth.me] },
  ]
}
