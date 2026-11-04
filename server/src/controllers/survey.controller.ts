import type { Request, RequestHandler, Response } from 'express'

import { pageOf, pageRequest } from '../lib/pagination.js'
import * as selectors from '../selectors/survey.selectors.js'
import { createEntry as saveEntry } from '../services/entry.service.js'
import * as services from '../services/survey.service.js'
import { camelKeys } from '../validators/common.js'
import {
  entryCreate,
  recordCreate,
  recordQuery,
  recordUpdate,
  roundCreate,
  roundQuery,
  transitionBody,
} from '../validators/survey.validators.js'
import { actorOf, auditHandler, pathId, scopeOf } from './helpers.js'

// --- Rounds

export async function listRounds(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await selectors.listRounds(
    scopeOf(req),
    roundQuery.parse(req.query),
    page,
    req.query.ordering,
  )
  res.json(pageOf(req, page, count, results))
}

export async function getRound(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getRound(scopeOf(req), pathId(req)))
}

export async function createRound(req: Request, res: Response): Promise<void> {
  const { commodity, name, as_of_date: asOfDate, deadline } = roundCreate.parse(req.body)
  const round = await services.openRound({
    actor: actorOf(req),
    commodityId: commodity,
    name,
    asOfDate,
    deadline,
  })
  res.status(201).json(await selectors.getRound(scopeOf(req), round._id))
}

export async function closeRound(req: Request, res: Response): Promise<void> {
  await selectors.requireRound(scopeOf(req), pathId(req))
  const locked = await services.closeRound({ actor: actorOf(req), roundId: pathId(req) })
  res.json({ locked })
}

export async function roundProgress(req: Request, res: Response): Promise<void> {
  res.json(await selectors.roundProgress(scopeOf(req), pathId(req)))
}

export async function roundTotals(req: Request, res: Response): Promise<void> {
  res.json(await selectors.roundTotals(scopeOf(req), pathId(req)))
}

export async function homeStats(req: Request, res: Response): Promise<void> {
  res.json(await selectors.homeStats(scopeOf(req)))
}

// --- Records

export async function listRecords(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await selectors.listRecords(
    scopeOf(req),
    recordQuery.parse(req.query),
    page,
    req.query.ordering,
  )
  res.json(pageOf(req, page, count, results))
}

export async function getRecord(req: Request, res: Response): Promise<void> {
  res.json(await selectors.getRecord(scopeOf(req), pathId(req)))
}

export async function createRecord(req: Request, res: Response): Promise<void> {
  const {
    survey_round: roundId,
    crop_stand: standId,
    counts,
    remarks,
  } = recordCreate.parse(req.body)
  const record = await services.createRecord({
    actor: actorOf(req),
    roundId,
    standId,
    counts,
    remarks,
  })
  res.status(201).json(await selectors.getRecord(scopeOf(req), record._id))
}

export async function createEntry(req: Request, res: Response): Promise<void> {
  const body = entryCreate.parse(req.body)
  const { varieties, ...planting } = body.planting ?? {}
  const { consent_given: consentGiven, ...farmer } = body.new_farmer ?? { home_barangay: '' }
  const record = await saveEntry({
    actor: actorOf(req),
    roundId: body.survey_round,
    farmerId: body.farmer,
    newFarmer: body.new_farmer
      ? { data: camelKeys(farmer), consentGiven: consentGiven ?? false }
      : undefined,
    barangayId: body.barangay,
    sitio: body.sitio,
    planting: { data: camelKeys(planting), varietyIds: varieties },
    counts: body.counts,
    remarks: body.remarks,
  })
  res.status(201).json(await selectors.getRecord(scopeOf(req), record._id))
}

export async function updateRecord(req: Request, res: Response): Promise<void> {
  await selectors.requireRecord(scopeOf(req), pathId(req))
  const { counts, remarks } = recordUpdate.parse(req.body)
  const record = await services.updateRecord({
    actor: actorOf(req),
    recordId: pathId(req),
    counts,
    remarks,
  })
  res.json(await selectors.getRecord(scopeOf(req), record._id))
}

export async function deleteRecord(req: Request, res: Response): Promise<void> {
  await services.deleteRecord({ actor: actorOf(req), recordId: pathId(req) })
  res.status(204).end()
}

export const recordAudit = auditHandler('inventory_record', selectors.requireRecord)

export async function listComments(req: Request, res: Response): Promise<void> {
  res.json(await selectors.listComments(scopeOf(req), pathId(req)))
}

function transition(run: (input: services.TransitionInput) => Promise<unknown>): RequestHandler {
  return async (req: Request, res: Response) => {
    await selectors.requireRecord(scopeOf(req), pathId(req))
    const { comment } = transitionBody.parse(req.body)
    await run({ actor: actorOf(req), recordId: pathId(req), comment })
    res.json(await selectors.getRecord(scopeOf(req), pathId(req)))
  }
}

export const submitRecord = transition(services.submit)
export const validateRecord = transition(services.validate)
export const approveRecord = transition(services.approve)
export const returnRecord = transition(services.returnRecord)
export const reopenRecord = transition(services.reopen)
