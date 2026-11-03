import type { RequestHandler } from 'express'

import * as auth from '../controllers/auth.controller.js'
import * as reference from '../controllers/reference.controller.js'
import { Cap } from '../lib/roles.js'
import { enforceCsrf, issueCsrfToken } from '../middleware/csrf.js'
import type { Throttles } from '../middleware/throttle.js'
import { ADMIN_ROUTES } from './admin.routes.js'
import { ANALYTICS_ROUTES } from './analytics.routes.js'
import { importRoutes } from './imports.routes.js'
import { RECORD_ROUTES } from './records.routes.js'
import type { RouteDefinition } from './registry.js'

export interface RouteConfig {
  production: boolean
  csrfTrustedOrigins: readonly string[]
  throttles: Throttles
}

const PUBLIC = { kind: 'public' } as const
const SIGNED_IN = { kind: 'authenticated' } as const
// Locations and the catalog are not personal, so every role reads them, whole and unscoped.
const REFERENCE = { kind: 'capability', capability: Cap.VIEW_AGGREGATES } as const

function referenceRoute(path: string, handler: RequestHandler): RouteDefinition {
  return { method: 'get', path, access: REFERENCE, handlers: [handler] }
}

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
    referenceRoute('/municipalities', reference.listMunicipalities),
    referenceRoute('/municipalities/:id', reference.getMunicipality),
    referenceRoute('/barangays', reference.listBarangays),
    referenceRoute('/barangays/:id', reference.getBarangay),
    referenceRoute('/programs', reference.listPrograms),
    referenceRoute('/programs/:id', reference.getProgram),
    referenceRoute('/commodities', reference.listCommodities),
    referenceRoute('/commodities/:id', reference.getCommodity),
    referenceRoute('/commodities/:id/stages', reference.listCommodityStages),
    referenceRoute('/varieties', reference.listVarieties),
    referenceRoute('/varieties/:id', reference.getVariety),
    referenceRoute('/material-sources', reference.listMaterialSources),
    referenceRoute('/material-sources/:id', reference.getMaterialSource),
    referenceRoute('/units', reference.listUnits),
    referenceRoute('/units/:id', reference.getUnit),
    ...RECORD_ROUTES,
    ...importRoutes(throttles),
    ...ANALYTICS_ROUTES,
    ...ADMIN_ROUTES,
  ]
}
