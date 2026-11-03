import type { Request, RequestHandler, Response } from 'express'

import * as catalog from '../selectors/catalog.selectors.js'
import * as locations from '../selectors/location.selectors.js'
import { barangayQuery, commodityQuery, varietyQuery } from '../validators/reference.validators.js'

function pathId(req: Request): string {
  return String(req.params.id)
}

function detail(read: (id: string) => Promise<unknown>): RequestHandler {
  return async (req: Request, res: Response) => {
    res.json(await read(pathId(req)))
  }
}

function list(read: (ordering: unknown) => Promise<unknown>): RequestHandler {
  return async (req: Request, res: Response) => {
    res.json(await read(req.query.ordering))
  }
}

export const listMunicipalities = list(locations.listMunicipalities)
export const getMunicipality = detail(locations.getMunicipality)
export const getBarangay = detail(locations.getBarangay)

export async function listBarangays(req: Request, res: Response): Promise<void> {
  const { municipality, is_verified: isVerified, q } = barangayQuery.parse(req.query)
  res.json(await locations.listBarangays({ municipality, isVerified, q }, req.query.ordering))
}

export const listPrograms = list(catalog.listPrograms)
export const getProgram = detail(catalog.getProgram)
export const getCommodity = detail(catalog.getCommodity)
export const getVariety = detail(catalog.getVariety)
export const listMaterialSources = list(catalog.listMaterialSources)
export const getMaterialSource = detail(catalog.getMaterialSource)
export const listUnits = list(catalog.listUnits)
export const getUnit = detail(catalog.getUnit)

export async function listCommodities(req: Request, res: Response): Promise<void> {
  res.json(await catalog.listCommodities(commodityQuery.parse(req.query), req.query.ordering))
}

export async function listCommodityStages(req: Request, res: Response): Promise<void> {
  res.json(await catalog.listCommodityStages(pathId(req), commodityQuery.parse(req.query)))
}

export async function listVarieties(req: Request, res: Response): Promise<void> {
  res.json(await catalog.listVarieties(varietyQuery.parse(req.query), req.query.ordering))
}
