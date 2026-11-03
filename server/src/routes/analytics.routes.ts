/** Analytics, reports and the map. Every figure is an aggregate, limited to the caller's scope. */
import type { RequestHandler } from 'express'

import * as controller from '../controllers/analytics.controller.js'
import { Cap } from '../lib/roles.js'
import type { RouteDefinition } from './registry.js'

function route(
  method: RouteDefinition['method'],
  path: string,
  capability: Cap,
  handler: RequestHandler,
): RouteDefinition {
  return { method, path, access: { kind: 'capability', capability }, handlers: [handler] }
}

const aggregate = (path: string, handler: RequestHandler) =>
  route('get', path, Cap.VIEW_AGGREGATES, handler)

export const ANALYTICS_ROUTES: RouteDefinition[] = [
  aggregate('/analytics/status', controller.status),
  aggregate('/analytics/trends', controller.trends),
  aggregate('/analytics/harvests', controller.harvests),
  aggregate('/analytics/rounds/:id/overview', controller.overview),
  aggregate('/analytics/rounds/:id/breakdown', controller.breakdown),
  aggregate('/analytics/rounds/:id/distribution', controller.distribution),

  aggregate('/map/config', controller.mapConfig),
  aggregate('/map/boundaries', controller.mapBoundaries),

  aggregate('/reports/rounds/:id/summary.:fmt', controller.summaryFile),
  route(
    'get',
    '/reports/rounds/:id/municipal-list.:fmt',
    Cap.EXPORT_PERSONAL_DATA,
    controller.municipalListFile,
  ),
  aggregate('/reports/rounds/:id/sign-off', controller.getSignoff),
  route('post', '/reports/rounds/:id/sign-off', Cap.SIGN_REPORTS, controller.signOff),
]
