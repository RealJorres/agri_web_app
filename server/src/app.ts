import express, { type Express } from 'express'

import { errorHandler, unmatchedRoute } from './middleware/errorHandler.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { apiRouter } from './routes/index.js'

const MAX_JSON_BODY = '10mb'

export function createApp({ production }: { production: boolean }): Express {
  const app = express()
  app.disable('x-powered-by')
  // The production web tier sits behind one proxy, which tells us the client address and scheme.
  if (production) app.set('trust proxy', 1)

  app.use(securityHeaders({ production }))
  app.use(express.json({ limit: MAX_JSON_BODY }))
  app.use('/api', apiRouter)
  app.use(unmatchedRoute)
  app.use(errorHandler)
  return app
}
