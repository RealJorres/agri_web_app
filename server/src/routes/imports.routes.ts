import type { RequestHandler } from 'express'

import * as imports from '../controllers/import.controller.js'
import { Cap } from '../lib/roles.js'
import type { Throttles } from '../middleware/throttle.js'
import type { RouteDefinition } from './registry.js'

const RUN = { kind: 'capability', capability: Cap.RUN_IMPORTS } as const
const EXPORT = { kind: 'capability', capability: Cap.EXPORT_PERSONAL_DATA } as const

function run(method: RouteDefinition['method'], path: string, ...handlers: RequestHandler[]) {
  return { method, path, access: RUN, handlers }
}

export function importRoutes(throttles: Throttles): RouteDefinition[] {
  return [
    run('get', '/imports', imports.listImports),
    run('post', '/imports', throttles.imports, imports.receiveUpload, imports.createImport),
    run('get', '/imports/template', imports.downloadTemplate),
    run('get', '/imports/:id', imports.getImport),
    run('post', '/imports/:id/commit', imports.commitImport),
    run('get', '/imports/:id/error-report', imports.downloadErrorReport),
    {
      method: 'get',
      path: '/exports/farmers.xlsx',
      access: EXPORT,
      handlers: [imports.exportFarmerList],
    },
    {
      method: 'get',
      path: '/exports/inventory.xlsx',
      access: EXPORT,
      handlers: [imports.exportInventoryList],
    },
  ]
}
