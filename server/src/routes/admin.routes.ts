import type { RequestHandler } from 'express'

import * as admin from '../controllers/admin.controller.js'
import { Cap } from '../lib/roles.js'
import type { RouteDefinition } from './registry.js'

const ADMIN = { kind: 'capability', capability: Cap.ADMIN } as const

function route(
  method: RouteDefinition['method'],
  path: string,
  ...handlers: RequestHandler[]
): RouteDefinition {
  return { method, path: `/admin${path}`, access: ADMIN, handlers }
}

/** Staff accounts, the catalog and report settings. See ADR-0021. */
export const ADMIN_ROUTES: RouteDefinition[] = [
  route('get', '/users', admin.listUsers),
  route('post', '/users', admin.createStaffUser),
  route('get', '/users/:id', admin.getUser),
  route('patch', '/users/:id', admin.updateUser),
  route('post', '/users/:id/password', admin.resetPassword),
  route('post', '/users/:id/assignments', admin.addAssignment),
  route('delete', '/users/:id/assignments/:assignment_id', admin.removeAssignment),
  route('post', '/programs', admin.createProgram),
  route('patch', '/programs/:id', admin.updateProgram),
  route('post', '/commodities', admin.createCommodity),
  route('patch', '/commodities/:id', admin.updateCommodity),
  route('get', '/commodities/:id/usage', admin.commodityUsage),
  route('get', '/commodities/:id/stages', admin.listStages),
  route('post', '/commodities/:id/stages', admin.createStage),
  route('patch', '/stages/:id', admin.updateStage),
  route('delete', '/stages/:id', admin.deleteStage),
  route('get', '/varieties', admin.listVarieties),
  route('post', '/varieties', admin.createVariety),
  route('patch', '/varieties/:id', admin.updateVariety),
  route('delete', '/varieties/:id', admin.deleteVariety),
  route('get', '/material-sources', admin.listSources),
  route('post', '/material-sources', admin.createSource),
  route('patch', '/material-sources/:id', admin.updateSource),
  route('delete', '/material-sources/:id', admin.deleteSource),
  route('get', '/report-settings', admin.getReportSettings),
  route('patch', '/report-settings', admin.updateReportSettings),
  route('post', '/report-settings/logo', admin.receiveLogo, admin.uploadLogo),
  route('delete', '/report-settings/logo', admin.removeLogo),
  route('get', '/signatories', admin.listSignatories),
  route('post', '/signatories', admin.createSignatory),
  route('patch', '/signatories/:id', admin.updateSignatory),
  route('delete', '/signatories/:id', admin.deleteSignatory),
]
