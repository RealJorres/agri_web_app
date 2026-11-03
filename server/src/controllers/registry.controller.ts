import type { Request, Response } from 'express'

import { pageOf, pageRequest } from '../lib/pagination.js'
import * as selectors from '../selectors/registry.selectors.js'
import * as services from '../services/registry.service.js'
import { camelKeys } from '../validators/common.js'
import {
  associationPatch,
  associationQuery,
  associationWrite,
  duplicatesQuery,
  farmerPatch,
  farmerQuery,
  farmerWrite,
  memberBody,
  mergeBody,
} from '../validators/registry.validators.js'
import { actorOf, auditHandler, pathId, scopeOf } from './helpers.js'

export async function listFarmers(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await selectors.listFarmers(
    scopeOf(req),
    farmerQuery.parse(req.query),
    page,
    req.query.ordering,
  )
  res.json(pageOf(req, page, count, results))
}

export async function getFarmer(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getFarmerDetail(scopeOf(req), pathId(req)))
}

export async function createFarmer(req: Request, res: Response): Promise<void> {
  const { consent_given: consentGiven, ...data } = farmerWrite.parse(req.body)
  const farmer = await services.createFarmer({
    actor: actorOf(req),
    data: camelKeys(data),
    consentGiven: consentGiven ?? false,
  })
  res.status(201).json(await selectors.getFarmerRow(scopeOf(req), farmer._id))
}

async function writeFarmer(req: Request, res: Response, schema: typeof farmerPatch): Promise<void> {
  // Scope first: out-of-reach ids answer 404 whether or not the body is valid.
  await selectors.requireFarmer(scopeOf(req), pathId(req))
  const { consent_given: consentGiven, ...data } = schema.parse(req.body)
  const farmer = await services.updateFarmer({
    actor: actorOf(req),
    farmerId: pathId(req),
    data: camelKeys(data),
    consentGiven: consentGiven ?? false,
  })
  res.json(await selectors.getFarmerRow(scopeOf(req), farmer._id))
}

export async function putFarmer(req: Request, res: Response): Promise<void> {
  await writeFarmer(req, res, farmerWrite as unknown as typeof farmerPatch)
}

export async function patchFarmer(req: Request, res: Response): Promise<void> {
  await writeFarmer(req, res, farmerPatch)
}

export async function deleteFarmer(req: Request, res: Response): Promise<void> {
  await services.deleteFarmer({ actor: actorOf(req), farmerId: pathId(req) })
  res.status(204).end()
}

export const farmerAudit = auditHandler('farmer', selectors.requireFarmer)

export async function farmerDuplicates(req: Request, res: Response): Promise<void> {
  const query = duplicatesQuery.parse(req.query)
  res.json(
    await selectors.duplicateCandidates(scopeOf(req), {
      ...(query.name !== undefined && { name: query.name }),
      ...(query.barangay && { barangay: query.barangay }),
      ...(query.rsbsa_no !== undefined && { rsbsaNo: query.rsbsa_no }),
      ...(query.exclude && { exclude: query.exclude }),
    }),
  )
}

export async function mergeFarmers(req: Request, res: Response): Promise<void> {
  await selectors.requireFarmer(scopeOf(req), pathId(req))
  const { duplicate } = mergeBody.parse(req.body)
  const result = await services.mergeFarmers({
    actor: actorOf(req),
    targetId: pathId(req),
    duplicateId: duplicate,
  })
  res.json({
    target: await selectors.getFarmerRow(scopeOf(req), result.targetId),
    farms_moved: result.farmsMoved,
    memberships_moved: result.membershipsMoved,
    fields_filled: result.fieldsFilled,
    conflicts: result.conflicts,
  })
}

export async function listAssociations(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await selectors.listAssociations(
    scopeOf(req),
    associationQuery.parse(req.query),
    page,
    req.query.ordering,
  )
  res.json(pageOf(req, page, count, results))
}

export async function getAssociation(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getAssociation(scopeOf(req), pathId(req)))
}

export async function createAssociation(req: Request, res: Response): Promise<void> {
  const association = await services.createAssociation({
    actor: actorOf(req),
    data: camelKeys(associationWrite.parse(req.body)),
  })
  res.status(201).json(await selectors.getAssociation(scopeOf(req), association._id))
}

async function writeAssociation(
  req: Request,
  res: Response,
  schema: typeof associationPatch,
): Promise<void> {
  await selectors.requireAssociation(scopeOf(req), pathId(req))
  const association = await services.updateAssociation({
    actor: actorOf(req),
    associationId: pathId(req),
    data: camelKeys(schema.parse(req.body)),
  })
  res.json(await selectors.getAssociation(scopeOf(req), association._id))
}

export async function putAssociation(req: Request, res: Response): Promise<void> {
  await writeAssociation(req, res, associationWrite as unknown as typeof associationPatch)
}

export async function patchAssociation(req: Request, res: Response): Promise<void> {
  await writeAssociation(req, res, associationPatch)
}

export async function deleteAssociation(req: Request, res: Response): Promise<void> {
  await services.deleteAssociation({ actor: actorOf(req), associationId: pathId(req) })
  res.status(204).end()
}

export const associationAudit = auditHandler('association', selectors.requireAssociation)

export async function listMembers(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await selectors.listMembers(scopeOf(req), pathId(req), page)
  res.json(pageOf(req, page, count, results))
}

export async function addMember(req: Request, res: Response): Promise<void> {
  await selectors.requireAssociation(scopeOf(req), pathId(req))
  const { farmer, role, since } = memberBody.parse(req.body)
  const memberId = await services.addMember({
    actor: actorOf(req),
    associationId: pathId(req),
    farmerId: farmer,
    role,
    since,
  })
  res.status(201).json(await selectors.getMember(scopeOf(req), memberId))
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  await services.removeMember({
    actor: actorOf(req),
    associationId: pathId(req),
    memberId: pathId(req, 'member_id'),
  })
  res.status(204).end()
}
