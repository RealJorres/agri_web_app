import type { Request, Response } from 'express'

import { DomainError } from '../lib/errors.js'
import { pageOf, pageRequest } from '../lib/pagination.js'
import * as selectors from '../selectors/farm.selectors.js'
import * as farms from '../services/farm.service.js'
import * as harvests from '../services/harvest.service.js'
import { camelKeys } from '../validators/common.js'
import {
  farmCreate,
  farmPatch,
  farmQuery,
  farmUpdate,
  harvestPatch,
  harvestWrite,
  plantingWrite,
  pointsQuery,
  standCreate,
  standUpdate,
} from '../validators/farm.validators.js'
import { actorOf, auditHandler, pathId, scopeOf, useInstead } from './helpers.js'

// --- Farms

export async function listFarms(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await selectors.listFarms(
    scopeOf(req),
    farmQuery.parse(req.query),
    page,
    req.query.ordering,
  )
  res.json(pageOf(req, page, count, results))
}

export async function farmPoints(req: Request, res: Response): Promise<void> {
  res.json(await selectors.farmPoints(scopeOf(req), pointsQuery.parse(req.query)))
}

export async function getFarm(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getFarm(scopeOf(req), pathId(req)))
}

export async function createFarm(req: Request, res: Response): Promise<void> {
  const { farmer, ...data } = farmCreate.parse(req.body)
  if (farmer === undefined) {
    throw new DomainError('not_found', 'Farmer not found.', { farmer: ['Not found.'] }, 404)
  }
  const farm = await farms.createFarm({
    actor: actorOf(req),
    farmerId: farmer,
    data: camelKeys(data),
  })
  res.status(201).json(await selectors.getFarm(scopeOf(req), farm._id))
}

async function writeFarm(req: Request, res: Response, schema: typeof farmPatch): Promise<void> {
  await selectors.requireFarm(scopeOf(req), pathId(req))
  const { farmer, ...data } = schema.parse(req.body)
  const farm = await farms.updateFarm({
    actor: actorOf(req),
    farmId: pathId(req),
    data: camelKeys(data),
    farmerId: farmer,
  })
  res.json(await selectors.getFarm(scopeOf(req), farm._id))
}

export async function putFarm(req: Request, res: Response): Promise<void> {
  await writeFarm(req, res, farmUpdate as unknown as typeof farmPatch)
}

export async function patchFarm(req: Request, res: Response): Promise<void> {
  await writeFarm(req, res, farmPatch)
}

export async function deleteFarm(req: Request, res: Response): Promise<void> {
  await farms.deleteFarm({ actor: actorOf(req), farmId: pathId(req) })
  res.status(204).end()
}

export const farmAudit = auditHandler('farm', selectors.requireFarm)

export async function listFarmStands(req: Request, res: Response): Promise<void> {
  res.json(await selectors.listStandsOfFarm(scopeOf(req), pathId(req)))
}

export async function createFarmStand(req: Request, res: Response): Promise<void> {
  await selectors.requireFarm(scopeOf(req), pathId(req))
  const { commodity, ...data } = standCreate.parse(req.body)
  const stand = await farms.createCropStand({
    actor: actorOf(req),
    farmId: pathId(req),
    commodityId: commodity,
    data: camelKeys(data),
  })
  res.status(201).json(await selectors.getCropStand(scopeOf(req), stand._id))
}

// --- Crop stands

export async function listCropStands(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await selectors.listCropStands(scopeOf(req), page, req.query.ordering)
  res.json(pageOf(req, page, count, results))
}

export const createCropStandHere = useInstead(
  'use_farm_endpoint',
  'Create crop stands via /farms/{id}/crop-stands.',
)

export async function getCropStand(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getCropStand(scopeOf(req), pathId(req)))
}

export async function updateCropStand(req: Request, res: Response): Promise<void> {
  await selectors.requireCropStand(scopeOf(req), pathId(req))
  const stand = await farms.updateCropStand({
    actor: actorOf(req),
    standId: pathId(req),
    data: camelKeys(standUpdate.parse(req.body)),
  })
  res.json(await selectors.getCropStand(scopeOf(req), stand._id))
}

export async function deleteCropStand(req: Request, res: Response): Promise<void> {
  await farms.deleteCropStand({ actor: actorOf(req), standId: pathId(req) })
  res.status(204).end()
}

export const cropStandAudit = auditHandler('crop_stand', selectors.requireCropStand)

export async function listStandPlantings(req: Request, res: Response): Promise<void> {
  res.json(await selectors.listPlantingsOfStand(scopeOf(req), pathId(req)))
}

export async function createStandPlanting(req: Request, res: Response): Promise<void> {
  await selectors.requireCropStand(scopeOf(req), pathId(req))
  const { varieties, ...data } = plantingWrite.parse(req.body)
  const planting = await farms.createPlanting({
    actor: actorOf(req),
    standId: pathId(req),
    data: camelKeys(data),
    varietyIds: varieties,
  })
  res.status(201).json(await selectors.getPlanting(scopeOf(req), planting._id))
}

export async function listStandHarvests(req: Request, res: Response): Promise<void> {
  res.json(await selectors.listHarvestsOfStand(scopeOf(req), pathId(req)))
}

export async function createStandHarvest(req: Request, res: Response): Promise<void> {
  await selectors.requireCropStand(scopeOf(req), pathId(req))
  const harvest = await harvests.createHarvest({
    actor: actorOf(req),
    standId: pathId(req),
    data: camelKeys(harvestWrite.parse(req.body)),
  })
  res.status(201).json(await selectors.getHarvest(scopeOf(req), harvest._id))
}

// --- Plantings

export const plantingCollection = useInstead(
  'use_crop_stand_endpoint',
  'List plantings via /crop-stands/{id}/plantings.',
)

export async function getPlanting(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getPlanting(scopeOf(req), pathId(req)))
}

export async function updatePlanting(req: Request, res: Response): Promise<void> {
  await selectors.getPlanting(scopeOf(req), pathId(req))
  const { varieties, ...data } = plantingWrite.parse(req.body)
  const planting = await farms.updatePlanting({
    actor: actorOf(req),
    plantingId: pathId(req),
    data: camelKeys(data),
    varietyIds: varieties,
  })
  res.json(await selectors.getPlanting(scopeOf(req), planting._id))
}

export async function deletePlanting(req: Request, res: Response): Promise<void> {
  await farms.deletePlanting({ actor: actorOf(req), plantingId: pathId(req) })
  res.status(204).end()
}

// --- Harvests

export const harvestCollection = useInstead(
  'use_crop_stand_endpoint',
  'List harvests via /crop-stands/{id}/harvests.',
)

export async function getHarvest(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getHarvest(scopeOf(req), pathId(req)))
}

async function writeHarvest(
  req: Request,
  res: Response,
  schema: typeof harvestPatch,
): Promise<void> {
  await selectors.getHarvest(scopeOf(req), pathId(req))
  const harvest = await harvests.updateHarvest({
    actor: actorOf(req),
    harvestId: pathId(req),
    data: camelKeys(schema.parse(req.body)),
  })
  res.json(await selectors.getHarvest(scopeOf(req), harvest._id))
}

export async function putHarvest(req: Request, res: Response): Promise<void> {
  await writeHarvest(req, res, harvestWrite as unknown as typeof harvestPatch)
}

export async function patchHarvest(req: Request, res: Response): Promise<void> {
  await writeHarvest(req, res, harvestPatch)
}

export async function deleteHarvest(req: Request, res: Response): Promise<void> {
  await harvests.deleteHarvest({ actor: actorOf(req), harvestId: pathId(req) })
  res.status(204).end()
}
