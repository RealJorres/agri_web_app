/** Farmers, associations, farms, crop stands, plantings and harvests. Fixed paths precede :id. */
import type { RequestHandler } from 'express'

import * as farm from '../controllers/farm.controller.js'
import * as registry from '../controllers/registry.controller.js'
import { Cap } from '../lib/roles.js'
import type { RouteDefinition } from './registry.js'

type Method = RouteDefinition['method']

function route(method: Method, path: string, capability: Cap, handler: RequestHandler) {
  const access = { kind: 'capability', capability } as const
  return { method, path, access, handlers: [handler] }
}

const read = (path: string, handler: RequestHandler) =>
  route('get', path, Cap.VIEW_RECORDS, handler)
const edit = (method: Method, path: string, handler: RequestHandler) =>
  route(method, path, Cap.EDIT_RECORDS, handler)

export const RECORD_ROUTES: RouteDefinition[] = [
  read('/farmers', registry.listFarmers),
  edit('post', '/farmers', registry.createFarmer),
  read('/farmers/duplicates', registry.farmerDuplicates),
  read('/farmers/:id', registry.getFarmer),
  edit('put', '/farmers/:id', registry.putFarmer),
  edit('patch', '/farmers/:id', registry.patchFarmer),
  edit('delete', '/farmers/:id', registry.deleteFarmer),
  read('/farmers/:id/audit', registry.farmerAudit),
  route('post', '/farmers/:id/merge', Cap.MERGE_FARMERS, registry.mergeFarmers),

  read('/associations', registry.listAssociations),
  edit('post', '/associations', registry.createAssociation),
  read('/associations/:id', registry.getAssociation),
  edit('put', '/associations/:id', registry.putAssociation),
  edit('patch', '/associations/:id', registry.patchAssociation),
  edit('delete', '/associations/:id', registry.deleteAssociation),
  read('/associations/:id/audit', registry.associationAudit),
  read('/associations/:id/members', registry.listMembers),
  edit('post', '/associations/:id/members', registry.addMember),
  edit('delete', '/associations/:id/members/:member_id', registry.removeMember),

  read('/farms', farm.listFarms),
  edit('post', '/farms', farm.createFarm),
  route('get', '/farms/points', Cap.VIEW_PERSONAL_DATA, farm.farmPoints),
  read('/farms/:id', farm.getFarm),
  edit('put', '/farms/:id', farm.putFarm),
  edit('patch', '/farms/:id', farm.patchFarm),
  edit('delete', '/farms/:id', farm.deleteFarm),
  read('/farms/:id/audit', farm.farmAudit),
  read('/farms/:id/crop-stands', farm.listFarmStands),
  edit('post', '/farms/:id/crop-stands', farm.createFarmStand),

  read('/crop-stands', farm.listCropStands),
  edit('post', '/crop-stands', farm.createCropStandHere),
  read('/crop-stands/:id', farm.getCropStand),
  edit('put', '/crop-stands/:id', farm.updateCropStand),
  edit('patch', '/crop-stands/:id', farm.updateCropStand),
  edit('delete', '/crop-stands/:id', farm.deleteCropStand),
  read('/crop-stands/:id/audit', farm.cropStandAudit),
  read('/crop-stands/:id/plantings', farm.listStandPlantings),
  edit('post', '/crop-stands/:id/plantings', farm.createStandPlanting),
  read('/crop-stands/:id/harvests', farm.listStandHarvests),
  edit('post', '/crop-stands/:id/harvests', farm.createStandHarvest),

  read('/plantings', farm.plantingCollection),
  edit('post', '/plantings', farm.plantingCollection),
  read('/plantings/:id', farm.getPlanting),
  edit('put', '/plantings/:id', farm.updatePlanting),
  edit('patch', '/plantings/:id', farm.updatePlanting),
  edit('delete', '/plantings/:id', farm.deletePlanting),

  read('/harvests', farm.harvestCollection),
  edit('post', '/harvests', farm.harvestCollection),
  read('/harvests/:id', farm.getHarvest),
  edit('put', '/harvests/:id', farm.putHarvest),
  edit('patch', '/harvests/:id', farm.patchHarvest),
  edit('delete', '/harvests/:id', farm.deleteHarvest),
]
