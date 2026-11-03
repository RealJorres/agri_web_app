import cookieParser from 'cookie-parser'
import express, { type Express } from 'express'

import { requestContext } from './lib/requestContext.js'
import { errorHandler, unmatchedRoute } from './middleware/errorHandler.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { createThrottles } from './middleware/throttle.js'
import { apiRouter } from './routes/index.js'
import { buildRouter, type RouteDefinition } from './routes/registry.js'
import { v1Routes, type RouteConfig } from './routes/v1.js'

const MAX_JSON_BODY = '10mb'

export interface AppOptions {
  production: boolean
  /** How many reverse proxies stand in front of this server, for the client address and scheme. */
  trustedProxies?: number
  csrfTrustedOrigins?: readonly string[]
  /** Replaces the route table, or adds to it. Used by tests to mount a harness route. */
  routes?: (config: RouteConfig) => RouteDefinition[]
}

export function createApp(options: AppOptions): Express {
  const { production, trustedProxies = 0, csrfTrustedOrigins = [], routes = v1Routes } = options
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', trustedProxies)

  const throttles = createThrottles()
  app.use(securityHeaders({ production }))
  app.use(requestContext)
  app.use(cookieParser())
  app.use(express.json({ limit: MAX_JSON_BODY }))
  app.use(
    '/api/v1',
    buildRouter(routes({ production, csrfTrustedOrigins, throttles }), {
      signedIn: throttles.user,
    }),
  )
  app.use('/api', apiRouter)
  app.use(unmatchedRoute)
  app.use(errorHandler)
  return app
}
